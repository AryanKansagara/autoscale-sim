import type { Req } from './types.ts'

/** Deterministic PRNG so bootstraps and samples are reproducible. */
export function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Linear-interpolated percentile of an ascending array, p in 0..1. */
export function pct(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length
  if (!n) return NaN
  const x = (n - 1) * Math.min(1, Math.max(0, p))
  const lo = Math.floor(x), hi = Math.ceil(x)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (x - lo)
}

export const sortNum = (a: ArrayLike<number>) => Float64Array.from(a).sort()
export const mean = (a: ArrayLike<number>) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return a.length ? s / a.length : NaN }

/**
 * Percentile bootstrap CI. Each resample is drawn as counts over the sorted sample, so finding the
 * resample's percentile is a single cumulative walk instead of a sort (O(n) per iteration).
 */
export function bootstrapCI(sorted: ArrayLike<number>, p: number, iters = 200, level = 0.95, seed = 7): [number, number] {
  const n = sorted.length
  if (n < 2) return [NaN, NaN]
  const r = rng(seed)
  const counts = new Uint32Array(n)
  const est: number[] = []
  const target = Math.max(1, Math.ceil(p * n))
  for (let it = 0; it < iters; it++) {
    counts.fill(0)
    for (let j = 0; j < n; j++) counts[(r() * n) | 0]++
    let c = 0, i = 0
    while (i < n && (c += counts[i]) < target) i++
    est.push(sorted[Math.min(i, n - 1)])
  }
  est.sort((a, b) => a - b)
  const a = (1 - level) / 2
  return [pct(est, a), pct(est, 1 - a)]
}

export interface LatencyStats { n: number; p50: number; p90: number; p95: number; p99: number; ci95: [number, number]; ci99: [number, number]; mean: number; max: number }

export function latencyStats(values: number[], iters = 200): LatencyStats {
  const s = sortNum(values)
  return { n: s.length, p50: pct(s, 0.5), p90: pct(s, 0.9), p95: pct(s, 0.95), p99: pct(s, 0.99), ci95: bootstrapCI(s, 0.95, iters), ci99: bootstrapCI(s, 0.99, iters, 0.95, 11), mean: mean(s), max: s[s.length - 1] ?? NaN }
}

/** Splits latency into prefill (TTFT) and decode speed, for requests that report TTFT and output tokens. */
export function tokenSplit(reqs: Req[]) {
  const ttft: number[] = [], tps: number[] = [], perTok: number[] = []
  for (const r of reqs) {
    if (!r.ok || r.ttft === undefined) continue
    ttft.push(r.ttft)
    if (r.outTok && r.outTok > 1 && r.lat > r.ttft) {
      const decodeS = (r.lat - r.ttft) / 1000
      tps.push((r.outTok - 1) / decodeS)
      perTok.push((r.lat - r.ttft) / (r.outTok - 1))
    }
  }
  const st = sortNum(ttft), sp = sortNum(tps), sk = sortNum(perTok)
  return { n: st.length, ttftP50: pct(st, 0.5), ttftP95: pct(st, 0.95), tpsP50: pct(sp, 0.5), tpsP10: pct(sp, 0.1), msPerTokP50: pct(sk, 0.5), withTokens: sp.length }
}

export function errorStats(reqs: Req[], timeoutMs = Infinity) {
  let err = 0, to = 0
  for (const r of reqs) {
    const t = r.timeout || r.lat >= timeoutMs
    if (t) to++
    if (!r.ok || t) err++
  }
  return { n: reqs.length, errors: err, timeouts: to, errorRate: reqs.length ? err / reqs.length : 0, timeoutRate: reqs.length ? to / reqs.length : 0 }
}

export interface ColdStarts {
  /** Indices into reqs of requests flagged as cold starts. */
  idx: number[]
  gaps: number
  medianLat: number
  /** Median extra latency of flagged requests over the warm median, ms. */
  penaltyMs: number
}

/**
 * A cold start is a request that arrives after an idle gap and is a latency outlier: at least
 * `factor` times the warm median and at least `minPenaltyMs` slower. The idle gap is global
 * (scale to zero idles the whole deployment); with replica ids it is per replica as well.
 */
export function detectColdStarts(reqs: Req[], gapSec = 300, factor = 3, minPenaltyMs = 2000): ColdStarts {
  const ok = sortNum(reqs.filter(r => r.ok).map(r => r.lat))
  const med = pct(ok, 0.5)
  const idx: number[] = []
  let gaps = 0
  const lastByReplica = new Map<string, number>()
  for (let i = 0; i < reqs.length; i++) {
    const r = reqs[i]
    const prevT = i ? reqs[i - 1].t + reqs[i - 1].lat : -Infinity
    const globalGap = i > 0 && r.t - prevT >= gapSec * 1000
    const repPrev = r.replica ? lastByReplica.get(r.replica) : undefined
    const repGap = !globalGap && repPrev === undefined && r.replica !== undefined && i > 0
    if (r.replica) lastByReplica.set(r.replica, r.t + r.lat)
    if (!globalGap && !repGap) continue
    gaps++
    if (r.lat >= med * factor && r.lat - med >= minPenaltyMs) idx.push(i)
  }
  const pen = sortNum(idx.map(i => reqs[i].lat - med))
  return { idx, gaps, medianLat: med, penaltyMs: pct(pen, 0.5) }
}

/** Requests per bucket from the first request's bucket to the last. */
export function arrivalSeries(reqs: Req[], bucketSec = 60): { t0: number; bucketSec: number; counts: number[] } {
  if (!reqs.length) return { t0: 0, bucketSec, counts: [] }
  const b = bucketSec * 1000
  const t0 = Math.floor(reqs[0].t / b) * b
  const counts = new Array(Math.floor((reqs[reqs.length - 1].t - t0) / b) + 1).fill(0)
  for (const r of reqs) counts[Math.floor((r.t - t0) / b)]++
  return { t0, bucketSec, counts }
}

export function burstiness(reqs: Req[]) {
  const s = arrivalSeries(reqs, 60)
  const m = mean(s.counts)
  const peak = s.counts.reduce((a, b) => Math.max(a, b), 0)
  const gaps: number[] = []
  for (let i = 1; i < reqs.length; i++) gaps.push((reqs[i].t - reqs[i - 1].t) / 1000)
  const gm = mean(gaps)
  let v = 0
  for (const g of gaps) v += (g - gm) ** 2
  const sd = gaps.length > 1 ? Math.sqrt(v / (gaps.length - 1)) : NaN
  const spanS = reqs.length > 1 ? (reqs[reqs.length - 1].t - reqs[0].t) / 1000 : 0
  return { perMinMean: m, perMinPeak: peak, peakToMean: m ? peak / m : NaN, interArrivalCv: gm ? sd / gm : NaN, meanRps: spanS ? (reqs.length - 1) / spanS : NaN }
}
