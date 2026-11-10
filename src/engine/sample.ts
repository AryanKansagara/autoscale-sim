import type { Policy, Req } from './types.ts'
import { rng } from './stats.ts'

export interface SampleDef { id: string; name: string; blurb: string; gpu: string; policy: Policy }

export const SAMPLES: SampleDef[] = [
  {
    id: 'chat-llm', name: 'Chat LLM endpoint', gpu: 'H100',
    blurb: '7 days of a 70B chat model: diurnal traffic, quiet nights, a nightly batch job at 02:00 UTC.',
    policy: { minReplicas: 0, maxReplicas: 6, concurrency: 8, targetUtil: 0.7, windowSec: 60, scaleDownDelaySec: 900, coldStartSec: 75, gpuHourly: 6.5 },
  },
  {
    id: 'image-gen', name: 'Image model, spiky', gpu: 'A100',
    blurb: '7 days of an SDXL-style endpoint: a trickle of traffic with sudden campaign spikes.',
    policy: { minReplicas: 0, maxReplicas: 8, concurrency: 1, targetUtil: 0.8, windowSec: 60, scaleDownDelaySec: 300, coldStartSec: 45, gpuHourly: 4.0 },
  },
]

// Samples start on a fixed Monday so they are identical for everyone.
export const SAMPLE_START = Date.UTC(2026, 9, 26)
const DAY = 86_400_000

function poisson(r: () => number, lambda: number) {
  // Knuth for small lambda, normal approximation for large.
  if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * gauss(r)))
  const L = Math.exp(-lambda)
  let k = 0, p = 1
  do { k++; p *= r() } while (p > L)
  return k - 1
}
function gauss(r: () => number) { return Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r()) }
const logn = (r: () => number, med: number, sigma: number) => med * Math.exp(sigma * gauss(r))

/**
 * Logs as a scale-to-zero deployment would have produced them: requests after a long idle gap pay a
 * cold start, which is what the detector and simulator have to find.
 */
export function generate(id: string): Req[] {
  const r = rng(id === 'chat-llm' ? 42 : 99)
  const out: Req[] = []
  const days = 7
  const chat = id === 'chat-llm'
  // Arrival rates per minute.
  for (let m = 0; m < days * 1440; m++) {
    const day = Math.floor(m / 1440), mod = m % 1440, h = mod / 60
    const weekend = day >= 5
    let rate: number
    if (chat) {
      const diurnal = Math.max(0, Math.sin(((h - 8) / 24) * 2 * Math.PI)) ** 1.6
      rate = (weekend ? 26 : 60) * diurnal + 0.05
      if (h >= 2 && h < 2.25 && !weekend) rate += 200 // nightly batch eval job
    } else {
      rate = 0.9 + 1.6 * Math.max(0, Math.sin(((h - 10) / 24) * 2 * Math.PI))
      if (h >= 0 && h < 6) rate *= 0.2
    }
    let k = poisson(r, rate)
    for (let j = 0; j < k; j++) out.push(make(r, SAMPLE_START + m * 60000 + r() * 60000, chat))
    k = 0
  }
  if (!chat) {
    // Campaign spikes: 3 to 5 per day, 2 to 6 minutes at 8 to 20 requests a minute.
    for (let d = 0; d < days; d++) {
      const n = 3 + Math.floor(r() * 3)
      for (let s = 0; s < n; s++) {
        const start = SAMPLE_START + d * DAY + (8 + r() * 14) * 3_600_000
        const len = 2 + r() * 4, per = 8 + r() * 12
        const total = Math.round(len * per)
        for (let j = 0; j < total; j++) out.push(make(r, start + r() * len * 60000, false))
      }
    }
  }
  out.sort((a, b) => a.t - b.t)
  // Cold starts and queueing as the real (scale-to-zero, scale-down 15 min) deployment saw them.
  const idle = (chat ? 900 : 300) * 1000
  const coldMs = chat ? 75000 : 45000
  let lastEnd = -Infinity
  for (const q of out) {
    if (q.t - lastEnd > idle) { q.lat += coldMs * (0.85 + r() * 0.3); if (q.ttft !== undefined) q.ttft += coldMs; if (q.lat > 120000) { q.ok = false; q.timeout = true; q.status = 504 } }
    lastEnd = Math.max(lastEnd, q.t + q.lat)
    q.t = Math.round(q.t); q.lat = Math.round(q.lat); if (q.ttft !== undefined) q.ttft = Math.round(q.ttft)
  }
  return out
}

function make(r: () => number, t: number, chat: boolean): Req {
  if (chat) {
    const inTok = Math.round(logn(r, 900, 0.8)), outTok = Math.max(2, Math.round(logn(r, 260, 0.7)))
    const ttft = 180 + inTok * 0.12 + logn(r, 60, 0.5)
    const tps = Math.max(8, 42 + 6 * gauss(r))
    const fail = r() < 0.004
    return { t, lat: ttft + (outTok - 1) / tps * 1000, ttft, ok: !fail, status: fail ? (r() < 0.5 ? 500 : 429) : 200, inTok, outTok, replica: `chat-${1 + Math.floor(r() * 3)}` }
  }
  const lat = logn(r, 3200, 0.18)
  const fail = r() < 0.006
  return { t, lat, ok: !fail, status: fail ? 500 : 200, inTok: 77, outTok: 1, replica: `img-${1 + Math.floor(r() * 4)}` }
}
