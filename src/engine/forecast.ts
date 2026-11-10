import type { Policy, Req } from './types.ts'
import { mean } from './stats.ts'

const H = 3_600_000
const D = 24 * H

/** Requests per UTC hour over whole days, plus the peak minute of each hour. */
export function hourly(reqs: Req[]) {
  if (!reqs.length) return { day0: 0, days: 0, counts: [] as number[], peakMin: [] as number[] }
  const day0 = Math.floor(reqs[0].t / D) * D
  const days = Math.floor((reqs[reqs.length - 1].t - day0) / D) + 1
  const counts = new Array(days * 24).fill(0)
  const mins = new Map<number, number>()
  for (const r of reqs) {
    counts[Math.floor((r.t - day0) / H)]++
    const m = Math.floor((r.t - day0) / 60000)
    mins.set(m, (mins.get(m) ?? 0) + 1)
  }
  const peakMin = new Array(days * 24).fill(0)
  for (const [m, c] of mins) { const h = Math.floor(m / 60); if (c > peakMin[h]) peakMin[h] = c }
  return { day0, days, counts, peakMin }
}

/** Same hour on the previous day, or on the same weekday last week once a full week of data exists. */
export function seasonalNaive(counts: number[], days: number): number[] {
  const lag = days >= 7 ? 7 : 1
  return Array.from({ length: 24 }, (_, h) => counts[(days - lag) * 24 + h] ?? 0)
}

/** EWMA across days for each hour of the day. */
export function ewmaByHour(counts: number[], days: number, alpha = 0.4): number[] {
  return Array.from({ length: 24 }, (_, h) => {
    let s = counts[h]
    for (let d = 1; d < days; d++) s = alpha * counts[d * 24 + h] + (1 - alpha) * s
    return s
  })
}

const mae = (a: number[], b: number[]) => mean(a.map((x, i) => Math.abs(x - b[i])))

export interface Forecast {
  method: 'seasonal-naive' | 'ewma'
  hours: { h: number; naive: number; ewma: number; value: number; peakFactor: number }[]
  backtest: { naive: number; ewma: number } | null
  /** Start of the forecast day (ms, UTC). */
  day: number
  /** Whole days of history used. */
  days: number
}

/**
 * Forecasts the next UTC day hour by hour. The last full day is held out to backtest both methods
 * (mean absolute error per hour); the better one is used. Needs 2+ days, 3+ to backtest.
 */
export function forecastTomorrow(reqs: Req[], alpha = 0.4): Forecast | null {
  const hr = hourly(reqs)
  // Ignore a partial last day.
  const last = reqs.length ? reqs[reqs.length - 1].t : 0
  const full = last - hr.day0 >= hr.days * D - H ? hr.days : hr.days - 1
  if (full < 2) return null
  const c = hr.counts.slice(0, full * 24)
  let backtest: Forecast['backtest'] = null
  if (full >= 3) {
    const hold = c.slice((full - 1) * 24)
    const prior = c.slice(0, (full - 1) * 24)
    backtest = { naive: mae(seasonalNaive(prior, full - 1), hold), ewma: mae(ewmaByHour(prior, full - 1, alpha), hold) }
  }
  const naive = seasonalNaive(c, full), ew = ewmaByHour(c, full, alpha)
  const method = backtest && backtest.naive < backtest.ewma ? 'seasonal-naive' : 'ewma'
  // Peak-minute factor per hour of day: busiest minute vs the hour's average minute.
  const pf = Array.from({ length: 24 }, (_, h) => {
    const f: number[] = []
    for (let d = 0; d < full; d++) { const n = c[d * 24 + h]; if (n >= 10) f.push(hr.peakMin[d * 24 + h] / (n / 60)) }
    return f.length ? Math.max(1, mean(f)) : 2
  })
  return {
    method, backtest, day: hr.day0 + full * D, days: full,
    hours: naive.map((nv, h) => ({ h, naive: nv, ewma: ew[h], value: method === 'ewma' ? ew[h] : nv, peakFactor: pf[h] })),
  }
}

export interface PrewarmBlock { fromH: number; toH: number; minReplicas: number }

/**
 * Replicas needed per hour so the expected peak minute fits without a scale-up:
 * concurrency = peak rate * mean service time (Little's law), divided by per-replica capacity.
 */
export function prewarm(f: Forecast, p: Policy, meanServiceMs: number): { perHour: number[]; blocks: PrewarmBlock[] } {
  const cap = Math.max(1, p.concurrency) * Math.min(1, Math.max(0.05, p.targetUtil))
  const perHour = f.hours.map(x => {
    const peakRps = x.value / 3600 * x.peakFactor
    const conc = peakRps * meanServiceMs / 1000
    const need = conc < 0.05 ? 0 : Math.ceil(conc / cap - 1e-9)
    return Math.min(p.maxReplicas, Math.max(0, need))
  })
  const blocks: PrewarmBlock[] = []
  for (let h = 0; h < 24; h++) {
    const b = blocks[blocks.length - 1]
    if (b && b.minReplicas === perHour[h]) b.toH = h + 1
    else blocks.push({ fromH: h, toH: h + 1, minReplicas: perHour[h] })
  }
  return { perHour, blocks }
}
