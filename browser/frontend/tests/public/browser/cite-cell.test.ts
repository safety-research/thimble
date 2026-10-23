// A table's cited cell (lib/tableCell CITED, styles/refchip.css) in a card's table drawn by Output (canvas/FrameTable),
// with thimble's own stylesheets, in a real browser: the cell a takeaway's citation points at is the accent's wash,
// with no edge, border or ink box, on Warm and on Dark, and so is a cell flashed after a click (lib/tableCell
// revealCell).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let page: Page

const FRAME = {
  'application/vnd.thimble.frame+json': {
    columns: ['agent', 'tokens', 'merged'],
    types: { agent: 'nominal', tokens: 'quantitative', merged: 'quantitative' },
    index: 'agent',
    rows: [['agent-01', 9087, 3], ['agent-02', 12410, 5], ['agent-03', 7310, 2]],
    total: 3,
    label: 'agent',
    view: { columns: ['tokens', 'merged'], formats: { tokens: ',d', merged: ',d' }, more: 0 },
  },
  'text/plain': 'agent     tokens  merged\nagent-01  9,087   3',
}

beforeAll(async () => {
  const script = await bundle(
    'cite-cell',
    [
      `import '${src('styles/index.css')}'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { flushSync } from 'react-dom'`,
      `import { Output } from '${src('components/Outputs.tsx')}'`,
      `window.__t = { table: (b) => { const el = document.createElement('div'); el.className = 'canvas-card'; el.style.width = '420px'; document.body.appendChild(el); flushSync(() => createRoot(el).render(<Output bundle={b} card />)) } }`,
    ],
    { loader: { '.css': 'css', '.woff2': 'empty', '.woff': 'empty' }, conditions: ['style'] },
  )
  const css = script.replace(/\.js$/, '.css')
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  await page.route('**/*', (route) => {
    const p = new URL(route.request().url()).pathname
    if (p === '/bundle.css') return route.fulfill({ status: 200, contentType: 'text/css', body: readFileSync(css) })
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body></body></html>' })
  })
  await page.goto(`${ORIGIN}/`)
  await page.addScriptTag({ path: script })
  await page.evaluate((b) => (window as any).__t.table(b), FRAME)
  await page.waitForSelector('.canvas-card .outputs-html td.outputs-num')
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

/** The cell 9,087 marked with `cls`, its drawn background, edge and border, and the colours its tokens resolve to. */
const marked = (p: Page, cls: string) =>
  p.evaluate((cls) => {
    const td = [...document.querySelectorAll<HTMLElement>('.canvas-card td')].find((t) => t.textContent?.trim() === '9,087')!
    td.className = td.className.replace(/\bcite-cell(-flash)?\b/g, '').trim()
    const edges = () => {
      const c = getComputedStyle(td)
      return ['Top', 'Right', 'Bottom', 'Left'].map((k) => `${c.getPropertyValue(`border-${k.toLowerCase()}-width`)} ${c.getPropertyValue(`border-${k.toLowerCase()}-color`)}`).join(', ')
    }
    const plain = edges()
    td.classList.add(cls)
    const swatch = (v: string) => {
      const s = document.createElement('div')
      s.style.background = `var(${v})`
      document.body.appendChild(s)
      const c = getComputedStyle(s).backgroundColor
      s.remove()
      return c
    }
    const cs = getComputedStyle(td)
    const got = { bg: cs.backgroundColor, shadow: cs.boxShadow, border: edges(), plain, outline: cs.outlineStyle, accent: swatch('--accent-wash'), ink: swatch('--hl-bg') }
    td.classList.remove(cls)
    return got
  }, cls)

for (const paper of ['warm', 'dark'])
  test(`on ${paper === 'warm' ? 'Warm' : 'Dark'} a card table's cited cell is the accent's wash with no edge, and so is a flashed one`, async () => {
    await page.evaluate((paper) => {
      document.documentElement.setAttribute('data-paper', paper)
      document.documentElement.setAttribute('data-theme', paper === 'dark' ? 'dark' : 'light')
    }, paper)
    const cited = await marked(page, 'cite-cell')
    assert.equal(cited.bg, cited.accent, `the cited cell's fill is the accent's wash ${JSON.stringify(cited)}`)
    assert.notEqual(cited.bg, cited.ink, `not the ink highlight ${JSON.stringify(cited)}`)
    assert.equal(cited.shadow, 'none', `no edge drawn inside the cell ${JSON.stringify(cited)}`)
    assert.equal(cited.border, cited.plain, `its borders are the table's own, no box of its own ${JSON.stringify(cited)}`)
    assert.equal(cited.outline, 'none')
    // the flash after a click starts at the same wash, with no edge
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    const flashed = await marked(page, 'cite-cell-flash')
    assert.equal(flashed.bg, flashed.accent, `the flashed cell starts at the accent's wash ${JSON.stringify(flashed)}`)
    assert.equal(flashed.shadow, 'none', `the flashed cell has no edge ${JSON.stringify(flashed)}`)
  })
