import { useEffect, useMemo } from 'react'
import { checkSlo, configYaml, prewarmCron, recommend } from './engine/actions.ts'
import { forecastTomorrow, prewarm } from './engine/forecast.ts'
import { simulate } from './engine/sim.ts'
import { toCsv } from './engine/parse.ts'
import type { Policy } from './engine/types.ts'
import { fmtMs, ReplayChart, ReplicaStrip } from './charts.tsx'
import { busiestDay, dayOptions, fmtRange, sliceJobs, useAnalysis, useProject } from './projectData.ts'
import { money, useSweep } from './Tabs.tsx'
import { download, fmtN, fmtPct, Link, SyntheticBadge } from './ui.tsx'
import type { Analysis } from './projectData.ts'
import type { Project } from './store.ts'

export default function Report({ id }: { id: string }) {
  const { loading, project, ds } = useProject(id)
  const a = useAnalysis(ds, project)
  if (loading) return <div className="boot"><span className="spinner" /> Building the report</div>
  if (!project || !a) return <section className="page narrow center"><h1>Nothing to report</h1><p className="muted">This endpoint has no request log on this device.</p><Link href="/app" className="btn primary">All endpoints</Link></section>
  return <Body project={project} a={a} />
}

function Body({ project, a }: { project: Project; a: Analysis }) {
  const ranges = useMemo(() => dayOptions(a.reqs), [a])
  const q = new URLSearchParams(location.search).get('d')
  const range = q && ranges.includes(q) ? q : busiestDay(a.reqs)
  useEffect(() => { document.title = `Capacity report · ${project.name} · ${fmtRange(range)}` }, [project.name, range])
  const { cells } = useSweep(project, a, range)
  const rec = useMemo(() => cells ? recommend(cells, project.slo) : null, [cells, project.slo])
  const s = useMemo(() => sliceJobs(a.jobs, range, a.reqs), [a, range])
  const run = (p: Policy) => simulate(s.jobs, p, { start: s.start, end: s.end, bucketSec: range === 'all' ? 1800 : 600 })
  const cur = useMemo(() => run(project.policy), [s, project.policy])
  const recP: Policy | null = rec ? { ...project.policy, minReplicas: rec.cell.minReplicas, maxReplicas: Math.max(project.policy.maxReplicas, rec.cell.minReplicas), scaleDownDelaySec: rec.cell.scaleDownDelaySec } : null
  const recR = useMemo(() => recP ? run(recP) : null, [s, rec])
  const f = useMemo(() => forecastTomorrow(a.reqs), [a])
  const pw = f ? prewarm(f, project.policy, a.meanServiceMs) : null
  const errRate = a.err.errorRate
  const rows: [string, string, string][] = [
    ['p95 latency', fmtMs(cur.p95), recR ? fmtMs(recR.p95) : '…'], ['p99 latency', fmtMs(cur.p99), recR ? fmtMs(recR.p99) : '…'],
    ['Requests that waited on a cold start', `${fmtN(cur.coldHits)} (${fmtPct(cur.coldRate, 2)})`, recR ? `${fmtN(recR.coldHits)} (${fmtPct(recR.coldRate, 2)})` : '…'],
    ['Replica-hours', cur.replicaHours.toFixed(1), recR ? recR.replicaHours.toFixed(1) : '…'], ['GPU cost', money(cur.cost), recR ? money(recR.cost) : '…'],
    ['Cost per 1k requests', money(cur.costPer1k, 2), recR ? money(recR.costPer1k, 2) : '…'],
  ]
  const pol = (p: Policy) => `min ${p.minReplicas}, max ${p.maxReplicas}, concurrency ${p.concurrency}, target ${Math.round(p.targetUtil * 100)}%, window ${p.windowSec}s, scale-down ${p.scaleDownDelaySec}s`
  return (
    <article className="report">
      <div className="report-actions">
        <Link href={`/app/p/${project.id}${location.search}`} className="btn ghost">Back to the endpoint</Link>
        <button type="button" className="btn outline" onClick={() => download(`capacity-report-${range}.csv`, toCsv([['metric', 'current', 'recommended'], ...rows]))}>Download CSV</button>
        <button type="button" className="btn primary" onClick={() => print()}>Print or save as PDF</button>
      </div>
      <div className="eyebrow">Capacity report</div>
      <h1 className="row gap wrap">{project.name} {project.sampleId && <SyntheticBadge />}</h1>
      <p className="muted">{fmtN(a.reqs.length)} logged requests over {a.days.toFixed(1)} days · replay range {fmtRange(range)} · {project.gpu} at {money(project.policy.gpuHourly, 2)}/replica-hour · prepared {new Date().toLocaleDateString('en-US', { dateStyle: 'long' })}</p>

      <div className="kpis">
        <div className="kpi"><small>Logged p95 (95% CI)</small><b>{fmtMs(a.lat.p95)}</b><p>{fmtMs(a.lat.ci95[0])} to {fmtMs(a.lat.ci95[1])}</p></div>
        <div className="kpi"><small>Logged p99 (95% CI)</small><b>{fmtMs(a.lat.p99)}</b><p>{fmtMs(a.lat.ci99[0])} to {fmtMs(a.lat.ci99[1])}</p></div>
        <div className="kpi"><small>Cold starts detected</small><b>{fmtN(a.cold.idx.length)}</b><p>typical penalty {fmtMs(a.cold.penaltyMs)}</p></div>
        <div className="kpi"><small>Errors + timeouts</small><b>{fmtPct(errRate, 2)}</b><p>peak-to-mean {a.burst.peakToMean.toFixed(1)}×, CV {a.burst.interArrivalCv.toFixed(2)}</p></div>
      </div>

      <h2>Current vs recommended policy</h2>
      <p className="small"><b>Current:</b> {pol(project.policy)}.<br /><b>Recommended:</b> {recP ? `${pol(recP)}. ${rec!.meets ? 'Cheapest policy on the cost/p99 frontier that meets every SLO.' : 'No policy in the grid meets every SLO; this has the lowest p99.'}` : 'running the policy sweep…'}</p>
      <div className="table-wrap"><table>
        <thead><tr><th>Replay of {fmtRange(range).toLowerCase()}</th><th className="num">Current</th><th className="num">Recommended</th></tr></thead>
        <tbody>{rows.map(r => <tr key={r[0]}><th scope="row">{r[0]}</th><td className="num">{r[1]}</td><td className="num">{r[2]}</td></tr>)}</tbody>
      </table></div>

      <h2>SLO check (recommended)</h2>
      <div className="table-wrap"><table>
        <thead><tr><th>Objective</th><th className="num">Target</th><th className="num">Replayed</th><th>Status</th></tr></thead>
        <tbody>{checkSlo(project.slo, { ...(recR ?? cur), errorRate: errRate }).map(c => <tr key={c.key}><th scope="row">{c.label}</th><td className="num">≤ {c.unit === 'ms' ? fmtMs(c.target) : fmtPct(c.target, 2)}</td><td className="num">{c.unit === 'ms' ? fmtMs(c.actual) : fmtPct(c.actual, 2)}</td><td><span className={`status ${c.pass ? 'pass' : 'fail'}`}>{c.pass ? '✓ Meets' : '✕ Misses'}</span></td></tr>)}</tbody>
      </table></div>

      <h2>Replay: {recR ? 'recommended policy' : 'current policy'}</h2>
      <ReplayChart series={(recR ?? cur).series} sloMs={project.slo.p95Ms} label="Replay timeline" />

      <h2>Config to apply</h2>
      <pre className="report-code">{configYaml(recP ?? project.policy, recR ?? cur)}</pre>

      {f && pw && <>
        <h2>Pre-warm schedule for {new Date(f.day).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' })}</h2>
        <p className="small muted">Forecast {fmtN(f.hours.reduce((x, h) => x + h.value, 0))} requests ({f.method === 'ewma' ? 'EWMA' : 'seasonal naive'}{f.backtest ? `, backtest MAE ${Math.min(f.backtest.naive, f.backtest.ewma).toFixed(0)} req/h` : ''}). Minimum replicas per UTC hour:</p>
        <ReplicaStrip perHour={pw.perHour} />
        <pre className="report-code">{prewarmCron(pw.blocks, project.policy.coldStartSec)}</pre>
      </>}

      {project.snapshots.length > 0 && <>
        <h2>Saved experiments</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Experiment</th><th>Range</th><th className="num">p99</th><th className="num">Cold hits</th><th className="num">Cost</th></tr></thead>
          <tbody>{project.snapshots.map(x => <tr key={x.id}><th scope="row">{x.label}</th><td>{fmtRange(x.range)}</td><td className="num">{fmtMs(x.result.p99)}</td><td className="num">{fmtN(x.result.coldHits)}</td><td className="num">{money(x.result.cost)}</td></tr>)}</tbody>
        </table></div>
      </>}
      <p className="muted small" style={{ marginTop: 28 }}>Method: discrete-event replay of every logged request against the policy (FIFO queue, concurrency slots per replica, 5 s autoscaler ticks averaging load over the window, scale-down after the delay, replicas billed from boot). Detected cold starts in the log are replaced by the warm median so they are not double counted. {project.sampleId ? 'Data is synthetic.' : ''} Generated by Autoscale Sim; not affiliated with Baseten.</p>
    </article>
  )
}
