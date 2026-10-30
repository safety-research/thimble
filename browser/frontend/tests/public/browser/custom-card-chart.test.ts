// A chart a custom card draws in SVG (src/canvas/cardBridge.ts), in a real browser that reports a Mac, on the real board:
// a ⌘-click on one of its shapes asks about that shape by what the drawing says it is, its tooltip or its aria-label, or
// by the label it is grouped with; a label is asked about by its own text (a line of a label of two lines by that line),
// and a shape in a label of the page (a legend's swatch, an icon in a list) by that label. A shape that says nothing of
// itself among the chart's other shapes stands for the whole card, so the thread is about the card and is named by its
// question, not by the chart's labels run together, which is all the text of the drawing around the shape (an SVG
// element has no innerText).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Frame, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let page: Page
const threads: { anchor: string; anchor_text: string }[] = []

// as a script draws a chart: no white space between the elements, the ticks first, a tooltip on one bar, an aria-label
// on another (as Vega's SVG marks carry), two bars that say nothing of themselves and one grouped with its own label, a
// title of two lines; a legend's swatch above it and a list with an icon under it
const CHART =
  '<style>body{margin:0;padding:10px;font:12px sans-serif}ul{margin:4px 0;padding:0;list-style:none}</style>' +
  '<div><span><svg width="12" height="12"><rect id="swatch" width="12" height="12" fill="#d63b6f"></rect></svg> Late</span></div>' +
  '<svg width="420" height="190">' +
  '<g class="axis"><text x="14" y="160">0</text><text x="14" y="120">10</text><text x="14" y="80">20</text><text x="14" y="40">30</text></g>' +
  '<g class="bars"><rect id="rail" x="120" y="100" width="50" height="60" fill="#3b6fd6"></rect><rect id="road" x="260" y="80" width="50" height="80" fill="#3b6fd6"></rect></g>' +
  '<g class="tips"><rect id="bus" x="50" y="60" width="50" height="100" fill="#3b6fd6"><title>Bus: 25 late</title></rect></g>' +
  '<path id="ferry" d="M190 120h50v40h-50z" fill="#3b6fd6" aria-label="mode: Ferry; late: 10"></path>' +
  '<g class="names"><text id="rail-name" x="128" y="178">Rail</text><text x="58" y="178">Bus</text><text x="198" y="178">Ferry</text><text x="268" y="178">Road</text></g>' +
  '<g class="tram"><rect id="tram" x="330" y="110" width="50" height="50" fill="#3b6fd6"></rect><text x="338" y="178">Tram</text></g>' +
  '<text x="300" y="18"><tspan x="300">Late by</tspan><tspan id="title-2" x="300" dy="14">night and mode</tspan></text>' +
  '</svg>' +
  '<ul><li><svg width="12" height="12"><circle id="icon" cx="6" cy="6" r="6" fill="#20a040"></circle></svg> Alpha run</li></ul>'
const QUESTION = 'Which mode ran late most?'
const CANVAS = {
  groups: [{ id: 'g', title: 'Your work', parent: null, kind: 'sequence', anchor: null, chat: null, role: 'analyst' }],
  cells: [{ id: 'c1', notebook: 'g', kind: 'custom', title: QUESTION, takeaway: '', created_by: 'model', ts: '2026-10-10T12:00:00+00:00', payload: { html: CHART, height: 260 } }],
}

beforeAll(async () => {
  const script = await bundle(
    'custom-card-chart',
    [
      `import '${src('styles/index.css')}'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { Canvas } from '${src('canvas/Canvas.tsx')}'`,
      `import { CmdPointer } from '${src('pointer/CmdPointer.tsx')}'`,
      `createRoot(document.getElementById('root')!).render(<><Canvas ws="w" active={true} /><CmdPointer ws="w" /></>)`,
    ],
    { loader: { '.css': 'css', '.woff2': 'empty', '.woff': 'empty' }, conditions: ['style'] },
  )
  const css = readFileSync(script.replace(/\.js$/, '.css'), 'utf8')
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' })
    Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => ({ platform: 'macOS' }) })
  })
  await page.route('**/*', async (route) => {
    const req = route.request()
    const p = new URL(req.url()).pathname
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    if (p === '/bundle.css') return route.fulfill({ status: 200, contentType: 'text/css', body: css })
    if (p === '/api/ws/w/canvas') return json(CANVAS)
    if (p === '/api/ws/w/canvas/comments') return json({ comments: [] })
    if (p === '/api/ws/w/chats' && req.method() === 'POST') {
      threads.push(JSON.parse(req.postData() || '{}'))
      return json({ id: `t${threads.length}`, kind: 'thread', title: 'why' })
    }
    if (p === '/api/ws/w/chats' || p === '/api/ws/w/concepts' || p === '/api/ws/w/checks') return json([])
    if (p.startsWith('/api/')) return json({})
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root" style="position:absolute;inset:0;display:flex"></div></body></html>' })
  })
  await page.goto(`${ORIGIN}/`)
  await page.addScriptTag({ path: script })
  await page.waitForSelector('.canvas-card-frame[data-settled="true"]')
  await page.waitForTimeout(300)
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

const frame = (): Frame => page.frames().find((f) => f !== page.mainFrame())!
/** The middle of the element `id` of the card's page, where the zoomed board draws it on screen. */
async function middleOf(id: string): Promise<{ x: number; y: number }> {
  const inner = await frame().evaluate((i) => document.getElementById(i)!.getBoundingClientRect().toJSON(), id)
  const f = await page.evaluate(() => {
    const el = document.querySelector<HTMLIFrameElement>('iframe.canvas-card-html')!
    const r = el.getBoundingClientRect()
    return { x: r.left, y: r.top, k: r.width / el.offsetWidth }
  })
  return { x: f.x + (inner.left + inner.width / 2) * f.k, y: f.y + (inner.top + inner.height / 2) * f.k }
}

/** The thread a ⌘-click on the element `id` of the card's page opens: its anchor and the words it is about. */
async function threadOn(id: string): Promise<{ anchor: string; anchor_text: string }> {
  const at = await middleOf(id)
  const n = threads.length
  await page.mouse.move(at.x, at.y)
  await page.keyboard.down('Meta')
  await page.mouse.click(at.x, at.y)
  await page.keyboard.up('Meta')
  await page.waitForSelector('.pointer-box textarea', { timeout: 3000 })
  await page.fill('.pointer-box textarea', 'why so late?')
  await page.press('.pointer-box textarea', 'Enter')
  await page.waitForSelector('.pointer-box', { state: 'detached', timeout: 3000 })
  assert.equal(threads.length, n + 1, 'one thread was opened')
  return { anchor: threads[n].anchor, anchor_text: threads[n].anchor_text }
}

test('a bar that says nothing of itself stands for the whole card: the thread is about the card, by its question', async () => {
  assert.deepEqual(await threadOn('rail'), { anchor: 'card:c1', anchor_text: QUESTION })
})

test('a shape is asked about by its aria-label, or by its tooltip', async () => {
  assert.deepEqual(await threadOn('ferry'), { anchor: 'card:c1', anchor_text: 'mode: Ferry; late: 10' })
  assert.deepEqual(await threadOn('bus'), { anchor: 'card:c1', anchor_text: 'Bus: 25 late' })
})

test('a label is asked about by its own text', async () => {
  assert.deepEqual(await threadOn('rail-name'), { anchor: 'card:c1', anchor_text: 'Rail' })
})

test('a line of a label of two lines is asked about by that line', async () => {
  assert.deepEqual(await threadOn('title-2'), { anchor: 'card:c1', anchor_text: 'night and mode' })
})

test('a bar grouped with its own label is asked about by that label', async () => {
  assert.deepEqual(await threadOn('tram'), { anchor: 'card:c1', anchor_text: 'Tram' })
})

test("a shape in a label of the page is asked about by that label: a legend's swatch, an icon in a list", async () => {
  assert.deepEqual(await threadOn('swatch'), { anchor: 'card:c1', anchor_text: 'Late' })
  assert.deepEqual(await threadOn('icon'), { anchor: 'card:c1', anchor_text: 'Alpha run' })
})
