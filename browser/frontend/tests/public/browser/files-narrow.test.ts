// The File browser (src/files/FilesTab.tsx) in a narrow pane, as the chat column, a side panel or a split layout leaves
// it. The files tree docks only while the pane holds it beside the reader at a readable width (shell/dock.tsx); in a
// narrower pane it folds to its show button. A workspace with no README opens with no file, so the column then showed
// its bar and nothing under it. Drawn with the app's stylesheets in headless Chromium over a server the test answers,
// FilesTab at pane widths from 1100 px down to 200 px shows the workspace's files at each: in the tree beside the
// column while it docks, else in the column, every row inside the pane, and a row opens its file.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let page: Page

const MIME: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff' }
// a workspace with no README, so no file opens by itself
const LISTING = {
  path: '',
  folders: [{ path: 'agents', name: 'agents', n_files: 2 }],
  files: [
    { path: 'board.jsonl', name: 'board.jsonl', size_bytes: 15000, kind: 'jsonl' },
    { path: 'events.jsonl', name: 'events.jsonl', size_bytes: 61000, kind: 'jsonl' },
    { path: 'manifest.json', name: 'manifest.json', size_bytes: 419, kind: 'json' },
  ],
  n_files: 5,
}

beforeAll(async () => {
  const script = await bundle(
    'files-narrow',
    [
      `import '${src('styles/index.css')}'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { FilesTab } from '${src('files/FilesTab.tsx')}'`,
      `let root = null`,
      `;(window as any).__files = (width, ws) => {`,
      `  root?.unmount()`,
      `  root = createRoot(document.getElementById('root')!)`,
      `  root.render(<div className="files-pane-box" style={{ width, height: 700, display: 'flex', flexDirection: 'column' }}><FilesTab ws={ws} active /></div>)`,
      `}`,
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
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  page.on('pageerror', (e) => console.warn('page error:', e.message))
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url())
    const p = url.pathname
    const json = (v: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(v) })
    if (p === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>' })
    if (p.startsWith('/api/')) {
      if (p.endsWith('/sources')) return json(url.searchParams.get('path') === 'agents' ? { path: 'agents', folders: [], files: [], n_files: 0 } : LISTING)
      if (p.endsWith('/views') || p.endsWith('/views/proposals') || p.endsWith('/chats') || p.endsWith('/concepts')) return json([])
      if (p.endsWith('/filters') || p.endsWith('/labels/presence')) return json({})
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{"detail":"not found"}' })
    }
    const file = path.join(dir, p)
    if (existsSync(file)) return route.fulfill({ status: 200, contentType: MIME[path.extname(file)] ?? 'application/octet-stream', body: readFileSync(file) })
    return route.fulfill({ status: 404, body: '' })
  })
  await page.goto(`${ORIGIN}/`)
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

/** In the page: the pane, whether the tree shows, and the rows of the files shown inside the pane. */
const SEEN = () => {
  const pane = document.querySelector('.files-tab')!.getBoundingClientRect()
  const rows = [...document.querySelectorAll<HTMLElement>('.files-tab .files-row')].map((r) => {
    const b = r.getBoundingClientRect()
    const name = r.querySelector('.files-name')!
    const nb = name.getBoundingClientRect()
    return { name: name.textContent ?? '', inside: b.width > 0 && b.height > 0 && nb.left >= pane.left - 0.5 && nb.left < pane.right && b.bottom <= pane.bottom + 0.5 }
  })
  return { width: Math.round(pane.width), tree: !!document.querySelector('.files-side-tree'), rows }
}

let n = 0
for (const width of [1100, 700, 480, 320, 200]) {
  test(`a ${width} px Files pane with no file open shows the workspace's files`, async () => {
    const ws = `narrow${++n}`
    await page.evaluate(([w, s]) => { localStorage.clear(); (window as any).__files(w, s) }, [width, ws] as const)
    await page.waitForFunction(() => document.querySelectorAll('.files-tab .files-row').length > 0, null, { timeout: 5_000 }).catch(() => undefined)
    await page.waitForTimeout(200)
    const seen = await page.evaluate(SEEN)
    const names = seen.rows.filter((r) => r.inside).map((r) => r.name)
    for (const f of ['agents', 'board.jsonl', 'events.jsonl', 'manifest.json']) {
      assert.ok(names.includes(f), `${width} px: ${f} shows inside the pane ${JSON.stringify(seen)}`)
    }
    if (width >= 1100) assert.ok(seen.tree, `${width} px: the tree docks beside the column`)
    if (width <= 480) assert.ok(!seen.tree, `${width} px: the tree folds, the column lists the files`)
  })
}

test('in a narrow pane a row of the column opens its file in a tab', async () => {
  await page.evaluate(([w, s]) => { localStorage.clear(); (window as any).__files(w, s) }, [320, `narrow${++n}`] as const)
  await page.waitForSelector('.files-main .folder-pane-row', { timeout: 5_000 })
  await page.click('.files-main .folder-pane-row:has-text("board.jsonl")')
  await page.waitForSelector('.reader-tabs > .reader-tab.active', { timeout: 5_000 })
  const tab = await page.evaluate(() => document.querySelector('.reader-tabs > .reader-tab.active .reader-tab-name')?.textContent)
  assert.equal(tab, 'board.jsonl')
})
