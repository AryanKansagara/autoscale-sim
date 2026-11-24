import { test, expect } from './test.ts'
import { fixture, importFile, kpi, openSample, setMinReplicas, setScaleDown, tab } from './helpers.ts'

test('an imported endpoint, its policy, SLOs and saved experiments survive a reload', async ({ page }) => {
  await importFile(page, fixture('tiny.csv'), 3)
  await page.getByLabel('Client timeout (s)').fill('90')

  await tab(page, 'Replay').click()
  await setMinReplicas(page, 1)
  await setScaleDown(page, 300)
  await expect(kpi(page, 'GPU cost').locator('b')).toHaveText('$156')
  await page.getByRole('button', { name: 'Save experiment' }).click()
  await expect(page.getByText('Saved experiment: min 1, max 4, scale-down 300s, concurrency 4')).toBeVisible()

  await tab(page, 'Config & SLO').click()
  await page.getByLabel('p95 latency (s)').fill('2.5')
  await expect(page.getByLabel('p95 latency (s)')).toHaveValue('2.5')

  await page.reload()

  // Policy and SLO.
  await expect(page.getByLabel('p95 latency (s)')).toHaveValue('2.5')
  await tab(page, 'Replay').click()
  await expect(page.locator('#pf-min')).toHaveValue('1')
  await expect(page.locator('#pf-sd')).toHaveValue('4')
  await expect(kpi(page, 'GPU cost').locator('b')).toHaveText('$156')
  // The data itself.
  await tab(page, 'Traffic').click()
  await expect(kpi(page, 'Requests').locator('b')).toHaveText('3')
  await expect(page.getByLabel('Client timeout (s)')).toHaveValue('90')
  await tab(page, 'Data').click()
  await expect(page.locator('tbody tr')).toContainText('tiny.csv')
  // The experiment (its cost is not asserted: see known-bugs.spec.ts, issue #4).
  await tab(page, 'Experiments').click()
  const row = page.locator('tr', { has: page.getByLabel('Experiment name') })
  await expect(row).toHaveCount(1)
  await expect(row.getByLabel('Experiment name')).toHaveValue('min 1, max 4, scale-down 300s, concurrency 4')
  await expect(row).toContainText('Mon, Mar 2')
  await expect(row.locator('td.num').first()).toHaveText('1.00 s') // p95: nobody waits with one warm replica

  // And the workspace card.
  await page.goto('/app')
  const card = page.locator('.project-card')
  await expect(card).toHaveCount(1)
  await expect(card).toContainText('Min / max1 / 4')
  await expect(card).toContainText('Experiments1')
  await expect(page.getByText('Stored on this device.')).toBeVisible()
})

test('renaming an endpoint persists', async ({ page }) => {
  await importFile(page, fixture('tiny.csv'), 3)
  await page.goto('/app')
  await page.getByRole('button', { name: 'Rename' }).click()
  await page.getByLabel('Endpoint name').fill('Prod chat')
  await page.getByLabel('Endpoint name').press('Enter')
  await expect(page.getByRole('heading', { name: 'Prod chat' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Prod chat' })).toBeVisible()
})

test('settings: the default price survives a reload and is used by the next endpoint', async ({ page }) => {
  await page.goto('/settings')
  await page.getByLabel('$ per replica-hour').fill('10')
  await page.reload()
  await expect(page.getByLabel('$ per replica-hour')).toHaveValue('10')

  // One warm replica for the 24 h UTC day at $10/h is $240 (the default $6.50 would be $156).
  await importFile(page, fixture('tiny.csv'), 3)
  await expect(page.getByText('H100 at $10.00/h')).toBeVisible()
  await tab(page, 'Replay').click()
  await setMinReplicas(page, 1)
  await expect(kpi(page, 'GPU cost').locator('b')).toHaveText('$240')
})

test('the theme choice survives a reload', async ({ page }) => {
  await page.goto('/settings')
  await page.getByRole('radio', { name: 'Dark' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'dark')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'dark')
  await expect(page.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true')
})

test('deleting an endpoint persists, and Undo brings it back with its data', async ({ page }) => {
  await importFile(page, fixture('tiny.csv'), 3)
  await page.goto('/app')
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await page.getByRole('button', { name: 'Delete endpoint' }).click()
  await expect(page.getByText('Deleted Endpoint 1')).toBeVisible()
  await expect(page.locator('.project-card')).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Try the sample' })).toBeVisible()

  // A second round: delete, undo within the toast, reload.
  await importFile(page, fixture('tiny.csv'), 3)
  await page.goto('/app')
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await page.getByRole('button', { name: 'Delete endpoint' }).click()
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(page.locator('.project-card')).toHaveCount(1)
  await page.reload()
  await page.locator('.project-card').getByRole('link', { name: 'Endpoint 1' }).click()
  await expect(kpi(page, 'Requests').locator('b')).toHaveText('3')
})

test('a sample is stored once: opening it again reuses the endpoint, and it survives a reload', async ({ page }) => {
  await openSample(page, /Chat LLM endpoint/)
  const url = page.url()
  await page.goto('/app')
  await page.locator('.samples-row').getByRole('button', { name: 'Chat LLM endpoint' }).click()
  await expect(page).toHaveURL(url)
  await page.goto('/app')
  await expect(page.locator('.project-card')).toHaveCount(1)
  await page.reload()
  await expect(page.locator('.project-card')).toHaveCount(1)
  await expect(page.locator('.project-card')).toContainText('Experiments2') // the two it ships with
})
