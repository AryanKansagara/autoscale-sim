import { test, expect } from './test.ts'
import { chooseFiles, file, fixture, importFile, kpi, tab } from './helpers.ts'

const GOOD = 'timestamp,latency_ms,status\n2026-03-02T02:00:00Z,1000,200\n2026-03-02T02:10:00Z,1000,200\n2026-03-02T12:00:00Z,1000,200\n'
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0xff, 0xfe, 0, 1, 2]
const JSONL = '{"timestamp":"2026-03-02T02:00:00Z","latency_ms":1000}\n{"timestamp":"2026-03-02T02:10:00Z","latency_ms":1000}\n'

/** Files that are refused outright with a toast: nothing is shown to import. */
const REFUSED = [
  { why: 'an empty file (0 bytes)', f: file('empty.csv', ''), message: 'empty.csv has no requests in it.' },
  { why: 'a file with only a byte order mark', f: file('bom.csv', '\uFEFF'), message: 'bom.csv has no requests in it.' },
  { why: 'a header row and nothing else', f: file('header-only.csv', 'timestamp,latency_ms,status\n'), message: 'header-only.csv has no requests in it.' },
  { why: 'a single line of prose', f: file('one.txt', 'hello world'), message: 'one.txt has no requests in it.' },
  { why: 'an empty JSON array', f: file('empty.json', '[]'), message: 'empty.json has no requests in it.' },
  { why: 'a JSONL file cut inside its first line', f: file('first-line-cut.jsonl', '{"timestamp":"2026-03-02T02:00:00Z","laten'), message: 'first-line-cut.jsonl has no requests in it.' },
  { why: 'a JSON array cut mid-string', f: file('cut.json', '[{"timestamp":"2026-03-02T02:00:00Z","latency_ms":1000},{"timestamp":"2026-'), message: /^cut\.json: .*JSON/ },
]

/** Files that open the mapping and validation report but contain no usable request: Import stays disabled. */
const UNUSABLE = [
  { why: 'only whitespace', f: file('blank.csv', ' \n\t\n'), report: '0 requests ready of 1 rows, 1 skipped.', issues: ['Map a column to "Request time".'] },
  { why: 'prose', f: file('notes.txt', 'hello world\nthis is not a log\nat all\n'), report: '0 requests ready of 2 rows, 2 skipped.', issues: ['Map a column to "Request time".'] },
  { why: 'binary data named .csv', f: file('image.csv', PNG), report: '0 requests ready of 3 rows, 3 skipped.', issues: ['Map a column to "Request time".'] },
  { why: 'JSON from an unrelated API', f: file('other.json', '{"hello":"world"}'), report: '0 requests ready of 1 rows, 1 skipped.', issues: ['Map a column to "Request time".'] },
  { why: 'a CSV with no time column', f: file('no-time.csv', 'latency_ms,status\n1000,200\n900,200\n'), report: '0 requests ready of 2 rows, 2 skipped.', issues: ['Map a column to "Request time".'] },
  { why: 'a CSV whose times are not times', f: file('bad-times.csv', 'timestamp,latency_ms\nyesterday,1000\nlater,900\n'), report: '0 requests ready of 2 rows, 2 skipped.', issues: ['Unreadable request time "yesterday"', 'Unreadable request time "later"'] },
  { why: 'a CSV with neither latency nor token counts', f: file('no-latency.csv', 'timestamp,status\n2026-03-02T02:00:00Z,200\n2026-03-02T02:10:00Z,200\n'), report: '0 requests ready of 2 rows, 2 skipped.', issues: ['Map "Latency" or "Finished at" so latency can be computed (or token columns to estimate it).'] },
]

/** Nothing was imported, so no endpoint page may offer a recommendation, a config or a report. */
async function expectNoRecommendation(page: import('@playwright/test').Page) {
  for (const t of ['Policy sweep', 'Config & SLO', 'Replay', 'Forecast']) {
    await tab(page, t).click()
    await expect(page.getByRole('heading', { name: 'Import request logs' })).toBeVisible() // the Data page stands in for every tab
    await expect(page.getByText(/Cheapest policy|No policy in the grid|Nothing in the sweep meets|recommended policy/i)).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Use this policy|Make it current/ })).toHaveCount(0)
    await expect(page.locator('.kpi')).toHaveCount(0)
    await expect(page.locator('td.cell')).toHaveCount(0)
  }
  const id = page.url().match(/\/app\/p\/([0-9a-f-]+)/)![1]
  await page.goto(`/app/p/${id}/report`)
  await expect(page.getByRole('heading', { name: 'Nothing to report' })).toBeVisible()
  await page.goto('/app')
  const card = page.locator('.project-card')
  await expect(card).toHaveCount(1)
  await expect(card.locator('dd').first()).toHaveText('0') // requests
  await expect(card).toContainText('Last p99—')
}

test.describe('files the importer refuses', () => {
  for (const { why, f, message } of REFUSED) {
    test(`${why}: says so, imports nothing, no recommendation, app stays usable`, async ({ page }) => {
      await chooseFiles(page, f)
      await expect(page.getByRole('status').filter({ hasText: message }).first()).toBeVisible()
      await expect(page.getByLabel('Detected format')).toHaveCount(0)
      await expect(page.getByRole('button', { name: /^Import \d/ })).toHaveCount(0)
      await expectNoRecommendation(page)
    })
  }
})

test.describe('files with no usable request', () => {
  for (const { why, f, report, issues } of UNUSABLE) {
    test(`${why}: reports the problem by line, cannot be imported, no recommendation`, async ({ page }) => {
      await chooseFiles(page, f)
      await expect(page.getByText(report, { exact: true })).toBeVisible()
      const log = page.getByRole('log', { name: 'Validation issues' })
      for (const message of issues) await expect(log).toContainText(message)
      await expect(log.locator('.ln').first()).toHaveText(/^line \d+$/)
      await expect(page.getByRole('button', { name: 'Import 0 requests' })).toBeDisabled()
      await expectNoRecommendation(page)
    })
  }
})

test('a refused file does not block a good one', async ({ page }) => {
  await chooseFiles(page, file('empty.csv', ''))
  await expect(page.getByRole('status').filter({ hasText: 'empty.csv has no requests in it.' }).first()).toBeVisible()
  await page.locator('input[type=file]').setInputFiles(file('good.csv', GOOD))
  await page.getByRole('button', { name: 'Import 3 requests' }).click()
  await expect(kpi(page, 'Requests').locator('b')).toHaveText('3')
  await page.goto('/app')
  await expect(page.locator('.project-card')).toHaveCount(1)
})

test.describe('truncated files: the readable rows are offered, the cut one is reported by line and skipped', () => {
  test('CSV cut inside the last timestamp', async ({ page }) => {
    await chooseFiles(page, file('cut.csv', GOOD.slice(0, GOOD.lastIndexOf('\n2026') + 12)))
    await expect(page.getByText(/^2 requests ready of 3 rows, 1 skipped\. Range 2026-03-02 02:00 to 2026-03-02 02:10 UTC/)).toBeVisible()
    const log = page.getByRole('log', { name: 'Validation issues' })
    await expect(log).toContainText('line 4')
    await expect(log).toContainText('Unreadable request time "2026-03-02T"')
    await page.getByRole('button', { name: 'Import 2 requests' }).click()
    await expect(kpi(page, 'Requests').locator('b')).toHaveText('2')
    await tab(page, 'Data').click()
    const row = page.locator('tbody tr')
    await expect(row.locator('td').nth(1)).toHaveText('2') // rows
    await expect(row.locator('td').nth(2)).toHaveText('1') // skipped
  })

  test('JSONL cut inside the last line', async ({ page }) => {
    await chooseFiles(page, file('cut.jsonl', JSONL + '{"timestamp":"2026-03-02T12:00:00Z","laten'))
    await expect(page.getByText(/^2 requests ready of 3 rows, 1 skipped\./)).toBeVisible()
    const log = page.getByRole('log', { name: 'Validation issues' })
    await expect(log).toContainText('line 3')
    await expect(log).toContainText('Not valid JSON; skipped')
    await page.getByRole('button', { name: 'Import 2 requests' }).click()
    await expect(kpi(page, 'Requests').locator('b')).toHaveText('2')
  })

  test('a malformed line in the middle of a JSONL file is reported at its line number', async ({ page }) => {
    await chooseFiles(page, file('middle.jsonl', '{"timestamp":"2026-03-02T02:00:00Z","latency_ms":1000}\nnot json at all\n{"timestamp":"2026-03-02T02:10:00Z","latency_ms":1000}\n'))
    await expect(page.getByText(/^2 requests ready of 3 rows, 1 skipped\./)).toBeVisible()
    await expect(page.getByRole('log', { name: 'Validation issues' })).toContainText('line 2')
  })
})

test('a good fixture still imports after the failures above (guards the fixtures themselves)', async ({ page }) => {
  await importFile(page, fixture('tiny.csv'), 3)
})
