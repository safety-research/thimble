// Cards never cover each other, in a real browser with thimble's own stylesheets and the real Canvas
// (src/canvas/Canvas.tsx dropCard). A card dragged away from a gap and dropped on a card in an open frame moves straight
// down to the first place where it covers no card, which the move route is told and the board then shows; a card
// dropped on a collapsed frame goes to the end of its deck (the move names the frame and no place).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let page: Page
const moves: Record<string, unknown>[] = []

type Pos = { x: number; y: number }
const cell = (id: string, notebook: string, height: number, pos: Pos | null = null) => ({ id, notebook, kind: 'note', title: `Card ${id}`, takeaway: '', created_by: 'user', ts: '2026-10-08T12:00:00+00:00', payload: { text: id }, text: id, height, pos })
const CANVAS = {
  groups: [
    { id: 'g', title: 'Your work', parent: null, kind: 'sequence', anchor: null, chat: null, role: 'analyst' },
    { id: 'h', title: 'Notes', parent: null, kind: 'sequence', anchor: null, chat: null, role: 'analyst' },
    { id: 'l', title: '', parent: null, kind: 'loose', anchor: null, chat: null, role: 'analyst' },
  ],
  cells: [cell('a', 'g', 200), cell('b', 'g', 200), cell('c', 'g', 200), cell('d', 'h', 150), cell('e', 'h', 150), cell('x', 'l', 200, { x: 900, y: 80 })],
}

beforeAll(async () => {
  const script = await bundle(
    'canvas-drop',
    [`import '${src('styles/index.css')}'`, `import { createRoot } from 'react-dom/client'`, `import { Canvas } from '${src('canvas/Canvas.tsx')}'`, `createRoot(document.getElementById('root')!).render(<Canvas ws="w" active={true} />)`],
    { loader: { '.css': 'css', '.woff2': 'empty', '.woff': 'empty' }, conditions: ['style'] },
  )
  const css = readFileSync(script.replace(/\.js$/, '.css'), 'utf8')
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
  await page.route('**/*', async (route) => {
    const req = route.request()
    const p = new URL(req.url()).pathname
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    if (p === '/bundle.css') return route.fulfill({ status: 200, contentType: 'text/css', body: css })
    if (p === '/api/ws/w/canvas') return json(CANVAS)
    if (p === '/api/ws/w/cells/move') {
      const body = JSON.parse(req.postData() || '{}') as { cells: string[]; group: string; pos?: Pos | null }
      moves.push(body)
      // the route moves the card as notebook.move_cells does: into the group's flow at its end, or free at pos
      const moved = CANVAS.cells.find((c) => c.id === body.cells[0])!
      CANVAS.cells = [...CANVAS.cells.filter((c) => c !== moved), { ...moved, notebook: body.group, pos: body.pos ?? null }]
      return json([])
    }
    if (p === '/api/ws/w/canvas/comments') return json({ comments: [] })
    if (p === '/api/ws/w/chats' || p === '/api/ws/w/concepts' || p === '/api/ws/w/checks') return json([])
    if (p.startsWith('/api/')) return json({})
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root" style="position:absolute;inset:0;display:flex"></div></body></html>' })
  })
  await page.goto(`${ORIGIN}/`)
  // Your work open and Notes collapsed, the board at 50% from its origin
  await page.evaluate(() => {
    localStorage.setItem('thimble:w:canvas-shut', JSON.stringify(['h']))
    localStorage.setItem('thimble:w:canvas-view', JSON.stringify({ x: 0, y: 0, scale: 0.5 }))
  })
  await page.addScriptTag({ path: script })
  await page.waitForSelector('[data-cell="x"]')
  await page.waitForTimeout(300)
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

type Box = { left: number; top: number; right: number; bottom: number; width: number; height: number }
const box = (sel: string): Promise<Box> => page.evaluate((s) => document.querySelector<HTMLElement>(s)!.getBoundingClientRect().toJSON(), sel)
const overlap = (a: Box, b: Box) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top

/** Drag a card by a point in its body to `to` (page px), in steps, as a hand does. */
async function drag(id: string, to: { x: number; y: number }) {
  const from = await box(`[data-cell="${id}"]`)
  const start = { x: from.left + from.width / 2, y: from.top + from.height / 2 }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) await page.mouse.move(start.x + ((to.x - start.x) * i) / 8, start.y + ((to.y - start.y) * i) / 8)
  await page.mouse.up()
  await page.waitForTimeout(400)
}

test('a card dropped on a card in an open frame moves down to the first place where it covers no card', async () => {
  const b = await box('[data-cell="b"]')
  // the pointer over the middle of b, far from the gaps above and below it, so the card is placed free
  await drag('x', { x: b.left + b.width / 2, y: b.top + b.height / 2 })
  assert.equal(moves.length, 1)
  const m = moves[0] as { cells: string[]; group: string; pos: Pos }
  assert.deepEqual(m.cells, ['x'])
  assert.equal(m.group, 'g')
  // below b it would cover c, so it stands GAP below c: c's top in the frame (HEAD + 2 × (200 + GAP)) + 200 + GAP
  assert.equal(m.pos.y, 20 + 2 * 220 + 220)
  await page.waitForTimeout(300)
  const [x, a, bb, c] = await Promise.all(['x', 'a', 'b', 'c'].map((id) => box(`[data-cell="${id}"]`)))
  for (const [name, other] of [['a', a], ['b', bb], ['c', c]] as const) assert.ok(!overlap(x, other), `x covers ${name}: ${JSON.stringify({ x, other })}`)
  assert.ok(x.top >= c.bottom, 'x stands below c')
})

test('a card dropped on a collapsed frame goes to the end of its deck', async () => {
  const d = await box('[data-cell="d"]')
  await drag('x', { x: d.left + d.width / 2, y: d.top + d.height / 2 })
  assert.equal(moves.length, 2)
  assert.deepEqual(moves[1], { cells: ['x'], group: 'h' }, 'the move names the frame and no place, so the card goes last in its flow')
  await page.waitForTimeout(300)
  assert.equal(await page.locator('[data-cell="x"]').count(), 0, 'the card is in the collapsed deck, which shows only its first card')
  assert.equal(await page.locator('[data-group="h"] .frame-chev.is-open').count(), 0, 'the frame stays collapsed')
})
