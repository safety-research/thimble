// The File browser's tabs (src/files/FilesTab.tsx ReaderTabs), drawn with the app's stylesheets in headless Chromium:
// with thirty tabs open nothing around the strip can scroll sideways.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let page: Page
const MIME: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff' }

beforeAll(async () => {
  const script = await bundle(
    'file-tabs',
    [
      `import '${src('styles/index.css')}'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { useState } from 'react'`,
      `import { ReaderTabs, TAB_MIN_PX } from '${src('files/FilesTab.tsx')}'`,
      `;(window as any).__min = TAB_MIN_PX`,
      `function Bar({ width, paths, first }) {`,
      `  const [current, setCurrent] = useState(first)`,
      `  ;(window as any).__current = current`,
      `  return (<div className="files-main" style={{ width, height: 300 }}><div className="reader"><div className="reader-bar">`,
      `    <ReaderTabs tabs={paths.map((path) => ({ path }))} current={current} onPick={setCurrent} onClose={() => {}} isDir={() => false} />`,
      `    <span className="reader-spacer" />`,
      `    <button type="button" className="btn btn-ghost btn-sm btn-square bar-find">F</button>`,
      `    <span className="reader-modes bar-modes" style={{ width: 106, flex: 'none' }} />`,
      `  </div></div></div>)`,
      `}`,
      `let root = null`,
      `;(window as any).__bar = (width, paths, first) => {`,
      `  root?.unmount()`,
      `  root = createRoot(document.getElementById('root')!)`,
      `  root.render(<Bar key={Math.random()} width={width} paths={paths} first={first} />)`,
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
  page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
  page.on('pageerror', (e) => console.warn('page error:', e.message))
  await page.route('**/*', (route) => {
    const p = new URL(route.request().url()).pathname
    if (p === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>' })
    const file = path.join(dir, p)
    if (existsSync(file)) return route.fulfill({ status: 200, contentType: MIME[path.extname(file)] ?? 'application/octet-stream', body: readFileSync(file) })
    return route.fulfill({ status: 404, body: '' })
  })
  await page.goto(`${ORIGIN}/`)
  // the tabs measure their names in the face thimble draws them in
  await page.evaluate(async () => {
    const probe = document.createElement('span')
    probe.style.font = '13px "Hanken Grotesk"'
    probe.textContent = 'x'
    document.body.append(probe)
    await document.fonts.load('13px "Hanken Grotesk"')
    await document.fonts.ready
    probe.remove()
  })
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

const frames = (n = 2) => page.evaluate((n) => new Promise<void>((r) => {
  const step = (k: number) => (k ? requestAnimationFrame(() => step(k - 1)) : r())
  step(n)
}), n)

/** In the page: the strip, its tabs and its menu's button, measured. */
const GEO = () => {
  const wrap = document.querySelector('.reader-tabs-wrap')!
  const wb = wrap.getBoundingClientRect()
  const inside = (b: DOMRect) => b.left >= wb.left - 0.5 && b.right <= wb.right + 0.5 && b.top >= wb.top - 0.5 && b.bottom <= wb.bottom + 0.5
  const tabs = [...wrap.querySelectorAll('.reader-tabs > .reader-tab')].map((t) => {
    const b = t.getBoundingClientRect()
    const n = t.querySelector<HTMLElement>('.reader-tab-name')!
    return { name: n.textContent!, active: t.classList.contains('active'), w: b.width, whole: n.scrollWidth <= n.clientWidth + 1, inside: inside(b), right: b.right }
  })
  const more = [...wrap.querySelectorAll<HTMLElement>('.reader-tabs-more')].find((m) => !m.closest('.reader-tabs-measure'))
  const find = document.querySelector('.bar-find')!.getBoundingClientRect()
  return {
    font: getComputedStyle(wrap.querySelector('.reader-tab-name')!).fontFamily.split(',')[0].replace(/["']/g, ''),
    fontLoaded: document.fonts.check('13px "Hanken Grotesk"'),
    tabs,
    more: more ? { text: more.textContent!, inside: inside(more.getBoundingClientRect()), right: more.getBoundingClientRect().right } : null,
    end: wb.right,
    find: find.left,
    min: (window as any).__min as number,
    current: (window as any).__current as string,
  }
}

test('with thirty tabs open nothing around the strip overflows sideways, so no pane can be scrolled to the hidden copy', async () => {
  const many = Array.from({ length: 30 }, (_, i) => `runs/r1/messages-${i + 1}.jsonl`)
  await page.evaluate(([w, paths, f]) => (window as any).__bar(w, paths, f), [845, many, many[2]] as const)
  await frames(3)
  const over = await page.evaluate(() => {
    const out: string[] = []
    for (let p = document.querySelector('.reader-tabs-wrap')!.parentElement; p && p !== document.body; p = p.parentElement) {
      if (p.scrollWidth > p.clientWidth + 1) out.push(`${p.className}: ${p.scrollWidth} > ${p.clientWidth}`)
    }
    return out
  })
  assert.deepEqual(over, [], 'no box around the strip is wider inside than it shows')
  const g = await page.evaluate(GEO)
  assert.ok(g.more && g.more.inside && g.tabs.every((t) => t.inside), `the strip and its menu button fit ${JSON.stringify(g.more)}`)
})
