import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_POLICY } from './engine/actions.ts'
import { simulate, toJobs } from './engine/sim.ts'
import type { Req } from './engine/types.ts'
import { EXPERIMENT_CALC, experiment, isLegacyExperiment, replay, sliceJobs } from './projectData.ts'

const req = (iso: string, lat = 1000): Req => ({ t: Date.parse(iso), lat, ok: true })
// The tiny trace from issue #4: three requests on 2026-03-02, 02:00, 02:10 and 12:00 UTC.
const tiny = [req('2026-03-02T02:00:00Z'), req('2026-03-02T02:10:00Z'), req('2026-03-02T12:00:00Z')]
const policy = { ...DEFAULT_POLICY, minReplicas: 1 }

test('a single-day experiment equals the replay of that day, whole-day window included (#4)', () => {
  const jobs = toJobs(tiny)
  const shown = replay(jobs, tiny, '2026-03-02', policy)
  const saved = experiment(jobs, tiny, policy, 'x', '2026-03-02').result
  assert.equal(shown.replicaHours, 24)
  assert.equal(shown.cost, 156)
  for (const k of Object.keys(saved) as (keyof typeof saved)[]) assert.equal(saved[k], shown[k], k)
})

test('replay is the same calculation as simulating the sliced jobs over the day bounds (#4)', () => {
  const jobs = toJobs(tiny)
  const s = sliceJobs(jobs, '2026-03-02', tiny)
  const direct = simulate(s.jobs, policy, { start: s.start, end: s.end })
  const viaReplay = replay(jobs, tiny, '2026-03-02', policy)
  assert.deepEqual({ ...viaReplay, series: [] }, { ...direct, series: [] })
})

test('experiment and replay agree for several policies and for the all-days range (#4)', () => {
  const day = (d: number, h: number) => req(new Date(Date.UTC(2026, 2, d, h)).toISOString())
  const reqs = [day(2, 3), day(2, 3), day(2, 20), day(3, 1), day(3, 23), day(4, 12)]
  const jobs = toJobs(reqs)
  for (const range of ['all', '2026-03-02', '2026-03-03', '2026-03-04'])
    for (const p of [DEFAULT_POLICY, policy, { ...policy, minReplicas: 2, scaleDownDelaySec: 60 }]) {
      const shown = replay(jobs, reqs, range, p)
      const saved = experiment(jobs, reqs, p, 'x', range).result
      assert.equal(saved.cost, shown.cost, `${range} cost`)
      assert.equal(saved.replicaHours, shown.replicaHours, `${range} replica-hours`)
      assert.equal(saved.p99, shown.p99, `${range} p99`)
      assert.equal(saved.coldHits, shown.coldHits, `${range} cold hits`)
    }
})

test('all days: the tail after the last request is billed until the scale-down delay, as Docs says (#4)', () => {
  const r = replay(toJobs(tiny), tiny, 'all', DEFAULT_POLICY)
  assert.ok(Math.abs(r.replicaHours - 2521 / 3600) < 1e-9) // worked by hand in e2e/replay.spec.ts
})

test('new experiments carry the calculation version; older single-day ones are flagged, all-days ones are not (#4)', () => {
  assert.equal(experiment(toJobs(tiny), tiny, policy, 'x', '2026-03-02').calc, EXPERIMENT_CALC)
  const base = { range: '2026-03-02' }
  assert.equal(isLegacyExperiment(base), true)
  assert.equal(isLegacyExperiment({ ...base, calc: EXPERIMENT_CALC }), false)
  assert.equal(isLegacyExperiment({ range: 'all' }), false)
})
