// The clicks on a collapsed deck and on its title (src/canvas/Canvas.tsx, Cell.tsx): a click on the deck opens it and a
// click outside collapses it again, a title's click opens or collapses
// its frame and only a quick second click renames it, and a double click on any card of an open deck, on its text too,
// opens focus mode.
import assert from 'node:assert/strict'
import { afterAll, beforeAll, test } from 'vitest'
import { addStyles, bundle, cleanup, launch, src } from './page.ts'

let script: string
let browser: any, page: any
const pageErrors: any[] = []

const group = (id: string, extra = {}) => ({ id, title: id, parent: null, kind: 'sequence', anchor: null, chat: null, role: 'analyst', n_cells: 0, pos: null, order: null, ...extra })
const cell = (id: string, notebook: string): any => ({ id, notebook, kind: 'note', title: `Question ${id}`, created_by: 'user', ts: '2026-09-22T10:00:00Z', payload: { text: `Text of ${id}` }, text: `Text of ${id}`, takeaway: `Takeaway of ${id}.` })
const DECK = ['o1', 'o2', 'o3', 'o4', 'o5', 'o6']
const DATA = {
  groups: [group('orient', { title: 'Orientation', role: 'exploration' }), group('mine', { title: 'Your work', pos: { x: 1000, y: 60 } })],
  cells: [...DECK.map((id) => cell(id, 'orient')), cell('y1', 'mine'), cell('y2', 'mine'), cell('s1', 'scratch')],
  // an older workspace's scratch work, not on the board: the chip that names it lands on the deck
  hidden: ['s1'],
}

beforeAll(async () => {
  script = await bundle('canvas-deck', [
    `import { createRoot } from 'react-dom/client'`,
    `import { Canvas } from '${src('canvas/Canvas.tsx')}'`,
    `import { teleport } from '${src('lib/teleport.ts')}'`,
    `;(window as any).teleport = teleport`,
    `const el = document.createElement('div')`,
    `el.style.cssText = 'position:absolute;left:0;top:0;width:1000px;height:700px;display:flex;flex-direction:column'`,
    `document.body.appendChild(el)`,
    `localStorage.setItem('thimble:deck:canvas-view', JSON.stringify({ x: 0, y: 0, scale: 0.5 }))`,
    `createRoot(el).render(<Canvas ws="deck" active />)`,
  ])
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
  page.on('pageerror', (e: any) => pageErrors.push(String(e)))
  await page.route('http://thimble.test/**', (route: any) => {
    const req = route.request()
    const url = req.url()
    const json = (body: any) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    if (req.method() !== 'GET' && /\/api\//.test(url)) return json({ ok: true })
    if (/\/api\/ws\/deck\/canvas$/.test(url)) return json(DATA)
    if (/\/api\/ws\/deck\/chats$/.test(url)) return json([])
    if (/\/api\/ws\/deck\/filters$/.test(url)) return json({})
    if (/\/api\/ws\/deck\/concepts$/.test(url)) return json([])
    if (/\/api\/ws\/deck\/card-checks$/.test(url)) return json({ enabled: false, auto: false, render: false, render_why: '', concurrency: 1, running: [], timings: [] })
    if (/\/api\//.test(url)) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"detail":"no"}' })
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"></body></html>' })
  })
  await page.goto('http://thimble.test/?ws=deck')
  await addStyles(page, ['tokens', 'base', 'components', 'outputs', 'canvas'])
  await page.addScriptTag({ path: script })
  await page.waitForSelector('.frame')
  await page.waitForTimeout(300)
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

const shown = () => page.evaluate(() => [...document.querySelectorAll('.frame[data-group] ~ .bcell, .bcell')].map((c: any) => c.querySelector('[data-cell]').dataset.cell))
const deckShown = async () => (await shown()).filter((id: string) => id.startsWith('o'))
const card = (id: string) => page.locator(`.bcell:has([data-cell="${id}"])`)
const box = async (sel: any) => (typeof sel === 'string' ? page.locator(sel) : sel).boundingBox()
// a spot of the empty board: below the Your work frame, right of the deck
const outside = async () => {
  const f = await box('.frame[data-group="mine"]')
  return { x: f.x + 40, y: Math.min(680, f.y + f.height + 60) }
}

test('a click on a collapsed deck\'s card opens it; a click on the empty board outside it collapses it again', async () => {
  assert.deepEqual(await deckShown(), ['o1'], 'collapsed, the deck shows its first card')
  const c = await box(card('o1'))
  await page.mouse.click(c.x + c.width / 2, c.y + c.height - 8)
  await page.waitForTimeout(100)
  assert.deepEqual(await deckShown(), DECK, 'the click opened the deck')
  assert.equal(await page.locator('.bcell.is-selected').count(), 1, 'and selected the card')
  // a click inside the open frame, on its padding, keeps it open
  const f = await box('.frame[data-group="orient"]')
  await page.mouse.click(f.x + 4, f.y + f.height / 2)
  await page.waitForTimeout(100)
  assert.deepEqual(await deckShown(), DECK, 'a click inside the frame keeps it open')
  const o = await outside()
  await page.mouse.click(o.x, o.y)
  await page.waitForTimeout(100)
  assert.deepEqual(await deckShown(), ['o1'], 'a click outside collapsed it')
})

test('a click on the edges under a collapsed deck opens it; a click on a card of another frame collapses it', async () => {
  const c = await box(card('o1'))
  await page.mouse.click(c.x + c.width / 2, c.y + c.height + 3)
  await page.waitForTimeout(100)
  assert.deepEqual(await deckShown(), DECK, 'the edges opened the deck')
  const y = await box(card('y1'))
  await page.mouse.click(y.x + y.width / 2, y.y + y.height - 8)
  await page.waitForTimeout(100)
  assert.deepEqual(await deckShown(), ['o1'], 'a click on a card of Your work collapsed the deck')
  // Your work opened by that click on its deck, and collapses at a click on the board
  const o = await outside()
  await page.mouse.click(o.x, o.y)
  await page.waitForTimeout(100)
  assert.deepEqual((await shown()).filter((id: string) => id.startsWith('y')), ['y1'])
})

test('a click on the title opens the frame and it stays open at a click outside; two slow clicks never rename it', async () => {
  const t = await box('.frame[data-group="orient"] .frame-name')
  await page.mouse.click(t.x + 5, t.y + t.height / 2)
  await page.waitForTimeout(350)
  assert.deepEqual(await deckShown(), DECK, 'the title opened the frame')
  assert.equal(await page.locator('.frame-rename').count(), 0, 'one click does not rename')
  const o = await outside()
  await page.mouse.click(o.x, o.y)
  await page.waitForTimeout(100)
  assert.deepEqual(await deckShown(), DECK, 'a frame its title opened stays open')
  // two clicks 300ms apart: within the browser's double click, past the title's; the frame collapses and opens again
  await page.mouse.click(t.x + 5, t.y + t.height / 2)
  await page.waitForTimeout(300)
  // one press and release the browser counts as the second of a double click (its dblclick fires)
  await page.mouse.down({ clickCount: 2 })
  await page.mouse.up({ clickCount: 2 })
  await page.waitForTimeout(350)
  assert.equal(await page.locator('.frame-rename').count(), 0, 'two slow clicks do not rename')
  assert.deepEqual(await deckShown(), DECK, 'they collapsed and opened the frame')
  // a quick double click renames, and leaves the frame as it was
  await page.mouse.dblclick(t.x + 5, t.y + t.height / 2)
  await page.waitForTimeout(350)
  assert.equal(await page.locator('.frame-rename').count(), 1, 'a double click renames')
  assert.deepEqual(await deckShown(), DECK)
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('.frame-rename').count(), 0)
})

test('a double click on any card of the open deck opens focus mode, on its question or takeaway too, the last card among them', async () => {
  // the last card, panned into view with the wheel
  await page.mouse.move(500, 400)
  for (let i = 0; i < 20 && ((await box(card('o6'))).y + 120 > 700); i++) {
    await page.mouse.wheel(0, 200)
    await page.waitForTimeout(50)
  }
  const last = await box(card('o6'))
  assert.ok(last.y + 60 < 700, 'the last card is in view')
  // selected alone first, so a single click on its text would edit it
  await page.mouse.click(last.x + last.width / 2, last.y + 8)
  const take = await box(card('o6').locator('.bcell-take-text'))
  await page.mouse.dblclick(take.x + 10, take.y + take.height / 2)
  await page.waitForSelector('.bfocus')
  assert.equal(await page.locator('.bfocus-pos').innerText(), '6 of 6')
  assert.equal(await page.locator('.bcell-edit').count(), 0, 'the double click did not also edit the takeaway')
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('.bfocus').count(), 0)
  const q = await box(card('o5').locator('.bcell-q'))
  await page.mouse.click(q.x + 10, q.y + q.height / 2)
  await page.waitForTimeout(50)
  await page.mouse.dblclick(q.x + 10, q.y + q.height / 2)
  await page.waitForSelector('.bfocus')
  assert.equal(await page.locator('.bfocus-pos').innerText(), '5 of 6')
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('.bcell-edit').count(), 0)
})

test('a single click on the question of a card selected alone still edits it, once no second click follows', async () => {
  const q = await box(card('o5').locator('.bcell-q'))
  await page.mouse.click(q.x + 10, q.y + q.height / 2)
  await page.waitForTimeout(400)
  assert.equal(await page.locator('.bcell-edit').count(), 1)
  await page.keyboard.press('Escape')
})

const focusPos = async () => {
  await page.waitForSelector('.bfocus')
  return page.locator('.bfocus-pos').innerText()
}
const closeFocus = async () => {
  await page.keyboard.press('Escape')
  await page.waitForTimeout(50)
  assert.equal(await page.locator('.bfocus').count(), 0)
}

// focus mode starts on the deck's first card, a later card only when it is the one double clicked
test('the deck\'s canvas chip opens focus mode on its first card, whichever card of the deck it names', async () => {
  await page.evaluate(() => (window as any).teleport('card:o4', { focus: true }))
  assert.equal(await focusPos(), '1 of 6')
  assert.match(await page.locator('.bfocus').innerText(), /Question o1/)
  await closeFocus()
  await page.evaluate(() => (window as any).teleport('group:orient', { focus: true }))
  assert.equal(await focusPos(), '1 of 6', 'a chip naming the frame itself')
  await closeFocus()
  // the orientation's chip of an older workspace names a hidden scratch card: the deck's first card instead
  await page.evaluate(() => (window as any).teleport('card:s1', { focus: true }))
  assert.equal(await focusPos(), '1 of 6', 'a hidden scratch card redirects to the deck')
  await closeFocus()
  // a plain ref to a card (a card's chip) still only brings the card into view
  await page.evaluate(() => (window as any).teleport('card:o4'))
  await page.waitForTimeout(400)
  assert.equal(await page.locator('.bfocus').count(), 0)
})

test('Enter on a selected frame opens focus mode on its first card; Enter on a selected card, on that card', async () => {
  const d = await box(card('o3'))
  await page.mouse.click(d.x + d.width / 2, d.y + d.height - 8)
  await page.waitForTimeout(300)
  await page.keyboard.press('Enter')
  assert.equal(await focusPos(), '3 of 6')
  await closeFocus()
  // the deck's title brought into view, then clicked: the frame selected, no card
  await page.evaluate(() => (window as any).teleport('group:orient'))
  await page.waitForTimeout(400)
  const t = await box('.frame[data-group="orient"] .frame-name')
  await page.mouse.click(t.x + 5, t.y + t.height / 2)
  await page.waitForTimeout(350)
  assert.equal(await page.locator('.frame.is-selected').count(), 1, 'the frame is selected')
  await page.keyboard.press('Enter')
  assert.equal(await focusPos(), '1 of 6')
  await closeFocus()
})

test('nothing threw', () => {
  assert.deepEqual(pageErrors, [])
})
