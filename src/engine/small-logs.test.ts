import { test } from 'node:test'
import assert from 'node:assert/strict'
import { arrivalPattern, burstiness, fixed } from './stats.ts'
import type { Req } from './types.ts'

const at = (...secs: number[]): Req[] => secs.map(s => ({ t: Date.UTC(2026, 2, 2) + s * 1000, lat: 1000, ok: true }))

test('logs without an inter-arrival CV show a dash and claim no arrival pattern (#3)', () => {
  for (const secs of [[0], [0, 0], [0, 600], [0, 0, 0]]) {
    const { interArrivalCv: cv, meanRps } = burstiness(at(...secs))
    assert.equal(fixed(cv, 2), '—', String(secs))
    assert.match(arrivalPattern(cv), /^Not enough requests/)
    assert.doesNotMatch(fixed(meanRps, 2), /NaN/)
  }
  assert.equal(fixed(burstiness(at(0)).meanRps, 2), '—')
})

test('logs with a CV are described as before (#3)', () => {
  assert.match(arrivalPattern(burstiness(at(0, 10, 20)).interArrivalCv), /^Very regular/)
  assert.equal(fixed(burstiness(at(0, 10, 20)).interArrivalCv, 2), '0.00')
  assert.match(arrivalPattern(0.8), /^Very regular/)
  assert.match(arrivalPattern(0.81), /^Roughly random/)
  assert.match(arrivalPattern(1.5), /^Roughly random/)
  assert.match(arrivalPattern(1.51), /^Bursty/)
  assert.equal(fixed(0, 2), '0.00')
  assert.equal(fixed(1.005, 1), '1.0')
})
