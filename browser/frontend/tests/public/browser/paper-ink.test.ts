// Text the paper made hard to read takes the ink that reads (I26; src/lib/ink.ts), in a real browser: a custom card's
// page (src/canvas/DataViz.tsx CustomFrame) and a matplotlib figure inlined as SVG (src/components/Outputs.tsx) are
// written for a light page. On Dark, a step box's title that sets no color takes the paper's light ink on the box the
// page filled white, and a figure's black node name on its white or light box; each reads again, on the dark ink. Text
// the page colored itself and that reads keeps its color (a pill, a faint arrow, a section label), a name on the
// figure's own background keeps the paper's light ink, and on Warm nothing changes.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Frame, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let page: Page

const CARD = `<html><head><style>body{margin:0;padding:12px 14px}
.label{font-size:11px;text-transform:uppercase;color:#64748b}
.step{background:#fff;border-left:4px solid #3b82f6;border-radius:6px;padding:9px 12px}
.title{font-weight:600}.desc{color:#475569}.arrow{text-align:center;color:#94a3b8}
.tag{background:#eff6ff;color:#1d4ed8;border-radius:10px;padding:0 8px}</style></head><body>
<div class="label" id="label">The nightly run</div>
<div class="step"><div class="title" id="t1">Scheduler starts the run</div><div class="desc" id="d1">At 02:00.</div><span class="tag" id="tag">cron</span></div>
<div class="arrow" id="arrow">▼</div>
<div class="step"><div class="title" id="t2">Build</div></div>
<svg width="220" height="40"><defs><rect id="box" width="80" height="28" rx="4"/></defs><use href="#box" x="100" y="6" fill="#ffffff"/><text id="u1" x="140" y="25" text-anchor="middle" fill="currentColor">db</text></svg>
</body></html>`

// what matplotlib writes for two node boxes, one white and one light blue, each with its name (no fill: black), and a
// note on the figure's own white background
const FIGURE = `<svg xmlns="http://www.w3.org/2000/svg" width="300pt" height="120pt" viewBox="0 0 300 120">
 <g id="figure_1"><g id="patch_1"><path d="M 0 120 L 300 120 L 300 0 L 0 0 z" style="fill: #ffffff"/></g>
 <g id="axes_1">
  <g id="text_1"><g id="patch_2"><path id="box" d="M 10 20 L 140 20 L 140 60 L 10 60 z" style="fill: #ffffff; stroke: #000000"/></g>
   <text id="name" x="75" y="45" style="font: 14px 'DejaVu Sans'; text-anchor: middle">Scheduler</text></g>
  <g id="text_2"><g id="patch_3"><path id="lightbox" d="M 160 20 L 290 20 L 290 60 L 160 60 z" style="fill: #dbeafe; stroke: #000000"/></g>
   <text id="name2" x="225" y="45" style="font: 14px 'DejaVu Sans'; text-anchor: middle">Build</text></g>
  <g id="text_3"><text id="note" x="150" y="100" style="font: 12px 'DejaVu Sans'; text-anchor: middle">nightly, 02:00</text></g>
 </g></g>
</svg>`

beforeAll(async () => {
  const script = await bundle(
    'paper-ink',
    [
      `import '${src('styles/index.css')}'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { CustomFrame } from '${src('canvas/DataViz.tsx')}'`,
      `import { Output } from '${src('components/Outputs.tsx')}'`,
      `import { setPaper } from '${src('lib/theme.ts')}'`,
      `;(window as any).setPaper = setPaper`,
      `const card = ${JSON.stringify(CARD)}`,
      `const svg = ${JSON.stringify(FIGURE)}`,
      `const root = createRoot(document.getElementById('root')!)`,
      `const tree = () => <div style={{ width: 700, background: 'var(--surface-card)' }}><CustomFrame html={card} title="steps" height={300} /><div id="fig"><Output bundle={{ 'image/svg+xml': svg }} /></div></div>`,
      `root.render(tree())`,
      // the board draws a card again (a new bundle object) while it stays on screen
      `;(window as any).rerender = () => root.render(tree())`,
    ],
    { loader: { '.css': 'css', '.woff2': 'empty', '.woff': 'empty' }, conditions: ['style'] },
  )
  const css = readFileSync(script.replace(/\.js$/, '.css'), 'utf8')
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 900, height: 900 } })
  await page.route('**/*', (route) => {
    const p = new URL(route.request().url()).pathname
    if (p === '/bundle.css') return route.fulfill({ status: 200, contentType: 'text/css', body: css })
    if (p.startsWith('/api/')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div></body></html>' })
  })
  await page.goto(`${ORIGIN}/`)
  await page.evaluate(() => localStorage.setItem('thimble:paper', 'dark'))
  await page.reload()
  await page.addScriptTag({ path: script })
  await page.waitForSelector('.canvas-card-frame[data-settled="true"]')
  await page.waitForSelector('#fig svg')
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

const frame = (): Frame => page.frames().find((f) => f !== page.mainFrame())!

/** Each element's color (fill for an SVG text) and the contrast it reads at on `on` (a color, else its nearest opaque
 * background), from a document's computed styles. */
const READ = ([ids, on]: [string[], string | null]) => {
  const rgb = (s: string) => (/rgba?\(([^)]+)\)/.exec(s)?.[1] ?? '0,0,0').split(/[,\s/]+/).filter(Boolean).slice(0, 3).map(Number)
  const lum = (c: number[]) => c.map((v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0)
  const ratio = (a: number[], b: number[]) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)
  return ids.map((id) => {
    const el = document.querySelector(`[id$="${id}"]`)!
    const color = el instanceof SVGElement ? getComputedStyle(el).fill : getComputedStyle(el).color
    let bg = on
    for (let e: Element | null = el; !bg && e; e = e.parentElement) if (rgb(getComputedStyle(e).backgroundColor).length && !/rgba\(.*,\s*0\)|transparent/.test(getComputedStyle(e).backgroundColor)) bg = getComputedStyle(e).backgroundColor
    return { id, color, contrast: Math.round(ratio(rgb(color), rgb(bg ?? 'rgb(255,255,255)')) * 10) / 10 }
  })
}

const card = (ids: string[]) => frame().evaluate(READ, [ids, null] as [string[], string | null])
const fig = (ids: string[], on: string) => page.evaluate(READ, [ids, on] as [string[], string | null])
const paperCard = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--surface-card').trim())

test("on Dark, a step box's title that sets no color reads on the dark ink on the box the page filled white", async () => {
  await page.waitForTimeout(400)
  for (const r of await card(['t1', 't2'])) assert.ok(r.contrast >= 3, `${r.id} reads at ${r.contrast}:1 on its white box (${r.color})`)
  // and a name in the page's own svg on the white box it draws with <use>
  const [u] = await frame().evaluate(READ, [['u1'], 'rgb(255, 255, 255)'] as [string[], string | null])
  assert.ok(u.contrast >= 3, `u1 reads at ${u.contrast}:1 on its white box (${u.color})`)
})

test("on Dark, a matplotlib figure's black name on its white or light box reads on the dark ink, and the boxes keep their fills", async () => {
  // and still after the card is drawn again
  await page.evaluate(() => (window as any).rerender())
  await page.waitForTimeout(300)
  for (const [id, box] of [['name', 'rgb(255, 255, 255)'], ['name2', 'rgb(219, 234, 254)']]) {
    const [r] = await fig([id], box)
    assert.ok(r.contrast >= 3, `${id} reads at ${r.contrast}:1 on its box (${r.color})`)
  }
  // the boxes keep their own fills
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('[id$="lightbox"]')!).fill), 'rgb(219, 234, 254)')
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('[id$="-box"]')!).fill), 'rgb(255, 255, 255)')
})

test("on Dark, text the page colored and that reads keeps its color, and a figure's name on its own background keeps the paper's ink", async () => {
  const got = Object.fromEntries((await card(['tag', 'arrow', 'label', 'd1'])).map((r) => [r.id, r.color]))
  assert.deepEqual(got, { tag: 'rgb(29, 78, 216)', arrow: 'rgb(148, 163, 184)', label: 'rgb(100, 116, 139)', d1: 'rgb(71, 85, 105)' })
  const [note] = await fig(['note'], await paperCard())
  assert.ok(note.contrast >= 3, `the note reads at ${note.contrast}:1 on the paper (${note.color})`)
})

test('on Warm nothing is mended: the title and the names are the paper ink, as the page wrote them', async () => {
  await page.evaluate(() => (window as any).setPaper('warm'))
  await page.waitForSelector('.canvas-card-frame[data-settled="true"]')
  await page.waitForTimeout(800)
  assert.equal(await page.evaluate(() => document.querySelectorAll('[data-thimble-ink]').length), 0, 'no figure text is mended on Warm')
  assert.equal(await frame().evaluate(() => document.querySelectorAll('[data-thimble-ink]').length), 0, 'no card text is mended on Warm')
  const titles = await card(['t1', 'arrow'])
  assert.deepEqual(titles.map((r) => r.color), ['rgb(0, 0, 0)', 'rgb(148, 163, 184)'])
  const names = await fig(['name', 'name2', 'note'], 'rgb(255, 255, 255)')
  assert.deepEqual(names.map((r) => r.color), ['rgb(0, 0, 0)', 'rgb(0, 0, 0)', 'rgb(0, 0, 0)'])
})
