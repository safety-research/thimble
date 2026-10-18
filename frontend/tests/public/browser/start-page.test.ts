// thimble's start page (src/shell/StartPage.tsx), drawn with the app's stylesheets in headless Chromium on a made-up
// origin that answers GET /api/workspaces itself: at a phone's width nothing scrolls sideways and the sentence goes
// under the name.
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

/** In the page: the column, its groups and rows, measured. */
const GEO = () => {
  const box = (e: Element | null) => {
    if (!e) return null
    const b = e.getBoundingClientRect()
    return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width }
  }
  const main = document.querySelector('.start-main')!
  return {
    title: document.querySelector('.start-title')?.textContent ?? '',
    main: box(main)!,
    groups: [...document.querySelectorAll('.ws-group')].map((g) => ({ title: g.querySelector('.ws-group-title')!.textContent, box: box(g)! })),
    rows: [...document.querySelectorAll('a.ws-row')].map((r) => ({
      name: r.querySelector('.ws-row-name')!.textContent,
      row: box(r)!,
      nameBox: box(r.querySelector('.ws-row-name'))!,
      about: box(r.querySelector('.ws-row-about'))!,
      chip: box(r.querySelector('.chip')),
      clipped: (r.querySelector('.ws-row-about') as HTMLElement).scrollWidth > (r.querySelector('.ws-row-about') as HTMLElement).clientWidth + 1,
    })),
    scrollX: document.documentElement.scrollWidth - window.innerWidth,
    bg: getComputedStyle(document.body).backgroundColor,
    rowsBg: getComputedStyle(document.querySelector('.ws-rows')!).backgroundColor,
    ink: getComputedStyle(document.querySelector('.ws-row-name')!).color,
  }
}

const within = (inner: { left: number; right: number; top: number; bottom: number }, outer: { left: number; right: number; top: number; bottom: number }) =>
  inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5 && inner.top >= outer.top - 0.5 && inner.bottom <= outer.bottom + 0.5

test('at a phone\'s width nothing scrolls sideways and the sentence goes under the name', async () => {
  const page = await open(390, 800, 'warm')
  await page.waitForSelector('a.ws-row')
  const g = await page.evaluate(GEO)
  await page.close()
  assert.ok(g.scrollX <= 0, `nothing scrolls sideways (${g.scrollX})`)
  for (const r of g.rows) {
    assert.ok(within(r.row, { left: 0, right: 390, top: -1e6, bottom: 1e6 }), `${r.name}: its row fits the width ${JSON.stringify(r.row)}`)
    assert.ok(r.about.top >= r.nameBox.bottom - 0.5, `${r.name}: the sentence is under the name ${JSON.stringify(r)}`)
  }
})
