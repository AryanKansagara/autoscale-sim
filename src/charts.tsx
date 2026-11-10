import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { SimPoint } from './engine/sim.ts'

// Series colors (validated for CVD separation in both modes): s1 ready replicas, s2 requests, s3 booting, s4 latency.

export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [w, setW] = useState(640)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.round(e.contentRect.width))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

export const fmtMs = (ms: number) => !Number.isFinite(ms) ? '—' : ms < 1000 ? `${Math.round(ms)} ms` : ms < 60000 ? `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s` : `${(ms / 60000).toFixed(1)} min`
const niceMax = (v: number) => { if (!(v > 0)) return 1; const e = 10 ** Math.floor(Math.log10(v)); const m = v / e; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * e }
const timeLabel = (t: number, span: number) => {
  const d = new Date(t)
  return span > 2 * 86_400_000 ? d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }) : `${String(d.getUTCHours()).padStart(2, '0')}:00`
}

function Tip({ x, w, children }: { x: number; w: number; children: ReactNode }) {
  const left = Math.min(Math.max(8, x + 12), w - 200)
  return <div className="chart-tip" style={{ left }}>{children}</div>
}

/** Requests, replicas and p95 latency as three aligned panels over the same time axis, one shared crosshair. */
export function ReplayChart({ series, sloMs, compact, label }: { series: SimPoint[]; sloMs?: number; compact?: boolean; label: string }) {
  const [ref, w] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const L = compact ? 34 : 48, R = 10
  const pw = w - L - R
  const h1 = compact ? 54 : 80, h2 = compact ? 64 : 90, h3 = compact ? 64 : 90, gap = 18
  const n = series.length
  if (!n) return <div ref={ref} className="chart-empty">No requests in this range.</div>
  const t0 = series[0].t, t1 = series[n - 1].t, span = Math.max(1, t1 - t0)
  const x = (i: number) => L + (n === 1 ? 0 : (i / (n - 1)) * pw)
  const bw = Math.max(1, pw / n - (n > 200 ? 0 : 1))
  const maxN = niceMax(Math.max(...series.map(s => s.n)))
  const maxR = Math.max(1, ...series.map(s => s.replicas))
  const lats = series.map(s => s.p95).filter(Number.isFinite)
  const maxL = niceMax(Math.max(sloMs ?? 0, ...lats) * 1.05)
  const y1 = (v: number) => h1 - (v / maxN) * h1
  const top2 = h1 + gap, top3 = top2 + h2 + gap
  const y2 = (v: number) => top2 + h2 - (v / maxR) * h2
  const y3 = (v: number) => top3 + h3 - (v / maxL) * h3
  const H = top3 + h3 + 22
  const step = (get: (s: SimPoint) => number, y: (v: number) => number) => series.map((s, i) => `${i ? 'H' : 'M'}${x(i).toFixed(1)} ${i ? '' : y(get(s)).toFixed(1)}${i ? `V${y(get(s)).toFixed(1)}` : ''}`).join('')
  const area = (get: (s: SimPoint) => number, y: (v: number) => number, base: number) => `${step(get, y)}H${x(n - 1)}V${base}H${L}Z`
  let latPath = ''
  series.forEach((s, i) => { if (Number.isFinite(s.p95)) latPath += `${latPath && Number.isFinite(series[i - 1]?.p95) ? 'L' : 'M'}${x(i).toFixed(1)} ${y3(s.p95).toFixed(1)}` })
  const ticks = Array.from({ length: compact ? 4 : 7 }, (_, k) => Math.round((k / (compact ? 3 : 6)) * (n - 1)))
  const hs = hover !== null ? series[hover] : null
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const i = Math.round(((e.clientX - r.left - L) / pw) * (n - 1))
    setHover(i >= 0 && i < n ? i : null)
  }
  return (
    <div ref={ref} className="chart">
      {!compact && <div className="legend" aria-hidden="true"><span><i className="sw s2" />Requests per bucket</span><span><i className="sw s1" />Ready replicas</span><span><i className="sw s3" />Booting (cold start)</span><span><i className="sw s4 line" />p95 latency</span>{sloMs ? <span><i className="sw slo" />SLO</span> : null}</div>}
      <svg width={w} height={H} role="img" aria-label={label} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        <g className="grid">
          {[0, 0.5, 1].map(f => <line key={'a' + f} x1={L} x2={w - R} y1={y1(maxN * f)} y2={y1(maxN * f)} />)}
          {[0, 1].map(f => <line key={'b' + f} x1={L} x2={w - R} y1={y2(maxR * f)} y2={y2(maxR * f)} />)}
          {[0, 0.5, 1].map(f => <line key={'c' + f} x1={L} x2={w - R} y1={y3(maxL * f)} y2={y3(maxL * f)} />)}
        </g>
        <g className="axis">
          <text x={L - 6} y={y1(maxN) + 4}>{maxN}</text><text x={L - 6} y={h1}>0</text>
          <text x={L - 6} y={y2(maxR) + 4}>{maxR}</text><text x={L - 6} y={top2 + h2}>0</text>
          <text x={L - 6} y={y3(maxL) + 4}>{fmtMs(maxL).replace(' ', '')}</text><text x={L - 6} y={top3 + h3}>0</text>
          {ticks.map(i => <text key={i} className="x" x={x(i)} y={H - 4}>{timeLabel(series[i].t, span)}</text>)}
        </g>
        <g className="panel-label">
          <text x={L} y={-2 + 10}>{compact ? '' : 'REQUESTS'}</text>
          <text x={L} y={top2 - 5}>REPLICAS</text>
          <text x={L} y={top3 - 5}>P95 LATENCY</text>
        </g>
        <g className="s2-fill">{series.map((s, i) => s.n ? <rect key={i} x={x(i) - bw / 2} y={y1(s.n)} width={bw} height={h1 - y1(s.n)} /> : null)}</g>
        <path className="s3-fill" d={area(s => s.replicas, y2, top2 + h2)} />
        <path className="s1-fill" d={area(s => s.ready, y2, top2 + h2)} />
        <path className="s1-line" d={step(s => s.ready, y2)} />
        {sloMs ? <line className="slo-line" x1={L} x2={w - R} y1={y3(sloMs)} y2={y3(sloMs)} /> : null}
        <path className="s4-line" d={latPath} />
        {hs && <line className="crosshair" x1={x(hover!)} x2={x(hover!)} y1={0} y2={top3 + h3} />}
      </svg>
      {hs && <Tip x={x(hover!)} w={w}>
        <b>{new Date(hs.t).toUTCString().slice(0, 22)} UTC</b>
        <span><i className="sw s2" />{hs.n} requests</span>
        <span><i className="sw s1" />{hs.ready} ready{hs.replicas > hs.ready ? `, ${hs.replicas - hs.ready} booting` : ''}</span>
        <span><i className="sw s4 line" />p95 {fmtMs(hs.p95)} · wait {fmtMs(hs.wait)}</span>
        {hs.queue > 0 && <span>Max queue {hs.queue}</span>}
      </Tip>}
    </div>
  )
}

/** Log-binned latency histogram with p50 / p95 / p99 markers. */
export function LatencyHist({ values, marks, label }: { values: number[]; marks: { label: string; v: number }[]; label: string }) {
  const [ref, w] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const H = 170, L = 8, R = 8, B = 22
  const pos = values.filter(v => v > 0)
  if (!pos.length) return <div ref={ref} className="chart-empty">No latencies.</div>
  const lo = Math.log10(Math.max(1, Math.min(...pos))), hi = Math.log10(Math.max(...pos)) + 1e-6
  const nb = 40
  const bins = new Array(nb).fill(0)
  for (const v of pos) bins[Math.min(nb - 1, Math.floor(((Math.log10(Math.max(1, v)) - lo) / (hi - lo)) * nb))]++
  const max = Math.max(...bins)
  const pw = w - L - R
  const xv = (v: number) => L + ((Math.log10(Math.max(1, v)) - lo) / (hi - lo)) * pw
  const bw = pw / nb
  const edge = (i: number) => 10 ** (lo + (i / nb) * (hi - lo))
  return (
    <div ref={ref} className="chart">
      <svg width={w} height={H} role="img" aria-label={label} onPointerLeave={() => setHover(null)}>
        <line className="grid-base" x1={L} x2={w - R} y1={H - B} y2={H - B} />
        {bins.map((c, i) => {
          const hgt = c ? Math.max(2, (c / max) * (H - B - 26)) : 0
          return <g key={i} onPointerEnter={() => setHover(i)}>
            <rect className="hit" x={L + i * bw} y={0} width={bw} height={H - B} />
            {c > 0 && <rect className={`s2-fill${hover === i ? ' on' : ''}`} x={L + i * bw + 1} y={H - B - hgt} width={Math.max(1, bw - 2)} height={hgt} rx={1.5} />}
          </g>
        })}
        {marks.map((m, k) => <g key={m.label} className="mark">
          <line x1={xv(m.v)} x2={xv(m.v)} y1={14 + k * 0} y2={H - B} />
          <text x={xv(m.v)} y={10 + (k % 2) * 0} textAnchor={k === marks.length - 1 ? 'end' : 'middle'}>{m.label} {fmtMs(m.v)}</text>
        </g>)}
        <g className="axis">{[0, 0.25, 0.5, 0.75, 1].map(f => <text key={f} className="x" x={L + f * pw} y={H - 5} textAnchor={f === 0 ? 'start' : f === 1 ? 'end' : 'middle'}>{fmtMs(10 ** (lo + f * (hi - lo)))}</text>)}</g>
      </svg>
      {hover !== null && <Tip x={L + hover * bw} w={w}><b>{fmtMs(edge(hover))} to {fmtMs(edge(hover + 1))}</b><span>{bins[hover].toLocaleString()} requests</span></Tip>}
    </div>
  )
}

export interface ParetoPt { id: string; cost: number; p99: number; label: string; frontier: boolean; current?: boolean; picked?: boolean }

/** Cost vs p99 scatter with the efficient frontier drawn through its points. */
export function ParetoChart({ pts, sloMs, onPick, money }: { pts: ParetoPt[]; sloMs: number; onPick?(id: string): void; money(n: number): string }) {
  const [ref, w] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<string | null>(null)
  const H = 300, L = 56, R = 16, T = 14, B = 34
  const maxC = niceMax(Math.max(...pts.map(p => p.cost)) * 1.05)
  const maxP = niceMax(Math.max(sloMs, ...pts.map(p => p.p99)) * 1.05)
  const x = (c: number) => L + (c / maxC) * (w - L - R)
  const y = (v: number) => T + (H - T - B) - (v / maxP) * (H - T - B)
  const fr = pts.filter(p => p.frontier).sort((a, b) => a.cost - b.cost)
  const hp = pts.find(p => p.id === hover)
  return (
    <div ref={ref} className="chart">
      <div className="legend" aria-hidden="true"><span><i className="sw dot s2" />Policy in the grid</span><span><i className="sw dot s1" />Efficient frontier</span><span><i className="sw ring" />Current policy</span><span><i className="sw slo" />p99 SLO</span></div>
      <svg width={w} height={H} role="img" aria-label="Cost versus p99 latency for every policy in the sweep">
        <g className="grid">{[0, 0.25, 0.5, 0.75, 1].map(f => <line key={f} x1={L} x2={w - R} y1={y(maxP * f)} y2={y(maxP * f)} />)}</g>
        <g className="axis">
          {[0, 0.5, 1].map(f => <text key={f} x={L - 6} y={y(maxP * f) + 4}>{fmtMs(maxP * f)}</text>)}
          {[0, 0.25, 0.5, 0.75, 1].map(f => <text key={f} className="x" x={x(maxC * f)} y={H - 16}>{money(maxC * f)}</text>)}
          <text className="x" x={(L + w - R) / 2} y={H - 1}>Replay cost</text>
        </g>
        <line className="slo-line" x1={L} x2={w - R} y1={y(sloMs)} y2={y(sloMs)} />
        <path className="s1-line" d={fr.map((p, i) => `${i ? 'L' : 'M'}${x(p.cost)} ${y(p.p99)}`).join('')} />
        {pts.map(p => <g key={p.id} className="pt" onPointerEnter={() => setHover(p.id)} onPointerLeave={() => setHover(null)} onClick={() => onPick?.(p.id)} style={{ cursor: onPick ? 'pointer' : undefined }}>
          <circle className="hit" cx={x(p.cost)} cy={y(p.p99)} r={12} />
          <circle className={p.frontier ? 's1-dot' : 's2-dot'} cx={x(p.cost)} cy={y(p.p99)} r={p.picked ? 7 : 5} />
          {p.current && <circle className="ring" cx={x(p.cost)} cy={y(p.p99)} r={10} />}
          {p.picked && <text className="pt-label" x={x(p.cost) + 10} y={y(p.p99) - 10}>Recommended</text>}
        </g>)}
      </svg>
      {hp && <Tip x={x(hp.cost)} w={w}><b>{hp.label}</b><span>Cost {money(hp.cost)}</span><span>p99 {fmtMs(hp.p99)}</span>{hp.frontier && <span>On the frontier</span>}</Tip>}
    </div>
  )
}

/** 24 hourly bars (one series) with an optional reference tick per hour, e.g. the same hour of the last day. */
export function HourBars({ values, ref2, label, unit, refLabel }: { values: number[]; ref2?: number[]; label: string; unit: string; refLabel?: string }) {
  const [ref, w] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const H = 190, L = 40, R = 8, B = 22, T = 8
  const max = niceMax(Math.max(...values, ...(ref2 ?? [0])))
  const bw = (w - L - R) / 24
  const y = (v: number) => T + (H - T - B) - (v / max) * (H - T - B)
  return (
    <div ref={ref} className="chart">
      {ref2 && <div className="legend" aria-hidden="true"><span><i className="sw s2" />{label}</span><span><i className="sw tick" />{refLabel}</span></div>}
      <svg width={w} height={H} role="img" aria-label={label} onPointerLeave={() => setHover(null)}>
        <g className="grid">{[0, 0.5, 1].map(f => <line key={f} x1={L} x2={w - R} y1={y(max * f)} y2={y(max * f)} />)}</g>
        <g className="axis">{[0, 0.5, 1].map(f => <text key={f} x={L - 6} y={y(max * f) + 4}>{Math.round(max * f).toLocaleString()}</text>)}
          {[0, 6, 12, 18, 23].map(h => <text key={h} className="x" x={L + h * bw + bw / 2} y={H - 5}>{String(h).padStart(2, '0')}</text>)}</g>
        {values.map((v, h) => <g key={h} onPointerEnter={() => setHover(h)}>
          <rect className="hit" x={L + h * bw} y={0} width={bw} height={H - B} />
          <rect className={`s2-fill${hover === h ? ' on' : ''}`} x={L + h * bw + 1} y={y(v)} width={Math.max(1, bw - 2)} height={Math.max(0, H - B - y(v))} rx={2} />
          {ref2 && <line className="tick-line" x1={L + h * bw + 2} x2={L + (h + 1) * bw - 2} y1={y(ref2[h])} y2={y(ref2[h])} />}
        </g>)}
      </svg>
      {hover !== null && <Tip x={L + hover * bw} w={w}><b>{String(hover).padStart(2, '0')}:00 UTC</b><span>{Math.round(values[hover]).toLocaleString()} {unit}</span>{ref2 && <span>{refLabel}: {Math.round(ref2[hover]).toLocaleString()}</span>}</Tip>}
    </div>
  )
}

/** Min replicas per hour as a step strip. */
export function ReplicaStrip({ perHour }: { perHour: number[] }) {
  const max = Math.max(1, ...perHour)
  return (
    <div className="strip" role="img" aria-label={`Recommended minimum replicas per UTC hour: ${perHour.join(', ')}`}>
      {perHour.map((v, h) => <div key={h} className="strip-cell" title={`${String(h).padStart(2, '0')}:00 UTC · min ${v}`}><span style={{ height: `${(v / max) * 100}%` }} /><b>{v}</b></div>)}
    </div>
  )
}

/** Observed requests per bucket over the whole log, with optional markers (e.g. detected cold starts). */
export function SeriesBars({ counts, t0, bucketMs, marks, label }: { counts: number[]; t0: number; bucketMs: number; marks?: number[]; label: string }) {
  const [ref, w] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const H = 170, L = 40, R = 8, B = 22, T = 14
  const n = counts.length
  if (!n) return <div ref={ref} className="chart-empty">No requests.</div>
  const max = niceMax(Math.max(...counts))
  const bw = (w - L - R) / n
  const y = (v: number) => T + (H - T - B) - (v / max) * (H - T - B)
  const span = n * bucketMs
  const ticks = Array.from({ length: 7 }, (_, k) => Math.round((k / 6) * (n - 1)))
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => { const r = e.currentTarget.getBoundingClientRect(); const i = Math.floor((e.clientX - r.left - L) / bw); setHover(i >= 0 && i < n ? i : null) }
  return (
    <div ref={ref} className="chart">
      {marks && <div className="legend" aria-hidden="true"><span><i className="sw s2" />Requests per {Math.round(bucketMs / 60000)} min</span><span><i className="sw dot s3" />Detected cold start</span></div>}
      <svg width={w} height={H} role="img" aria-label={label} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        <g className="grid">{[0, 0.5, 1].map(f => <line key={f} x1={L} x2={w - R} y1={y(max * f)} y2={y(max * f)} />)}</g>
        <g className="axis">{[0, 0.5, 1].map(f => <text key={f} x={L - 6} y={y(max * f) + 4}>{Math.round(max * f)}</text>)}
          {ticks.map(i => <text key={i} className="x" x={L + i * bw} y={H - 5}>{timeLabel(t0 + i * bucketMs, span)}</text>)}</g>
        <path className="s2-fill" d={counts.map((c, i) => c ? `M${(L + i * bw).toFixed(1)} ${y(0)}V${y(c).toFixed(1)}h${Math.max(0.8, bw - (bw > 3 ? 1 : 0)).toFixed(1)}V${y(0)}Z` : '').join('')} />
        {marks?.map((t, k) => { const i = (t - t0) / bucketMs; return <circle key={k} className="s3-dot" cx={L + i * bw} cy={T - 6} r={4} /> })}
        {hover !== null && <line className="crosshair" x1={L + hover * bw + bw / 2} x2={L + hover * bw + bw / 2} y1={T} y2={H - B} />}
      </svg>
      {hover !== null && <Tip x={L + hover * bw} w={w}><b>{new Date(t0 + hover * bucketMs).toUTCString().slice(0, 22)} UTC</b><span>{counts[hover].toLocaleString()} requests</span></Tip>}
    </div>
  )
}
