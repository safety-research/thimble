// The view kit's record card (backend/app/viewer_kit.css .thimble-card, viewer_colour.js thimble.recordCard), in a real
// browser: a page in a sandboxed frame draws records as cards in a column and colors them by a field with the kit's
// Color by. A card is a hairline box on the paper with the chip token's corners and no colour of its own; Color by's
// bar is its only colour, drawn by the bridge on its left edge, and the card's left corners go square under it, so the
// bar is as straight at the card's top as at its middle. With Off the card has no bar and its corners are all the
// token's again. With two or three Color by choices the bar is a straight band per choice, side by side from the
// edge in the order of the choices, as wide and as far apart as the bands on the kit's list row beside it, empty where
// the card has no value or its value's colour is turned off (the card stays); the text stays clear of them, in light
// and dark, in a column and in a tile grid, and with more choices than the padding holds the padding widens and the
// bands stay inside the card. The pixels across each card's edge are read from a picture of the page. What
// recordCard writes, without layout, is tests/public/record-card.test.ts.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Frame, Page } from 'playwright'
import { cleanup, FRONTEND, launch } from './page.ts'

const APP = path.join(FRONTEND, '..', 'backend', 'app')
const read = (name: string) => readFileSync(path.join(APP, name), 'utf8')
const inline = (js: string) => js.replace(/<\/script/g, '<\\/script')
const BRIDGE = inline(read('viewer_bridge.js'))
const COLOUR = `window.__thimbleLabelOrder = ${read('label_order.json')}\n` + inline(read('viewer_colour.js'))
const KIT = read('viewer_kit.css')
const TOKENS =
  ':root{--label-1:#025ac3;--label-2:#d0750a;--label-3:#08632f;--label-none:#a09c93;--ink-rgb:27,26,24;--surface-card:#ffffff;' +
  '--text-primary:#000;--text-secondary:#4a4844;--text-tertiary:#726f69;--accent:#5135ff;--radius-chip:4px;--radius-ui:6px;--radius-card:8px;' +
  '--h-row:28px;--control-sm:28px;--h-control:24px;--h-chip:20px;--text-xs:12px;--text-ui-sm:12px;--text-mono-sm:11px;' +
  '--border-subtle:rgba(27,26,24,0.12);--border-strong:rgba(27,26,24,0.22);--font-body:sans-serif;--font-mono:monospace}'
const PRS = [
  { number: 66599, ref: 'forge.db#prs/66599', claimant: 'agent-08', title: 'DOC: fix url in concat docs to copy-on-write' },
  { number: 66191, ref: 'forge.db#prs/66191', claimant: 'agent-21', title: 'BUG: rolling window behavior with offsets' },
  { number: 66047, ref: 'forge.db#prs/66047', claimant: '', title: 'BUG: fix plotting with tz-aware index' },
]
const view = `<!doctype html><html><head><style>${TOKENS} body{margin:0;font:12px sans-serif;background:#f0f0f0} .top{display:flex;align-items:center;gap:8px;padding:8px} #col{width:240px;margin:8px 16px}</style>
<script>${BRIDGE}</script><script>${COLOUR}</script><style>${KIT}</style></head><body>
<div class="top"><span id="colour"></span></div><div id="col" class="thimble-cards"></div>
<script>
const PRS = ${JSON.stringify(PRS)}
const draw = () => (document.getElementById('col').innerHTML = PRS.map((pr) => thimble.recordCard({ ref: pr.ref, record: pr, key: '#' + pr.number, chips: [pr.claimant], title: pr.title })).join(''))
window.colour = thimble.colourBy({ mount: '#colour', fields: [{ name: 'claimant', title: 'Claimant', values: ['agent-08', 'agent-21'] }], onChange: draw })
draw()
</script></body></html>`

const BLUE = 'rgb(2, 90, 195)'
const ORANGE = 'rgb(208, 117, 10)'
const WHITE = 'rgb(255, 255, 255)'

let browser: Browser
beforeAll(async () => {
  browser = await launch()
})
afterAll(async () => {
  await browser?.close()
  cleanup()
})

async function framed(): Promise<{ page: Page; frame: () => Frame }> {
  const page = await browser.newPage({ viewport: { width: 500, height: 400 }, deviceScaleFactor: 1 })
  await page.setContent('<!doctype html><html><body style="margin:0"><iframe id="f" sandbox="allow-scripts" style="border:0;width:400px;height:360px;display:block"></iframe></body></html>')
  await page.evaluate((doc) => ((document.getElementById('f') as HTMLIFrameElement).srcdoc = doc), view)
  const frame = () => page.frames().find((f) => f !== page.mainFrame())!
  await page.waitForFunction(() => (document.getElementById('f') as HTMLIFrameElement).contentWindow)
  await page.waitForTimeout(300)
  await frame().waitForFunction(() => document.querySelectorAll('.thimble-card[data-thimble-edge]').length === 2)
  await page.waitForTimeout(200)
  return { page, frame }
}

/** The colours of the `n` pixels from a card's left edge inward, `dy` px below its top (null: at its middle), read
 * from a picture of the page. */
async function edge(page: Page, frame: Frame, ref: string, dy: number | null, n = 6): Promise<string[]> {
  const r = await frame.evaluate(([ref, dy]) => {
    const b = document.querySelector(`[data-anchor="${ref}"]`)!.getBoundingClientRect()
    return { x: b.left, y: dy == null ? b.top + b.height / 2 : b.top + (dy as number) }
  }, [ref, dy] as const)
  const png = await page.screenshot({ clip: { x: Math.round(r.x), y: Math.floor(r.y), width: n, height: 1 } })
  return page.evaluate(async (b64) => {
    const img = new Image()
    img.src = 'data:image/png;base64,' + b64
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = 1
    const g = c.getContext('2d')!
    g.drawImage(img, 0, 0)
    const d = g.getImageData(0, 0, img.width, 1).data
    const out: string[] = []
    for (let i = 0; i < d.length; i += 4) out.push(`rgb(${d[i]}, ${d[i + 1]}, ${d[i + 2]})`)
    return out
  }, png.toString('base64'))
}

/** A card's look as the browser computes it. */
const look = (frame: Frame, ref: string) =>
  frame.evaluate((ref) => {
    const cs = getComputedStyle(document.querySelector(`[data-anchor="${ref}"]`)!)
    return {
      radius: [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius],
      left: cs.borderLeftWidth,
      right: cs.borderRightWidth,
      bg: cs.backgroundColor,
      token: getComputedStyle(document.documentElement).getPropertyValue('--radius-chip').trim(),
    }
  }, ref)

test("a card has the chip token's corners, a hairline edge and the paper; Color by's bar is straight on its left edge, and Off draws none", async () => {
  const { page, frame } = await framed()
  // colored: the bar on the left edge, inside the hairline, the left corners square under it
  const hot = await look(frame(), 'forge.db#prs/66599')
  assert.deepEqual(hot.radius, ['0px', '4px', '4px', '0px'], 'square on the left under the bar, the token on the right')
  assert.equal(hot.left, '1px', 'a hairline on the left, as on every side: no stripe of its own')
  assert.equal(hot.right, '1px')
  assert.equal(hot.bg, WHITE, 'the paper')
  for (const [ref, colour] of [['forge.db#prs/66599', BLUE], ['forge.db#prs/66191', ORANGE]] as const) {
    const middle = await edge(page, frame(), ref, null)
    assert.deepEqual(middle.slice(1, 5), [colour, colour, colour, WHITE], `${ref}: three pixels of its value's colour inside the hairline, then the paper`)
    assert.deepEqual(await edge(page, frame(), ref, 1), middle, `${ref}: the bar as straight just under the card's top as at its middle`)
  }
  // a record with no value: no bar, the token's corners all round
  const none = await look(frame(), 'forge.db#prs/66047')
  assert.deepEqual(none.radius, Array(4).fill(none.token), 'no value: the chip token on every corner')
  assert.ok(!(await edge(page, frame(), 'forge.db#prs/66047', null)).slice(1, 4).some((c) => c === BLUE || c === ORANGE))

  // Off: no bar on any card, every corner the token's
  await frame().click('.thimble-colour-by')
  await frame().click('.thimble-colour-menu [data-by="off"]')
  await frame().waitForFunction(() => !document.querySelector('[data-thimble-edge]'))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  for (const pr of PRS) {
    const l = await look(frame(), pr.ref)
    assert.deepEqual(l.radius, Array(4).fill('4px'), `${pr.ref}: the token's corners with Off`)
    assert.deepEqual((await edge(page, frame(), pr.ref, null)).slice(1, 4), [WHITE, WHITE, WHITE], `${pr.ref}: no bar with Off`)
  }
  await page.close()
}, 60_000)

// ---------------------------------------------------------------- several Color by choices
// three fields, each value in a palette place of its own; four more that every record has one value of, for a view
// with more choices than the card's padding holds
const MANY = ['d1', 'd2', 'd3', 'd4']
const RECS = [
  { ref: 'forge.db#prs/1', number: 1, claimant: 'agent-08', state: 'open', kind: 'doc', title: 'DOC: fix url in concat docs to copy-on-write' },
  { ref: 'forge.db#prs/2', number: 2, claimant: 'agent-21', state: 'merged', kind: 'bug', title: 'BUG: rolling window behavior with offsets' },
  { ref: 'forge.db#prs/3', number: 3, claimant: '', state: 'open', kind: '', title: 'BUG: fix plotting with tz-aware index' },
]
const PALETTE = '--label-1:#025ac3;--label-2:#d0750a;--label-3:#08632f;--label-5:#8a6d00;--label-6:#0e7c86;--label-7:#7a4a1c;--label-none:#a09c93;'
const LIGHT =
  `:root{${PALETTE}--ink-rgb:27,26,24;--surface-card:#ffffff;--text-primary:#000;--text-secondary:#4a4844;--text-tertiary:#726f69;--accent:#5135ff;` +
  '--radius-chip:4px;--radius-ui:6px;--radius-card:8px;--h-row:28px;--control-sm:28px;--h-control:24px;--h-chip:20px;--text-xs:12px;--text-ui-sm:12px;' +
  '--text-mono-sm:11px;--border-subtle:rgba(27,26,24,0.12);--border-strong:rgba(27,26,24,0.22);--font-body:sans-serif;--font-mono:monospace} body{background:#ffffff}'
const DARK =
  `:root{${PALETTE}--ink-rgb:236,234,228;--surface-card:#262624;--text-primary:#eceae4;--text-secondary:#b8b5ad;--text-tertiary:#8f8c85;--accent:#8f7dff;` +
  '--radius-chip:4px;--radius-ui:6px;--radius-card:8px;--h-row:28px;--control-sm:28px;--h-control:24px;--h-chip:20px;--text-xs:12px;--text-ui-sm:12px;' +
  '--text-mono-sm:11px;--border-subtle:rgba(236,234,228,0.14);--border-strong:rgba(236,234,228,0.26);--font-body:sans-serif;--font-mono:monospace} body{background:#262624}'
/** A page that draws RECS as cards in a column, as tiles in a grid and as the kit's list rows, Color by starting on
 * `picks` (the choices thimble kept for the view), on the light or the dark tokens. */
const bandsView = (picks: string[], dark: boolean) => `<!doctype html><html><head><style>${dark ? DARK : LIGHT} body{margin:0;font:12px sans-serif;color:var(--text-primary)} .top{display:flex;align-items:center;gap:8px;padding:8px} #wrap{display:flex;align-items:flex-start} #col{width:240px;margin:8px 16px} #rows{width:240px;margin:8px 24px} #grid{width:470px;margin:8px 16px}</style>
<script>window.__thimbleColour = ${JSON.stringify({ v: 1, by: picks[0], picks, off: {}, seen: [], colours: {} })}</script>
<script>${BRIDGE}</script><script>${COLOUR}</script><style>${KIT}</style></head><body>
<div class="top"><span id="colour"></span></div>
<div id="wrap"><div id="col" class="thimble-cards"></div><div id="rows"></div></div><div id="grid" class="thimble-cards-grid"></div>
<script>
const RECS = ${JSON.stringify(RECS)}
const FIELDS = [
  { name: 'claimant', title: 'Claimant', values: [{ name: 'agent-08', colour: 1 }, { name: 'agent-21', colour: 2 }] },
  { name: 'state', title: 'State', values: [{ name: 'open', colour: 3 }, { name: 'merged', colour: 5 }] },
  { name: 'kind', title: 'Kind', values: [{ name: 'doc', colour: 6 }, { name: 'bug', colour: 7 }] },
].concat(${JSON.stringify(MANY)}.map((name) => ({ name, title: name, value: () => 'x', values: [{ name: 'x', colour: 1 }] })))
const draw = () => {
  document.getElementById('col').innerHTML = RECS.map((r) => thimble.recordCard({ ref: r.ref, record: r, key: '#' + r.number, chips: [r.claimant], title: r.title })).join('')
  document.getElementById('grid').innerHTML = RECS.map((r) => thimble.recordCard({ ref: r.ref + '/tile', record: r, key: '#' + r.number, title: r.title })).join('')
  document.getElementById('rows').innerHTML = RECS.map((r) => '<div class="list-row" data-anchor="' + r.ref + '/row"' + colour.attr(r) + '><span>#' + r.number + ' ' + r.title.slice(0, 22) + '</span></div>').join('')
}
window.colour = thimble.colourBy({ mount: '#colour', fields: FIELDS, onChange: draw })
draw()
</script></body></html>`

const GREEN = 'rgb(8, 99, 47)'
const GOLD = 'rgb(138, 109, 0)'
const TEAL = 'rgb(14, 124, 134)'
const BROWN = 'rgb(122, 74, 28)'
const NIGHT = 'rgb(38, 38, 36)'

/** px: a band's width and the width of `n` bands, as the bridge gives them (viewer_bridge.js bandW, bandsW) */
const bandW = (n: number) => Math.max(1, Math.min(3, Math.floor((9 - (n - 1)) / n)))
const bandsW = (n: number) => n * bandW(n) + (n - 1)
/** The pixels of `n` bands of `colours` from the edge inward, a 1 px gap of `paper` between two and after the last. */
const expected = (colours: string[], paper: string) => colours.flatMap((c, i) => [...Array(bandW(colours.length)).fill(c), ...(i < colours.length - 1 ? [paper] : [])]).concat([paper])

async function framedBands(picks: string[], dark = false): Promise<{ page: Page; frame: () => Frame }> {
  const page = await browser.newPage({ viewport: { width: 560, height: 560 }, deviceScaleFactor: 1 })
  await page.setContent('<!doctype html><html><body style="margin:0"><iframe id="f" sandbox="allow-scripts" style="border:0;width:540px;height:540px;display:block"></iframe></body></html>')
  await page.evaluate((doc) => ((document.getElementById('f') as HTMLIFrameElement).srcdoc = doc), bandsView(picks, dark))
  const frame = () => page.frames().find((f) => f !== page.mainFrame())!
  await page.waitForFunction(() => (document.getElementById('f') as HTMLIFrameElement).contentWindow)
  await page.waitForTimeout(300)
  await frame().waitForFunction(() => document.querySelectorAll('.thimble-card[data-thimble-edge]').length === 6)
  await page.waitForTimeout(200)
  return { page, frame }
}

/** The colours of `n` pixels in a row of the picture, from `dx` px right of the left edge of the element `ref`
 * anchors (negative: left of it), `dy` px below the first whole pixel row at its top (null: at its middle). */
async function pixels(page: Page, frame: Frame, ref: string, dx: number, dy: number | null, n: number): Promise<string[]> {
  const r = await frame.evaluate(([ref, dy]) => {
    const b = document.querySelector(`[data-anchor="${ref}"]`)!.getBoundingClientRect()
    return { x: b.left, y: dy == null ? b.top + b.height / 2 : Math.ceil(b.top) + (dy as number) }
  }, [ref, dy] as const)
  const png = await page.screenshot({ clip: { x: Math.round(r.x) + dx, y: Math.floor(r.y), width: n, height: 1 } })
  return page.evaluate(async (b64) => {
    const img = new Image()
    img.src = 'data:image/png;base64,' + b64
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = 1
    const g = c.getContext('2d')!
    g.drawImage(img, 0, 0)
    const d = g.getImageData(0, 0, img.width, 1).data
    const out: string[] = []
    for (let i = 0; i < d.length; i += 4) out.push(`rgb(${d[i]}, ${d[i + 1]}, ${d[i + 2]})`)
    return out
  }, png.toString('base64'))
}

/** How far a card's text starts from its left edge, the bridge's edge on it, and its corners. */
const layout = (frame: Frame, ref: string) =>
  frame.evaluate((ref) => {
    const el = document.querySelector(`[data-anchor="${ref}"]`)!
    const b = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    const text = Math.min(...[...el.querySelectorAll('.thimble-card-key, .thimble-card-title')].map((t) => t.getBoundingClientRect().left))
    return { text: text - b.left, edge: el.getAttribute('data-thimble-edge'), radius: [cs.borderTopLeftRadius, cs.borderBottomLeftRadius], opacity: cs.opacity, display: cs.display }
  }, ref)

/** A card's bands, in the picture at its middle and 1 px under its top, as `colours` say: straight, in order, the gaps
 * and the empty ones in `paper`, inside the card's hairline; and its text clear of them, its left corners square. */
async function assertBands(page: Page, frame: Frame, ref: string, colours: string[], paper: string) {
  const want = expected(colours, paper)
  const middle = await pixels(page, frame, ref, 1, null, want.length)
  assert.deepEqual(middle, want, `${ref}: ${colours.length} bands inside the hairline, in the order of the choices`)
  assert.deepEqual(await pixels(page, frame, ref, 1, 1, want.length), middle, `${ref}: the bands as straight just under the card's top as at its middle`)
  const l = await layout(frame, ref)
  assert.equal(l.edge, 'bands', `${ref}: the bands in the card's padding, never outside its edge`)
  assert.deepEqual(l.radius, ['0px', '0px'], `${ref}: square on the left under the bands`)
  assert.ok(l.text >= 1 + bandsW(colours.length) + 3, `${ref}: the text starts ${l.text}px in, clear of ${bandsW(colours.length)}px of bands and a gap`)
}

test("two and three choices: a straight band per choice in their order on each card, as wide and as far apart as a list row's, empty where it has no value", async () => {
  for (const [picks, rows] of [
    [['f:claimant', 'f:state'], [[BLUE, GREEN], [ORANGE, GOLD], [WHITE, GREEN]]],
    [['f:claimant', 'f:state', 'f:kind'], [[BLUE, GREEN, TEAL], [ORANGE, GOLD, BROWN], [WHITE, GREEN, WHITE]]],
    [['f:kind', 'f:claimant', 'f:state'], [[TEAL, BLUE, GREEN], [BROWN, ORANGE, GOLD], [WHITE, WHITE, GREEN]]],
  ] as const) {
    const { page, frame } = await framedBands([...picks])
    for (const [i, rec] of RECS.entries()) {
      await assertBands(page, frame(), rec.ref, [...rows[i]], WHITE)
      // the tile in the grid as the card in the column
      await assertBands(page, frame(), rec.ref + '/tile', [...rows[i]], WHITE)
      // the kit's list row of the record: the same bands, as wide and as far apart, just outside its edge
      const w = bandsW(picks.length)
      assert.deepEqual(await pixels(page, frame(), rec.ref + '/row', -w, null, w), (await pixels(page, frame(), rec.ref, 1, null, w)), `${rec.ref}: the row's bands as the card's`)
    }
    await page.close()
  }
}, 120_000)

test("a value's colour turned off leaves its band empty and the card in place; Off takes the bands off and rounds the corners", async () => {
  const { page, frame } = await framedBands(['f:claimant', 'f:state', 'f:kind'])
  await frame().evaluate(() => [...document.querySelectorAll<HTMLElement>('.thimble-colour-chip')].find((c) => c.textContent!.includes('agent-08'))!.click())
  await frame().waitForFunction(() => !(window as unknown as { colour: { isOn(v: string): boolean } }).colour.isOn('agent-08'))
  await page.waitForTimeout(300)
  await assertBands(page, frame(), 'forge.db#prs/1', [WHITE, GREEN, TEAL], WHITE)
  await assertBands(page, frame(), 'forge.db#prs/2', [ORANGE, GOLD, BROWN], WHITE)
  const l = await layout(frame(), 'forge.db#prs/1')
  assert.equal(l.opacity, '1', 'Color by only colors: the card is not dimmed')
  assert.notEqual(l.display, 'none', 'nor hidden')
  // Off: no band on any card, every corner the token's, the text where it was
  await frame().click('.thimble-colour-by')
  await frame().click('.thimble-colour-menu [data-by="off"]')
  await frame().waitForFunction(() => !document.querySelector('[data-thimble-edge]'))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  for (const rec of RECS) {
    const off = await layout(frame(), rec.ref)
    assert.deepEqual(off.radius, ['4px', '4px'], `${rec.ref}: the token's corners with Off`)
    assert.equal(off.text, 13, `${rec.ref}: the text 12px of padding and the hairline in, as before`)
    assert.deepEqual(await pixels(page, frame(), rec.ref, 1, null, 4), [WHITE, WHITE, WHITE, WHITE], `${rec.ref}: no band with Off`)
  }
  await page.close()
}, 60_000)

test('in dark, the bands are as in light and their gaps and empty bands the dark paper', async () => {
  const { page, frame } = await framedBands(['f:claimant', 'f:state', 'f:kind'], true)
  await assertBands(page, frame(), 'forge.db#prs/1', [BLUE, GREEN, TEAL], NIGHT)
  await assertBands(page, frame(), 'forge.db#prs/3', [NIGHT, GREEN, NIGHT], NIGHT)
  await assertBands(page, frame(), 'forge.db#prs/2/tile', [ORANGE, GOLD, BROWN], NIGHT)
  await page.close()
}, 60_000)

test("more choices than the card's padding holds: the padding widens with the bands, which stay inside every card and tile", async () => {
  const picks = ['f:claimant', 'f:state', 'f:kind', ...MANY.map((m) => 'f:' + m)]
  const { page, frame } = await framedBands(picks)
  assert.ok(bandsW(picks.length) + 3 > 12, 'more bands than 12px of padding holds')
  for (const rec of RECS) {
    const colours = rec.claimant === 'agent-08' ? [BLUE, GREEN, TEAL] : rec.claimant ? [ORANGE, GOLD, BROWN] : [WHITE, GREEN, WHITE]
    for (const ref of [rec.ref, rec.ref + '/tile']) await assertBands(page, frame(), ref, [...colours, BLUE, BLUE, BLUE, BLUE], WHITE)
  }
  // back to one choice: the one bar, and the text 12px in again
  // as the view checks choose it (thimble.__choices)
  await frame().evaluate(() => {
    type Choice = { control: string; choice: string; go(): void }
    const all = (window as unknown as { thimble: { __choices(): Choice[] } }).thimble.__choices()
    all.find((c) => c.control === 'Color by' && c.choice === 'Claimant')!.go()
  })
  await page.waitForTimeout(400)
  const one = await layout(frame(), 'forge.db#prs/1')
  assert.equal(one.edge, 'in')
  assert.equal(one.text, 13)
  await page.close()
}, 60_000)
