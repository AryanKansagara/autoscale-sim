import { test } from 'node:test'
import assert from 'node:assert/strict'
import { autoMap, detectFormat, guessUnit, mergeReqs, parseCsv, parseJsonl, parseStatus, reqsToCsv, validate } from './parse.ts'
import { arrivalSeries, bootstrapCI, burstiness, detectColdStarts, errorStats, latencyStats, pct, rng, sortNum, tokenSplit } from './stats.ts'
import { pareto, simulate, sweep, toJobs, type Job } from './sim.ts'
import { ewmaByHour, forecastTomorrow, prewarm, seasonalNaive } from './forecast.ts'
import { checkSlo, configJson, configYaml, DEFAULT_POLICY, DEFAULT_SLO, prewarmCron, recommend } from './actions.ts'
import { generate, SAMPLES } from './sample.ts'
import type { Policy, Req } from './types.ts'

const P = (o: Partial<Policy> = {}): Policy => ({ ...DEFAULT_POLICY, minReplicas: 1, maxReplicas: 1, concurrency: 1, targetUtil: 1, coldStartSec: 0, gpuHourly: 1, ...o })
const T0 = Date.UTC(2026, 0, 5)

// ---------- Parsing ----------

test('plain CSV maps the obvious columns and parses requests', () => {
  const csv = parseCsv('timestamp,latency_ms,ttft_ms,status,input_tokens,output_tokens,replica_id\n2026-01-05T00:00:00Z,1200,300,200,100,50,r1\n2026-01-05T00:00:01Z,900,,500,10,5,r2\n')
  const m = autoMap(csv.rows[0])
  assert.deepEqual([m.time, m.latency, m.ttft, m.status, m.inTok, m.outTok, m.replica], [0, 1, 2, 3, 4, 5, 6])
  const v = validate(csv, m)
  assert.equal(v.reqs.length, 2)
  assert.equal(v.reqs[0].ttft, 300)
  assert.equal(v.reqs[1].ok, false)
  assert.equal(detectFormat(csv.rows[0], false), 'plain')
})

test('LiteLLM spend logs: latency and TTFT come from start, end and first-token times', () => {
  const csv = parseCsv('request_id,startTime,endTime,completionStartTime,prompt_tokens,completion_tokens,status\na,2026-01-05 10:00:00.000,2026-01-05 10:00:04.500,2026-01-05 10:00:00.400,20,90,success\n')
  assert.equal(detectFormat(csv.rows[0], false), 'litellm')
  const m = autoMap(csv.rows[0])
  assert.equal(m.latency, undefined)
  const v = validate(csv, m)
  assert.equal(v.reqs[0].lat, 4500)
  assert.equal(v.reqs[0].ttft, 400)
  assert.equal(v.reqs[0].outTok, 90)
})

test('OpenAI-compatible JSONL is flattened, detected and keeps line numbers for bad records', () => {
  const text = '{"timestamp":"2026-01-05T00:00:00Z","duration_ms":800,"status":200,"response":{"usage":{"prompt_tokens":12,"completion_tokens":40}}}\nnot json\n{"timestamp":"bad","duration_ms":10,"status":200}\n'
  const j = parseJsonl(text)
  assert.deepEqual(j.bad, [2])
  assert.equal(detectFormat(j.rows[0], true), 'openai-proxy')
  const v = validate(j, autoMap(j.rows[0]))
  assert.equal(v.reqs.length, 1)
  assert.equal(v.reqs[0].outTok, 40)
  assert.equal(v.issues[0].line, 3)
  assert.equal(v.skipped, 1)
})

test('latency in seconds is detected from the header or from magnitude', () => {
  assert.equal(guessUnit('duration_s'), 's')
  assert.equal(guessUnit('latency_ms'), 'ms')
  const csv = parseCsv('time,latency\n2026-01-05T00:00:00Z,1.5\n2026-01-05T00:00:02Z,2.25\n')
  const v = validate(csv, autoMap(csv.rows[0]))
  assert.equal(v.unit, 's')
  assert.equal(v.reqs[0].lat, 1500)
})

test('validation reports line numbers for bad rows and rejects TTFT above latency', () => {
  const csv = parseCsv('time,latency_ms,ttft_ms\n2026-01-05T00:00:00Z,100,500\nyesterday,100,1\n2026-01-05T00:00:03Z,-4,1\n')
  const v = validate(csv, autoMap(csv.rows[0]), 'ms')
  assert.equal(v.reqs.length, 1)
  assert.equal(v.reqs[0].ttft, undefined)
  assert.deepEqual(v.issues.map(i => [i.line, i.level]), [[2, 'warn'], [3, 'error'], [4, 'error']])
})

test('status parsing understands codes, words and timeouts', () => {
  assert.deepEqual(parseStatus('200'), { ok: true, timeout: false, code: 200 })
  assert.equal(parseStatus('504')!.timeout, true)
  assert.equal(parseStatus('failure')!.ok, false)
  assert.equal(parseStatus('Timed_Out')!.timeout, true)
  assert.equal(parseStatus('weird'), null)
})

test('re-importing the same requests does not duplicate them, and CSV export round-trips', () => {
  const a: Req[] = [{ t: T0, lat: 100, ok: true }, { t: T0 + 1000, lat: 200, ok: false, status: 500 }]
  assert.equal(mergeReqs(a, a).length, 2)
  const csv = parseCsv(reqsToCsv(a))
  const v = validate(csv, autoMap(csv.rows[0]), 'ms')
  assert.deepEqual(v.reqs.map(r => [r.t, r.lat, r.ok]), [[T0, 100, true], [T0 + 1000, 200, false]])
})

// ---------- Statistics ----------

test('percentiles interpolate linearly', () => {
  const s = sortNum([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  assert.equal(pct(s, 0.5), 5.5)
  assert.equal(pct(s, 0), 1)
  assert.equal(pct(s, 1), 10)
  assert.ok(Math.abs(pct(s, 0.95) - 9.55) < 1e-9)
})

test('bootstrap CI brackets the true p95 and narrows with more data', () => {
  const r = rng(3)
  const draw = (n: number) => sortNum(Array.from({ length: n }, () => -Math.log(r()) * 1000))
  const truth = -Math.log(0.05) * 1000
  const small = bootstrapCI(draw(400), 0.95), big = bootstrapCI(draw(20000), 0.95)
  assert.ok(big[0] < truth && truth < big[1], `CI ${big} should contain ${truth}`)
  assert.ok(big[1] - big[0] < small[1] - small[0])
})

test('latency stats are deterministic for the same input', () => {
  const v = Array.from({ length: 500 }, (_, i) => (i * 37) % 1000)
  assert.deepEqual(latencyStats(v).ci99, latencyStats(v).ci99)
})

test('TTFT and decode speed are split per request', () => {
  const s = tokenSplit([{ t: 0, lat: 2300, ttft: 300, outTok: 101, ok: true }, { t: 1, lat: 1300, ttft: 300, outTok: 51, ok: true }, { t: 2, lat: 50, ok: false }])
  assert.equal(s.n, 2)
  assert.equal(s.tpsP50, 50)
  assert.equal(s.msPerTokP50, 20)
  assert.equal(s.ttftP50, 300)
})

test('error and timeout rates include latency over the client timeout', () => {
  const e = errorStats([{ t: 0, lat: 10, ok: true }, { t: 1, lat: 10, ok: false }, { t: 2, lat: 70000, ok: true }, { t: 3, lat: 5, ok: false, timeout: true }], 60000)
  assert.equal(e.errors, 3)
  assert.equal(e.timeouts, 2)
  assert.equal(e.errorRate, 0.75)
})

test('cold starts are slow requests after idle gaps, not every slow request', () => {
  const reqs: Req[] = []
  for (let i = 0; i < 100; i++) reqs.push({ t: T0 + i * 1000, lat: 1000, ok: true })
  reqs.push({ t: T0 + 101_000, lat: 40000, ok: true }) // slow but no gap: not cold
  reqs.push({ t: T0 + 2_000_000, lat: 61000, ok: true }) // after a 30 min gap: cold
  reqs.push({ t: T0 + 4_000_000, lat: 1100, ok: true }) // gap but warm
  const c = detectColdStarts(reqs, 300)
  assert.deepEqual(c.idx, [101])
  assert.equal(c.gaps, 2)
  assert.equal(c.penaltyMs, 60000)
})

test('burstiness: regular arrivals have CV near 0, Poisson near 1', () => {
  const regular: Req[] = Array.from({ length: 2000 }, (_, i) => ({ t: T0 + i * 1000, lat: 1, ok: true }))
  assert.ok(burstiness(regular).interArrivalCv < 0.01)
  const r = rng(5)
  let t = T0
  const pois: Req[] = Array.from({ length: 20000 }, () => ({ t: (t += -Math.log(r()) * 1000), lat: 1, ok: true }))
  const b = burstiness(pois)
  assert.ok(Math.abs(b.interArrivalCv - 1) < 0.05, `cv ${b.interArrivalCv}`)
  assert.ok(Math.abs(b.meanRps - 1) < 0.05)
})

test('arrival series buckets by minute', () => {
  const s = arrivalSeries([{ t: T0, lat: 1, ok: true }, { t: T0 + 59_000, lat: 1, ok: true }, { t: T0 + 180_000, lat: 1, ok: true }])
  assert.deepEqual(s.counts, [2, 0, 0, 1])
})

// ---------- Simulator ----------

test('one warm replica, concurrency 1: back-to-back requests queue FIFO', () => {
  const jobs: Job[] = [{ t: T0, s: 1000 }, { t: T0, s: 1000 }, { t: T0, s: 1000 }]
  const r = simulate(jobs, P())
  assert.equal(r.maxQueue, 2) // the first starts at once
  assert.equal(r.p99WaitMs > 1900, true)
  assert.equal(Math.round(r.meanWaitMs), 1000) // waits 0, 1000, 2000
  assert.equal(r.coldHits, 0)
})

test('concurrency target lets one replica serve parallel requests without waiting', () => {
  const jobs: Job[] = Array.from({ length: 4 }, () => ({ t: T0, s: 500 }))
  const r = simulate(jobs, P({ concurrency: 4 }))
  assert.equal(r.meanWaitMs, 0)
  assert.equal(r.p99, 500)
})

test('scale to zero: the first request after idle pays the cold start and is counted', () => {
  const jobs: Job[] = [{ t: T0, s: 1000 }, { t: T0 + 3_600_000, s: 1000 }]
  const r = simulate(jobs, P({ minReplicas: 0, coldStartSec: 30, scaleDownDelaySec: 60, windowSec: 60 }))
  assert.equal(r.coldHits, 2)
  assert.equal(r.p99 > 30_000, true)
  assert.equal(r.scaleUps, 2)
  // Billed roughly two (boot + serve + scale-down delay) periods, not the whole hour.
  assert.ok(r.replicaHours < 0.2, `hours ${r.replicaHours}`)
})

test('a warm minimum replica removes cold starts but bills the whole window', () => {
  const jobs: Job[] = [{ t: T0, s: 1000 }, { t: T0 + 3_600_000, s: 1000 }]
  const r = simulate(jobs, P({ minReplicas: 1, coldStartSec: 30 }))
  assert.equal(r.coldHits, 0)
  assert.ok(Math.abs(r.replicaHours - 1) < 0.01)
  assert.ok(Math.abs(r.cost - r.replicaHours) < 1e-9)
})

test('autoscaler adds replicas under sustained load and they speed up the queue', () => {
  const jobs: Job[] = Array.from({ length: 600 }, (_, i) => ({ t: T0 + i * 250, s: 1000 })) // 4 rps x 1 s = 4 concurrent
  const one = simulate(jobs, P({ maxReplicas: 1 }))
  const many = simulate(jobs, P({ maxReplicas: 8, coldStartSec: 10, windowSec: 10 }))
  assert.ok(many.peakReplicas >= 4)
  assert.ok(many.p99 < one.p99 / 5, `${many.p99} vs ${one.p99}`)
  assert.ok(many.coldHits > 0)
})

test('max replicas caps scale-up', () => {
  const jobs: Job[] = Array.from({ length: 400 }, (_, i) => ({ t: T0 + i * 100, s: 2000 }))
  assert.equal(simulate(jobs, P({ maxReplicas: 3, coldStartSec: 1 })).peakReplicas, 3)
})

test('a longer scale-down delay costs more but avoids repeat cold starts', () => {
  // Bursts every 10 minutes.
  const jobs: Job[] = []
  for (let b = 0; b < 12; b++) for (let i = 0; i < 20; i++) jobs.push({ t: T0 + b * 600_000 + i * 100, s: 800 })
  const short = simulate(jobs, P({ minReplicas: 0, maxReplicas: 4, concurrency: 2, coldStartSec: 20, scaleDownDelaySec: 60 }))
  const long = simulate(jobs, P({ minReplicas: 0, maxReplicas: 4, concurrency: 2, coldStartSec: 20, scaleDownDelaySec: 900 }))
  assert.ok(long.coldHits < short.coldHits)
  assert.ok(long.replicaHours > short.replicaHours)
})

test('toJobs replaces logged cold-start latency with the warm median', () => {
  const reqs: Req[] = [{ t: 0, lat: 100, ok: true }, { t: 1, lat: 100, ok: true }, { t: 2, lat: 90000, ok: true }]
  assert.deepEqual(toJobs(reqs, [2]).map(j => j.s), [100, 100, 100])
})

test('series buckets cover the window and report replica counts', () => {
  const jobs: Job[] = [{ t: T0, s: 1000 }, { t: T0 + 1_800_000, s: 1000 }]
  const r = simulate(jobs, P({ minReplicas: 2, maxReplicas: 2 }), { start: T0, end: T0 + 3_600_000, bucketSec: 600 })
  assert.equal(r.series.length, 7)
  assert.ok(r.series.every(s => s.replicas === 2))
  assert.equal(r.series[0].n, 1)
})

test('pareto keeps only non-dominated (cost, p99) points', () => {
  const pts = [{ cost: 1, p99: 10 }, { cost: 2, p99: 5 }, { cost: 3, p99: 6 }, { cost: 4, p99: 1 }, { cost: 2, p99: 9 }]
  assert.deepEqual(pareto(pts), [0, 1, 3])
})

test('sweep covers the grid and more warm replicas never raise cold-start hits', () => {
  const reqs = generate('image-gen').slice(0, 3000)
  const cells = sweep(toJobs(reqs), SAMPLES[1].policy, [0, 1, 2], [60, 900])
  assert.equal(cells.length, 6)
  const at = (m: number) => cells.find(c => c.minReplicas === m && c.scaleDownDelaySec === 60)!.r
  assert.ok(at(2).coldHits <= at(1).coldHits && at(1).coldHits <= at(0).coldHits)
  assert.ok(at(2).cost >= at(0).cost)
})

// ---------- Forecast and actions ----------

test('seasonal naive repeats yesterday; EWMA smooths across days', () => {
  const counts = [...new Array(24).fill(10), ...new Array(24).fill(20)]
  assert.equal(seasonalNaive(counts, 2)[5], 20)
  assert.ok(Math.abs(ewmaByHour(counts, 2, 0.5)[5] - 15) < 1e-9)
})

test('forecast backtests both methods and picks the better one; prewarm follows demand', () => {
  // Three identical days: naive is exact.
  const reqs: Req[] = []
  for (let d = 0; d < 4; d++) for (let h = 0; h < 24; h++) {
    const n = h >= 9 && h < 17 ? 600 : 6
    for (let i = 0; i < n; i++) reqs.push({ t: T0 + d * 86_400_000 + h * 3_600_000 + i * (3_600_000 / n), lat: 2000, ok: true })
  }
  const f = forecastTomorrow(reqs)!
  assert.equal(f.days, 4)
  assert.equal(f.backtest!.naive, 0)
  assert.equal(f.hours[10].value, 600)
  const pw = prewarm(f, { ...DEFAULT_POLICY, concurrency: 1, targetUtil: 1, maxReplicas: 10 }, 2000)
  assert.equal(pw.perHour[3], 0)
  assert.ok(pw.perHour[10] >= 1)
  assert.equal(pw.blocks.length, 3)
  assert.deepEqual(pw.blocks.map(b => b.fromH), [0, 9, 17])
})

test('forecast needs two full days', () => {
  assert.equal(forecastTomorrow([{ t: T0, lat: 1, ok: true }, { t: T0 + 3_600_000, lat: 1, ok: true }]), null)
})

test('SLO check and recommendation pick the cheapest frontier policy that passes', () => {
  const mk = (m: number, cost: number, p99: number, coldRate: number) => ({ minReplicas: m, scaleDownDelaySec: 60, r: { cost, p99, p95: p99 / 2, coldRate } as never })
  const cells = [mk(0, 10, 90000, 0.2), mk(1, 20, 20000, 0.005), mk(2, 30, 10000, 0)]
  const rec = recommend(cells, DEFAULT_SLO)!
  assert.equal(rec.meets, true)
  assert.equal(rec.cell.minReplicas, 1)
  const strict = recommend(cells, { ...DEFAULT_SLO, p99Ms: 1000 })!
  assert.equal(strict.meets, false)
  assert.equal(strict.cell.minReplicas, 2)
  const chk = checkSlo(DEFAULT_SLO, { p95: 1000, p99: 40000, coldRate: 0, errorRate: 0.02 })
  assert.deepEqual(chk.map(c => c.pass), [true, false, true, false])
})

test('config snippets carry every field and cron lines raise replicas ahead of time', () => {
  const j = configJson(DEFAULT_POLICY)
  assert.deepEqual(Object.keys(j), ['min_replica', 'max_replica', 'autoscaling_window', 'scale_down_delay', 'concurrency_target', 'target_utilization_percentage'])
  assert.match(configYaml(DEFAULT_POLICY), /scale_down_delay: 900/)
  const cron = prewarmCron([{ fromH: 0, toH: 9, minReplicas: 0 }, { fromH: 9, toH: 17, minReplicas: 2 }, { fromH: 17, toH: 24, minReplicas: 0 }], 90).split('\n')
  assert.match(cron[1], /^58\s+8 \* \* \*\s+set_min_replica 2/)
  assert.match(cron[2], /^ 0 17 \* \* \*\s+set_min_replica 0/)
})

test('samples are deterministic, labelled and contain detectable cold starts', () => {
  const a = generate('chat-llm'), b = generate('chat-llm')
  assert.equal(a.length, b.length)
  assert.equal(a[1234].lat, b[1234].lat)
  const c = detectColdStarts(a)
  assert.ok(c.idx.length > 20)
  assert.ok(Math.abs(c.penaltyMs - 75000) < 15000, `penalty ${c.penaltyMs}`)
  assert.ok(SAMPLES.every(s => s.blurb.length > 0))
})
