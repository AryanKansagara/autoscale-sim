import { test, expect } from './test.ts'
import { fixture, importFile, kpi, setMinReplicas, setScaleDown, tab } from './helpers.ts'

// tiny.csv: three requests of 1.000 s on Mon 2 Mar 2026 (UTC) at 02:00:00, 02:10:00 and 12:00:00.
// The endpoint starts with the app defaults: min 0, max 4, concurrency 4, 70% utilisation,
// 60 s autoscaling window, 15 min scale-down delay, 60 s cold start, $6.50 per replica-hour.
//
// Worked by hand, with D = the scale-down delay in seconds:
//  * With no warm replica every request that finds no replica running boots one and waits 60 s,
//    so its latency is 61 s. With D <= 300 the replica is gone before the next request (the
//    replica lives 60 s boot + 60 s window + D after its request), so all three requests are cold.
//    With D = 900 the replica from 02:00 is still there at 02:10, so only 2 of 3 are cold.
//  * Billed seconds, per replica: 120 + D (boot + window + D) for a request with nothing after it,
//    61 + D for the very last one (boot + service + D, nothing is simulated after it).
//      D = 900: (660 + 900) + (61 + 900)      = 2521 s   (one replica serves 02:00 and 02:10)
//      D = 300: (120 + 300) + (120 + 300) + (61 + 300) = 1201 s
//      D = 60:  (120 + 60)  + (120 + 60)  + (61 + 60)  = 481 s
//  * One warm replica for the whole UTC day is 24 h = 86 400 s; two are 172 800 s. No request ever
//    waits, so every latency is the logged 1.000 s and nothing is cold.
const RATE = 6.5
const REQUESTS = 3
const usd = (n: number, digits = 0) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits })
const cost = (billedSeconds: number) => `${usd(billedSeconds / 3600 * RATE)}`
const hours = (billedSeconds: number) => (billedSeconds / 3600).toFixed(1)
const per1k = (billedSeconds: number) => usd(billedSeconds / 3600 * RATE / REQUESTS * 1000, 2)

test.beforeEach(async ({ page }) => {
  await importFile(page, fixture('tiny.csv'), REQUESTS)
  await tab(page, 'Replay').click()
  await expect(page.getByRole('heading', { name: 'Policy' })).toBeVisible()
})

test('scale-down delay: a shorter delay is cheaper but sends the 02:10 request to a cold start', async ({ page }) => {
  // Defaults: min 0, delay 15 min.
  await expect(page.locator('#pf-sd')).toHaveValue('6')
  await expect(kpi(page, 'Waited on a cold start').locator('b')).toHaveText('2')
  await expect(kpi(page, 'Waited on a cold start')).toContainText('66.67% of requests')
  await expect(kpi(page, 'p99 latency').locator('b')).toHaveText('1.0 min') // 61 s
  await expect(kpi(page, 'GPU cost').locator('b')).toHaveText(cost(2521))
  await expect(kpi(page, 'GPU cost')).toContainText(`${hours(2521)} replica-hours · ${per1k(2521)} per 1k req`)
  await expect(page.getByText('peak 1 replicas · 2 scale-ups')).toBeVisible()

  await setScaleDown(page, 300)
  await expect(page.locator('output', { hasText: '5 min' })).toBeVisible()
  await expect(kpi(page, 'Waited on a cold start').locator('b')).toHaveText('3')
  await expect(kpi(page, 'Waited on a cold start')).toContainText('100.00% of requests')
  await expect(kpi(page, 'GPU cost').locator('b')).toHaveText(cost(1201))
  await expect(kpi(page, 'GPU cost')).toContainText(`${hours(1201)} replica-hours · ${per1k(1201)} per 1k req`)
  await expect(page.getByText('peak 1 replicas · 3 scale-ups')).toBeVisible()

  await setScaleDown(page, 60)
  await expect(kpi(page, 'Waited on a cold start')).toContainText('100.00% of requests')
  await expect(kpi(page, 'GPU cost').locator('b')).toHaveText(cost(481))
  await expect(kpi(page, 'GPU cost')).toContainText(`${hours(481)} replica-hours · ${per1k(481)} per 1k req`)
})

test('min replicas: one warm replica bills the whole day, removes every cold start and leaves the logged latency', async ({ page }) => {
  await setMinReplicas(page, 1)
  await expect(kpi(page, 'GPU cost').locator('b')).toHaveText(cost(86_400)) // $156
  await expect(kpi(page, 'GPU cost')).toContainText(`${hours(86_400)} replica-hours · ${per1k(86_400)} per 1k req`)
  await expect(kpi(page, 'Waited on a cold start').locator('b')).toHaveText('0')
  await expect(kpi(page, 'Waited on a cold start')).toContainText('0.00% of requests')
  await expect(kpi(page, 'p95 latency').locator('b')).toHaveText('1.00 s')
  await expect(kpi(page, 'p99 latency').locator('b')).toHaveText('1.00 s')
  await expect(kpi(page, 'p99 latency')).not.toContainText('vs logged') // replay equals the log

  await setMinReplicas(page, 2)
  await expect(kpi(page, 'GPU cost').locator('b')).toHaveText(cost(172_800)) // $312
  await expect(kpi(page, 'GPU cost')).toContainText(`${hours(172_800)} replica-hours · ${per1k(172_800)} per 1k req`)
  await expect(page.getByText('peak 2 replicas · 0 scale-ups')).toBeVisible()

  // Back to scale-to-zero: the cold starts and the p99 come back.
  await setMinReplicas(page, 0)
  await expect(kpi(page, 'Waited on a cold start').locator('b')).toHaveText('2')
  await expect(kpi(page, 'p99 latency').locator('b')).toHaveText('1.0 min')
})

test('replay chart: replicas drop to 0 after the scale-down delay and return at 12:00; isolated latencies are drawn (issue #6)', async ({ page }) => {
  const chart = page.getByRole('img', { name: /^Replay of/ })
  await expect(chart.locator('circle.s4-dot')).toHaveCount(3) // 02:00, 02:10 and 12:00: no measured neighbours
  // Hover by time of day: the plot spans 00:00 to 24:00 between a 48 px and a 10 px margin.
  const tip = page.locator('.chart-tip')
  const hover = async (hhmm: string) => {
    const box = (await chart.boundingBox())!
    const [h, m] = hhmm.split(':').map(Number)
    await page.mouse.move(box.x + 48 + (h * 60 + m) / 1440 * (box.width - 58), box.y + 130)
    await expect(tip).toContainText(`${hhmm}`)
  }
  await hover('02:00'); await expect(tip).toContainText('0.8 ready, 0.2 booting')
  await hover('02:15'); await expect(tip).toContainText('1 ready')
  await hover('02:25'); await expect(tip).toContainText('0.2 ready on average, peak 1')
  for (const t of ['02:30', '07:00', '11:55', '12:20', '23:00']) { await hover(t); await expect(tip).toContainText('0 ready') }
  await hover('12:05'); await expect(tip).toContainText('1 ready')
  // The drawn line: back on the baseline, not a flat line until midnight.
  const d = (await chart.locator('path.s1-line').getAttribute('d'))!
  const ys = [...d.matchAll(/V([\d.]+)/g)].map(x => Number(x[1]))
  const base = Math.max(...ys)
  expect(ys.filter(y => y === base).length).toBeGreaterThan(250) // of 288 steps
})

test('the SLO check follows the replay: scale-to-zero misses, one warm replica meets', async ({ page }) => {
  const row = (name: string) => page.locator('tr', { has: page.getByRole('rowheader', { name }) })
  // Targets are the defaults: p95 <= 15 s, p99 <= 30 s, cold starts <= 1%, errors <= 1%.
  await expect(row('p99 latency')).toContainText('1.00 s') // logged
  await expect(row('p99 latency')).toContainText('✕ Misses')
  await expect(row('Requests hitting a cold start')).toContainText('66.67%')
  await expect(row('Error + timeout rate')).toContainText('✓ Meets')

  await setMinReplicas(page, 1)
  for (const name of ['p95 latency', 'p99 latency', 'Requests hitting a cold start', 'Error + timeout rate']) await expect(row(name)).toContainText('✓ Meets')
})

test('policy sweep and config pick min 1, scale-down 1 min: the cheapest cell that meets the SLOs', async ({ page }) => {
  // Every min-0 cell has a 61 s p99 (SLO 30 s). Every min-1 cell costs the same $156, so the first
  // one on the frontier in grid order (scale-down 60 s) is the cheapest that meets the SLOs.
  await tab(page, 'Policy sweep').click()
  await expect(page.locator('td.cell')).toHaveCount(25)
  await expect(page.locator('.banner.good')).toContainText('min 1 replicas, scale-down 1 min, p99 1.00 s, $156 for Mon, Mar 2')

  await tab(page, 'Config & SLO').click()
  await expect(page.getByText('Cheapest policy on the cost/p99 frontier that meets your latency and cold-start SLOs for Mon, Mar 2.')).toBeVisible()
  const code = page.locator('.code pre, .code code').first()
  await expect(code).toContainText('min_replica: 1')
  await expect(code).toContainText('scale_down_delay: 60')

  // "Make it current" applies it to the Replay tab.
  await page.getByRole('button', { name: 'Make it current' }).click()
  await tab(page, 'Replay').click()
  await expect(page.locator('#pf-min')).toHaveValue('1')
  await expect(page.locator('#pf-sd')).toHaveValue('2')
  await expect(kpi(page, 'GPU cost').locator('b')).toHaveText('$156')
})
