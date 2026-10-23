// What the bridge's paint (backend/app/viewer_bridge.js) costs the browser, in a real one: every attribute it writes on
// an element makes the browser work out that element's style again, and every computed style it reads makes the
// browser work out the page's. So a list that adds rows as it scrolls has only its new rows written and measured, a
// labels message that adds the marks of new rows writes nothing on the rows drawn already, and a message that changes
// nothing writes and reads nothing; so too with the bands of two choices of the kit's Colour by. WebKit checks every
// range of a highlight for each piece of text it draws, so a page with many highlighted texts registers only those near
// the view. What paint draws is tests/public/browser/view-labels.test.ts and view-bands.test.ts.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Frame, Page } from 'playwright'
import { FRONTEND, launch } from './page.ts'

const BRIDGE = readFileSync(path.join(FRONTEND, '..', 'backend', 'app', 'viewer_bridge.js'), 'utf8')
// before the bridge: counts of the data-thimble-* attributes written, per element, and of computed styles read
const COUNT = `(() => {
  const C = (window.__count = { writes: new Map(), styles: 0 })
  const note = (el) => C.writes.set(el, (C.writes.get(el) || 0) + 1)
  const set = Element.prototype.setAttribute, remove = Element.prototype.removeAttribute
  Element.prototype.setAttribute = function (n, v) { if (String(n).startsWith('data-thimble-')) note(this); return set.call(this, n, v) }
  Element.prototype.removeAttribute = function (n) { if (String(n).startsWith('data-thimble-') && this.hasAttribute(n)) note(this); return remove.call(this, n) }
  const gcs = window.getComputedStyle
  window.getComputedStyle = function (...a) { C.styles++; return gcs.apply(this, a) }
})()`
const ROWS = 200
const row = (i: number) => `<div class="row" data-anchor="a.jsonl#L${i + 1}">row ${i + 1} says the deadline moved</div>`
const VIEW = `<!doctype html><html><head><style>#list{height:300px;overflow:auto} .row{padding:2px 2px 2px 10px} .row.sel{box-shadow:0 0 0 1px rgb(0, 0, 255)}</style>
<script>${COUNT}</script><script>${BRIDGE.replace(/<\/script/g, '<\\/script')}</script></head><body>
<div id="list">${Array.from({ length: ROWS }, (_, i) => row(i)).join('')}</div></body></html>`
const mark = (i: number) => ({ bar: i % 2 ? '#025ac3' : '#d0750a', names: ['coord'], values: [{ id: 'k1', label: 'coord', value: i % 2 ? 'yes' : 'no', colour: i % 2 ? '#025ac3' : '#d0750a' }], spans: [{ text: 'deadline', colour: i % 2 ? '#025ac3' : '#d0750a' }] })
const marksUpTo = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`a.jsonl#L${i + 1}`, mark(i)]))

let browser: Browser
let page: Page
beforeAll(async () => {
  browser = await launch()
  page = await browser.newPage()
  await page.setContent('<!doctype html><html><body><iframe id="f" sandbox="allow-scripts" style="border:0;width:600px;height:400px"></iframe></body></html>')
  await page.evaluate((doc) => {
    ;(window as any).__anchors = 0
    addEventListener('message', (e) => {
      if ((e.data || {}).type === 'thimble:anchors') (window as any).__anchors++
    })
    ;(document.getElementById('f') as HTMLIFrameElement).srcdoc = doc
  }, VIEW)
  await page.waitForFunction(() => (window as any).__anchors > 0)
})
afterAll(async () => {
  await browser?.close()
})

const frame = (): Frame => page.frames().find((f) => f !== page.mainFrame())!
const send = (marks: object) => page.evaluate((m) => (document.getElementById('f') as HTMLIFrameElement).contentWindow!.postMessage({ type: 'thimble:labels', marks: m, on: [], filter: null }, '*'), marks)
// the writes and reads since the last call: on the rows drawn before `from`, on the others, and the computed styles read
const counts = (from = 0) =>
  frame().evaluate((from) => {
    const C = (window as any).__count
    const rows = [...document.querySelectorAll('.row')]
    let old = 0
    let added = 0
    rows.forEach((r, i) => {
      if (i < from) old += C.writes.get(r) || 0
      else added += C.writes.get(r) || 0
    })
    const out = { old, added, styles: C.styles, bars: document.querySelectorAll('[data-thimble-label]').length }
    C.writes = new Map()
    C.styles = 0
    return out
  }, from)
// two frames, so a paint the bridge put on the next frame has run
const settle = (fr: Frame = frame()) => fr.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 150)))))

test('rows a list adds as it scrolls are the only ones written and measured; a message that changes nothing writes nothing', async () => {
  await send(marksUpTo(ROWS))
  await frame().waitForFunction((n) => document.querySelectorAll('[data-thimble-label]').length === n, ROWS)
  await settle()
  await counts()

  // the list adds 20 rows at its end, which the page then marks
  await frame().evaluate(({ from, n }) => {
    const list = document.getElementById('list')!
    for (let i = from; i < from + n; i++) list.insertAdjacentHTML('beforeend', `<div class="row" data-anchor="a.jsonl#L${i + 1}">row ${i + 1} says the deadline moved</div>`)
  }, { from: ROWS, n: 20 })
  await settle()
  let c = await counts(ROWS)
  assert.equal(c.old, 0, `the rows drawn before had ${c.old} attributes written when rows were added`)
  assert.ok(c.styles <= 4, `${c.styles} computed styles read when unmarked rows were added`)
  await send(marksUpTo(ROWS + 20))
  await frame().waitForFunction((n) => document.querySelectorAll('[data-thimble-label]').length === n, ROWS + 20)
  await settle()
  c = await counts(ROWS)
  assert.equal(c.old, 0, `the marks of new rows wrote ${c.old} attributes on the rows drawn before`)
  assert.ok(c.added > 0 && c.added <= 20 * 3, `${c.added} attributes written on the 20 new rows`)
  // measuring is per new row, never per row on the page
  assert.ok(c.styles <= 20 * 2 + 10, `${c.styles} computed styles read to mark 20 new rows of ${ROWS + 20}`)

  // the same marks again, as the page sends when only how far thimble has answered changed
  await send(marksUpTo(ROWS + 20))
  await settle()
  c = await counts()
  assert.deepEqual([c.old + c.added, c.styles], [0, 0], 'a labels message that changes nothing wrote or read')
})

test('a row whose class changes is measured again, and keeps its own shadow under the bar; a mark taken away is cleared', async () => {
  const shadow = () => frame().evaluate(() => getComputedStyle(document.querySelector('.row')!).boxShadow)
  assert.doesNotMatch(await shadow(), /rgb\(0, 0, 255\)/)
  await frame().evaluate(() => document.querySelector('.row')!.classList.add('sel'))
  await settle()
  const s = await shadow()
  assert.match(s, /rgb\(208, 117, 10\) 3px 0px 0px 0px inset/, `the bar stays: ${s}`)
  assert.match(s, /rgb\(0, 0, 255\) 0px 0px 0px 1px/, `the view's own ring is drawn with it: ${s}`)
  const c = await counts(1)
  assert.equal(c.old > 0 && c.added === 0, true, `only the row whose class changed is written: ${JSON.stringify(c)}`)

  const marks = marksUpTo(ROWS + 20)
  delete (marks as Record<string, unknown>)['a.jsonl#L2']
  await send(marks)
  await settle()
  assert.equal(await frame().evaluate(() => [...document.querySelectorAll('.row')][1].hasAttribute('data-thimble-label')), false, 'the row whose mark went keeps its bar')
  assert.equal(await frame().evaluate(() => document.querySelectorAll('[data-thimble-label]').length), ROWS + 19)
})

test('with many highlighted texts only those near the view are registered, and a scroll brings in the others', async () => {
  const many = await browser.newPage()
  const n = 1000
  const doc = VIEW.replace(/<div id="list">[\s\S]*<\/div><\/body>/, `<div id="list">${Array.from({ length: n }, (_, i) => row(i)).join('')}</div></body>`)
  await many.setContent('<!doctype html><html><body><iframe id="f" sandbox="allow-scripts" style="border:0;width:600px;height:400px"></iframe></body></html>')
  await many.evaluate((d) => ((document.getElementById('f') as HTMLIFrameElement).srcdoc = d), doc)
  const f = () => many.frames().find((x) => x !== many.mainFrame())!
  await f().waitForFunction((n) => document.querySelectorAll('.row').length === n, n)
  await many.evaluate((m) => (document.getElementById('f') as HTMLIFrameElement).contentWindow!.postMessage({ type: 'thimble:labels', marks: m, on: [], filter: null }, '*'), marksUpTo(n))
  // the rows in view, and how many ranges are registered
  const lit = () =>
    f().evaluate(() => {
      const ranges = [...CSS.highlights.keys()].filter((k) => k.startsWith('thimble-label-')).flatMap((k) => [...CSS.highlights.get(k)!])
      const box = document.getElementById('list')!.getBoundingClientRect()
      const shown = [...document.querySelectorAll('.row')].filter((r) => {
        const b = r.getBoundingClientRect()
        return b.bottom > box.top && b.top < box.bottom
      })
      const held = (r: Element) => ranges.some((x) => r.contains(x.startContainer))
      return { ranges: ranges.length, shown: shown.length, all: shown.every(held) }
    })
  await f().waitForFunction(() => [...CSS.highlights.keys()].some((k) => k.startsWith('thimble-label-')))
  await settle(f())
  let s = await lit()
  assert.ok(s.all && s.shown > 5, `every row in view has its text highlighted: ${JSON.stringify(s)}`)
  assert.ok(s.ranges < n / 4, `${s.ranges} of ${n} ranges registered`)
  await f().evaluate(() => (document.getElementById('list')!.scrollTop = 12000))
  await settle(f())
  s = await lit()
  assert.ok(s.all && s.shown > 5, `after a scroll, every row in view has its text highlighted: ${JSON.stringify(s)}`)
  await many.close()
})

test("with two choices of the kit's Colour by, the rows a list adds are the only ones given bands and measured; a message that changes nothing writes nothing", async () => {
  const two = await browser.newPage()
  await two.setContent('<!doctype html><html><body><iframe id="f" sandbox="allow-scripts" style="border:0;width:600px;height:400px"></iframe></body></html>')
  await two.evaluate((d) => ((document.getElementById('f') as HTMLIFrameElement).srcdoc = d), VIEW)
  const f = () => two.frames().find((x) => x !== two.mainFrame())!
  await f().waitForFunction((n) => document.querySelectorAll('.row').length === n, ROWS)
  // the labels "coord" (the colour) and "lang" (a track, on every other row), as viewer_colour.js hands them over
  await f().evaluate(() => (window as any).__thimbleKit.colour({ mode: 'label', label: 'k1', name: 'coord', off: () => null, colourOf: () => null, tracks: [{ label: 'k2', name: 'lang' }] }))
  const marked = (n: number) =>
    Object.fromEntries(
      Array.from({ length: n }, (_, i) => [
        `a.jsonl#L${i + 1}`,
        { ...mark(i), names: ['coord', 'lang'], values: [...mark(i).values, ...(i % 2 ? [{ id: 'k2', label: 'lang', value: 'yes', colour: '#08632f' }] : [])] },
      ]),
    )
  const tell = (m: object) => two.evaluate((m) => (document.getElementById('f') as HTMLIFrameElement).contentWindow!.postMessage({ type: 'thimble:labels', marks: m, on: [], filter: null }, '*'), m)
  const tally = (from = 0) =>
    f().evaluate((from) => {
      const C = (window as any).__count
      let old = 0
      let added = 0
      ;[...document.querySelectorAll('.row')].forEach((r, i) => (i < from ? (old += C.writes.get(r) || 0) : (added += C.writes.get(r) || 0)))
      const out = { old, added, styles: C.styles }
      C.writes = new Map()
      C.styles = 0
      return out
    }, from)
  await tell(marked(ROWS))
  await f().waitForFunction((n) => document.querySelectorAll('[data-thimble-bands]').length === n, ROWS)
  await settle(f())
  assert.equal(await f().evaluate(() => document.querySelector('.row')!.getAttribute('data-thimble-edge')), 'bands')
  await tally()

  await f().evaluate(({ from, n }) => {
    const list = document.getElementById('list')!
    for (let i = from; i < from + n; i++) list.insertAdjacentHTML('beforeend', `<div class="row" data-anchor="a.jsonl#L${i + 1}">row ${i + 1} says the deadline moved</div>`)
  }, { from: ROWS, n: 20 })
  await settle(f())
  let c = await tally(ROWS)
  assert.equal(c.old, 0, `the rows drawn before had ${c.old} attributes written when rows were added`)
  await tell(marked(ROWS + 20))
  await f().waitForFunction((n) => document.querySelectorAll('[data-thimble-bands]').length === n, ROWS + 20)
  await settle(f())
  c = await tally(ROWS)
  assert.equal(c.old, 0, `the marks of new rows wrote ${c.old} attributes on the rows drawn before`)
  assert.ok(c.added > 0 && c.added <= 20 * 3, `${c.added} attributes written on the 20 new rows`)
  assert.ok(c.styles <= 20 * 2 + 10, `${c.styles} computed styles read to give 20 new rows of ${ROWS + 20} their bands`)
  await tell(marked(ROWS + 20))
  await settle(f())
  c = await tally()
  assert.deepEqual([c.old + c.added, c.styles], [0, 0], 'a labels message that changes nothing wrote or read')
  await two.close()
})
