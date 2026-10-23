// The top bar's workspace switcher (src/shell/TopBar.tsx WorkspaceSwitcher, the start page's rows), drawn with the app's
// stylesheets in headless Chromium on a made-up origin that answers GET /api/workspaces itself: the switcher's sheet
// opens under the folder name inside the window, with the workspace the page shows marked, and a click on a row
// navigates to that workspace.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let dir = ''

const ROWS = [
  { name: 'collusion-wiki', kind: 'demo', folder: 'collusion-wiki', path: '/home/ana/.thimble/demo/collusion-wiki', dataset: 'collusion-wiki', title: 'collusion.wiki', blurb: 'Logs of a small wiki that a swarm of AI agents used as a message board.', ready: true },
  { name: 'mythos-5', kind: 'demo', folder: 'mythos-5', path: '/home/ana/.thimble/demo/mythos-5', dataset: 'mythos-5', title: 'Mythos 5', blurb: 'The transcript Anthropic released of Mythos 5 during a cybersecurity evaluation.', ready: true },
  { name: 'transluce-urlquery', kind: 'demo', folder: 'transluce-urlquery', path: '/home/ana/.thimble/demo/transluce-urlquery', dataset: 'transluce-urlquery', title: 'urlquery', blurb: '38,160 urlquery.net scans that Transluce found were likely made by AI agents.', ready: false },
  { name: 'example-linked-sessions', kind: 'example', folder: 'example-linked-sessions', path: '/home/ana/.thimble/examples/example-linked-sessions', view: { slug: 'linked-sessions', name: 'Linked sessions' } },
  { name: 'example-timeline', kind: 'example', folder: 'example-timeline', path: '/home/ana/.thimble/examples/example-timeline', view: { slug: 'timeline', name: 'Timeline' } },
  { name: 'logs', kind: 'folder', folder: 'logs', path: '/home/ana/research/runs/2026-09/logs' },
]
const MIME: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff' }

beforeAll(async () => {
  const script = await bundle(
    'start-page',
    [
      `import '${src('styles/index.css')}'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { applyTheme } from '${src('lib/theme.ts')}'`,
      `import { StartPage } from '${src('shell/StartPage.tsx')}'`,
      `import { WorkspaceSwitcher } from '${src('shell/TopBar.tsx')}'`,
      `applyTheme()`,
      `const q = new URLSearchParams(location.search)`,
      `const root = createRoot(document.getElementById('root')!)`,
      `root.render(q.get('switcher')`,
      `  ? <header className="shell-topbar"><span className="shell-brand" style={{ width: 322 }}><span className="shell-word">thimble</span><WorkspaceSwitcher ws={q.get('switcher')!} label={'~/.thimble/demo/' + q.get('switcher')} /></span></header>`,
      `  : <StartPage />)`,
    ],
    {
      loader: { '.css': 'css', '.woff2': 'file', '.woff': 'file', '.json': 'json' },
      conditions: ['style'],
      assetNames: '[name]-[hash]',
      publicPath: '/',
      define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.BASE_URL': '"/"' },
    },
  )
  dir = path.dirname(script)
  browser = await launch()
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

/** A page of `width`×`height` on `paper`, opened at `query`. */
async function open(width: number, height: number, paper: string, query = ''): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height } })
  page.on('pageerror', (e) => console.warn('page error:', e.message))
  await page.route('**/*', (route) => {
    const p = new URL(route.request().url()).pathname
    if (p === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>' })
    if (p === '/api/workspaces') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ROWS) })
    const file = path.join(dir, p)
    if (existsSync(file)) return route.fulfill({ status: 200, contentType: MIME[path.extname(file)] ?? 'application/octet-stream', body: readFileSync(file) })
    return route.fulfill({ status: 404, body: '' })
  })
  await page.addInitScript((paper) => window.localStorage.setItem('thimble:paper', paper), paper)
  await page.goto(`${ORIGIN}/${query}`)
  await page.evaluate(() => document.fonts.ready)
  return page
}

const within = (inner: { left: number; right: number; top: number; bottom: number }, outer: { left: number; right: number; top: number; bottom: number }) =>
  inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5 && inner.top >= outer.top - 0.5 && inner.bottom <= outer.bottom + 0.5

/** The luminance of a computed `rgb(...)` colour, 0 to 1. */
const lum = (rgb: string) => {
  const [r, g, b] = (rgb.match(/[\d.]+/g) ?? ['0', '0', '0']).slice(0, 3).map(Number)
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
}

test('the folder name opens the switcher under it, this workspace marked, and a row goes to its workspace', async () => {
  const page = await open(1280, 800, 'warm', '?switcher=mythos-5')
  await page.click('button.shell-corpus-name')
  await page.waitForSelector('.popover.ws-switcher a.ws-row')
  // the sheet's opening scales it a little: measured once that ends
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)))
  const got = await page.evaluate(() => {
    const sheet = document.querySelector('.popover.ws-switcher')!.getBoundingClientRect()
    const button = document.querySelector('button.shell-corpus-name')!.getBoundingClientRect()
    const rows = [...document.querySelectorAll('.popover.ws-switcher a.ws-row')]
    return {
      sheet: { left: sheet.left, right: sheet.right, top: sheet.top, bottom: sheet.bottom },
      under: sheet.top >= button.bottom - 0.5 && Math.abs(sheet.left - button.left) < 2,
      groups: [...document.querySelectorAll('.popover.ws-switcher .ws-group-title')].map((h) => h.textContent),
      current: rows.filter((r) => r.getAttribute('aria-current') === 'page').map((r) => r.getAttribute('data-ws')),
      rowsInside: rows.every((r) => {
        const b = r.getBoundingClientRect()
        return b.left >= sheet.left && b.right <= sheet.right + 0.5
      }),
      bg: getComputedStyle(document.querySelector('.popover.ws-switcher')!).backgroundColor,
    }
  })
  assert.ok(within(got.sheet, { left: 0, right: 1280, top: 0, bottom: 800 }), `the sheet lies in the window ${JSON.stringify(got.sheet)}`)
  assert.ok(got.under, `the sheet hangs under the folder name ${JSON.stringify(got)}`)
  assert.deepEqual(got.groups, ['Demo', 'Examples', 'Your folders'])
  assert.deepEqual(got.current, ['mythos-5'])
  assert.ok(got.rowsInside, 'every row lies in the sheet')
  assert.ok(lum(got.bg) > 0.9, `the sheet's paper: ${got.bg}`)
  await Promise.all([page.waitForURL(/\?ws=logs$/), page.click('.popover.ws-switcher a.ws-row[data-ws="logs"]')])
  await page.close()
})
