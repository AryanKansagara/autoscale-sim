import { test, expect } from './test.ts'
import { downloaded, fixture, importFile, openSample, setMinReplicas, setScaleDown, tab } from './helpers.ts'

// Same hand-worked tiny.csv trace as replay.spec.ts. Its endpoint is "Endpoint 1", so files are named endpoint-1-*.
// Billed seconds of scale-to-zero replicas, by scale-down delay (worked out in replay.spec.ts).
const BILLED = { 60: 481, 300: 1201, 900: 2521, 1800: 4321, 3600: 7921 } as const
// With a 1800 s delay the replica from 02:00 also outlives the 02:10 request:
//   (660 + 1800) + (61 + 1800) = 4321 s; with 3600 s: (660 + 3600) + (61 + 3600) = 7921 s.

test.describe('tiny trace', () => {
  test.beforeEach(async ({ page }) => { await importFile(page, fixture('tiny.csv'), 3) })

  test('normalized request log (Data tab and Config tab)', async ({ page }) => {
    const rows = [
      'timestamp,latency_ms,ttft_ms,queue_ms,status,input_tokens,output_tokens,replica_id',
      '2026-03-02T02:00:00.000Z,1000,,,200,,,',
      '2026-03-02T02:10:00.000Z,1000,,,200,,,',
      '2026-03-02T12:00:00.000Z,1000,,,200,,,',
      '',
    ]
    await tab(page, 'Data').click()
    const data = await downloaded(page, page.getByRole('button', { name: 'Download normalized CSV' }))
    expect(data.name).toBe('endpoint-1-requests.csv')
    expect(data.text.split('\n')).toEqual(rows)

    await tab(page, 'Config & SLO').click()
    const config = await downloaded(page, page.getByRole('button', { name: 'Normalized request log (CSV)' }))
    expect(config.name).toBe('endpoint-1-requests.csv')
    expect(config.text).toBe(data.text)
  })

  test('config as YAML, JSON and API call, for the recommended and the current policy', async ({ page }) => {
    await tab(page, 'Config & SLO').click()
    await expect(page.getByText('Cheapest policy on the cost/p99 frontier')).toBeVisible()

    // Recommended: min 1, scale-down 60 s (see replay.spec.ts), everything else as the app defaults.
    const yaml = await downloaded(page, page.getByRole('button', { name: 'Download', exact: true }))
    expect(yaml.name).toBe('endpoint-1-autoscaling.yaml')
    expect(yaml.text).toContain('# Replayed: p95 1.0 s, p99 1.0 s, 0.00% of requests waited on a cold start, 24.0 replica-hours\n')
    expect(yaml.text).toMatch(/^autoscaling_settings:$/m)
    for (const line of [/^ {2}min_replica: 1 /m, /^ {2}max_replica: 4 /m, /^ {2}concurrency_target: 4 /m, /^ {2}target_utilization_percentage: 70 /m, /^ {2}autoscaling_window: 60 /m, /^ {2}scale_down_delay: 60 /m]) expect(yaml.text).toMatch(line)

    await page.getByRole('radio', { name: 'JSON' }).click()
    const json = await downloaded(page, page.getByRole('button', { name: 'Download', exact: true }))
    expect(json.name).toBe('endpoint-1-autoscaling.json')
    expect(JSON.parse(json.text)).toEqual({ min_replica: 1, max_replica: 4, autoscaling_window: 60, scale_down_delay: 60, concurrency_target: 4, target_utilization_percentage: 70 })

    await page.getByRole('radio', { name: 'API call' }).click()
    const curl = await downloaded(page, page.getByRole('button', { name: 'Download', exact: true }))
    expect(curl.name).toBe('endpoint-1-autoscaling.sh')
    expect(curl.text).toContain('-X PATCH')
    expect(curl.text).toContain(`-d '{"min_replica":1,"max_replica":4,"autoscaling_window":60,"scale_down_delay":60,"concurrency_target":4,"target_utilization_percentage":70}'`)

    // Current policy: the app default (min 0, scale-down 15 min = 900 s) with its replayed numbers: p99 61 s, 2 of 3 cold, 2521 s billed.
    await page.getByRole('radio', { name: 'Current' }).click()
    await page.getByRole('radio', { name: 'YAML' }).click()
    await expect(page.locator('.code')).toContainText('0.7 replica-hours') // the replay behind the header has caught up
    const current = await downloaded(page, page.getByRole('button', { name: 'Download', exact: true }))
    expect(current.text).toContain('# Replayed: p95 61.0 s, p99 61.0 s, 66.67% of requests waited on a cold start, 0.7 replica-hours\n')
    expect(current.text).toMatch(/^ {2}min_replica: 0 /m)
    expect(current.text).toMatch(/^ {2}scale_down_delay: 900 /m)
  })

  test('replay timeline CSV covers the UTC day in 5-minute buckets, plus the closing instant', async ({ page }) => {
    // The timeline is the replay of the policy picked in the Recommended / Current switch above the config,
    // so choose it explicitly: the recommendation only appears once the sweep has finished.
    await tab(page, 'Config & SLO').click()
    await page.getByRole('radio', { name: 'Current' }).click() // min 0, scale-down 15 min
    await expect(page.locator('.code')).toContainText('0.7 replica-hours') // the YAML header is drawn from the same replay
    const current = await downloaded(page, page.getByRole('button', { name: 'Replay timeline (CSV)' }))
    expect(current.name).toBe('endpoint-1-replay-2026-03-02.csv')
    const [header, ...rows] = current.text.trim().split('\n').map(l => l.split(','))
    expect(header).toEqual(['bucket_start_utc', 'requests', 'replicas', 'ready_replicas', 'max_queue', 'p95_ms', 'mean_wait_ms'])
    expect(rows).toHaveLength(289) // 24 h / 5 min = 288, plus the bucket that starts at the window's end (as in the engine test: one hour in 10-minute buckets is 7 rows)
    expect(rows[0][0]).toBe('2026-03-02T00:00:00.000Z')
    expect(rows.at(-2)![0]).toBe('2026-03-02T23:55:00.000Z')
    expect(rows.at(-1)![0]).toBe('2026-03-03T00:00:00.000Z')
    expect(rows.filter(r => Number(r[1]) > 0).map(r => [r[0], r[1]])).toEqual([['2026-03-02T02:00:00.000Z', '1'], ['2026-03-02T02:10:00.000Z', '1'], ['2026-03-02T12:00:00.000Z', '1']])
    const at = (hhmm: string) => rows.find(r => r[0] === `2026-03-02T${hhmm}:00.000Z`)!
    expect(at('01:55')[2]).toBe('0') // nothing running before the first request
    expect(at('02:00')[5]).toBe('61000') // cold: 60 s boot + 1 s
    expect(at('02:10')[5]).toBe('1000') // the replica from 02:00 is still up (15 min delay): warm, the logged 1 s
    expect(at('12:00')[5]).toBe('61000') // cold again

    // Recommended (min 1): a replica from the first bucket to the last, nobody waits.
    await page.getByRole('radio', { name: 'Recommended' }).click()
    await expect(page.locator('.code')).toContainText('24.0 replica-hours')
    const rec = await downloaded(page, page.getByRole('button', { name: 'Replay timeline (CSV)' }))
    const recRows = rec.text.trim().split('\n').slice(1).map(l => l.split(','))
    expect(recRows.every(r => r[2] === '1' && r[3] === '1')).toBe(true)
    expect(recRows.filter(r => Number(r[1]) > 0).map(r => r[5])).toEqual(['1000', '1000', '1000'])
  })

  test('policy sweep CSV: every cell costs what the hand calculation says', async ({ page }) => {
    await tab(page, 'Policy sweep').click()
    await expect(page.locator('td.cell')).toHaveCount(25)
    const { name, text } = await downloaded(page, page.getByRole('button', { name: 'Download sweep CSV' }))
    expect(name).toBe('endpoint-1-sweep-2026-03-02.csv')
    const [header, ...rows] = text.trim().split('\n').map(l => l.split(','))
    expect(header).toEqual(['min_replicas', 'scale_down_delay_s', 'p50_ms', 'p95_ms', 'p99_ms', 'cold_hits', 'cold_rate', 'replica_hours', 'cost_usd', 'on_frontier'])
    expect(rows).toHaveLength(25)
    const cell = (min: number, delay: number) => Object.fromEntries(header.map((h, i) => [h, rows.find(r => Number(r[0]) === min && Number(r[1]) === delay)![i]]))

    for (const [delay, seconds] of Object.entries(BILLED)) {
      const c = cell(0, Number(delay))
      expect(Number(c.replica_hours), `min 0, delay ${delay}`).toBeCloseTo(seconds / 3600, 5)
      expect(Number(c.cost_usd), `min 0, delay ${delay}`).toBeCloseTo(seconds / 3600 * 6.5, 5)
      expect(Number(c.p99_ms)).toBe(61_000)
    }
    // Cold hits: the 02:10 request is warm only when the replica from 02:00 is still up (delay 900 s or more).
    expect(Object.keys(BILLED).map(d => Number(cell(0, Number(d)).cold_hits))).toEqual([3, 3, 2, 2, 2])
    // Warm replicas bill the whole day whatever the delay, and nobody waits.
    for (const min of [1, 2, 3, 4]) for (const delay of [60, 300, 900, 1800, 3600]) {
      const c = cell(min, delay)
      expect(Number(c.replica_hours)).toBeCloseTo(24 * min, 5)
      expect(Number(c.cost_usd)).toBeCloseTo(24 * min * 6.5, 5)
      expect([c.cold_hits, c.p99_ms]).toEqual(['0', '1000'])
    }
    // Frontier: the cheapest cell (min 0, 60 s) and the first min-1 cell (the same price as all the others, but the p99 is far lower).
    expect(rows.filter(r => r[9] === 'yes').map(r => `${r[0]}/${r[1]}`)).toEqual(['0/60', '1/60'])
  })
})

test('every export on a sample endpoint: forecast CSV and all-my-data JSON', async ({ page }) => {
  await openSample(page, /Chat LLM endpoint/)
  await tab(page, 'Forecast').click()
  const forecast = await downloaded(page, page.getByRole('button', { name: 'Download forecast CSV' }))
  expect(forecast.name).toBe('chat-llm-endpoint-forecast.csv')
  const lines = forecast.text.trim().split('\n')
  expect(lines[0]).toBe('hour_utc,seasonal_naive,ewma,forecast,peak_minute_factor,min_replicas')
  expect(lines).toHaveLength(25) // 24 hours
  expect(lines.slice(1).map(l => l.split(',')[0])).toEqual(Array.from({ length: 24 }, (_, h) => String(h)))
  await expect(page.locator('.code', { hasText: 'set_min_replica' })).toBeVisible()

  await page.goto('/settings')
  const all = await downloaded(page, page.getByRole('button', { name: 'Export all my data (JSON)' }))
  expect(all.name).toMatch(/^autoscale-sim-export-\d{4}-\d{2}-\d{2}\.json$/)
  const exported = JSON.parse(all.text)
  expect(JSON.stringify(exported)).toContain('Chat LLM endpoint')
})

test('exports follow a changed policy: the Config tab shows what the Replay tab set', async ({ page }) => {
  await importFile(page, fixture('tiny.csv'), 3)
  await tab(page, 'Replay').click()
  await setMinReplicas(page, 2)
  await setScaleDown(page, 1800)
  await tab(page, 'Config & SLO').click()
  await page.getByRole('radio', { name: 'Current' }).click()
  await page.getByRole('radio', { name: 'JSON' }).click()
  const json = await downloaded(page, page.getByRole('button', { name: 'Download', exact: true }))
  expect(JSON.parse(json.text)).toMatchObject({ min_replica: 2, scale_down_delay: 1800 })
})
