import { useDeferredValue, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { checkSlo, configCurl, configJson, configYaml, prewarmCron, recommend } from './engine/actions.ts'
import { forecastTomorrow, hourly, prewarm } from './engine/forecast.ts'
import { reqsToCsv, toCsv } from './engine/parse.ts'
import { simulate, SWEEP_DELAYS, SWEEP_MINS, type SweepCell } from './engine/sim.ts'
import { arrivalSeries } from './engine/stats.ts'
import type { Policy, Slo } from './engine/types.ts'
import { fmtMs, HourBars, LatencyHist, ParetoChart, ReplayChart, ReplicaStrip, SeriesBars } from './charts.tsx'
import type { Tab, TabProps } from './Project.tsx'
import { fmtRange, sliceJobs, type Analysis } from './projectData.ts'
import type { Project, Snapshot } from './store.ts'
import { ask, Code, download, Empty, fmtN, fmtPct, signed, toast } from './ui.tsx'

export const money = (n: number, d = 0) => Number.isFinite(n) ? n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: d, maximumFractionDigits: d }) : '—'
const dur = (s: number) => s >= 3600 ? `${+(s / 3600).toFixed(1)} h` : s >= 60 ? `${+(s / 60).toFixed(1)} min` : `${s} s`
const slug = (s: string) => s.replace(/\W+/g, '-').toLowerCase()

export default function Tabs(props: TabProps & { tab: Tab }) {
  switch (props.tab) {
    case 'replay': return <Replay {...props} />
    case 'sweep': return <Sweep {...props} />
    case 'forecast': return <ForecastTab {...props} />
    case 'actions': return <Actions {...props} />
    case 'history': return <History {...props} />
    default: return <Overview {...props} />
  }
}

// ---------- Shared: sweep in a worker, cached per policy and range ----------

const sweepCache = new Map<string, SweepCell[]>()
const sweepSubs = new Set<() => void>()
let worker: Worker | null = null
const running = new Set<string>()

function sweepKey(p: Project, range: string, n: number) {
  const { minReplicas: _m, scaleDownDelaySec: _d, ...rest } = p.policy
  return `${p.id}|${range}|${n}|${JSON.stringify(rest)}`
}

export function useSweep(p: Project, a: Analysis, range: string): { cells: SweepCell[] | null; key: string } {
  const s = useMemo(() => sliceJobs(a.jobs, range, a.reqs), [a, range])
  const key = sweepKey(p, range, s.jobs.length)
  const cells = useSyncExternalStore(f => { sweepSubs.add(f); return () => sweepSubs.delete(f) }, () => sweepCache.get(key) ?? null)
  useEffect(() => {
    if (sweepCache.has(key) || running.has(key)) return
    running.add(key)
    const done = (c: SweepCell[]) => { sweepCache.set(key, c); running.delete(key); sweepSubs.forEach(f => f()) }
    try {
      worker ??= new Worker(new URL('./sweep.worker.ts', import.meta.url), { type: 'module' })
      const w = worker
      const onMsg = (e: MessageEvent<{ key: string; cells: SweepCell[] }>) => { if (e.data.key === key) { w.removeEventListener('message', onMsg); done(e.data.cells) } }
      w.addEventListener('message', onMsg)
      w.postMessage({ jobs: s.jobs, policy: p.policy, start: s.start, end: s.end, key })
    } catch {
      void import('./engine/sim.ts').then(m => done(m.sweep(s.jobs, p.policy, undefined, undefined, { start: s.start, end: s.end })))
    }
  }, [key])
  return { cells, key }
}

function useReplay(p: Policy, a: Analysis, range: string, bucketSec?: number) {
  const dp = useDeferredValue(p)
  return useMemo(() => {
    const s = sliceJobs(a.jobs, range, a.reqs)
    const span = (s.end - s.start) / 1000
    return simulate(s.jobs, dp, { start: s.start, end: s.end, bucketSec: bucketSec ?? (span > 3 * 86400 ? 1800 : 300) })
  }, [a, range, dp, bucketSec])
}

/** Observed stats restricted to the replay range, for honest before/after comparisons. */
function useObserved(a: Analysis, range: string, p: Project) {
  return useMemo(() => {
    const s = sliceJobs(a.jobs, range, a.reqs)
    const rs = range === 'all' ? a.reqs : a.reqs.filter(r => r.t >= s.start && r.t < s.end)
    const lat = Float64Array.from(rs.filter(r => r.ok).map(r => r.lat)).sort()
    const q = (x: number) => lat.length ? lat[Math.min(lat.length - 1, Math.floor(x * (lat.length - 1)))] : NaN
    const coldIn = a.cold.idx.filter(i => a.reqs[i].t >= s.start && a.reqs[i].t < s.end).length
    const err = rs.filter(r => !r.ok || r.timeout || r.lat >= p.timeoutMs).length
    return { n: rs.length, p95: q(0.95), p99: q(0.99), coldRate: rs.length ? coldIn / rs.length : 0, errorRate: rs.length ? err / rs.length : 0 }
  }, [a, range, p.timeoutMs])
}

function Kpi({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: 'good' | 'bad' }) {
  return <div className={`kpi${tone ? ' ' + tone : ''}`}><small>{label}</small><b>{value}</b>{note && <p>{note}</p>}</div>
}

// ---------- Traffic (observed) ----------

function Overview({ project, a, update }: TabProps) {
  const bucket = a.days > 2 ? 1800 : 300
  const series = useMemo(() => arrivalSeries(a.reqs, bucket), [a, bucket])
  const okLat = useMemo(() => a.reqs.filter(r => r.ok).map(r => r.lat), [a])
  const coldSec = Math.round(a.cold.penaltyMs / 1000)
  const b = a.burst
  return (
    <>
      <div className="kpis">
        <Kpi label="Requests" value={fmtN(a.reqs.length)} note={`${b.meanRps.toFixed(2)} req/s mean over ${a.days.toFixed(1)} days`} />
        <Kpi label="p95 latency (95% CI)" value={fmtMs(a.lat.p95)} note={`${fmtMs(a.lat.ci95[0])} to ${fmtMs(a.lat.ci95[1])}`} />
        <Kpi label="p99 latency (95% CI)" value={fmtMs(a.lat.p99)} note={`${fmtMs(a.lat.ci99[0])} to ${fmtMs(a.lat.ci99[1])}`} />
        <Kpi label="Errors + timeouts" value={fmtPct(a.err.errorRate, 2)} note={`${fmtN(a.err.errors)} failed, ${fmtN(a.err.timeouts)} timed out`} tone={a.err.errorRate > project.slo.errorRate ? 'bad' : undefined} />
      </div>

      <div className="panel">
        <div className="panel-head"><h2>Arrivals</h2><span className="muted small mono">UTC · peak-to-mean {b.peakToMean.toFixed(1)}× · inter-arrival CV {b.interArrivalCv.toFixed(2)}</span></div>
        <SeriesBars counts={series.counts} t0={series.t0} bucketMs={bucket * 1000} marks={a.cold.idx.map(i => a.reqs[i].t)} label={`Requests per ${bucket / 60} minutes with detected cold starts`} />
        <p className="muted small" style={{ marginTop: 10 }}>
          {b.interArrivalCv > 1.5 ? 'Bursty: arrivals clump far more than random (Poisson) traffic would, so the autoscaler will see sudden load it has to boot replicas for.' : b.interArrivalCv > 0.8 ? 'Roughly random arrivals. Bursts are moderate.' : 'Very regular arrivals, typical of a scheduled client.'}
          {' '}Busiest minute: {b.perMinPeak} requests vs {b.perMinMean.toFixed(1)} on average.
        </p>
      </div>

      <div className="grid-2">
        <div className="panel">
          <div className="panel-head"><h2>Latency distribution</h2><span className="muted small">successful requests, log scale</span></div>
          <LatencyHist values={okLat} marks={[{ label: 'p50', v: a.lat.p50 }, { label: 'p95', v: a.lat.p95 }, { label: 'p99', v: a.lat.p99 }]} label="Latency histogram" />
          <p className="muted small">Confidence intervals are percentile bootstraps ({a.reqs.length > 50000 ? 100 : 200} resamples). A wide p99 interval means the tail rests on a handful of requests.</p>
        </div>
        <div className="panel">
          <div className="panel-head"><h2>Prefill vs decode</h2><span className="muted small">{fmtN(a.ttft.n)} requests report TTFT</span></div>
          {a.ttft.n ? (
            <dl className="facts">
              <div><dt>TTFT p50 / p95</dt><dd>{fmtMs(a.ttft.ttftP50)} / {fmtMs(a.ttft.ttftP95)}</dd></div>
              <div><dt>Decode speed p50</dt><dd>{Number.isFinite(a.ttft.tpsP50) ? `${a.ttft.tpsP50.toFixed(1)} tok/s` : '—'}</dd></div>
              <div><dt>Slowest 10% decode</dt><dd>{Number.isFinite(a.ttft.tpsP10) ? `${a.ttft.tpsP10.toFixed(1)} tok/s` : '—'}</dd></div>
              <div><dt>Time per output token</dt><dd>{Number.isFinite(a.ttft.msPerTokP50) ? `${a.ttft.msPerTokP50.toFixed(1)} ms` : '—'}</dd></div>
            </dl>
          ) : <p className="muted">This log has no time-to-first-token column (normal for image and embedding models). Add TTFT to your logs to separate queueing and prefill from generation speed; <a href="/docs#ttft">how</a>.</p>}
          <p className="muted small">High TTFT with normal decode speed points at queueing, prefill or cold starts, which autoscaling can fix. Slow decode is the model server or GPU, which it cannot.</p>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><h2>Cold starts</h2><span className="muted small">slow requests (3× median and +2 s) after {dur(project.coldGapSec)} of idle</span></div>
        <div className="row gap wrap" style={{ alignItems: 'flex-start' }}>
          <div className="kpis three grow" style={{ marginBottom: 0 }}>
            <Kpi label="Detected" value={fmtN(a.cold.idx.length)} note={`after ${fmtN(a.cold.gaps)} idle gaps or new replicas`} />
            <Kpi label="Typical penalty" value={Number.isFinite(a.cold.penaltyMs) ? fmtMs(a.cold.penaltyMs) : '—'} note={`over the ${fmtMs(a.cold.medianLat)} median`} />
            <Kpi label="Share of requests" value={fmtPct(a.cold.idx.length / a.reqs.length, 2)} />
          </div>
          {Number.isFinite(a.cold.penaltyMs) && coldSec !== project.policy.coldStartSec && (
            <div className="callout">
              <p className="small" style={{ margin: '0 0 8px' }}>Your logs show cold starts of about <b>{coldSec} s</b>. The replay uses {project.policy.coldStartSec} s.</p>
              <button type="button" className="btn sm primary" onClick={() => { update({ policy: { ...project.policy, coldStartSec: coldSec } }); toast(`Replay cold start set to ${coldSec} s`, { tone: 'ok' }) }}>Use {coldSec} s in the replay</button>
            </div>
          )}
        </div>
        {a.cold.idx.length > 0 && (
          <div className="table-wrap" style={{ marginTop: 14 }}>
            <table>
              <thead><tr><th>Request at (UTC)</th><th className="num">Idle before</th><th className="num">Latency</th><th className="num">Penalty</th><th>Replica</th></tr></thead>
              <tbody>{a.cold.idx.slice(-8).reverse().map(i => {
                const r = a.reqs[i], prev = a.reqs[i - 1]
                return <tr key={i}><td className="mono small">{new Date(r.t).toISOString().replace('T', ' ').slice(0, 19)}</td><td className="num">{prev ? dur(Math.round((r.t - prev.t - prev.lat) / 1000)) : '—'}</td><td className="num">{fmtMs(r.lat)}</td><td className="num">{fmtMs(r.lat - a.cold.medianLat)}</td><td className="mono small">{r.replica ?? '—'}</td></tr>
              })}</tbody>
            </table>
          </div>
        )}
        <div className="inline-fields" style={{ marginTop: 14, maxWidth: 520 }}>
          <label className="field"><span>Cold-start idle gap (s)</span><input type="number" min={30} step={30} value={project.coldGapSec} onChange={e => update({ coldGapSec: Math.max(30, Number(e.target.value) || 300) })} /></label>
          <label className="field"><span>Client timeout (s)</span><input type="number" min={1} value={project.timeoutMs / 1000} onChange={e => update({ timeoutMs: Math.max(1, Number(e.target.value) || 120) * 1000 })} /></label>
        </div>
      </div>
    </>
  )
}

// ---------- Policy editor ----------

export function PolicyForm({ p, onChange, compact }: { p: Policy; onChange(p: Policy): void; compact?: boolean }) {
  const set = (k: keyof Policy, v: number) => onChange({ ...p, [k]: v, ...(k === 'minReplicas' && v > p.maxReplicas ? { maxReplicas: v } : {}), ...(k === 'maxReplicas' && v < p.minReplicas ? { minReplicas: v } : {}) })
  const num = (k: keyof Policy, label: string, min: number, max: number, step = 1, hint?: string) => (
    <label className="field"><span>{label}{hint && <em className="hint"> {hint}</em>}</span><input type="number" min={min} max={max} step={step} value={p[k]} onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v)) set(k, Math.min(max, Math.max(min, v))) }} /></label>
  )
  return (
    <div className="policy">
      <div className="slider-field">
        <div className="row between"><label htmlFor="pf-min">Min replicas</label><output className="mono">{p.minReplicas}</output></div>
        <input id="pf-min" type="range" min={0} max={Math.max(8, p.maxReplicas)} value={p.minReplicas} onChange={e => set('minReplicas', Number(e.target.value))} />
      </div>
      <div className="slider-field">
        <div className="row between"><label htmlFor="pf-sd">Scale-down delay</label><output className="mono">{dur(p.scaleDownDelaySec)}</output></div>
        <input id="pf-sd" type="range" min={0} max={DELAY_STEPS.length - 1} value={nearestStep(p.scaleDownDelaySec)} onChange={e => set('scaleDownDelaySec', DELAY_STEPS[Number(e.target.value)])} />
      </div>
      {!compact && <div className="inline-fields">
        {num('maxReplicas', 'Max replicas', 1, 200)}
        {num('concurrency', 'Concurrency target', 1, 512, 1, 'per replica')}
        {num('targetUtil', 'Target utilization', 0.05, 1, 0.05, '0 to 1')}
        {num('windowSec', 'Autoscaling window (s)', 5, 3600, 5)}
        {num('coldStartSec', 'Cold start (s)', 0, 1800, 5)}
        {num('gpuHourly', '$ per replica-hour', 0, 200, 0.01)}
      </div>}
    </div>
  )
}
const DELAY_STEPS = [0, 30, 60, 120, 300, 600, 900, 1200, 1800, 2700, 3600, 7200]
const nearestStep = (s: number) => DELAY_STEPS.reduce((b, v, i) => Math.abs(v - s) < Math.abs(DELAY_STEPS[b] - s) ? i : b, 0)

// ---------- Replay ----------

function Delta({ now, was, fmt, lowerBetter = true }: { now: number; was: number; fmt(n: number): string; lowerBetter?: boolean }) {
  if (!Number.isFinite(now) || !Number.isFinite(was) || Math.abs(now - was) < 1e-9) return null
  const better = lowerBetter ? now < was : now > was
  return <span className={`delta ${better ? 'good-text' : 'error'}`}>{signed(now - was, fmt)} vs logged</span>
}

function Replay({ project, a, range, update }: TabProps) {
  const r = useReplay(project.policy, a, range)
  const obs = useObserved(a, range, project)
  const slo = project.slo
  return (
    <div className="replay-layout">
      <div className="panel sticky-side">
        <div className="panel-head"><h2>Policy</h2><span className="muted small">{fmtRange(range)}</span></div>
        <PolicyForm p={project.policy} onChange={p => update({ policy: p })} />
        <p className="muted small">Replays every logged request in order. Service time is the logged latency minus logged waiting (queue time, excess TTFT or a detected boot), so queueing and cold starts are not counted twice.</p>
      </div>
      <div>
        <div className="kpis">
          <div className="kpi"><small>p95 latency</small><b>{fmtMs(r.p95)}</b><p><Delta now={r.p95} was={obs.p95} fmt={fmtMs} /></p></div>
          <div className="kpi"><small>p99 latency</small><b>{fmtMs(r.p99)}</b><p><Delta now={r.p99} was={obs.p99} fmt={fmtMs} /></p></div>
          <div className="kpi"><small>Waited on a cold start</small><b>{fmtN(r.coldHits)}</b><p>{fmtPct(r.coldRate, 2)} of requests</p></div>
          <div className="kpi accent"><small>GPU cost</small><b>{money(r.cost)}</b><p>{r.replicaHours.toFixed(1)} replica-hours · {money(r.costPer1k, 2)} per 1k req</p></div>
        </div>
        <div className="panel">
          <div className="panel-head"><h2>Replay</h2><span className="muted small mono">peak {r.peakReplicas} replicas · {r.scaleUps} scale-ups · max queue {r.maxQueue} · p99 wait {fmtMs(r.p99WaitMs)}</span></div>
          <ReplayChart series={r.series} sloMs={slo.p95Ms} label={`Replay of ${fmtRange(range)}: requests, replicas and p95 latency`} />
        </div>
        <div className="panel">
          <h2>SLO check</h2>
          <SloTable checks={checkSlo(slo, { ...r, errorRate: obs.errorRate })} was={checkSlo(slo, obs)} />
        </div>
      </div>
    </div>
  )
}

function SloTable({ checks, was }: { checks: ReturnType<typeof checkSlo>; was?: ReturnType<typeof checkSlo> }) {
  const f = (c: { unit: string }, v: number) => c.unit === 'ms' ? fmtMs(v) : fmtPct(v, 2)
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Objective</th><th className="num">Target</th>{was && <th className="num">Logged</th>}<th className="num">Replayed</th><th>Status</th></tr></thead>
        <tbody>{checks.map((c, i) => <tr key={c.key}>
          <th scope="row">{c.label}</th><td className="num">≤ {f(c, c.target)}</td>
          {was && <td className="num">{f(c, was[i].actual)}</td>}
          <td className="num">{f(c, c.actual)}</td>
          <td><span className={`status ${c.pass ? 'pass' : 'fail'}`}>{c.pass ? '✓ Meets' : '✕ Misses'}</span></td>
        </tr>)}</tbody>
      </table>
    </div>
  )
}

// ---------- Sweep ----------

function Sweep({ project, a, range, update }: TabProps) {
  const { cells } = useSweep(project, a, range)
  const rec = useMemo(() => cells ? recommend(cells, project.slo) : null, [cells, project.slo])
  if (!cells) return <div className="panel"><div className="boot" role="status" style={{ padding: 60 }}><span className="spinner" /> Replaying {SWEEP_MINS.length * SWEEP_DELAYS.length} policies over {fmtRange(range).toLowerCase()}</div></div>
  const apply = (c: SweepCell) => { update({ policy: { ...project.policy, minReplicas: c.minReplicas, maxReplicas: Math.max(project.policy.maxReplicas, c.minReplicas), scaleDownDelaySec: c.scaleDownDelaySec } }); toast(`Policy set to min ${c.minReplicas}, scale-down ${dur(c.scaleDownDelaySec)}`, { tone: 'ok' }) }
  const front = new Set(rec?.frontier ?? [])
  const id = (c: SweepCell) => `${c.minReplicas}-${c.scaleDownDelaySec}`
  const cur = cells.find(c => c.minReplicas === project.policy.minReplicas && c.scaleDownDelaySec === project.policy.scaleDownDelaySec)
  const pts = cells.map((c, i) => ({ id: id(c), cost: c.r.cost, p99: c.r.p99, label: `min ${c.minReplicas}, scale-down ${dur(c.scaleDownDelaySec)}`, frontier: front.has(i), current: c === cur, picked: c === rec?.cell }))
  const maxP99 = Math.max(...cells.map(c => c.r.p99))
  return (
    <>
      {rec && <div className={`banner ${rec.meets ? 'good' : 'warn'}`}>
        <span>{rec.meets
          ? <>Cheapest policy on the frontier that meets your SLOs: <b>min {rec.cell.minReplicas} replicas, scale-down {dur(rec.cell.scaleDownDelaySec)}</b>, p99 {fmtMs(rec.cell.r.p99)}, {money(rec.cell.r.cost)} for {fmtRange(range).toLowerCase()}.</>
          : <>No policy in the grid meets every SLO. Lowest p99: <b>min {rec.cell.minReplicas}, scale-down {dur(rec.cell.scaleDownDelaySec)}</b> at {fmtMs(rec.cell.r.p99)}. Raise max replicas or concurrency, or relax the SLO.</>}</span>
        <button type="button" className="btn sm primary" onClick={() => apply(rec.cell)}>Use this policy</button>
      </div>}
      <div className="grid-2 sweep-grid">
        <div className="panel">
          <div className="panel-head"><h2>Cost vs p99</h2><span className="muted small">click a point to use it</span></div>
          <ParetoChart pts={pts} sloMs={project.slo.p99Ms} money={n => money(n)} onPick={pid => { const c = cells.find(x => id(x) === pid); if (c) apply(c) }} />
        </div>
        <div className="panel">
          <div className="panel-head"><h2>Grid</h2><span className="muted small">p99 and cost per policy; other settings as in Replay</span></div>
          <div className="table-wrap">
            <table className="grid-table">
              <thead><tr><th>Min \ delay</th>{SWEEP_DELAYS.map(d => <th key={d} className="num">{dur(d)}</th>)}</tr></thead>
              <tbody>{SWEEP_MINS.map(m => <tr key={m}><th scope="row">{m}</th>{SWEEP_DELAYS.map(d => {
                const c = cells.find(x => x.minReplicas === m && x.scaleDownDelaySec === d)!
                const ok = c.r.p99 <= project.slo.p99Ms && c.r.p95 <= project.slo.p95Ms && c.r.coldRate <= project.slo.coldRate
                const i = cells.indexOf(c)
                return <td key={d} className={`cell${ok ? ' ok' : ''}${c === rec?.cell ? ' picked' : ''}${front.has(i) ? ' front' : ''}`} style={{ ['--v' as string]: `${Math.round(8 + 50 * (c.r.p99 / maxP99))}%` }}>
                  <button type="button" onClick={() => apply(c)} title={`Use min ${m}, scale-down ${dur(d)}`}><b>{fmtMs(c.r.p99)}</b><small>{money(c.r.cost)}</small></button>
                </td>
              })}</tr>)}</tbody>
            </table>
          </div>
          <p className="muted small">Darker cells have a worse p99. Green outline: meets every SLO. Dot: on the cost/p99 frontier.</p>
        </div>
      </div>
      <div className="row gap wrap">
        <button type="button" className="btn sm outline" onClick={() => download(`${slug(project.name)}-sweep-${range}.csv`, toCsv([['min_replicas', 'scale_down_delay_s', 'p50_ms', 'p95_ms', 'p99_ms', 'cold_hits', 'cold_rate', 'replica_hours', 'cost_usd', 'on_frontier'], ...cells.map((c, i) => [c.minReplicas, c.scaleDownDelaySec, c.r.p50, c.r.p95, c.r.p99, c.r.coldHits, c.r.coldRate, c.r.replicaHours, c.r.cost, front.has(i) ? 'yes' : 'no'])]))}>Download sweep CSV</button>
      </div>
    </>
  )
}

// ---------- Forecast ----------

function ForecastTab({ project, a, update }: TabProps) {
  const f = useMemo(() => forecastTomorrow(a.reqs), [a])
  const hr = useMemo(() => hourly(a.reqs), [a])
  if (!f) return <div className="panel"><Empty title="Need two full days of logs"><p className="muted">The forecast holds out the last day to check itself. Import at least two days, ideally a week, so weekday patterns show.</p></Empty></div>
  const pw = prewarm(f, project.policy, a.meanServiceMs)
  const lastDay = hr.counts.slice((f.days - 1) * 24, f.days * 24)
  const cron = prewarmCron(pw.blocks, project.policy.coldStartSec)
  const total = f.hours.reduce((s, h) => s + h.value, 0)
  const pwHours = pw.perHour.reduce((s, v) => s + v, 0)
  return (
    <>
      <div className="kpis">
        <Kpi label="Forecast requests" value={fmtN(total)} note={new Date(f.day).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' }) + ' (UTC)'} />
        <Kpi label="Method" value={f.method === 'ewma' ? 'EWMA' : 'Seasonal naive'} note={f.backtest ? `backtest MAE ${f.backtest.naive.toFixed(0)} (naive) vs ${f.backtest.ewma.toFixed(0)} (EWMA) req/h` : 'not enough days to backtest'} />
        <Kpi label="Warm replica-hours" value={fmtN(pwHours)} note={`${money(pwHours * project.policy.gpuHourly)} of pre-warming`} />
        <Kpi label="Peak minimum" value={String(Math.max(...pw.perHour))} note="replicas at the busiest hour" />
      </div>
      <div className="panel">
        <div className="panel-head"><h2>Tomorrow, hour by hour</h2><span className="muted small">{f.days} days of history · UTC</span></div>
        <HourBars values={f.hours.map(h => h.value)} ref2={lastDay} label="Forecast requests per hour" refLabel="Last full day" unit="requests forecast" />
        <p className="muted small">Seasonal naive repeats {f.days >= 7 ? 'the same weekday last week' : 'yesterday'}; EWMA smooths each hour across days (α 0.4). The last full day is held out and whichever had the lower error is used.</p>
      </div>
      <div className="panel">
        <div className="panel-head"><h2>Pre-warm schedule</h2><span className="muted small">min replicas per hour so the expected peak minute never waits on a boot</span></div>
        <ReplicaStrip perHour={pw.perHour} />
        <p className="muted small">Per hour: forecast rate × busiest-minute factor × mean service time ({fmtMs(a.meanServiceMs)}) = expected concurrency, divided by concurrency target × utilization ({project.policy.concurrency} × {Math.round(project.policy.targetUtil * 100)}%). Raises start {Math.ceil(project.policy.coldStartSec / 60)} min early to cover the cold start.</p>
        <Code label="crontab (UTC): call your autoscaling API from set_min_replica" code={cron + '\n'} />
        <div className="row gap wrap">
          <button type="button" className="btn sm outline" onClick={() => download(`${slug(project.name)}-forecast.csv`, toCsv([['hour_utc', 'seasonal_naive', 'ewma', 'forecast', 'peak_minute_factor', 'min_replicas'], ...f.hours.map((h, i) => [h.h, h.naive, h.ewma, h.value, h.peakFactor, pw.perHour[i]])]))}>Download forecast CSV</button>
          <button type="button" className="btn sm ghost" onClick={() => { const m = Math.min(...pw.perHour); update({ policy: { ...project.policy, minReplicas: m } }); toast(`Base min replicas set to ${m}; schedule the rest with the cron above`, { tone: 'ok' }) }}>Set base min replicas to {Math.min(...pw.perHour)}</button>
        </div>
      </div>
    </>
  )
}

// ---------- Config & SLO ----------

function Actions({ project, a, range, update }: TabProps) {
  const { cells } = useSweep(project, a, range)
  const rec = useMemo(() => cells ? recommend(cells, project.slo) : null, [cells, project.slo])
  const recPolicy: Policy = rec ? { ...project.policy, minReplicas: rec.cell.minReplicas, maxReplicas: Math.max(project.policy.maxReplicas, rec.cell.minReplicas), scaleDownDelaySec: rec.cell.scaleDownDelaySec } : project.policy
  const [which, setWhich] = useState<'rec' | 'cur'>('rec')
  const p = which === 'rec' ? recPolicy : project.policy
  const r = useReplay(p, a, range)
  const obs = useObserved(a, range, project)
  const [fmt, setFmt] = useState<'yaml' | 'json' | 'curl'>('yaml')
  const code = fmt === 'yaml' ? configYaml(p, r) : fmt === 'json' ? JSON.stringify(configJson(p), null, 2) + '\n' : configCurl(p) + '\n'
  const setSlo = (patch: Partial<Slo>) => update({ slo: { ...project.slo, ...patch } })
  return (
    <>
      <div className="grid-2">
        <div className="panel">
          <div className="panel-head"><h2>Recommended config</h2>
            <div className="seg-control" role="radiogroup" aria-label="Which policy">
              <button type="button" role="radio" aria-checked={which === 'rec'} className={which === 'rec' ? 'on' : ''} onClick={() => setWhich('rec')}>{rec ? 'Recommended' : 'Sweeping…'}</button>
              <button type="button" role="radio" aria-checked={which === 'cur'} className={which === 'cur' ? 'on' : ''} onClick={() => setWhich('cur')}>Current</button>
            </div>
          </div>
          {which === 'rec' && rec && <p className="small">{rec.meets ? 'Cheapest policy on the cost/p99 frontier that meets your latency and cold-start SLOs' : 'Nothing in the sweep meets every SLO; this is the lowest p99'} for {fmtRange(range).toLowerCase()}.</p>}
          <div className="seg-control" role="radiogroup" aria-label="Format" style={{ marginBottom: 6 }}>
            {(['yaml', 'json', 'curl'] as const).map(f => <button key={f} type="button" role="radio" aria-checked={fmt === f} className={fmt === f ? 'on' : ''} onClick={() => setFmt(f)}>{f === 'curl' ? 'API call' : f.toUpperCase()}</button>)}
          </div>
          <Code label={fmt === 'yaml' ? 'autoscaling.yaml (annotated)' : fmt === 'json' ? 'autoscaling_settings.json' : 'shell'} code={code} />
          <div className="row gap wrap">
            <button type="button" className="btn sm outline" onClick={() => download(`${slug(project.name)}-autoscaling.${fmt === 'curl' ? 'sh' : fmt}`, code, 'text/plain')}>Download</button>
            {which === 'rec' && rec && <button type="button" className="btn sm primary" onClick={() => { update({ policy: recPolicy }); toast('Recommended policy is now the current policy', { tone: 'ok' }) }}>Make it current</button>}
          </div>
          <dl className="explain">
            <div><dt>min_replica</dt><dd>Replicas kept warm at all times. Each one is billed around the clock but removes the cold start for traffic it can absorb.</dd></div>
            <div><dt>scale_down_delay</dt><dd>How long load must stay low before a replica is removed. Longer delays bridge gaps between bursts at the cost of idle GPU time.</dd></div>
            <div><dt>concurrency_target</dt><dd>Requests a replica handles at once. Too low wastes GPUs; too high raises per-request latency. Set it from a load test.</dd></div>
            <div><dt>target_utilization_percentage</dt><dd>Headroom: scale up when average load passes this share of capacity.</dd></div>
            <div><dt>autoscaling_window</dt><dd>Seconds of load averaged per decision. Short windows react to bursts; long ones ignore noise.</dd></div>
          </dl>
        </div>
        <div>
          <div className="panel">
            <h2>Service level objectives</h2>
            <div className="inline-fields">
              <label className="field"><span>p95 latency (s)</span><input type="number" min={0.1} step={0.5} value={project.slo.p95Ms / 1000} onChange={e => setSlo({ p95Ms: Math.max(0.1, Number(e.target.value)) * 1000 })} /></label>
              <label className="field"><span>p99 latency (s)</span><input type="number" min={0.1} step={0.5} value={project.slo.p99Ms / 1000} onChange={e => setSlo({ p99Ms: Math.max(0.1, Number(e.target.value)) * 1000 })} /></label>
              <label className="field"><span>Max cold-start share (%)</span><input type="number" min={0} step={0.1} value={+(project.slo.coldRate * 100).toFixed(3)} onChange={e => setSlo({ coldRate: Math.max(0, Number(e.target.value)) / 100 })} /></label>
              <label className="field"><span>Max error rate (%)</span><input type="number" min={0} step={0.1} value={+(project.slo.errorRate * 100).toFixed(3)} onChange={e => setSlo({ errorRate: Math.max(0, Number(e.target.value)) / 100 })} /></label>
            </div>
            <SloTable checks={checkSlo(project.slo, { ...r, errorRate: obs.errorRate })} was={checkSlo(project.slo, obs)} />
            <p className="muted small">Error rate is taken from the logs: autoscaling changes queueing and cold starts, not model errors.</p>
          </div>
          <div className="panel">
            <h2>Exports</h2>
            <div className="stack-sm">
              <button type="button" className="btn sm outline block" onClick={() => download(`${slug(project.name)}-requests.csv`, reqsToCsv(a.reqs))}>Normalized request log (CSV)</button>
              <button type="button" className="btn sm outline block" onClick={() => download(`${slug(project.name)}-replay-${range}.csv`, toCsv([['bucket_start_utc', 'requests', 'replicas', 'ready_replicas', 'max_queue', 'p95_ms', 'mean_wait_ms'], ...r.series.map(s => [new Date(s.t).toISOString(), s.n, s.replicas, s.ready, s.queue, Number.isFinite(s.p95) ? s.p95 : '', s.wait])]))}>Replay timeline (CSV)</button>
              <a className="btn sm outline block" href={`/app/p/${project.id}/report${range === 'all' ? '?d=all' : `?d=${range}`}`}>Printable capacity report</a>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

// ---------- Experiments ----------

function History({ project, update }: TabProps) {
  const list = [...project.snapshots].sort((a, b) => b.at - a.at)
  const [sel, setSel] = useState<string[]>(() => list.slice(0, 2).map(s => s.id).reverse())
  const pick = (id: string) => setSel(s => s.includes(id) ? s.filter(x => x !== id) : [...s.slice(-1), id])
  if (!list.length) return <div className="panel"><Empty title="No experiments yet"><p className="muted">Tune a policy on the Replay tab and press <kbd>S</kbd> (or Save experiment) to keep it here for comparison.</p></Empty></div>
  const [A, B] = sel.map(id => project.snapshots.find(s => s.id === id)).filter(Boolean) as Snapshot[]
  const del = async (s: Snapshot) => {
    if (!(await ask('Delete experiment?', `“${s.label}” will be removed. You can undo for a few seconds.`, 'Delete'))) return
    const before = project.snapshots
    update({ snapshots: before.filter(x => x.id !== s.id) })
    void import('./sync.ts').then(m => m.deleteSnapshotCloud(s.id))
    toast('Experiment deleted', { undo: () => update({ snapshots: before }) })
  }
  return (
    <>
      {A && B && <Compare a={A} b={B} />}
      <div className="panel">
        <div className="panel-head"><h2>Saved experiments</h2><span className="muted small">pick two to compare</span></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th><span className="sr-only">Compare</span></th><th>Experiment</th><th>Range</th><th className="num">p95</th><th className="num">p99</th><th className="num">Cold hits</th><th className="num">Replica-h</th><th className="num">Cost</th><th /></tr></thead>
            <tbody>{list.map(s => <tr key={s.id} className={sel.includes(s.id) ? 'selected' : ''}>
              <td><input type="checkbox" checked={sel.includes(s.id)} onChange={() => pick(s.id)} aria-label={`Compare ${s.label}`} /></td>
              <th scope="row"><input className="table-input plain" defaultValue={s.label} aria-label="Experiment name" onBlur={e => { const v = e.target.value.trim(); if (v && v !== s.label) update({ snapshots: project.snapshots.map(x => x.id === s.id ? { ...x, label: v } : x) }) }} /><small className="muted">{new Date(s.at).toLocaleString()}{s.note ? ` · ${s.note}` : ''}</small></th>
              <td className="small">{fmtRange(s.range)}</td>
              <td className="num">{fmtMs(s.result.p95)}</td><td className="num">{fmtMs(s.result.p99)}</td>
              <td className="num">{fmtN(s.result.coldHits)}</td><td className="num">{s.result.replicaHours.toFixed(1)}</td><td className="num">{money(s.result.cost)}</td>
              <td className="row gap-sm end">
                <button type="button" className="btn ghost sm" onClick={() => { update({ policy: s.policy }); toast('Policy restored from experiment', { tone: 'ok' }) }}>Use</button>
                <button type="button" className="btn danger-ghost sm" onClick={() => void del(s)}>Delete</button>
              </td>
            </tr>)}</tbody>
          </table>
        </div>
      </div>
    </>
  )
}

const POLICY_ROWS: [keyof Policy, string, (v: number) => string][] = [
  ['minReplicas', 'Min replicas', String], ['maxReplicas', 'Max replicas', String], ['concurrency', 'Concurrency target', String],
  ['targetUtil', 'Target utilization', v => fmtPct(v)], ['windowSec', 'Autoscaling window', dur], ['scaleDownDelaySec', 'Scale-down delay', dur],
  ['coldStartSec', 'Cold start', dur], ['gpuHourly', '$ per replica-hour', v => money(v, 2)],
]
const RESULT_ROWS: [keyof Snapshot['result'], string, (v: number) => string, boolean][] = [
  ['p95', 'p95 latency', fmtMs, true], ['p99', 'p99 latency', fmtMs, true], ['meanWaitMs', 'Mean queue wait', fmtMs, true],
  ['coldHits', 'Requests that waited on a cold start', v => fmtN(v), true], ['replicaHours', 'Replica-hours', v => v.toFixed(1), true],
  ['cost', 'Cost', v => money(v), true], ['costPer1k', 'Cost per 1k requests', v => money(v, 2), true], ['peakReplicas', 'Peak replicas', String, true],
]

function Compare({ a, b }: { a: Snapshot; b: Snapshot }) {
  return (
    <div className="panel">
      <div className="panel-head"><h2>Compare</h2>{a.range !== b.range && <span className="warn-text small">Different replay ranges: compare cost per 1k requests, not totals.</span>}</div>
      <div className="table-wrap">
        <table className="compare">
          <thead><tr><th /><th>{a.label}</th><th>{b.label}</th><th className="num">Change</th></tr></thead>
          <tbody>
            {POLICY_ROWS.filter(([k]) => a.policy[k] !== b.policy[k]).map(([k, l, f]) => <tr key={k}><th scope="row">{l}</th><td>{f(a.policy[k])}</td><td>{f(b.policy[k])}</td><td className="num muted">changed</td></tr>)}
            {RESULT_ROWS.map(([k, l, f, lower]) => {
              const d = b.result[k] - a.result[k]
              const better = lower ? d < 0 : d > 0
              return <tr key={k}><th scope="row">{l}</th><td>{f(a.result[k])}</td><td>{f(b.result[k])}</td><td className={`num ${Math.abs(d) < 1e-9 ? 'muted' : better ? 'good-text' : 'error'}`}>{Math.abs(d) < 1e-9 ? 'same' : signed(d, f)}</td></tr>
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

