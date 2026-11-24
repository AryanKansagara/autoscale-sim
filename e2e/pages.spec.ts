import { test, expect } from './test.ts'

test('static pages render with their titles and no external requests', async ({ page }) => {
  await page.goto('/docs')
  await expect(page).toHaveTitle(/^Docs: getting request logs out of your gateway/)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await page.goto('/settings')
  await expect(page).toHaveTitle('Settings · Autoscale Sim')
  await page.goto('/app')
  await expect(page).toHaveTitle('Endpoints · Autoscale Sim')
  await expect(page.getByRole('heading', { name: 'Try the sample' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Import your data' })).toBeVisible()
})

test('unknown routes and unknown endpoints say so', async ({ page }) => {
  await page.goto('/nope')
  await expect(page).toHaveTitle('Not found · Autoscale Sim')
  await page.goto('/app/p/00000000-0000-0000-0000-000000000000')
  await expect(page.getByText('Endpoint not found')).toBeVisible()
  await page.goto('/app/p/00000000-0000-0000-0000-000000000000/report')
  await expect(page.getByRole('heading', { name: 'Nothing to report' })).toBeVisible()
})

test('the app works signed out: it says where the data lives and never offers a synced state', async ({ page }) => {
  await page.goto('/app')
  await expect(page.getByText('Stored on this device.')).toBeVisible()
  await expect(page.getByText('Synced to your account.')).toHaveCount(0)
})
