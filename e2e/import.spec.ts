import { test, expect } from './test.ts'
import { chooseFiles, downloaded, engineFixture, fixture, importFile, kpi, tab } from './helpers.ts'

const mapped = (page: import('@playwright/test').Page, field: string) => page.locator('label.field').filter({ has: page.locator('span').filter({ hasText: new RegExp(`^${field}( \\*)?$`) }) }).locator('select')
const selectedOption = (page: import('@playwright/test').Page, field: string) => mapped(page, field).evaluate((el: HTMLSelectElement) => el.selectedOptions[0].textContent)
const imports = (page: import('@playwright/test').Page) => page.locator('table', { has: page.getByRole('columnheader', { name: 'Rows' }) })

test('CSV with latency: columns are mapped, the validation report is exact, and nothing is labelled as modelled', async ({ page }) => {
  await chooseFiles(page, fixture('tiny.csv'))
  await expect(page.getByRole('heading', { name: 'tiny.csv' })).toBeVisible()
  await expect(page.getByLabel('Detected format')).toHaveValue('plain')
  expect(await selectedOption(page, 'Request time')).toBe('timestamp')
  expect(await selectedOption(page, 'Latency')).toBe('latency_ms')
  expect(await selectedOption(page, 'Status')).toBe('status')
  await expect(page.getByText('3 requests ready of 3 rows. Range 2026-03-02 02:00 to 2026-03-02 12:00 UTC. With TTFT: 0. Failed: 0.')).toBeVisible()
  await expect(page.getByRole('heading', { name: /Latency model/ })).toHaveCount(0)

  await page.getByRole('button', { name: 'Import 3 requests' }).click()
  await expect(kpi(page, 'Requests').locator('b')).toHaveText('3')
  await expect(kpi(page, 'p95 latency (95% CI)').locator('b')).toHaveText('1.00 s')
  await expect(kpi(page, 'Errors + timeouts').locator('b')).toHaveText('0.00%')

  await tab(page, 'Data').click()
  const row = imports(page).locator('tbody tr')
  await expect(row).toHaveCount(1)
  await expect(row).toContainText('tiny.csv')
  await expect(row).toContainText('Plain CSV / JSONL')
  await expect(row).not.toContainText('estimated from tokens')
})

test('JSONL from an OpenAI-compatible proxy: nested usage fields are found and the format is detected', async ({ page }) => {
  await chooseFiles(page, fixture('tiny.jsonl'))
  await expect(page.getByLabel('Detected format')).toHaveValue('openai-proxy')
  expect(await selectedOption(page, 'Request time')).toBe('timestamp')
  expect(await selectedOption(page, 'Latency')).toBe('latency_ms')
  expect(await selectedOption(page, 'Input tokens')).toBe('usage.prompt_tokens')
  expect(await selectedOption(page, 'Output tokens')).toBe('usage.completion_tokens')
  await expect(page.getByText('3 requests ready of 3 rows.')).toBeVisible()
  await page.getByRole('button', { name: 'Import 3 requests' }).click()
  await expect(kpi(page, 'Requests').locator('b')).toHaveText('3')
  await tab(page, 'Data').click()
  await expect(imports(page).locator('tbody tr')).toContainText('OpenAI-compatible proxy log (JSONL)')

  // The tokens are kept: the normalized CSV has them next to the logged latency.
  const { text } = await downloaded(page, page.getByRole('button', { name: 'Download normalized CSV' }))
  expect(text.split('\n')).toEqual([
    'timestamp,latency_ms,ttft_ms,queue_ms,status,input_tokens,output_tokens,replica_id',
    '2026-03-02T02:00:00.000Z,1000,,,200,120,30,',
    '2026-03-02T02:10:00.000Z,1000,,,200,80,20,',
    '2026-03-02T12:00:00.000Z,1000,,,200,200,50,',
    '',
  ])
})

test('a trace with no latency column is labelled as modelled, and the latency model can be edited', async ({ page }) => {
  // First rows of the Azure LLM inference trace: 374 prompt and 44 generated tokens, then 396 and 109.
  await chooseFiles(page, engineFixture('azure-llm-conv-2023.csv'))
  await expect(page.getByLabel('Detected format')).toHaveValue('azure-llm')
  await expect(page.getByRole('heading', { name: 'Latency model (no latency column)' })).toBeVisible()
  await expect(page.getByText('Service time = fixed overhead + prefill per input token + decode per output token.')).toBeVisible()
  await page.getByLabel('Decode (ms per output token)').fill('30')
  await page.getByRole('button', { name: 'Import 30 requests' }).click()
  await expect(kpi(page, 'Requests').locator('b')).toHaveText('30')

  await tab(page, 'Data').click()
  await expect(imports(page).locator('tbody tr')).toContainText('latency estimated from tokens: 150 ms + 0.12 ms/input token + 30 ms/output token')

  // Hand-worked with 150 ms + 0.12 ms/input token + 30 ms/output token:
  //   row 1: first token 150 + 374 x 0.12 = 194.88 ms, total 194.88 + 43 x 30 = 1484.88 ms;
  //   row 2: first token 150 + 396 x 0.12 = 197.52 ms, total 197.52 + 108 x 30 = 3437.52 ms.
  const { text } = await downloaded(page, page.getByRole('button', { name: 'Download normalized CSV' }))
  const [header, first, second] = text.split('\n')
  expect(header).toBe('timestamp,latency_ms,ttft_ms,queue_ms,status,input_tokens,output_tokens,replica_id')
  expect(first).toBe('2023-11-16T18:15:46.681Z,1485,195,,200,374,44,')
  expect(second).toBe('2023-11-16T18:15:50.995Z,3438,198,,200,396,109,')
})

test('BurstGPT excerpt: format detected, modelled latency noted, failed requests (0 response tokens) counted', async ({ page }) => {
  await chooseFiles(page, engineFixture('burstgpt-1.csv'))
  await expect(page.getByLabel('Detected format')).toHaveValue('burstgpt')
  await expect(page.getByRole('heading', { name: 'Latency model (no latency column)' })).toBeVisible()
  await expect(page.getByText(/^40 requests ready of 40 rows, 2 warnings\./)).toBeVisible()
  await expect(page.getByText(/Failed: 2\./)).toBeVisible()
  await page.getByRole('button', { name: 'Import 40 requests' }).click()
  await expect(kpi(page, 'Errors + timeouts').locator('b')).toHaveText('5.00%') // 2 of 40
  await tab(page, 'Data').click()
  await expect(imports(page).locator('tbody tr')).toContainText('BurstGPT trace (CSV)')
  await expect(imports(page).locator('tbody tr')).toContainText('latency estimated from tokens')
})

test('importing the same requests twice does not duplicate them', async ({ page }) => {
  await importFile(page, fixture('tiny.csv'), 3)
  await tab(page, 'Data').click()
  await page.locator('input[type=file]').setInputFiles(fixture('tiny.csv'))
  await page.getByRole('button', { name: 'Import 3 requests' }).click()
  await expect(kpi(page, 'Requests').locator('b')).toHaveText('3')
  await tab(page, 'Data').click()
  await expect(imports(page).locator('tbody tr')).toHaveCount(2) // two imports on record...
  await expect(page.locator('.panel-head', { hasText: 'Imported data' })).toContainText('3 requests') // ...of the same three requests
})

test('latency in seconds is detected from the values and converted', async ({ page }) => {
  const csv = 'timestamp,duration\n2026-03-02T02:00:00Z,1.5\n2026-03-02T02:10:00Z,2\n'
  await chooseFiles(page, { name: 'seconds.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
  await expect(page.getByLabel('Latency / TTFT unit')).toHaveValue('auto')
  await expect(page.getByRole('option', { name: 'Auto (seconds)' })).toBeAttached()
  await page.getByRole('button', { name: 'Import 2 requests' }).click()
  const { text } = await downloaded(page, (await tab(page, 'Data').click(), page.getByRole('button', { name: 'Download normalized CSV' })))
  expect(text.split('\n').slice(1, 3).map(l => l.split(',').slice(0, 2).join(','))).toEqual(['2026-03-02T02:00:00.000Z,1500', '2026-03-02T02:10:00.000Z,2000'])
})
