import { expect, type Download, type Locator, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

/** Small hand-made traces in e2e/fixtures. */
export const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
/** Real public-trace excerpts that the engine tests already use. Read only. */
export const engineFixture = (name: string) => fileURLToPath(new URL(`../src/engine/fixtures/${name}`, import.meta.url))

export const file = (name: string, content: string | number[]) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(typeof content === 'string' ? content : Uint8Array.from(content)) })
type Upload = string | ReturnType<typeof file>
type Uploads = string | string[] | ReturnType<typeof file> | ReturnType<typeof file>[]

/** Workspace -> "Import your data" -> choose files. Stops at the validation report. */
export async function chooseFiles(page: Page, files: Uploads) {
  await page.goto('/app')
  await page.getByRole('button', { name: 'Import your data' }).click()
  await expect(page).toHaveURL(/\/app\/p\/[0-9a-f-]+\/data$/)
  await page.locator('input[type=file]').setInputFiles(files)
}

/** Imports a file into a new endpoint and waits for the Traffic tab to show it. */
export async function importFile(page: Page, f: Upload, count: number) {
  await chooseFiles(page, f)
  await page.getByRole('button', { name: `Import ${count} requests` }).click()
  await expect(page).toHaveURL(/\/app\/p\/[0-9a-f-]+$/)
  await expect(kpi(page, 'Requests').locator('b')).toHaveText(String(count))
}

export const tab = (page: Page, name: string) => page.getByRole('navigation', { name: 'Endpoint sections' }).getByRole('link', { name })

export const kpi = (page: Page, label: string | RegExp) => page.locator('.kpi', { has: page.locator('small', { hasText: typeof label === 'string' ? new RegExp('^' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') : label }) })

/** Opens one of the built-in samples from the workspace and lands on its Traffic tab. */
export async function openSample(page: Page, name: string | RegExp) {
  await page.goto('/app')
  await page.getByRole('button', { name }).click()
  await expect(page).toHaveURL(/\/app\/p\/[0-9a-f-]+$/)
  await expect(kpi(page, 'Requests')).toBeVisible()
}

/** The Replay tab's Min replicas slider and Scale-down delay slider (steps 0 30 60 120 300 600 900 1200 1800 2700 3600 7200 s). */
export const DELAY_STEPS = [0, 30, 60, 120, 300, 600, 900, 1200, 1800, 2700, 3600, 7200]
export const setMinReplicas = (page: Page, n: number) => page.locator('#pf-min').fill(String(n))
export const setScaleDown = (page: Page, seconds: number) => page.locator('#pf-sd').fill(String(DELAY_STEPS.indexOf(seconds)))

/** Clicks something that downloads a file; returns its name and text. */
export async function downloaded(page: Page, click: Locator): Promise<{ name: string; text: string; download: Download }> {
  const [d] = await Promise.all([page.waitForEvent('download'), click.click()])
  const path = await d.path()
  return { name: d.suggestedFilename(), text: await readFile(path, 'utf8'), download: d }
}
