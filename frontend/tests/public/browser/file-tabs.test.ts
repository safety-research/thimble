// The File browser's tabs (src/files/FilesTab.tsx ReaderTabs) in a reader bar as wide as the one thimble draws with the
// chat column and the Files sidebar open: 845 px at 1440x900, 1325 px at 1920x1080, and 505 px in a window 1100 px wide.
// Drawn with the app's stylesheets and Hanken Grotesk in headless Chromium, with six tabs and each in turn open, it
// proves with getBoundingClientRect that every tab shown and the button of the menu that holds the others lie inside
// the strip, before the bar's own buttons; the open tab's name shows whole; every other tab shown is at least
// TAB_MIN_PX wide or shows its whole name; the menu lists exactly the tabs not shown and opens one; and the × of a tab
// other than the open one shows on hover without changing any tab's width.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let page: Page

const TABS = ['README.md', 'chat_messages.jsonl', 'claude_code_messages.jsonl', 'computer_use_turns.jsonl', 'village-transcript.jsonl', 'notes/day1/NOTES.md']
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

for (const [label, width] of [['1440x900', 845], ['1920x1080', 1325], ['1100 wide', 505]] as const) {
  test(`at ${label} (a ${width} px bar) six tabs fit or go in the menu, the open one whole, each other one readable`, async () => {
    for (const first of TABS) {
      await page.evaluate(([w, paths, f]) => (window as any).__bar(w, paths, f), [width, TABS, first] as const)
      await frames(3)
      const g = await page.evaluate(GEO)
      const tag = `${label}, ${first} open`
      assert.ok(g.font === 'Hanken Grotesk' && g.fontLoaded, `${tag}: drawn in Hanken Grotesk ${g.font}`)
      const base = first.slice(first.lastIndexOf('/') + 1)
      const active = g.tabs.filter((t) => t.active)
      assert.ok(active.length === 1 && active[0].name === base && active[0].whole, `${tag}: the open tab shows its whole name ${JSON.stringify(active)}`)
      for (const t of g.tabs) {
        assert.ok(t.inside, `${tag}: ${t.name} lies inside the strip ${JSON.stringify(t)} (strip ends at ${g.end})`)
        assert.ok(t.active || t.whole || t.w >= g.min - 0.5, `${tag}: ${t.name} is ${t.w} px wide, at least ${g.min} or its whole name`)
      }
      assert.ok(g.end <= g.find + 0.5, `${tag}: the strip ends before the bar's own buttons`)
      const hidden = TABS.length - g.tabs.length
      if (hidden) {
        assert.ok(g.more && g.more.inside && g.more.text === `${hidden} more`, `${tag}: the menu button counts the ${hidden} tabs not shown and lies in the strip ${JSON.stringify(g)}`)
      } else {
        assert.equal(g.more, null, `${tag}: no menu when every tab shows`)
      }
      if (width >= 1300) assert.equal(hidden, 0, `${tag}: all six tabs show`)
      if (width === 845) assert.ok(g.tabs.length >= 4, `${tag}: at least four tabs show (${g.tabs.length})`)
    }
  }, 60_000)
}

test('the menu lists the tabs not shown and opens one, which then shows whole', async () => {
  await page.evaluate(([w, paths, f]) => (window as any).__bar(w, paths, f), [845, TABS, 'village-transcript.jsonl'] as const)
  await frames(3)
  const before = await page.evaluate(GEO)
  const shown = new Set(before.tabs.map((t) => t.name))
  const hidden = TABS.map((p) => p.slice(p.lastIndexOf('/') + 1)).filter((n) => !shown.has(n))
  assert.ok(hidden.length > 0, 'some tabs are in the menu')
  await page.click('.reader-tabs-wrap > .menu-trigger .reader-tabs-more')
  await frames(3)
  const items = await page.evaluate(() => [...document.querySelectorAll('.popover .menu-item .menu-label, .popover .menu-item')].filter((e) => e.classList.contains('menu-item')).map((e) => e.textContent ?? ''))
  assert.equal(items.length, hidden.length, `the menu lists ${hidden.length} tabs ${JSON.stringify(items)}`)
  hidden.forEach((n, i) => assert.ok(items[i].startsWith(n), `item ${i} is ${n}: ${items[i]}`))
  await page.click('.popover .menu-item >> nth=0')
  await frames(3)
  const after = await page.evaluate(GEO)
  const open = after.tabs.find((t) => t.active)!
  assert.ok(open.name === hidden[0] && open.whole && open.inside, `the tab picked from the menu shows whole ${JSON.stringify(open)}`)
})

test('the × of a tab other than the open one shows on hover, over its name, and no tab changes width', async () => {
  await page.evaluate(([w, paths, f]) => (window as any).__bar(w, paths, f), [1325, TABS, 'README.md'] as const)
  await frames(3)
  const widths = () => page.evaluate(() => [...document.querySelectorAll('.reader-tabs > .reader-tab')].map((t) => t.getBoundingClientRect().width))
  const before = await widths()
  const x0 = await page.evaluate(() => getComputedStyle(document.querySelectorAll('.reader-tabs > .reader-tab')[2].querySelector('.reader-tab-x')!).opacity)
  await page.hover('.reader-tabs > .reader-tab >> nth=2')
  await frames(3)
  const got = await page.evaluate(() => {
    const t = document.querySelectorAll('.reader-tabs > .reader-tab')[2]
    const b = t.getBoundingClientRect(), x = t.querySelector('.reader-tab-x')!, xb = x.getBoundingClientRect()
    return { opacity: getComputedStyle(x).opacity, inside: xb.left >= b.left && xb.right <= b.right && xb.top >= b.top && xb.bottom <= b.bottom }
  })
  assert.equal(x0, '0', 'hidden until hover')
  assert.ok(got.opacity === '1' && got.inside, `the × shows inside the tab ${JSON.stringify(got)}`)
  assert.deepEqual(await widths(), before, 'no tab changes width on hover')
})
