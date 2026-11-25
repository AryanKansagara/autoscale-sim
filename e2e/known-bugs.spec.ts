import { test, expect } from './test.ts'
import { chooseFiles, file, fixture, importFile, kpi, setMinReplicas, tab } from './helpers.ts'

// Bugs found while writing this suite. Each test states the behaviour the app should have. While a bug exists its test is
// marked `test.fail`, so the suite stays green and goes red ("expected to fail but passed") the day it is fixed: delete
// the `test.fail` line then, and the test keeps the bug from coming back.

test('#2: a CSV cut inside the last row\'s latency is reported, not imported silently', async ({ page }) => {
  test.fail(true, 'https://github.com/AryanKansagara/autoscale-sim/issues/2')
  const cut = 'timestamp,latency_ms,status\n2026-03-02T02:00:00Z,1000,200\n2026-03-02T02:10:00Z,1000,200\n2026-03-02T12:00:00Z,10'
  await chooseFiles(page, file('cut.csv', cut))
  await expect(page.getByRole('log', { name: 'Validation issues' })).toContainText('line 4')
})

for (const { why, csv, rows } of [
  { why: 'one request', csv: 'timestamp,latency_ms\n2026-03-02T02:00:00Z,1000\n', rows: 1 },
  { why: 'two requests at one instant', csv: 'timestamp,latency_ms\n2026-03-02T02:00:00Z,1000\n2026-03-02T02:00:00Z,1200\n', rows: 2 },
  { why: 'two requests ten minutes apart', csv: 'timestamp,latency_ms\n2026-03-02T02:00:00Z,1000\n2026-03-02T02:10:00Z,1000\n', rows: 2 },
  { why: 'three requests at one instant', csv: 'timestamp,latency_ms\n2026-03-02T02:00:00Z,1000\n2026-03-02T02:00:00Z,1200\n2026-03-02T02:00:00Z,900\n', rows: 3 },
]) {
  test(`#3: a log of ${why} shows no NaN on the Traffic tab`, async ({ page }) => {
    await importFile(page, file('few.csv', csv), rows)
    await expect(page.locator('main')).not.toContainText('NaN')
    await expect(page.locator('main')).toContainText('inter-arrival CV —')
    await expect(page.locator('main')).not.toContainText('Very regular arrivals')
    await page.keyboard.press('p')
    await expect(page.locator('article.report')).toContainText('CV —')
    await expect(page.locator('article.report')).not.toContainText('NaN')
  })
}

test('#4: a saved experiment has the numbers the Replay tab showed when it was saved', async ({ page }) => {
  await importFile(page, fixture('tiny.csv'), 3)
  await tab(page, 'Replay').click()
  await setMinReplicas(page, 1)
  await expect(kpi(page, 'GPU cost').locator('b')).toHaveText('$156')
  await page.getByRole('button', { name: 'Save experiment' }).click()
  await tab(page, 'Experiments').click()
  const row = page.locator('tr', { has: page.getByLabel('Experiment name') })
  await expect(row).toContainText('24.0') // replica-hours: one replica for the 24 h day
  await expect(row).toContainText('$156')
})
