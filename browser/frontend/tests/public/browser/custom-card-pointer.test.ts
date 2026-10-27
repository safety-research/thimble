// A custom card on the canvas (src/canvas/DataViz.tsx CustomFrame, src/canvas/cardBridge.ts), in a real browser that
// reports a Mac, on the real board at its opening zoom of 80%: ⌘ held over a box of the card's page lights that box, a
// ⌘-click on it opens the pointer's box beside it and the thread is about the card with the box's words, the wheel over
// the card pans the board as over any other card and a pinch zooms it, and after a click in the card's page, which takes
// the focus, ⌘ held over the board still shows the pointer.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Frame, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let page: Page
const threads: { anchor: string; anchor_text: string }[] = []

const HTML =
  '<style>body{margin:0;padding:14px;font:13px sans-serif}.row{display:flex;gap:24px}.box{border:1px solid #888;padding:10px 14px}</style>' +
  '<div class="row"><div class="box" id="north">North</div><div class="box" id="harbor">Harbor</div><div class="box" id="hill">Hill</div></div>'
const card = (id: string, kind: string, title: string, payload: object) => ({ id, notebook: 'g', kind, title, takeaway: '', created_by: 'model', ts: '2026-10-10T12:00:00+00:00', payload })
const CANVAS = {
  groups: [{ id: 'g', title: 'Your work', parent: null, kind: 'sequence', anchor: null, chat: null, role: 'analyst' }],
  cells: [card('c1', 'custom', 'Which station is wettest?', { html: HTML, height: 80 }), card('n1', 'note', 'Is the hill gauge right?', { text: 'Is the hill gauge right?' })],
}

beforeAll(async () => {
  const script = await bundle(
    'custom-card-pointer',
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
      return json({ id: 't1', kind: 'thread', title: 'why' })
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
/** An element of the card's page where the board draws it on screen: its box in the frame, scaled as the frame is drawn
 * (Playwright's own boxes inside a frame leave the scale out). */
async function boxOf(id: string) {
  const inner = await frame().evaluate((i) => document.getElementById(i)!.getBoundingClientRect().toJSON(), id)
  const f = await page.evaluate(() => {
    const el = document.querySelector<HTMLIFrameElement>('iframe.canvas-card-html')!
    const r = el.getBoundingClientRect()
    return { x: r.left, y: r.top, k: r.width / el.offsetWidth }
  })
  return { x: f.x + inner.left * f.k, y: f.y + inner.top * f.k, width: inner.width * f.k, height: inner.height * f.k }
}
const centre = (b: { x: number; y: number; width: number; height: number }) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
const rectOf = (sel: string) => page.evaluate((s) => document.querySelector<HTMLElement>(s)!.getBoundingClientRect().toJSON(), sel)
const plane = () => page.evaluate(() => {
  const m = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([\d.]+)\)/.exec(document.querySelector<HTMLElement>('.board-plane')!.style.transform)!
  return { x: +m[1], y: +m[2], scale: +m[3] }
})

test('⌘ held over a box of the card lights that box, where the zoomed board draws it', async () => {
  assert.ok(Math.abs((await plane()).scale - 0.8) < 0.001, 'the board opens at 80%')
  const t = await boxOf('harbor')
  await page.mouse.move(centre(t).x, centre(t).y)
  await page.keyboard.down('Meta')
  await page.waitForTimeout(500)
  const hl = await rectOf('.pointer-hl')
  await page.keyboard.up('Meta')
  for (const [side, want] of [['left', t.x], ['top', t.y], ['width', t.width], ['height', t.height]] as const) assert.ok(Math.abs(hl[side] - want) < 2, `${side}: highlight ${hl[side]}, box ${want}`)
})

test('a ⌘-click on the box opens the pointer\'s box beside it, and the thread is about the card with the box\'s words', async () => {
  const t = await boxOf('harbor')
  await page.keyboard.down('Meta')
  await page.mouse.click(centre(t).x, centre(t).y)
  await page.keyboard.up('Meta')
  await page.waitForSelector('.pointer-box', { timeout: 2000 })
  const b = await rectOf('.pointer-box')
  assert.ok(b.left >= t.x + t.width && b.top >= t.y - 1 && b.top < t.y + t.height, `beside the box: ${JSON.stringify({ b, t })}`)
  assert.equal(await frame().evaluate(() => String(getSelection())), '', 'no text of the card is selected')
  await page.fill('.pointer-box textarea', 'why so wet here?')
  await page.press('.pointer-box textarea', 'Enter')
  await page.waitForSelector('.pointer-box', { state: 'detached', timeout: 2000 })
  assert.deepEqual(threads.map((th) => [th.anchor, th.anchor_text]), [['card:c1', 'Harbor']])
})

test('the wheel over the card pans the board, and a pinch over it zooms the board', async () => {
  const n = centre(await boxOf('hill'))
  await page.mouse.move(n.x, n.y)
  const before = await plane()
  await page.mouse.wheel(0, 120)
  await page.waitForTimeout(200)
  const panned = await plane()
  assert.ok(Math.abs(panned.y - (before.y - 120)) < 1 && panned.scale === before.scale, `panned up by the turn: ${JSON.stringify({ before, panned })}`)
  // the card moved with the board: the pinch is over it again
  const m = centre(await boxOf('hill'))
  await page.mouse.move(m.x, m.y)
  assert.equal(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName, [m.x, m.y]), 'IFRAME')
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -10)
  await page.keyboard.up('Control')
  await page.waitForTimeout(200)
  assert.ok((await plane()).scale > panned.scale, 'a pinch out zooms in')
})

test('after a click in the card, which takes the focus, ⌘ held over the board still shows the pointer', async () => {
  const north = centre(await boxOf('north'))
  await page.mouse.click(north.x, north.y)
  assert.equal(await frame().evaluate(() => document.hasFocus()), true, "the card's page has the focus")
  const note = await rectOf('article.canvas-card[data-cell="n1"]')
  await page.keyboard.down('Meta')
  await page.mouse.move(note.left + note.width / 2, note.top + note.height / 2)
  await page.waitForTimeout(450)
  const on = await page.evaluate(() => ({ cmd: document.body.hasAttribute('data-cmd'), hl: document.querySelector('.pointer-hl')?.hasAttribute('data-on') ?? false }))
  await page.keyboard.up('Meta')
  assert.deepEqual(on, { cmd: true, hl: true })
})
