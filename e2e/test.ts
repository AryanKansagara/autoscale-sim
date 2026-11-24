import { expect, test as base } from '@playwright/test'

// Every test is signed out and offline-safe:
//  - requests to the app itself pass through;
//  - Google Fonts (linked from index.html) is stubbed with an empty response;
//  - anything else, including Supabase, is aborted and recorded.
// After each test the suite fails on uncaught page errors and on any
// request that was not the app or the stubbed font hosts.
const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com'])

export const test = base.extend<{ blocked: string[]; pageErrors: string[] }>({
  blocked: [async ({ context }, use) => {
    const blocked: string[] = []
    await context.route(/^https?:\/\//, route => {
      const url = new URL(route.request().url())
      if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return route.continue()
      if (FONT_HOSTS.has(url.hostname)) return route.fulfill({ status: 200, contentType: url.hostname === 'fonts.googleapis.com' ? 'text/css' : 'font/woff2', body: '' })
      blocked.push(`${url.protocol}//${url.host}${url.pathname}`)
      return route.abort('blockedbyclient')
    })
    await use(blocked)
    expect(blocked, 'the app must not call any external host').toEqual([])
  }, { auto: true }],

  pageErrors: [async ({ page }, use) => {
    const errors: string[] = []
    page.on('pageerror', e => errors.push(e.message))
    await use(errors)
    expect(errors, 'uncaught page errors').toEqual([])
  }, { auto: true }],
})

export { expect }
