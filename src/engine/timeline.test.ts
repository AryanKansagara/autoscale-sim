import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_POLICY } from './actions.ts'
import { generate, SAMPLES } from './sample.ts'
import { simulate, toJobs, type Job, type SimResult } from './sim.ts'
import { rng } from './stats.ts'

const DAY0 = Date.UTC(2026, 2, 2)
const at = (h: number, m = 0) => DAY0 + (h * 60 + m) * 60_000
const tiny: Job[] = [at(2), at(2, 10), at(12)].map(t => ({ t, s: 1000 }))
const day = { start: DAY0, end: DAY0 + 86_400_000, bucketSec: 300 }
const area = (r: SimResult, bucketSec: number) => r.series.reduce((s, p) => s + p.replicas * bucketSec, 0)

test('timeline: replicas go to 0 after the scale-down delay and come back for the next request (#6)', () => {
  const r = simulate(tiny, DEFAULT_POLICY, day)
  const bucket = (h: number, m: number) => r.series[(h * 60 + m) / 5]
  assert.deepEqual([bucket(1, 55).replicas, bucket(1, 55).peak], [0, 0])
  // Boot 02:00 to 02:01, up until 02:26 (660 s + the 900 s delay, see e2e/replay.spec.ts).
  assert.deepEqual([bucket(2, 0).replicas, bucket(2, 0).ready, bucket(2, 0).peak], [1, 0.8, 1])
  for (const m of [5, 10, 15, 20]) assert.deepEqual([bucket(2, m).replicas, bucket(2, m).ready], [1, 1])
  assert.deepEqual([bucket(2, 25).replicas, bucket(2, 25).peak], [0.2, 1])
  for (let b = (2 * 60 + 30) / 5; b < 12 * 12; b++) assert.deepEqual([r.series[b].replicas, r.series[b].ready, r.series[b].peak], [0, 0, 0])
  // The last request: 61 s + 900 s.
  assert.deepEqual([bucket(12, 0).replicas, bucket(12, 0).ready], [1, 0.8])
  assert.ok(Math.abs(bucket(12, 15).replicas - 61 / 300) < 1e-9)
  for (let b = (12 * 60 + 20) / 5; b < r.series.length; b++) assert.equal(r.series[b].replicas, 0)
  assert.ok(Math.abs(area(r, 300) - 2521) < 1e-6)
})

test('timeline: the area under replicas is the billed time, within one bucket (#6)', () => {
  for (const bucketSec of [60, 300, 1800]) for (const scaleDownDelaySec of [0, 60, 900, 3600]) for (const minReplicas of [0, 1]) {
    const r = simulate(tiny, { ...DEFAULT_POLICY, scaleDownDelaySec, minReplicas }, { ...day, bucketSec })
    assert.ok(Math.abs(area(r, bucketSec) - r.replicaHours * 3600) <= bucketSec + 1e-6, `${bucketSec} s, delay ${scaleDownDelaySec}, min ${minReplicas}: ${area(r, bucketSec)} vs ${r.replicaHours * 3600}`)
  }
  // Random bursts that need several replicas, done well before midnight (midnight itself is the closing bucket).
  const rand = rng(3)
  for (let k = 0; k < 20; k++) {
    const jobs = Array.from({ length: 200 }, () => ({ t: at(1) + Math.floor(rand() * 8 * 3_600_000), s: 1000 + rand() * 120_000 })).sort((a, b) => a.t - b.t)
    const r = simulate(jobs, { ...DEFAULT_POLICY, concurrency: 1, maxReplicas: 6, scaleDownDelaySec: Math.floor(rand() * 1200) }, day)
    assert.ok(Math.abs(area(r, 300) - r.replicaHours * 3600) < 1e-3)
    assert.equal(Math.max(...r.series.map(s => s.peak)) >= r.peakReplicas, true)
    for (const s of r.series) assert.ok(s.ready <= s.replicas + 1e-9 && s.replicas <= s.peak + 1e-9)
  }
})

test('timeline: without an explicit end it runs on to the last billed second (#6)', () => {
  const r = simulate(tiny, DEFAULT_POLICY, { bucketSec: 300 })
  assert.ok(Math.abs(r.replicaHours * 3600 - 2521) < 1e-6)
  assert.ok(Math.abs(area(r, 300) - 2521) <= 300)
  assert.equal(r.series.at(-1)!.t, at(12, 15))
})

test('timeline: sample endpoints agree with their billed replica-hours over the whole log (#6)', () => {
  for (const s of SAMPLES.filter(s => !s.source)) {
    const jobs = toJobs(generate(s.id))
    const r = simulate(jobs, s.policy, { bucketSec: 1800 })
    const top = Math.max(...r.series.map(p => p.peak))
    assert.ok(Math.abs(area(r, 1800) - r.replicaHours * 3600) <= 1800 * r.series.at(-1)!.replicas + 1, s.id)
    assert.equal(top, r.peakReplicas, s.id)
  }
})
