// The picture a ⌘-click sends with a thread (src/pointer/capture.ts capturePng) holds what a card draws in a sandboxed
// frame, which the page cannot read and html-to-image drew as an empty box: a custom card's page (canvas/DataViz
// CustomFrame), a scripted output's (components/Outputs HtmlFrame) and a card type's (files/ViewerFrame) each draw
// themselves (src/lib/frameShot.ts). On the real board at its opening zoom, under the app's own content security
// policy, in a browser that reports a Mac: a ⌘-click on each card's top row asks about the card, and the PNG its thread
// is sent shows, where the card shows them, a block of one color in the frame's markup and a block a script painted on
// a canvas or set by its style, an image the frame's page loads by URL (which the frame cannot read, and a picture
// cannot load), and a control the card shows under the frame (Keep), which stays where it is rather than move up into
// the frame's place.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let page: Page
const threads: { anchor: string; image: string | null }[] = []

// the server's policy for the page (backend/app/http_guard.py APP_CSP), which a srcdoc frame inherits
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' data: blob:; worker-src 'self' blob:; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'"
const PINK = [208, 32, 138]
const GREEN = [32, 160, 64]
const BLUE = [32, 80, 208]
const VIOLET = [112, 48, 192]
const RED = [224, 48, 32]
// a PNG of one color, RED, which a page loads by URL
const RED_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAFElEQVR4nGN8YKDAAANMDEgANwcAPSQBOPH1r6oAAAAASUVORK5CYII='
const CUSTOM =
  '<style>body{margin:0;padding:12px}#pink{width:160px;height:50px;background:#d0208a}#green{display:block;margin-top:10px}</style>' +
  '<div id="pink"></div><canvas id="green" width="160" height="50"></canvas>' +
  "<script>const g = document.getElementById('green').getContext('2d'); g.fillStyle = '#20a040'; g.fillRect(0, 0, 160, 50)</script>"
const SCRIPTED = "<div id=\"blue\" style=\"width:160px;height:50px\"></div><script>document.getElementById('blue').style.background = '#2050d0'</script>"
const TYPE_PAGE = '<!doctype html><html><head></head><body style="margin:0"><div id="violet" style="margin:12px;width:160px;height:50px;background:#7030c0"></div></body></html>'
// a card type's page that, once drawn, asks for another query, as a page the analyst reshaped does: the card shows Keep
// and Undo under it
const ASKS_PAGE =
  '<!doctype html><html><head></head><body style="margin:0"><div id="asks" style="margin:12px;width:160px;height:50px;background:#7030c0"></div>' +
  "<script>setTimeout(() => parent.postMessage({ type: 'thimble:setQuery', patch: { min: 3 } }, '*'), 200)</script></body></html>"
const PICTURE = '<style>body{margin:0;padding:12px}</style><img id="pic" src="/pic.png" style="width:160px;height:50px">'
const T = '2026-10-10T12:00:00+00:00'
const CANVAS = {
  groups: [{ id: 'g', title: 'Your work', parent: null, kind: 'sequence', anchor: null, chat: null, role: 'analyst' }],
  cells: [
    { id: 'c1', notebook: 'g', kind: 'custom', title: 'Which nights failed?', takeaway: 'Two blocks.', created_by: 'model', ts: T, payload: { html: CUSTOM, height: 150 } },
    { id: 'h1', notebook: 'g', kind: 'plot', title: 'How did the runs go?', takeaway: 'One block.', created_by: 'model', ts: T, code: 'show()', status: 'ok', outputs: [{ 'text/html': SCRIPTED }] },
    { id: 'k1', notebook: 'g', kind: 'plot', title: 'Which runs were slow?', takeaway: 'One block.', created_by: 'model', ts: T, code: 'thimble.card("demo")', status: 'ok', outputs: [{ 'application/vnd.thimble.card+json': { type: 'demo', data: {}, size: [80, 200], labels: [] }, 'text/plain': 'run 1' }] },
    { id: 'p1', notebook: 'g', kind: 'custom', title: 'Which run looked wrong?', takeaway: 'Its picture.', created_by: 'model', ts: T, payload: { html: PICTURE, height: 90 } },
    { id: 'k2', notebook: 'g', kind: 'plot', title: 'Which runs were reshaped?', takeaway: 'One block.', created_by: 'model', ts: T, code: 'thimble.card("asks")', status: 'ok', outputs: [{ 'application/vnd.thimble.card+json': { type: 'asks', data: {}, size: [80, 200], labels: [] }, 'text/plain': 'run 1' }] },
  ],
}

beforeAll(async () => {
  const script = await bundle(
    'pointer-frame-shot',
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
  const js = readFileSync(script, 'utf8')
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 1400, height: 1400 } })
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' })
    Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => ({ platform: 'macOS' }) })
  })
  await page.route('**/*', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    if (url.protocol === 'data:' || url.protocol === 'blob:') return route.continue()
    const p = url.pathname
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    if (p === '/bundle.css') return route.fulfill({ status: 200, contentType: 'text/css', body: css })
    if (p === '/bundle.js') return route.fulfill({ status: 200, contentType: 'text/javascript', body: js })
    if (p === '/api/ws/w/canvas') return json(CANVAS)
    if (p === '/api/ws/w/cardtypes/demo/frame') return route.fulfill({ status: 200, contentType: 'text/html', body: TYPE_PAGE })
    if (p === '/api/ws/w/cardtypes/asks/frame') return route.fulfill({ status: 200, contentType: 'text/html', body: ASKS_PAGE })
    if (p === '/pic.png') return route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from(RED_PNG, 'base64') })
    if (p === '/api/ws/w/canvas/comments') return json({ comments: [] })
    if (p === '/api/ws/w/chats' && req.method() === 'POST') {
      const body = JSON.parse(req.postData() || '{}')
      threads.push({ anchor: body.anchor, image: body.image ?? null })
      return json({ id: `t${threads.length}`, kind: 'thread', title: 'why' })
    }
    if (p === '/api/ws/w/chats' || p === '/api/ws/w/concepts' || p === '/api/ws/w/checks') return json([])
    if (p.startsWith('/api/')) return json({})
    return route.fulfill({
      status: 200,
      contentType: 'text/html',
      headers: { 'content-security-policy': CSP },
      body: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root" style="position:absolute;inset:0;display:flex"></div><script src="/bundle.js"></script></body></html>',
    })
  })
  await page.goto(`${ORIGIN}/`)
  await page.waitForSelector('[data-cell="c1"] .canvas-card-frame[data-settled="true"]')
  await page.waitForSelector('[data-cell="h1"] iframe.outputs-iframe[data-settled="true"]')
  await page.waitForSelector('[data-cell="k1"] iframe.viewer-frame')
  await page.waitForSelector('[data-cell="p1"] .canvas-card-frame[data-settled="true"]')
  await page.waitForSelector('[data-cell="k2"] .bcell-type-actions button:has-text("Keep")')
  await page.waitForTimeout(500)
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

type Box = { left: number; top: number; width: number; height: number }

/** The picture a ⌘-click on the top row of card `cell` sends with its thread, a PNG data URL, and the card's box on
 * screen as it was taken. */
async function asked(cell: string): Promise<{ png: string; card: Box }> {
  const card: Box = await page.evaluate((c) => document.querySelector(`article.canvas-card[data-cell="${c}"]`)!.getBoundingClientRect().toJSON(), cell)
  const n = threads.length
  await page.keyboard.down('Meta')
  // the middle of the card's top row, which stands for the whole card
  await page.mouse.click(card.left + card.width / 2, card.top + 12)
  await page.keyboard.up('Meta')
  await page.waitForSelector('.pointer-box textarea', { timeout: 3000 })
  await page.fill('.pointer-box textarea', 'what is this?')
  await page.press('.pointer-box textarea', 'Enter')
  await page.waitForSelector('.pointer-box', { state: 'detached', timeout: 8000 })
  assert.equal(threads.length, n + 1, 'one thread was opened')
  const t = threads[n]
  assert.equal(t.anchor, `card:${cell}`, 'the thread is about the card')
  assert.ok(t.image?.startsWith('data:image/png;base64,'), 'the thread carries a picture')
  return { png: t.image!, card }
}

/** The middle of the element `id` in the frame of card `cell`, on screen. */
async function middleOf(cell: string, id: string): Promise<{ x: number; y: number }> {
  const el = await page.$(`[data-cell="${cell}"] iframe`)
  const frame = (await el!.contentFrame())!
  const inner = await frame.evaluate((i) => document.getElementById(i)!.getBoundingClientRect().toJSON(), id)
  const at = await el!.evaluate((f) => ({ ...f.getBoundingClientRect().toJSON(), k: f.getBoundingClientRect().width / (f as HTMLElement).offsetWidth }))
  return { x: at.left + (inner.left + inner.width / 2) * at.k, y: at.top + (inner.top + inner.height / 2) * at.k }
}

/** The color of the picture `png` of the card at `card` where the screen point `p` falls. */
async function colorAt(png: string, card: Box, p: { x: number; y: number }): Promise<number[]> {
  return page.evaluate(
    async ([data, c, q]) => {
      const img = new Image()
      img.src = data as string
      await img.decode()
      const box = c as Box
      const at = q as { x: number; y: number }
      const k = img.naturalWidth / box.width
      const cv = document.createElement('canvas')
      cv.width = img.naturalWidth
      cv.height = img.naturalHeight
      const ctx = cv.getContext('2d')!
      ctx.drawImage(img, 0, 0)
      return Array.from(ctx.getImageData(Math.round((at.x - box.left) * k), Math.round((at.y - box.top) * k), 1, 1).data.slice(0, 3))
    },
    [png, card, p] as const,
  )
}

const near = (got: number[], want: number[]) => got.every((v, i) => Math.abs(v - want[i]) <= 24)

/** The color the screen shows at the point `p`. */
async function screenColor(p: { x: number; y: number }): Promise<number[]> {
  const shot = await page.screenshot({ clip: { x: p.x, y: p.y, width: 1, height: 1 } })
  return colorAt(`data:image/png;base64,${shot.toString('base64')}`, { left: p.x, top: p.y, width: 1, height: 1 }, p)
}

test("the picture of a custom card holds its page: a block of its markup, and a canvas a script painted", async () => {
  const { png, card } = await asked('c1')
  const pink = await colorAt(png, card, await middleOf('c1', 'pink'))
  const green = await colorAt(png, card, await middleOf('c1', 'green'))
  assert.ok(near(pink, PINK), `the markup's block is drawn: ${pink}`)
  assert.ok(near(green, GREEN), `the canvas is drawn: ${green}`)
})

test("the picture of a card with a scripted output holds the output's page", async () => {
  const { png, card } = await asked('h1')
  const blue = await colorAt(png, card, await middleOf('h1', 'blue'))
  assert.ok(near(blue, BLUE), `the output's block is drawn: ${blue}`)
})

test("the picture of a card type's card holds the type's page", async () => {
  const { png, card } = await asked('k1')
  const violet = await colorAt(png, card, await middleOf('k1', 'violet'))
  assert.ok(near(violet, VIOLET), `the page's block is drawn: ${violet}`)
})

test("the picture holds an image the frame's page loads by URL", async () => {
  const { png, card } = await asked('p1')
  const red = await colorAt(png, card, await middleOf('p1', 'pic'))
  assert.ok(near(red, RED), `the image is drawn: ${red}`)
})

test('a control the card shows under its frame stays where the card shows it, beside the frame drawn in its place', async () => {
  const keep = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll<HTMLElement>('[data-cell="k2"] .bcell-type-actions button')).find((e) => e.innerText.includes('Keep'))!
    return b.getBoundingClientRect().toJSON()
  })
  // the button's own color, by its left edge, clear of its icon and its word
  const at = { x: Math.round(keep.left + 3), y: Math.round(keep.top + keep.height / 2) }
  const want = await screenColor(at)
  const { png, card } = await asked('k2')
  const got = await colorAt(png, card, at)
  assert.ok(near(got, want), `Keep is drawn where the card shows it: ${got}, on screen ${want}`)
  const violet = await colorAt(png, card, await middleOf('k2', 'asks'))
  assert.ok(near(violet, VIOLET), `the page's block is drawn: ${violet}`)
})
