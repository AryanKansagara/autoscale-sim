import type { Policy, Req } from './types.ts'
import { pct, sortNum } from './stats.ts'

/** A request to replay: arrival time (ms) and how long a warm replica takes to serve it (ms). */
export interface Job { t: number; s: number }

/**
 * Service time for replay. The simulator models queueing and cold starts itself, so time the logs show
 * spent waiting is removed: a logged queue time is subtracted directly; otherwise detected cold starts get the warm median, and when TTFT is logged, TTFT above
 * 3x the median TTFT is treated as waiting (queue or boot) rather than work; without TTFT, requests that
 * arrived during a detected boot have the remaining boot time removed.
 */
export function toJobs(reqs: Req[], coldIdx: number[] = [], medianLat?: number): Job[] {
  const cold = new Set(coldIdx)
  const med = medianLat ?? pct(sortNum(reqs.map(r => r.lat)), 0.5)
  const tt = sortNum(reqs.filter(r => r.ttft !== undefined).map(r => r.ttft!))
  const ttCap = tt.length ? 3 * pct(tt, 0.5) : Infinity
  // Without TTFT, requests that arrived while a detected cold start was booting waited for it too:
  // the boot ends about (latency - median) after the cold request arrived.
  let bootEnd = -Infinity
  return reqs.map((r, i) => {
    if (r.queue !== undefined) return { t: r.t, s: Math.max(1, r.lat - r.queue) }
    if (cold.has(i)) { bootEnd = Math.max(bootEnd, r.t + r.lat - med); return { t: r.t, s: med } }
    if (r.ttft !== undefined) return { t: r.t, s: r.ttft > ttCap ? Math.max(1, r.lat - (r.ttft - ttCap)) : r.lat }
    return { t: r.t, s: r.t < bootEnd ? Math.max(Math.min(r.lat, med * 0.25), r.lat - (bootEnd - r.t)) : r.lat }
  })
}

/**
 * One bucket of the timeline. `replicas` and `ready` are averages over the bucket, so a replica up for 1 of 5 minutes counts 0.2
 * and the area under `replicas` is the billed time; `peak` is the most replicas up at once.
 */
export interface SimPoint { t: number; replicas: number; ready: number; peak: number; queue: number; n: number; p95: number; wait: number }
export interface SimResult {
  n: number
  p50: number
  p95: number
  p99: number
  meanWaitMs: number
  p95WaitMs: number
  p99WaitMs: number
  maxQueue: number
  coldHits: number
  coldRate: number
  replicaHours: number
  cost: number
  costPer1k: number
  peakReplicas: number
  scaleUps: number
  hours: number
  series: SimPoint[]
  /** Per-job wait (ms) and whether it waited on a booting replica, when opts.perRequest is set. */
  waits?: Float64Array
  coldFlags?: Uint8Array
}

interface Replica { start: number; ready: number; end: number; active: number }

const TICK_MS = 5000

/**
 * Discrete-event replay of an autoscaler. Each replica serves up to `concurrency` requests at once;
 * extra requests queue FIFO. Every 5 s the autoscaler averages load (in flight + queued) over the window,
 * wants ceil(avg / (concurrency * targetUtil)) replicas, scales up immediately (replicas serve after
 * coldStartSec) and scales down only after load has stayed below capacity for scaleDownDelaySec.
 * With zero replicas, the first arrival triggers a scale-up at once. Replicas are billed from boot to removal.
 */
export function simulate(jobs: Job[], p: Policy, opts: { start?: number; end?: number; bucketSec?: number; series?: boolean; perRequest?: boolean } = {}): SimResult {
  const n = jobs.length
  const C = Math.max(1, Math.floor(p.concurrency))
  const minR = Math.max(0, Math.floor(p.minReplicas))
  const maxR = Math.max(1, minR, Math.floor(p.maxReplicas))
  const cold = Math.max(0, p.coldStartSec) * 1000
  const delay = Math.max(0, p.scaleDownDelaySec) * 1000
  const win = Math.max(TICK_MS, p.windowSec * 1000)
  const util = Math.min(1, Math.max(0.05, p.targetUtil))
  const t0 = opts.start ?? (n ? jobs[0].t : 0)
  const tEnd = opts.end ?? (n ? jobs[n - 1].t : t0)
  const bucket = (opts.bucketSec ?? 300) * 1000
  const wantSeries = opts.series !== false

  let reps: Replica[] = []
  let deadMs = 0
  const gone: Replica[] = []
  const retire = () => {
    // Drop removed replicas from the working set so per-event scans stay small.
    for (const r of reps) if (r.end !== Infinity) { deadMs += r.end - r.start; if (wantSeries) gone.push(r) }
    reps = reps.filter(r => r.end === Infinity)
  }
  for (let i = 0; i < minR; i++) reps.push({ start: t0, ready: t0, end: Infinity, active: 0 })
  const alive = () => { let c = 0; for (const r of reps) if (r.end === Infinity) c++; return c }

  // Completion min-heap on parallel arrays.
  const hT: number[] = [], hR: Replica[] = []
  const push = (t: number, r: Replica) => {
    let i = hT.length
    hT.push(t); hR.push(r)
    while (i > 0) { const pa = (i - 1) >> 1; if (hT[pa] <= hT[i]) break; [hT[pa], hT[i]] = [hT[i], hT[pa]]; [hR[pa], hR[i]] = [hR[i], hR[pa]]; i = pa }
  }
  const pop = () => {
    const r = hR[0]
    const lt = hT.pop()!, lr = hR.pop()!
    if (hT.length) {
      hT[0] = lt; hR[0] = lr
      let i = 0
      for (;;) {
        const l = 2 * i + 1, rr = l + 1
        let m = i
        if (l < hT.length && hT[l] < hT[m]) m = l
        if (rr < hT.length && hT[rr] < hT[m]) m = rr
        if (m === i) break
        ;[hT[m], hT[i]] = [hT[i], hT[m]]; [hR[m], hR[i]] = [hR[i], hR[m]]; i = m
      }
    }
    return r
  }

  const queue: number[] = []
  let qh = 0
  let inflight = 0
  const lat = new Float64Array(n), wait = new Float64Array(n)
  const coldFlags = opts.perRequest ? new Uint8Array(n) : undefined
  let coldHits = 0, scaleUps = 0, maxQueue = 0, peak = minR
  const samples: number[] = []
  let sampleSum = 0
  const sampleN = Math.max(1, Math.round(win / TICK_MS))
  let belowSince: number | null = null

  const nb = wantSeries ? Math.max(1, Math.ceil((tEnd - t0 + 1) / bucket)) : 0
  const bQ = new Float64Array(nb), bN = new Float64Array(nb), bW = new Float64Array(nb)
  const bLat: number[][] = wantSeries ? Array.from({ length: nb }, () => []) : []
  const bi = (t: number) => Math.min(nb - 1, Math.max(0, Math.floor((t - t0) / bucket)))

  const startReplica = (now: number) => { reps.push({ start: now, ready: now + cold, end: Infinity, active: 0 }); scaleUps++ }

  const dispatch = (now: number) => {
    while (qh < queue.length) {
      let best = -1
      for (let i = 0; i < reps.length; i++) {
        const r = reps[i]
        if (r.end !== Infinity || r.ready > now || r.active >= C) continue
        if (best < 0 || r.active < reps[best].active) best = i
      }
      if (best < 0) return
      const j = queue[qh++]
      const rep = reps[best]
      rep.active++
      inflight++
      const w = now - jobs[j].t
      wait[j] = w
      lat[j] = w + jobs[j].s
      if (rep.ready > jobs[j].t) { coldHits++; if (coldFlags) coldFlags[j] = 1 }
      push(now + jobs[j].s, rep)
      if (wantSeries) { const b = bi(jobs[j].t); bLat[b].push(lat[j]); bN[b]++; bW[b] += w }
    }
    if (qh > 4096 && qh * 2 > queue.length) { queue.splice(0, qh); qh = 0 }
  }

  let i = 0
  let nextTick = t0 + TICK_MS
  let now = t0
  for (;;) {
    const ta = i < n ? jobs[i].t : Infinity
    const tc = hT.length ? hT[0] : Infinity
    let tr = Infinity
    for (const r of reps) if (r.end === Infinity && r.ready > now && r.ready < tr) tr = r.ready
    const pending = i < n || hT.length > 0 || qh < queue.length
    if (!pending) break
    const tt = nextTick
    now = Math.min(ta, tc, tr, tt)
    if (now === tc) {
      const r = pop()
      r.active--
      inflight--
      dispatch(now)
    } else if (now === ta) {
      queue.push(i++)
      if (alive() === 0) startReplica(now)
      dispatch(now)
      const ql = queue.length - qh
      if (ql > maxQueue) maxQueue = ql
    } else if (now === tr) {
      dispatch(now)
    } else {
      nextTick += TICK_MS
      const load = inflight + (queue.length - qh)
      samples.push(load); sampleSum += load
      if (samples.length > sampleN) sampleSum -= samples.shift()!
      const want = Math.min(maxR, Math.max(minR, Math.ceil(sampleSum / samples.length / (C * util) - 1e-9), load > 0 ? 1 : 0))
      const have = alive()
      if (want > have) { for (let k = have; k < want; k++) startReplica(now); belowSince = null }
      else if (want < have) {
        if (belowSince === null) belowSince = now
        else if (now - belowSince >= delay) {
          // Remove idle replicas, booting ones first, then the most recently started.
          let extra = have - want
          for (let k = reps.length - 1; k >= 0 && extra > 0; k--) if (reps[k].end === Infinity && reps[k].active === 0 && reps[k].ready > now) { reps[k].end = now; extra-- }
          for (let k = reps.length - 1; k >= 0 && extra > 0; k--) if (reps[k].end === Infinity && reps[k].active === 0) { reps[k].end = now; extra-- }
          belowSince = null
          retire()
        }
      } else belowSince = null
      const a = alive()
      if (a > peak) peak = a
      if (wantSeries) {
        const b = bi(now)
        bQ[b] = Math.max(bQ[b], queue.length - qh)
      }
    }
  }

  // Bill until the end of the window (or last completion), including min replicas through quiet periods.
  // Replicas above the minimum after the last request go away once the scale-down delay passes.
  let extra = alive() - minR
  for (let k = reps.length - 1; k >= 0 && extra > 0; k--) if (reps[k].end === Infinity) { reps[k].end = Math.max(now, reps[k].ready) + delay; extra-- }
  const billEnd = Math.max(tEnd, now)
  let ms = deadMs
  // With an explicit window the next window picks up the tail; otherwise those replicas bill until they scale down.
  const billedTo = (r: Replica) => r.end !== Infinity && opts.end === undefined ? r.end : Math.min(r.end, billEnd)
  for (const r of reps) ms += Math.max(0, billedTo(r) - r.start)
  const replicaHours = ms / 3_600_000
  const sl = lat.slice().sort(), sw = wait.slice().sort()
  let ws = 0
  for (let k = 0; k < n; k++) ws += wait[k]
  const cost = replicaHours * p.gpuHourly

  const series: SimPoint[] = []
  if (wantSeries) {
    const spans = [...gone, ...reps].map(r => ({ start: r.start, ready: r.ready, end: billedTo(r) }))
    const last = spans.reduce((m, r) => Math.max(m, r.end), Math.max(tEnd, now))
    // Without an explicit end the replicas left after the last request are billed until they go: show that tail as well (bounded, in case the policy never catches up).
    const ns = opts.end === undefined ? Math.max(nb, Math.min(nb + 2000, Math.ceil((last - t0) / bucket))) : nb
    const replicas = timeline(spans.map(r => [r.start, r.end]), t0, bucket, ns, last)
    const ready = timeline(spans.map(r => [r.ready, r.end]), t0, bucket, ns, last)
    for (let b = 0; b < ns; b++) {
      const l = (bLat[b] ?? []).sort((x, y) => x - y)
      series.push({ t: t0 + b * bucket, replicas: replicas.avg[b], ready: ready.avg[b], peak: replicas.peak[b], queue: bQ[b] ?? 0, n: bN[b] ?? 0, p95: l.length ? pct(l, 0.95) : NaN, wait: bN[b] ? bW[b] / bN[b] : 0 })
    }
  }
  return {
    n, p50: pct(sl, 0.5), p95: pct(sl, 0.95), p99: pct(sl, 0.99),
    meanWaitMs: n ? ws / n : 0, p95WaitMs: pct(sw, 0.95), p99WaitMs: pct(sw, 0.99), maxQueue,
    coldHits, coldRate: n ? coldHits / n : 0, replicaHours, cost, costPer1k: n ? cost / n * 1000 : NaN,
    peakReplicas: peak, scaleUps, hours: (billEnd - t0) / 3_600_000, series,
    ...(opts.perRequest ? { waits: wait, coldFlags } : {}),
  }
}

/** How many of the [from, to) intervals are open in each of n buckets: on average over the part of the bucket before `last`, and at most. */
function timeline(intervals: [number, number][], t0: number, bucket: number, n: number, last: number): { avg: Float64Array; peak: Float64Array } {
  const avg = new Float64Array(n), peak = new Float64Array(n)
  const ev: [number, number][] = []
  for (const [from, to] of intervals) if (to > from) ev.push([from, 1], [to, -1])
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]) // at one instant, ends before starts
  let open = 0, e = 0
  for (let b = 0; b < n; b++) {
    const lo = t0 + b * bucket, hi = lo + bucket
    const cover = Math.min(hi, last) - lo
    // The bucket that starts at the window's end has no width: it repeats the count up to there.
    if (cover <= 0) { avg[b] = peak[b] = lo === last ? openAt(intervals, last) : 0; continue }
    while (e < ev.length && ev[e][0] <= lo) open += ev[e++][1]
    let area = 0, at = lo, top = open
    for (; e < ev.length && ev[e][0] < hi; e++) {
      area += open * (ev[e][0] - at); at = ev[e][0]
      open += ev[e][1]
      top = Math.max(top, open)
    }
    avg[b] = (area + open * (lo + cover - at)) / cover
    peak[b] = top
  }
  return { avg, peak }
}
const openAt = (intervals: [number, number][], t: number) => intervals.reduce((c, [from, to]) => c + (from < t && to >= t ? 1 : 0), 0)

export interface SweepCell { minReplicas: number; scaleDownDelaySec: number; r: SimResult }

export const SWEEP_MINS = [0, 1, 2, 3, 4]
export const SWEEP_DELAYS = [60, 300, 900, 1800, 3600]

export function sweep(jobs: Job[], base: Policy, mins = SWEEP_MINS, delays = SWEEP_DELAYS, opts: { start?: number; end?: number } = {}): SweepCell[] {
  const out: SweepCell[] = []
  for (const m of mins) for (const d of delays) {
    const p = { ...base, minReplicas: m, maxReplicas: Math.max(base.maxReplicas, m), scaleDownDelaySec: d }
    out.push({ minReplicas: m, scaleDownDelaySec: d, r: simulate(jobs, p, { ...opts, series: false }) })
  }
  return out
}

/** Indices of points not dominated on (lower cost, lower p99), sorted by cost. */
export function pareto(points: { cost: number; p99: number }[]): number[] {
  const idx = points.map((_, i) => i).sort((a, b) => points[a].cost - points[b].cost || points[a].p99 - points[b].p99)
  const out: number[] = []
  let best = Infinity
  for (const i of idx) if (points[i].p99 < best) { out.push(i); best = points[i].p99 }
  return out
}
