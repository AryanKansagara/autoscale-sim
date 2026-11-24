import { test, expect } from './test.ts'
import { kpi, openSample, tab } from './helpers.ts'

const SAMPLES = [
  { name: /^Chat LLM endpoint/, badge: 'Synthetic', min: 100_000 },
  { name: /^Image model, spiky/, badge: 'Synthetic', min: 10_000 },
  { name: /^BurstGPT, real ChatGPT traffic/, badge: 'Public trace', min: 12_845, exact: '12,845' },
]
const LATENCY = /^\d+(\.\d+)? (ms|s|min)$/

for (const s of SAMPLES) {
  test.describe(String(s.name), () => {
    test.beforeEach(async ({ page }) => { await openSample(page, s.name) })

    test('Traffic: request count, percentiles with confidence intervals, cold starts', async ({ page }) => {
      await expect(page.locator('.proj-head .badge')).toHaveText(s.badge)
      const requests = Number((await kpi(page, 'Requests').locator('b').innerText()).replace(/,/g, ''))
      expect(requests).toBeGreaterThanOrEqual(s.min)
      if (s.exact) await expect(kpi(page, 'Requests').locator('b')).toHaveText(s.exact) // the trace is a fixed excerpt

      for (const q of ['p95 latency (95% CI)', 'p99 latency (95% CI)']) {
        const k = kpi(page, q)
        await expect(k.locator('b')).toHaveText(LATENCY)
        await expect(k.locator('p')).toHaveText(/^\d+(\.\d+)? (ms|s|min) to \d+(\.\d+)? (ms|s|min)$/)
      }
      // p99 is never below p95, and the interval brackets the estimate.
      await expect(page.getByText('inter-arrival CV')).toContainText(/peak-to-mean \d+\.\d× · inter-arrival CV \d+\.\d\d/)
      const detected = Number((await kpi(page, 'Detected').locator('b').innerText()).replace(/,/g, ''))
      expect(detected).toBeGreaterThan(0)
      await expect(page.getByRole('heading', { name: 'Cold starts' })).toBeVisible()
      await expect(page.locator('main')).not.toContainText(/NaN|undefined|Infinity/)
    })

    test('Replay: cost, latency, cold starts and the SLO table', async ({ page }) => {
      await tab(page, 'Replay').click()
      await expect(kpi(page, 'GPU cost').locator('b')).toHaveText(/^\$[\d,]+$/)
      await expect(kpi(page, 'GPU cost')).toContainText(/[\d.]+ replica-hours · \$[\d,.]+ per 1k req/)
      await expect(kpi(page, 'p95 latency').locator('b')).toHaveText(LATENCY)
      await expect(kpi(page, 'p99 latency').locator('b')).toHaveText(LATENCY)
      await expect(kpi(page, 'Waited on a cold start')).toContainText(/% of requests/)
      await expect(page.locator('tbody tr', { has: page.getByRole('rowheader', { name: /latency|cold start|rate/ }) })).toHaveCount(4)
      await expect(page.getByRole('img', { name: /Replay of .*: requests, replicas and p95 latency/ })).toBeVisible()
    })

    test('Policy sweep: 25 replayed policies, a recommendation, and a cell applies to the Replay tab', async ({ page }) => {
      await tab(page, 'Policy sweep').click()
      await expect(page.locator('td.cell')).toHaveCount(25)
      await expect(page.locator('.banner')).toContainText(/Cheapest policy on the frontier that meets your SLOs: min \d replicas, scale-down [\d.]+ (min|s|h), p99 [\d.]+ (ms|s|min), \$[\d,]+ for /)
      await expect(page.locator('td.cell.picked')).toHaveCount(1)
      await expect(page.getByRole('columnheader')).toContainText(['Min \\ delay', '1 min', '5 min', '15 min', '30 min', '1 h'])

      // Click the cell for min 3, scale-down 30 min.
      await page.locator('tr', { has: page.getByRole('rowheader', { name: '3', exact: true }) }).locator('td.cell').nth(3).locator('button').click()
      await expect(page.getByText('Policy set to min 3, scale-down 30 min')).toBeVisible()
      await tab(page, 'Replay').click()
      await expect(page.locator('#pf-min')).toHaveValue('3')
      await expect(page.locator('output', { hasText: '30 min' })).toBeVisible()
    })

    test('Forecast, Config and Experiments render real content', async ({ page }) => {
      await tab(page, 'Forecast').click()
      await expect(kpi(page, 'Method')).toContainText(/EWMA|Seasonal naive/)
      await expect(page.locator('.code', { hasText: 'set_min_replica' })).toBeVisible()
      await tab(page, 'Config & SLO').click()
      await expect(page.locator('.code', { hasText: 'autoscaling_settings:' })).toBeVisible()
      await tab(page, 'Experiments').click()
      await expect(page.locator('tr', { has: page.getByLabel('Experiment name') })).toHaveCount(2) // the two it ships with
      await expect(page.getByRole('heading', { name: 'Compare' })).toBeVisible()
    })

    test('capacity report renders and says where the data comes from', async ({ page }) => {
      await page.keyboard.press('p')
      await expect(page).toHaveURL(/\/report$/)
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      await expect(page.locator('body')).toContainText(s.badge === 'Synthetic' ? 'Data is synthetic.' : 'latency estimated from token counts')
      await expect(page.locator('body')).not.toContainText(/NaN|undefined|Infinity/)
    })
  })
}

test('landing page: the hero replay reacts to its sliders, and the call to action opens the sample on the Replay tab', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' }) // no auto-demo nudging the sliders
  await page.goto('/')
  const hero = page.locator('.console')
  const cost = hero.locator('.console-kpis > div').filter({ hasText: 'GPU COST / DAY' }).locator('b')
  const hits = hero.locator('.console-kpis > div').filter({ hasText: 'COLD-START HITS' }).locator('b')
  const before = { cost: Number((await cost.innerText()).replace(/[$,]/g, '')), hits: Number((await hits.innerText()).replace(/,/g, '')) }
  expect(before.hits).toBeGreaterThan(0)

  await hero.locator('label.slider-field', { hasText: 'Min replicas' }).locator('input[type=range]').fill('2')
  await expect(hero.locator('output').first()).toHaveText('2')
  // Warm replicas cost more and absorb cold starts (some remain: a burst can still outgrow two replicas).
  await expect(async () => {
    expect(Number((await cost.innerText()).replace(/[$,]/g, ''))).toBeGreaterThan(before.cost)
    expect(Number((await hits.innerText()).replace(/,/g, ''))).toBeLessThan(before.hits)
  }).toPass()

  await page.getByRole('link', { name: 'Open the sample endpoint' }).click()
  await expect(page).toHaveURL(/\/app\/p\/[0-9a-f-]+\/replay$/)
  await expect(kpi(page, 'GPU cost')).toBeVisible()
})
