// The canvas board (src/canvas/Canvas.tsx) mounted whole against routed API answers:
// frames and decks as drawn, the ⌘ contract on every card, and what the drags, keys and controls send to the routes.
import assert from 'node:assert/strict'
import { afterAll, beforeAll, test } from 'vitest'
import { addStyles, bundle, cleanup, launch, src } from './page.ts'

let script: string

let browser: any, page: any
const pageErrors: any[] = []
const sent: any[] = []
// the server's filters (backend concepts.py): the canvas's card parts, only those set, as PUT .../canvas/cards leaves them
let FILTERS: any = {}
// the card check's state (backend card_check.py GET /card-checks), which its switch in the search menu changes
const CHECKS: any = { enabled: true, auto: true, render: true, render_why: '', concurrency: 4, running: [], timings: [] }
const setParts = (b: any) => Object.fromEntries(Object.entries(b ?? {}).filter(([, v]: any) => (Array.isArray(v) ? v.length > 0 : !!v)))

const group = (id: any, extra = {}) => ({ id, title: id, parent: null, kind: 'sequence', anchor: null, chat: null, role: 'analyst', n_cells: 0, pos: null, order: null, ...extra })
const cell = (id: string, notebook: string, extra: object = {}): any => ({ id, notebook, kind: 'note', title: `Question ${id}`, created_by: 'user', ts: '2026-09-22T10:00:00Z', payload: { text: `Text of ${id}` }, text: `Text of ${id}`, takeaway: '', ...extra })
// an Orientation row holding Final and Scratch, which the canvas hides beside Final until the analyst shows it; here
// they have it shown
const DATA = {
  groups: [
    group('orient', { title: 'Orientation', kind: 'split', role: 'exploration' }),
    group('final', { title: 'Final', parent: 'orient', role: 'exploration' }),
    group('scratch', { title: 'Scratch', parent: 'orient', role: 'working', kind: 'grid' }),
    group('mine', { title: 'Your work', pos: { x: 40, y: 700 } }),
  ],
  cells: [cell('f1', 'final', { takeaway: 'One day dominates.' }), cell('f2', 'final'), cell('s1', 'scratch'), cell('y1', 'mine'), cell('y2', 'mine')],
}

beforeAll(async () => {
  script = await bundle('canvas-board', [
      `import { createRoot } from 'react-dom/client'`,
      `import { Canvas } from '${src('canvas/Canvas.tsx')}'`,
      `const el = document.createElement('div')`,
      `el.style.cssText = 'position:absolute;left:0;top:0;width:1000px;height:700px;display:flex;flex-direction:column'`,
      `document.body.appendChild(el)`,
      `localStorage.setItem('thimble:mini:canvas-view', JSON.stringify({ x: 0, y: 40, scale: 1 }))`,
      `localStorage.setItem('thimble:mini:canvas-scratch', 'true')`,
      `createRoot(el).render(<Canvas ws="mini" active />)`,
  ])
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
  page.on('pageerror', (e: any) => pageErrors.push(String(e)))
  await page.route('http://thimble.test/**', (route: any) => {
    const req = route.request()
    const url = req.url()
    const json = (body: any) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    if (req.method() !== 'GET' && /\/api\//.test(url)) {
      const body = req.postData() ? JSON.parse(req.postData()) : null
      const at = new URL(url).pathname
      sent.push({ method: req.method(), path: at, body })
      if (at === '/api/ws/mini/filters/canvas/cards') {
        const parts = setParts(body)
        FILTERS = Object.keys(parts).length ? { canvas: parts } : {}
        return json(FILTERS)
      }
      if (at === '/api/ws/mini/filters/canvas') {
        FILTERS = {}
        return json(FILTERS)
      }
      if (at === '/api/ws/mini/card-checks/auto') {
        CHECKS.auto = !!body?.on
        return json(CHECKS)
      }
      return json({ ok: true, id: 'newg', title: 'Group 1' })
    }
    if (/\/api\/ws\/mini\/canvas$/.test(url)) return json(DATA)
    if (/\/api\/ws\/mini\/chats$/.test(url)) return json([])
    if (/\/api\/ws\/mini\/filters$/.test(url)) return json(FILTERS)
    if (/\/api\/ws\/mini\/concepts$/.test(url)) return json([])
    if (/\/api\/ws\/mini\/card-checks$/.test(url)) return json(CHECKS)
    if (/\/api\//.test(url)) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"detail":"no"}' })
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"></body></html>' })
  })
  await page.goto('http://thimble.test/?ws=mini')
  // the app's styles, the font import left out: the board's layout is absolute and needs them
  await addStyles(page, ['tokens', 'base', 'components', 'outputs', 'canvas'])
  await page.addScriptTag({ path: script })
  await page.waitForSelector('.frame')
  await page.waitForTimeout(300)
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

const frames = () => page.evaluate(() => [...document.querySelectorAll('.frame')].map((f: any) => ({ name: f.querySelector('.frame-name')?.textContent, count: f.querySelector('.frame-count')?.textContent, anchor: f.dataset.anchor })))
const cards = () => page.evaluate(() => [...document.querySelectorAll('.bcell')].map((c: any) => ({ id: c.querySelector('[data-cell]').dataset.cell, anchor: c.querySelector('.canvas-card').dataset.anchor, deck: !!c.querySelector('.bcell-deck') })))

test('frames with their titles and counts; collapsed, each shows its first card over the edges of the rest', async () => {
  // drawn outermost first, so a nested frame paints over its parent
  assert.deepEqual(await frames(), [
    { name: 'Orientation', count: '3', anchor: 'group:orient' },
    { name: 'Your work', count: '2', anchor: 'group:mine' },
    { name: 'Final', count: '2', anchor: 'group:final' },
    { name: 'Scratch', count: '1', anchor: 'group:scratch' },
  ])
  const cs = await cards()
  assert.deepEqual(cs.map((c: any) => c.id), ['f1', 's1', 'y1'], 'a collapsed frame draws its first card alone')
  assert.deepEqual(cs.filter((c: any) => c.deck).map((c: any) => c.id), ['f1', 'y1'], 'with the edges of the others under it')
  assert.ok(cs.every((c: any) => c.anchor === `card:${c.id}`), 'every card is a ⌘ anchor')
  assert.equal(await page.locator('.board-status').innerText(), '5 cards · 4 groups')
})

test('a click on a title opens the frame; the chrome is inside the card, in a row of its own above the question', async () => {
  const t = await page.locator('.frame[data-group="final"] .frame-title').boundingBox()
  await page.mouse.click(t.x + 30, t.y + 12)
  await page.waitForTimeout(400)
  assert.deepEqual((await cards()).map((c: any) => c.id), ['f1', 'f2', 's1', 'y1'])
  const card = page.locator('.bcell').first()
  assert.deepEqual(await card.locator('.bcell-acts button').evaluateAll((bs: any) => bs.map((b: any) => b.getAttribute('aria-label'))), ['Details', 'Chat about this card', 'Delete', 'Star', 'Lock'])
  // the thread, the time and the buttons are a row of their own on top, so the question takes the card's whole width:
  // the row holds the foot's thread and time at the left and the icons at the right, over the question
  assert.deepEqual(await card.locator('.bcell-top > *').evaluateAll((els: any) => els.map((e: any) => e.className)), ['bcell-meta', 'bcell-acts'])
  const [top, q] = await Promise.all([card.locator('.bcell-top').boundingBox(), card.locator('.bcell-q').boundingBox()])
  assert.ok(top.y + top.height <= q.y + 1, 'the row is above the question')
  const inner = await card.locator('.bcell-head').boundingBox()
  assert.ok(Math.abs(q.width - inner.width) < 1, 'the question takes the whole width of its row')
  assert.equal(await card.locator('.bcell-take-text').innerText(), 'One day dominates.')
  // the thread and time are hidden (and out of the tab order) until the card is hovered or selected: their text, not their rendering
  assert.equal(await card.locator('.bcell-meta').textContent(), `main · ${await page.evaluate(() => { const d = new Date('2026-09-22T10:00:00Z'); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` })}`)
})

test('the lock sends the card\'s lock, and a locked card shows its lock at rest with the rest of the chrome hidden', async () => {
  sent.length = 0
  const card = page.locator('.bcell').first()
  const box = await card.boundingBox()
  await page.mouse.move(box.x + 60, box.y + 20)
  await page.waitForTimeout(100)
  DATA.cells[0].locked = true // what the canvas reads back after the PUT, as the server stores it
  await card.locator('.bcell-lock').click()
  await page.waitForTimeout(300)
  assert.deepEqual(sent.filter((s: any) => s.method === 'PUT').map((s: any) => [s.path, s.body]), [['/api/ws/mini/cells/f1', { locked: true }]])
  assert.ok(await card.evaluate((el: any) => el.classList.contains('is-locked')))
  assert.equal(await card.locator('.bcell-lock').getAttribute('aria-label'), 'Locked')
  await page.mouse.move(990, 690)
  await page.waitForTimeout(800)
  const shown = await card.locator('.bcell-acts button').evaluateAll((bs: any) => bs.map((b: any) => [b.getAttribute('aria-label'), getComputedStyle(b).visibility]))
  assert.deepEqual(shown, [['Details', 'hidden'], ['Chat about this card', 'hidden'], ['Delete', 'hidden'], ['Star', 'hidden'], ['Locked', 'visible']])
  // unlocked again, the card is only its content at rest
  await page.mouse.move(box.x + 60, box.y + 20)
  await page.waitForTimeout(100)
  DATA.cells[0].locked = false
  await card.locator('.bcell-lock').click()
  await page.waitForTimeout(300)
  assert.deepEqual(sent.filter((s: any) => s.method === 'PUT').at(-1).body, { locked: false })
  await page.mouse.move(990, 690)
  await page.waitForTimeout(800)
  assert.equal(await card.locator('.bcell-lock').evaluate((b: any) => getComputedStyle(b.parentElement).visibility), 'hidden')
})

test('a card dragged onto the empty board is placed free there: the move route with no group and its pos', async () => {
  // a card drags from anywhere but its text (which a card selected alone edits) and its controls: here the empty middle
  // of its chrome's row
  sent.length = 0
  const c = await page.locator('.bcell').nth(1).boundingBox()
  await page.mouse.move(c.x + 300, c.y + 16)
  await page.mouse.down()
  await page.mouse.move(c.x + 300, c.y + 40, { steps: 5 })
  await page.mouse.move(970, 600, { steps: 5 })
  assert.equal(await page.locator('.board-tag').innerText(), 'Place freely')
  await page.mouse.up()
  await page.waitForTimeout(300)
  const move = sent.find((s: any) => s.path === '/api/ws/mini/cells/move')
  assert.ok(move, 'the move route was called')
  assert.deepEqual(move.body.cells, ['f2'])
  assert.equal(move.body.group, null)
  assert.ok(move.body.pos && move.body.pos.x > 500, `placed where it was dropped: ${JSON.stringify(move.body.pos)}`)
})

test('dropped in the gap above a card of the same frame, it goes into the flow before it', async () => {
  sent.length = 0
  // the route answered without changing the data, so the reload put f2 back under f1
  await page.waitForTimeout(300)
  const f1 = await page.locator('.bcell').nth(0).boundingBox()
  const f2 = await page.locator('.bcell').nth(1).boundingBox()
  await page.mouse.move(f2.x + 300, f2.y + 16)
  await page.mouse.down()
  await page.mouse.move(f1.x + 60, f1.y + 30, { steps: 5 })
  await page.mouse.move(f1.x + 60, f1.y - 8, { steps: 5 })
  assert.equal(await page.locator('.board-ins').count(), 1, 'the accent bar in the gap')
  await page.mouse.up()
  await page.waitForTimeout(300)
  const move = sent.find((s: any) => s.path === '/api/ws/mini/cells/move')
  assert.deepEqual(move.body, { cells: ['f2'], group: 'final', after: null })
})

test('over a gap in another frame it moves there: "Move to Scratch", then the move route into that frame', async () => {
  sent.length = 0
  await page.waitForTimeout(300)
  const f1 = await page.locator('.bcell').nth(0).boundingBox()
  const s1 = await page.locator('.frame[data-group="scratch"]').boundingBox()
  const s1card = await page.locator('.bcell').nth(2).boundingBox()
  assert.ok(s1card.x >= s1.x, 'the third card drawn is Scratch\'s')
  await page.mouse.move(f1.x + 300, f1.y + 16)
  await page.mouse.down()
  await page.mouse.move(s1card.x + 60, s1card.y + 40, { steps: 5 })
  await page.mouse.move(s1card.x + 60, s1card.y - 8, { steps: 5 })
  assert.equal(await page.locator('.board-tag').innerText(), 'Move to Scratch')
  assert.equal(await page.locator('.frame[data-group="scratch"].is-target.is-into').count(), 1, 'the frame it goes to takes the ring and the tint')
  await page.mouse.up()
  await page.waitForTimeout(300)
  const move = sent.find((s: any) => s.path === '/api/ws/mini/cells/move')
  assert.deepEqual(move.body, { cells: ['f1'], group: 'scratch', after: null })
})

test('a marquee selects the cards it touches; ⌘G groups them in their frame, where the first of them was', async () => {
  sent.length = 0
  await page.waitForTimeout(300)
  const f1 = await page.locator('.bcell').nth(0).boundingBox()
  const f2 = await page.locator('.bcell').nth(1).boundingBox()
  await page.mouse.move(f1.x + f1.width + 10, f1.y + 10)
  await page.mouse.down()
  await page.mouse.move(f1.x + 50, f2.y + 20, { steps: 8 })
  await page.mouse.up()
  assert.equal(await page.locator('.bcell.is-selected').count(), 2)
  assert.match(await page.locator('.board-status').innerText(), /2 selected$/)
  assert.equal(await page.locator('.bctl-count').innerText(), '2 selected')
  await page.keyboard.press('Control+g')
  await page.waitForTimeout(400)
  const made = sent.find((s: any) => s.path === '/api/ws/mini/notebooks')
  assert.deepEqual(made.body, { title: 'Group 1', parent: 'final', order: 0 }, 'a new group in Final, where the first of them was')
  const move = sent.find((s: any) => s.path === '/api/ws/mini/cells/move')
  assert.deepEqual(move.body, { cells: ['f1', 'f2'], group: 'newg' })
})

test('a frame dragged by its title out of its parent lands on the board with its pos', async () => {
  sent.length = 0
  await page.keyboard.press('Escape')
  const t = await page.locator('.frame[data-group="scratch"] .frame-title').boundingBox()
  await page.mouse.move(t.x + 30, t.y + 12)
  await page.mouse.down()
  await page.mouse.move(t.x + 200, t.y + 200, { steps: 5 })
  await page.mouse.move(t.x + 300, 650, { steps: 5 })
  await page.mouse.up()
  await page.waitForTimeout(300)
  const put = sent.find((s: any) => s.path === '/api/ws/mini/notebooks/scratch')
  assert.equal(put.body.parent, null)
  assert.equal(put.body.order, null)
  assert.ok(put.body.pos.y > 500)
})

test('a click selects a card; Delete deletes it; the details open in the panel; a double click opens focus mode', async () => {
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  const y = await page.locator('.bcell').first().boundingBox()
  // on the card's body, not its question (a click on the question of a card selected alone edits it)
  await page.mouse.click(y.x + 200, y.y + 70)
  assert.equal(await page.locator('.bcell.is-selected').count(), 1)
  await page.locator('.bcell.is-selected [aria-label=Details]').click()
  assert.equal(await page.locator('.bdetail .bdetail-q').inputValue(), 'Question f1')
  assert.equal(await page.locator('.bdetail-thread').innerText(), 'main')
  await page.locator('.bdetail-close').click()
  assert.equal(await page.locator('.bdetail').count(), 0)
  await page.mouse.dblclick(y.x + 200, y.y + 70)
  await page.waitForSelector('.bfocus')
  assert.deepEqual(await page.locator('.bfocus-item').allInnerTexts(), ['Question f1', 'Question f2'])
  assert.equal(await page.locator('.bfocus-pos').innerText(), '1 of 2')
  await page.keyboard.press('ArrowDown')
  assert.equal(await page.locator('.bfocus-pos').innerText(), '2 of 2')
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('.bfocus').count(), 0)
  sent.length = 0
  await page.keyboard.press('Delete')
  await page.waitForTimeout(300)
  assert.deepEqual(sent.map((s: any) => [s.method, s.path]), [['DELETE', '/api/ws/mini/cells/f2']], 'the card focus mode last showed is the one selected')
})

test("a card resizes from any edge: a card in a frame's flow keeps its place, a card placed free keeps its opposite edge", async () => {
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  const drag = async (edge: any, dx: any, dy: any) => {
    sent.length = 0
    const b = await page.locator('.bcell').first().locator(`.bcell-edge-${edge}`).boundingBox()
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
    await page.mouse.down()
    await page.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2 + dy, { steps: 4 })
    await page.mouse.up()
    await page.waitForTimeout(400)
    return sent.filter((x: any) => x.method === 'PUT' && x.path === '/api/ws/mini/cells/f1').map((x: any) => x.body)
  }
  const box = await page.locator('.bcell').first().boundingBox()
  assert.deepEqual(await drag('e', 100, 0), [{ width: Math.round(box.width + 100) }], 'the right edge: the width alone')
  const bottom = await drag('s', 0, 60)
  assert.deepEqual(Object.keys(bottom[0]), ['height'], 'the bottom edge: the height alone')
  assert.ok(Math.abs(bottom[0].height - (box.height + 60)) <= 2, JSON.stringify(bottom))
  // the card is in Final's column: its left edge widens it and it keeps the column's left edge (no pos)
  DATA.cells[0].pos = { x: 30, y: 60 } // what the reload after this change reads: the card placed free in Final
  assert.deepEqual(await drag('w', -50, 0), [{ width: Math.round(box.width + 50) }])
  await page.waitForTimeout(300)
  // placed free, its left edge moves its place by what it widens, so its right edge stays
  assert.deepEqual(await drag('w', -50, 0), [{ width: Math.round(box.width + 50), pos: { x: -20, y: 60 } }])
  const topEdge = await drag('n', 0, -40)
  assert.deepEqual(Object.keys(topEdge[0]), ['height', 'pos'])
  assert.equal(topEdge[0].pos.x, 30)
  assert.ok(Math.abs(topEdge[0].pos.y - 20) <= 2 && Math.abs(topEdge[0].height - (box.height + 40)) <= 2, JSON.stringify(topEdge))
  delete DATA.cells[0].pos
})

test('the search menu dims the cards it leaves out, names what it keeps in the band, and the minimap draws the kept cards in ink', async () => {
  await page.keyboard.press('Escape')
  await page.locator('.bctl-filter').click()
  await page.waitForSelector('.bfilter')
  assert.deepEqual(await page.locator('.bfilter .menu-heading').allInnerTexts(), ['KIND', 'GROUP', 'MADE BY', 'CARD CHECK', 'MARKED'], 'a heading per part (in caps, as menu headings are)')
  await page.locator('.bfilter .menu-item', { hasText: /^Final/ }).click()
  await page.waitForTimeout(200)
  assert.equal(await page.locator('.bfilter').count(), 1, 'the menu stays open for the next choice')
  assert.equal(await page.locator('.bfilter .menu-item.checked').innerText().then((t: any) => t.split('\n')[0]), 'Final')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  assert.deepEqual(await page.locator('.board-band .chip').allInnerTexts().then((ts: any) => ts.map((t: any) => t.replace(/\s+/g, ' ').trim())), ['Group · Final 2'])
  const dim = await page.locator('.bcell').evaluateAll((els: any) => els.map((e: any) => [e.querySelector('[data-cell]').dataset.cell, e.classList.contains('is-dimmed')]))
  assert.deepEqual(dim.filter(([, d]: any) => !d).map(([id]: any) => id), ['f1', 'f2'], 'the cards the filter leaves out dim')
  assert.equal(await page.locator('.bctl-map-card.is-kept').count(), 2)
  assert.equal(await page.locator('.bctl-map-card.is-left').count(), dim.length - 2)
  assert.equal(await page.locator('.bctl-filter-count').innerText(), '1')
  // the server keeps it, so every tab, a reload and the chat see it
  const put = () => sent.filter((x: any) => x.path === '/api/ws/mini/filters/canvas/cards').at(-1)?.body
  assert.deepEqual(put(), { kinds: [], groups: ['final'], makers: [], checks: [], starred: false, locked: false, text: '' })
  assert.deepEqual(FILTERS, { canvas: { groups: ['final'] } })
  // the chip clears its part
  await page.locator('.board-band .chip').click()
  await page.waitForTimeout(400)
  assert.equal(await page.locator('.board-band').count(), 0)
  assert.deepEqual(FILTERS, {})
  assert.equal(await page.locator('.bcell.is-dimmed').count(), 0)
  assert.equal(await page.locator('.bctl-map-card.is-kept, .bctl-map-card.is-left').count(), 0)
})

test('the search menu searches the questions and takeaways, and the words typed stay as typed while they are written', async () => {
  await page.locator('.bctl-filter').click()
  await page.waitForSelector('.bfilter-search input')
  // the search takes the focus on the frame after the menu is placed, so the test waits for that frame
  const focused = await page
    .waitForFunction(() => document.activeElement?.closest('.bfilter-search') != null, null, { timeout: 2000 })
    .then(() => true, () => false)
  assert.equal(focused, true, 'the search takes the keyboard')
  await page.keyboard.type('One day ')
  await page.waitForTimeout(500)
  assert.equal(await page.locator('.bfilter-search input').inputValue(), 'One day ', "the server's answer leaves the space just typed")
  assert.equal(FILTERS.canvas?.text, 'One day')
  await page.keyboard.type('dominates')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
  assert.deepEqual(await page.locator('.board-band .chip').allInnerTexts().then((ts: any) => ts.map((t: any) => t.replace(/\s+/g, ' ').trim())), ['Text · "One day dominates" 1'])
  const kept = await page.locator('.bcell:not(.is-dimmed) [data-cell]').evaluateAll((els: any) => els.map((e: any) => e.dataset.cell))
  assert.deepEqual(kept, ['f1'], 'the one card whose takeaway holds every word')
  // Clear filters clears the whole filter in one write
  await page.locator('.bctl-filter').click()
  await page.locator('.bfilter .menu-item', { hasText: 'Clear filters' }).click()
  await page.waitForTimeout(300)
  assert.deepEqual(sent.at(-1), { method: 'DELETE', path: '/api/ws/mini/filters/canvas', body: null })
  assert.equal(await page.locator('.board-band').count(), 0)
  await page.keyboard.press('Escape')
})

test('nothing threw', () => {
  assert.deepEqual(pageErrors, [])
})

test('Card and Group sit at the top right; the search, zoom, Fit and minimap are one group at the bottom right', async () => {
  const [top, nav] = await Promise.all([page.locator('.bctl-top').boundingBox(), page.locator('.bctl-nav').boundingBox()])
  assert.ok(top.y < 40, `the add bar is at the top: ${JSON.stringify(top)}`)
  assert.ok(nav.y + nav.height > 600, `the navigation group is at the bottom: ${JSON.stringify(nav)}`)
  assert.ok(Math.abs(top.x + top.width - (nav.x + nav.width)) < 1, 'both are held to the right edge')
  assert.deepEqual(await page.locator('.bctl-zoom > *').evaluateAll((els: any) => els.map((e: any) => e.getAttribute('aria-label') ?? e.textContent)), ['Search and filter the cards', '', 'Zoom out', '100%', 'Zoom in', '', 'Fit'])
})

test("the search menu holds the card check's automatic switch under a label that says it, and the switch sends it", async () => {
  await page.locator('.bctl-filter').click()
  await page.waitForSelector('.bfilter-auto')
  const sw = page.locator('.bfilter-auto [role=switch]')
  assert.equal(await page.locator('.bfilter-auto-text').innerText(), 'Check new cards automatically')
  // the switch reads the check's state from GET /card-checks, which the menu asks for as it opens
  await page.waitForSelector('.bfilter-auto [role=switch][aria-checked="true"]', { timeout: 5000 })
  await page.locator('.bfilter-auto-text').click()
  await page.waitForTimeout(300)
  assert.deepEqual(sent.at(-1), { method: 'PUT', path: '/api/ws/mini/card-checks/auto', body: { on: false } })
  assert.equal(await sw.getAttribute('aria-checked'), 'false')
  assert.equal(await page.locator('.bfilter-running').count(), 0, 'no count while no check runs')
  await page.keyboard.press('Escape')
})
