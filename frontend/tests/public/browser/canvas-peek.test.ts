// A frame opened from its deck collapses again only at a click on the bare board, in a real browser with the real
// Canvas (src/canvas/Canvas.tsx collapsePeeked). A click on a card, in the frame or out of it and including the card a
// thread is about, leaves it open; a click on a deck still opens that deck; the frame's title still opens and closes
// it.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let page: Page

const cell = (id: string, notebook: string, created_by = 'user') => ({ id, notebook, kind: 'note', title: `Card ${id}`, takeaway: '', created_by, ts: '2026-10-08T12:00:00+00:00', payload: { text: id }, text: id, height: 160, pos: null })
const CANVAS = {
  groups: [
    { id: 'g', title: 'Your work', parent: null, kind: 'sequence', anchor: null, chat: null, role: 'analyst' },
    // the thread about card a, with two cards: a deck while collapsed
    { id: 't', title: 'main/why-the-spike', parent: 'g', kind: 'sequence', anchor: 'a', chat: 'c1', role: 'analyst' },
    { id: 'h', title: 'Notes', parent: null, kind: 'sequence', anchor: null, chat: null, role: 'analyst' },
  ],
  cells: [cell('a', 'g'), cell('b', 'g'), cell('t1', 't', 'chat:c1'), cell('t2', 't', 'chat:c1'), cell('d', 'h'), cell('e', 'h')],
}

beforeAll(async () => {
  const script = await bundle(
    'canvas-peek',
    [`import '${src('styles/index.css')}'`, `import { createRoot } from 'react-dom/client'`, `import { Canvas } from '${src('canvas/Canvas.tsx')}'`, `createRoot(document.getElementById('root')!).render(<Canvas ws="w" active={true} />)`],
    { loader: { '.css': 'css', '.woff2': 'empty', '.woff': 'empty' }, conditions: ['style'] },
  )
  const css = readFileSync(script.replace(/\.js$/, '.css'), 'utf8')
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
  await page.route('**/*', async (route) => {
    const p = new URL(route.request().url()).pathname
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    if (p === '/bundle.css') return route.fulfill({ status: 200, contentType: 'text/css', body: css })
    if (p === '/api/ws/w/canvas') return json(CANVAS)
    if (p === '/api/ws/w/canvas/comments') return json({ comments: [] })
    if (p === '/api/ws/w/chats') return json([{ id: 'c1', kind: 'thread', title: 'why-the-spike', anchor: 'card:a', n_messages: 2 }])
    if (p === '/api/ws/w/concepts' || p === '/api/ws/w/checks') return json([])
    if (p.startsWith('/api/')) return json({})
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root" style="position:absolute;inset:0;display:flex"></div></body></html>' })
  })
  await page.goto(`${ORIGIN}/`)
  // Your work open, the thread's frame and Notes collapsed, the board at 50% from its origin
  await page.evaluate(() => {
    localStorage.setItem('thimble:w:canvas-open', JSON.stringify(['g']))
    localStorage.setItem('thimble:w:canvas-view', JSON.stringify({ x: 0, y: 0, scale: 0.5 }))
  })
  await page.addScriptTag({ path: script })
  await page.waitForSelector('[data-cell="t1"]')
  await page.waitForTimeout(300)
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

const isOpen = (g: string) => page.locator(`[data-group="${g}"] > .frame-title .frame-chev.is-open`).count().then((n) => n > 0)
/** A click in the middle of a card's body. */
async function clickCard(id: string) {
  const r = await page.evaluate((s) => document.querySelector<HTMLElement>(`[data-cell="${s}"]`)!.getBoundingClientRect().toJSON(), id)
  await page.mouse.click(r.left + r.width / 2, r.top + r.height / 2)
  await page.waitForTimeout(150)
}
/** A click on the board where no frame or card is. */
async function clickBoard() {
  await page.mouse.click(1250, 80)
  await page.waitForTimeout(150)
}

test('a click on a card, including the card the thread is about, leaves a frame opened from its deck open', async () => {
  assert.equal(await isOpen('t'), false, "the thread's frame starts collapsed")
  await clickCard('t1')
  assert.equal(await isOpen('t'), true, 'a click on the deck opens it')
  await clickCard('a')
  assert.equal(await isOpen('t'), true, 'a click on the card the thread is about leaves it open')
  await clickCard('b')
  assert.equal(await isOpen('t'), true, 'a click on another card of the frame around it leaves it open')
  await clickCard('d')
  assert.equal(await isOpen('h'), true, 'a click on another deck opens that deck')
  assert.equal(await isOpen('t'), true, 'and leaves the first one open')
})

test('a click on the bare board collapses the frames opened from their decks', async () => {
  await clickBoard()
  assert.equal(await isOpen('t'), false)
  assert.equal(await isOpen('h'), false)
  assert.equal(await isOpen('g'), true, 'a frame opened by its title stays open')
})

test("a frame's title still opens and closes it", async () => {
  await clickCard('t1')
  assert.equal(await isOpen('t'), true)
  await page.click('[data-group="t"] > .frame-title .frame-name')
  await page.waitForTimeout(400)
  assert.equal(await isOpen('t'), false, 'its title closes it')
  await page.click('[data-group="t"] > .frame-title .frame-name')
  await page.waitForTimeout(400)
  assert.equal(await isOpen('t'), true, 'and opens it again')
  await page.click('[data-group="h"] > .frame-title .frame-name')
  await page.waitForTimeout(400)
  assert.equal(await isOpen('h'), true)
  assert.equal(await isOpen('t'), true, "another frame's title leaves it open")
})
