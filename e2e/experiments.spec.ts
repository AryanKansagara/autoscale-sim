import { test, expect } from './test.ts'
import type { Page } from '@playwright/test'
import { downloaded, fixture, importFile, kpi, openSample, setMinReplicas, setScaleDown, tab } from './helpers.ts'

// A saved experiment and the Replay tab must come from one calculation (issue #4): the same log, range
// and policy give the same numbers. These tests read the Replay KPIs, press Save experiment, and compare
// them with the Experiments row cell by cell.

const text = (page: Page, label: string) => kpi(page, label).locator('b').innerText()

/** What Replay shows right now, in the units the Experiments table uses. */
async function replayNumbers(page: Page) {
  const note = await kpi(page, 'GPU cost').locator('p').innerText() // "24.0 replica-hours · $52,000.00 per 1k req"
  return {
    p95: await text(page, 'p95 latency'), p99: await text(page, 'p99 latency'), cold: await text(page, 'Waited on a cold start'),
    hours: note.split(' replica-hours')[0], cost: await text(page, 'GPU cost'),
  }
}

/** The newest row of the Experiments table: p95, p99, cold hits, replica-hours, cost. */
async function savedNumbers(page: Page) {
  await tab(page, 'Experiments').click()
  const cells = page.locator('tr', { has: page.getByLabel('Experiment name') }).first().locator('td.num')
  const [p95, p99, cold, hours, cost] = await cells.allInnerTexts()
  return { p95, p99, cold, hours, cost }
}

/** Saves, then waits for Replay (drawn a moment after a slider moves) to show exactly the saved numbers. */
async function saveAndCompare(page: Page) {
  await page.getByRole('button', { name: 'Save experiment' }).click()
  const saved = await savedNumbers(page)
  await tab(page, 'Replay').click()
  await expect.poll(() => replayNumbers(page)).toEqual(saved)
}

for (const { why, min, delay } of [
  { why: 'scale to zero, 15 min delay (the defaults)', min: 0, delay: 900 },
  { why: 'scale to zero, 1 min delay', min: 0, delay: 60 },
  { why: 'two warm replicas', min: 2, delay: 900 },
  { why: 'one warm replica', min: 1, delay: 900 },
]) {
  test(`the saved row equals the Replay KPIs for the tiny log: ${why}`, async ({ page }) => {
    await importFile(page, fixture('tiny.csv'), 3)
    await tab(page, 'Replay').click()
    await setMinReplicas(page, min)
    await setScaleDown(page, delay)
    await expect(page.locator('#pf-min')).toHaveValue(String(min))
    await saveAndCompare(page)
  })
}

test('the all-days range: Replay, the saved row and the sweep bill the last replica until it scales down', async ({ page }) => {
  await importFile(page, fixture('tiny.csv'), 3)
  await tab(page, 'Replay').click()
  await page.locator('#range').selectOption('all')
  // 2521 billed seconds, as in replay.spec.ts: both replicas scale down within the day.
  await expect(kpi(page, 'GPU cost')).toContainText('0.7 replica-hours · $1,517.27 per 1k req')
  await saveAndCompare(page)
  await tab(page, 'Policy sweep').click()
  const { text: csv } = await downloaded(page, page.getByRole('button', { name: 'Download sweep CSV' }))
  const cell = csv.split('\n').map(l => l.split(',')).find(r => r[0] === '0' && r[1] === '900')!
  expect(Number(cell[7])).toBeCloseTo(2521 / 3600, 5)
})

test('the saved row equals the Replay KPIs for the built-in chat sample (issue #4, reproduction 2)', async ({ page }) => {
  await openSample(page, /^Chat LLM endpoint/)
  await tab(page, 'Replay').click()
  await expect(kpi(page, 'GPU cost').locator('b')).toHaveText(/^\$[\d,]+$/)
  await saveAndCompare(page)
})

test('experiments saved before the shared calculation are flagged; all-days and new ones are not', async ({ page }) => {
  await importFile(page, fixture('tiny.csv'), 3)
  await tab(page, 'Replay').click()
  await setMinReplicas(page, 1)
  await page.getByRole('button', { name: 'Save experiment' }).click() // Mon, Mar 2
  await page.locator('#range').selectOption('all')
  await page.getByRole('button', { name: 'Save experiment' }).click() // all days
  await page.locator('#range').selectOption({ label: 'Mon, Mar 2 (busiest)' })
  await page.getByRole('button', { name: 'Save experiment' }).click() // Mon, Mar 2 again
  await tab(page, 'Experiments').click()
  await expect(page.getByText('Older calculation')).toHaveCount(0)

  // Make the two single-day experiments look like the ones saved before the fix: no `calc` field. The
  // all-days one stays as is: its calculation did not change.
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((res, rej) => { const q = indexedDB.open('autoscale-sim', 1); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error) })
    const store = () => db.transaction('projects', 'readwrite').objectStore('projects')
    const all = await new Promise<{ snapshots: { range: string; calc?: number }[] }[]>(res => { const q = store().getAll(); q.onsuccess = () => res(q.result) })
    for (const p of all) {
      let first = true
      for (const s of p.snapshots) if (s.range !== 'all') { if (first) { delete s.calc; first = false } }
      await new Promise(res => { const q = store().put(p); q.onsuccess = () => res(null) })
    }
  })
  await page.reload()
  await tab(page, 'Experiments').click()
  // Exactly one experiment (the first single-day one) is flagged.
  await expect(page.getByText('Older calculation')).toHaveCount(1)
  const flagged = page.locator('tr', { has: page.getByText('Older calculation') })
  await expect(flagged).toContainText('Mon, Mar 2')
  await expect(flagged).toContainText('To redo it, press Use')
  // Comparing a flagged experiment says why its numbers are not comparable.
  await flagged.getByLabel(/^Compare /).check()
  await expect(page.locator('.panel', { has: page.getByRole('heading', { name: 'Compare' }) })).toContainText('An older single-day experiment is selected')
})
