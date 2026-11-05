// The top bar (src/shell/TopBar.tsx) at a phone's width. A window narrower than all the bar holds once left the gear
// past its right edge, and the page scrolled sideways to reach it. Now the tools stay at the bar's right end, the gear
// among them, what does not fit scrolls under them inside the bar, and the page keeps the window's width; the gear's
// Settings opens inside the window. On a wide window the bar is as it was: nothing scrolls and the gear sits 16 px from
// the right edge. Drawn with the app's stylesheets in headless Chromium over a server the test answers.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let page: Page

const MIME: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff' }
const conf = (effort: string) => ({ model: 'claude-opus-5-5', effort, fast: false })
const SETTINGS = { models: { writer: conf('xhigh'), dev: conf('high'), checks: conf('high'), labels: conf('low'), verify: conf('high'), suggest: conf('medium') }, config_error: '' }

beforeAll(async () => {
  const script = await bundle(
    'topbar-narrow',
    [
      `import '${src('styles/index.css')}'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { TopBar } from '${src('shell/TopBar.tsx')}'`,
      `const tabs = [{ value: 'files', label: 'Files', state: 'focus' }, { value: 'canvas', label: 'Canvas', state: 'hidden' }, { value: 'report', label: 'Report', state: 'hidden' }]`,
      `createRoot(document.getElementById('root')!).render(<div className="shell"><TopBar ws="mini" tabs={tabs} onTab={() => {}} onTabDrag={() => {}} side={null} onSide={() => {}} /></div>)`,
    ],
    {
      loader: { '.css': 'css', '.woff2': 'file', '.woff': 'file', '.json': 'json' },
      conditions: ['style'],
      assetNames: '[name]-[hash]',
      publicPath: '/',
      define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.BASE_URL': '"/"' },
    },
  )
  const dir = path.dirname(script)
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  page.on('pageerror', (e) => console.warn('page error:', e.message))
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url())
    const p = url.pathname
    const json = (v: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(v) })
    if (p === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>' })
    if (p.startsWith('/api/')) {
      if (p.endsWith('/settings')) return json(SETTINGS)
      if (p.endsWith('/chats/main')) return json({ meta: { id: 'main', attached: null }, events: [] })
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{"detail":"not found"}' })
    }
    const file = path.join(dir, p)
    if (existsSync(file)) return route.fulfill({ status: 200, contentType: MIME[path.extname(file)] ?? 'application/octet-stream', body: readFileSync(file) })
    return route.fulfill({ status: 404, body: '' })
  })
  await page.goto(`${ORIGIN}/`)
  await page.waitForSelector('[data-tel="settings"]')
}, 60_000)

afterAll(async () => {
  await browser?.close()
  cleanup()
})

/** In the page: the window's width, how wide the page and the bar scroll, and the gear's box. */
const MEASURE = () => {
  const bar = document.querySelector('.shell-topbar')!
  const gear = document.querySelector('[data-tel="settings"]')!.getBoundingClientRect()
  return { inner: innerWidth, page: document.documentElement.scrollWidth, bar: bar.scrollWidth, barBox: bar.clientWidth, left: gear.left, right: gear.right }
}

test('on a phone the gear stays in the window, the page keeps its width, and Settings opens inside it', async () => {
  await page.setViewportSize({ width: 390, height: 844 })
  const m = await page.evaluate(MEASURE)
  assert.ok(m.bar > m.barBox, `the bar holds more than the window (${m.bar} px in ${m.barBox} px)`)
  assert.equal(m.page, m.inner, 'the page does not scroll sideways')
  assert.ok(m.left >= 0 && m.right <= m.inner, `the gear lies inside the window (${m.left}–${m.right} of ${m.inner})`)
  // what scrolls under the tools inside the bar leaves the gear where it is
  await page.evaluate(() => document.querySelector('.shell-topbar')!.scrollTo({ left: 10_000 }))
  assert.equal((await page.evaluate(MEASURE)).right, m.right)
  await page.click('[data-tel="settings"]')
  const pop = await (await page.waitForSelector('.settings-pop .settings-row')).evaluate((el) => el.closest('.settings-pop')!.getBoundingClientRect().toJSON())
  assert.ok(pop.left >= 0 && pop.right <= m.inner, `Settings lies inside the window (${pop.left}–${pop.right})`)
  await page.keyboard.press('Escape')
}, 60_000)

test('on a wide window the bar does not scroll and the gear sits 16 px from the right edge, as before', async () => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const m = await page.evaluate(MEASURE)
  assert.equal(m.bar, m.barBox)
  assert.equal(m.page, m.inner)
  assert.equal(m.right, m.inner - 16)
}, 60_000)
