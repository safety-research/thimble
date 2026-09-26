// The frame half of a view's bridge (backend/app/viewer_bridge.js) drawing the labels that are on, in a real browser:
// a page holds a view in a sandboxed frame as ViewerFrame does. A `labels` message draws its marks (a bar in the
// label's colour, and the marked text highlighted through the CSS Custom Highlight API, which leaves the view's DOM as
// it wrote it), marks again an element the view replaces, keeps the view's own box-shadow, and an empty `labels`
// removes them all; while the pointer key is held (`cmd`) the frame's cursor is the page's pointer arrow. What the
// bridge reports and posts is tests/public/bridge.test.ts, under jsdom, which has no layout and no highlights.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { FRONTEND, launch } from './page.ts'

const BRIDGE = readFileSync(path.join(FRONTEND, '..', 'backend', 'app', 'viewer_bridge.js'), 'utf8')
let browser: Browser
let page: Page

// a view as a dev agent writes one: a unit with a key of its own, records inside it anchored by file ref, one of them a
// table row whose text starts at its edge, a marked word split over two elements, and a canvas whose data-anchor is
// the drawn mark under the pointer
const VIEW = `<!doctype html><html><head>
<style>:root{--label-2:#e69f00;--label-6:#56b4e9} article{padding-left:12px} td{padding:2px 8px 2px 0}</style>
<script>${BRIDGE.replace(/<\/script/g, '<\\/script')}</script></head><body>
<section data-anchor="view:board/p1">
  <article id="one" data-anchor="a.jsonl#L1">the <b>dead</b>line passed; the deadline moved</article>
  <table><tr id="two" data-anchor="a.jsonl#L2"><td>row two</td></tr></table>
  <article id="five" data-anchor="a.jsonl#L5">nothing marks this</article>
  <canvas width="40" height="10" data-anchor="a.jsonl#L2"></canvas>
</section>
</body></html>`

const MARKS = {
  'a.jsonl#L1': { bar: 'var(--label-2)', names: ['coord'], spans: [{ text: 'deadline', colour: 'var(--label-2)' }] },
  'a.jsonl#L2': { bar: 'var(--label-6)', names: ['lang', 'coord'], spans: [] },
  'a.jsonl#L3': { bar: 'var(--label-6)', names: ['lang'], spans: [] },
}

beforeAll(async () => {
  browser = await launch()
  page = await browser.newPage()
  await page.setContent('<!doctype html><html><body><iframe id="f" sandbox="allow-scripts" style="border:0;width:600px;height:400px"></iframe></body></html>')
  await page.evaluate((doc) => {
    (window as any).__anchors = []
    addEventListener('message', (e) => {
      const d = (e.data || {}) as { type?: string; refs?: string[] }
      if (d.type === 'thimble:anchors') (window as any).__anchors.push(d.refs)
    })
    const f = document.getElementById('f') as HTMLIFrameElement
    f.srcdoc = doc
  }, VIEW)
  await page.waitForFunction(() => (window as any).__anchors.length > 0)
})
afterAll(async () => {
  await browser?.close()
})

const frame = () => page.frames().find((f) => f !== page.mainFrame())!
const send = (marks: object) => page.evaluate((m) => (document.getElementById('f') as HTMLIFrameElement).contentWindow!.postMessage({ type: 'thimble:labels', marks: m }, '*'), marks)
const state = () =>
  frame().evaluate(() => {
    const el = (id: string) => document.getElementById(id)!
    const hl = [...CSS.highlights.keys()].filter((k) => k.startsWith('thimble-label-'))
    return {
      labels: [...document.querySelectorAll('[data-thimble-label]')].map((e) => [e.getAttribute('data-anchor'), e.getAttribute('data-thimble-label')]),
      shadow: { one: getComputedStyle(el('one')).boxShadow, two: getComputedStyle(el('two')).boxShadow, five: getComputedStyle(el('five')).boxShadow },
      ranges: hl.flatMap((k) => [...CSS.highlights.get(k)!].map((r) => [k, r.toString()])),
      html: el('one').innerHTML,
    }
  })

test('labels draws a bar in the label colour and highlights the marked text without touching the view', async () => {
  const before = (await state()).html
  await send(MARKS)
  await frame().waitForFunction(() => document.querySelectorAll('[data-thimble-label]').length === 2)
  const s = await state()
  assert.deepEqual(s.labels, [['a.jsonl#L1', 'coord'], ['a.jsonl#L2', 'lang, coord']], 'no bar across a whole canvas')
  assert.match(s.shadow.one, /rgb\(230, 159, 0\) 3px 0px 0px 0px inset/, 'the bar of --label-2 inside the left edge, in the padding')
  assert.match(s.shadow.two, /rgb\(86, 180, 233\) -6px 0px 0px -3px/, 'a table row whose text starts at its edge: the bar just outside it')
  assert.equal(s.shadow.five, 'none', 'a record no label marks')
  assert.deepEqual(s.ranges, [['thimble-label-0', 'deadline'], ['thimble-label-0', 'deadline']], 'both occurrences, one across two elements')
  assert.equal(s.html, before, "the view's own DOM is as it wrote it")
})

test('an element the view replaces takes its mark again, and a new anchor is reported alone', async () => {
  const seen = (await page.evaluate(() => (window as any).__anchors)).length
  await frame().evaluate(() => {
    const old = document.getElementById('one')!
    const fresh = document.createElement('article')
    fresh.id = 'one'
    fresh.dataset.anchor = 'a.jsonl#L1'
    fresh.textContent = 'redrawn: the deadline'
    old.replaceWith(fresh)
    const three = document.createElement('article')
    three.id = 'three'
    three.dataset.anchor = 'a.jsonl#L3'
    three.textContent = 'a third record'
    document.querySelector('section')!.append(three)
  })
  await page.waitForFunction((n: number) => (window as any).__anchors.length > n, seen)
  assert.deepEqual((await page.evaluate(() => (window as any).__anchors)).slice(seen).flat(), ['a.jsonl#L3'])
  await frame().waitForFunction(() => document.getElementById('three')!.hasAttribute('data-thimble-label'))
  const s = await state()
  assert.deepEqual(s.labels.map(([ref]: any) => ref), ['a.jsonl#L1', 'a.jsonl#L2', 'a.jsonl#L3'])
  assert.deepEqual(s.ranges, [['thimble-label-0', 'deadline']], 'the replaced text is highlighted anew')
  await frame().evaluate(() => {
    document.getElementById('one')!.textContent = 'deadline, then the deadline again'
  })
  await frame().waitForFunction(() => [...(CSS.highlights.get('thimble-label-0') ?? [])].length === 2)
  assert.deepEqual((await state()).ranges.map(([, t]: any) => t), ['deadline', 'deadline'], 'text replaced inside a marked element')
})

test('an empty labels removes every mark, as when the labels are turned off', async () => {
  await send({})
  await frame().waitForFunction(() => !document.querySelector('[data-thimble-label]'))
  const s = await state()
  assert.deepEqual(s.labels, [])
  assert.equal(s.shadow.one, 'none')
  assert.equal(s.shadow.two, 'none')
  assert.deepEqual(s.ranges, [])
})

test("a marked element keeps the view's own box-shadow, and only the outermost element of a record takes the bar", async () => {
  await frame().evaluate(() => {
    const css = document.createElement('style')
    css.textContent = '.ring{box-shadow:inset 0 0 0 1px rgb(1, 2, 3)} #six,#seven{padding-left:12px}'
    document.head.append(css)
    const six = document.createElement('article')
    six.id = 'six'
    six.className = 'ring'
    six.dataset.anchor = 'a.jsonl#L6'
    six.textContent = 'the cited record, ringed by the view'
    // a view may repeat a record's ref on the parts inside its element, so a ⌘-click on a part asks about the record
    const seven = document.createElement('article')
    seven.id = 'seven'
    seven.dataset.anchor = 'a.jsonl#L7'
    seven.innerHTML = '<span id="who" data-anchor="a.jsonl#L7">bob</span> <span id="when" data-anchor="a.jsonl#L7">09:12</span> signed the deadline'
    document.querySelector('section')!.append(six, seven)
  })
  await send({
    'a.jsonl#L6': { bar: 'var(--label-2)', names: ['coord'], spans: [] },
    'a.jsonl#L7': { bar: 'var(--label-6)', names: ['lang'], spans: [{ text: 'deadline', colour: 'var(--label-6)' }] },
  })
  await frame().waitForFunction(() => document.getElementById('seven')!.hasAttribute('data-thimble-label'))
  const s = await frame().evaluate(() => {
    const sh = (id: string) => getComputedStyle(document.getElementById(id)!).boxShadow
    return {
      six: sh('six'),
      seven: sh('seven'),
      who: sh('who'),
      when: sh('when'),
      marked: [...document.querySelectorAll('[data-thimble-label]')].map((e) => e.id),
      ranges: [...CSS.highlights.keys()].flatMap((k) => [...CSS.highlights.get(k)!].map((r) => r.toString())),
    }
  })
  assert.match(s.six, /rgb\(230, 159, 0\) 3px 0px 0px 0px inset/, 'the label bar')
  assert.match(s.six, /rgb\(1, 2, 3\) 0px 0px 0px 1px inset/, "the view's own ring is still drawn")
  assert.deepEqual(s.marked, ['six', 'seven'], 'one bar per record: the parts inside its element take none')
  assert.equal(s.who, 'none')
  assert.equal(s.when, 'none')
  assert.deepEqual(s.ranges, ['deadline'], 'the text inside the outermost element is still highlighted')
  // the view rings the record after the marks were drawn (it opened a citation there): the ring shows with the bar
  await frame().evaluate(() => document.getElementById('seven')!.classList.add('ring'))
  await frame().waitForFunction(() => /rgb\(1, 2, 3\)/.test(getComputedStyle(document.getElementById('seven')!).boxShadow))
  const seven = await frame().evaluate(() => getComputedStyle(document.getElementById('seven')!).boxShadow)
  assert.match(seven, /rgb\(86, 180, 233\) 3px 0px 0px 0px inset/)
  await send({})
  await frame().waitForFunction(() => !document.querySelector('[data-thimble-label]'))
  const off = await frame().evaluate(() => [getComputedStyle(document.getElementById('six')!).boxShadow, getComputedStyle(document.getElementById('seven')!).boxShadow])
  assert.deepEqual(off, ['rgb(1, 2, 3) 0px 0px 0px 1px inset', 'rgb(1, 2, 3) 0px 0px 0px 1px inset'], 'turned off, the view looks as it did')
})

test('a marked row whose cells paint a background, such as a sheet with a pinned row number, shows its bar on its first cell', async () => {
  await frame().evaluate(() => {
    const css = document.createElement('style')
    css.textContent = '.grid th{position:sticky;left:0;padding:2px 8px;background:rgb(240, 240, 240)} .grid td{background:rgb(255, 255, 255)}'
    document.head.append(css)
    const table = document.createElement('table')
    table.className = 'grid'
    table.innerHTML = '<tr id="eight" data-anchor="a.jsonl#L8"><th id="eight-n">8</th><td>a cell</td></tr>'
    document.querySelector('section')!.append(table)
  })
  await send({ 'a.jsonl#L8': { bar: 'var(--label-2)', names: ['coord'], spans: [] } })
  await frame().waitForFunction(() => document.getElementById('eight')!.hasAttribute('data-thimble-label'))
  const first = await frame().evaluate(() => getComputedStyle(document.getElementById('eight-n')!).boxShadow)
  assert.match(first, /rgb\(230, 159, 0\) 3px 0px 0px 0px inset/, 'drawn over the cell\'s own background')
  await send({})
  await frame().waitForFunction(() => !document.querySelector('[data-thimble-label]'))
  assert.equal(await frame().evaluate(() => getComputedStyle(document.getElementById('eight-n')!).boxShadow), 'none')
})

test('cmd: while ⌘ is held the frame shows the page\'s ⌘ arrow as its cursor, and its own events keep it right', async () => {
  const CURSOR = 'url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2228%22%20height%3D%2228%22%2F%3E") 3 2, default'
  const post = (msg: object) => page.evaluate((m) => (document.getElementById('f') as HTMLIFrameElement).contentWindow!.postMessage(m, '*'), msg)
  const cursorOf = () => frame().evaluate(() => ({ on: document.documentElement.hasAttribute('data-thimble-cmd'), cursor: getComputedStyle(document.getElementById('five')!).cursor }))
  assert.deepEqual(await cursorOf(), { on: false, cursor: 'auto' })
  await post({ type: 'thimble:cmd', on: false, cursor: CURSOR })
  await post({ type: 'thimble:cmd', on: true, cursor: '' })
  await frame().waitForFunction(() => document.documentElement.hasAttribute('data-thimble-cmd'))
  const held = await cursorOf()
  assert.match(held.cursor, /^url\("data:image\/svg\+xml,.*"\) 3 2, default$/, 'the cursor the page sent before, kept when a message carries none')
  await post({ type: 'thimble:cmd', on: false, cursor: '' })
  await frame().waitForFunction(() => !document.documentElement.hasAttribute('data-thimble-cmd'))
  assert.equal((await cursorOf()).cursor, 'auto', 'released, the view\'s own cursor')
  // ⌘ pressed while the frame has the focus: the frame's own move with ⌘ shows the arrow, one without ⌘ takes it away
  const move = (meta: boolean) => frame().evaluate((m) => document.getElementById('five')!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, metaKey: m })), meta)
  await move(true)
  assert.equal((await cursorOf()).on, true)
  await move(false)
  assert.equal((await cursorOf()).on, false)
})

test('with a label filter on, what the filter drops leaves the page and what holds a kept record stays', async () => {
  const filtered = (marks: object, filter: object | null) =>
    page.evaluate(([m, f]) => (document.getElementById('f') as HTMLIFrameElement).contentWindow!.postMessage({ type: 'thimble:labels', marks: m, on: [], filter: f }, '*'), [marks, filter] as const)
  await filtered({ 'a.jsonl#L2': { bar: 'var(--label-6)', names: ['lang'], spans: [], keep: true } }, { label: 'lang', value: 'yes', colour: '#56b4e9' })
  await frame().waitForFunction(() => getComputedStyle(document.getElementById('five')!).display === 'none')
  const shown = await frame().evaluate(() => ['one', 'two', 'five'].map((id) => getComputedStyle(document.getElementById(id)!).display))
  assert.deepEqual(shown, ['none', 'table-row', 'none'], 'the kept row stays, the others leave the layout')
  assert.notEqual(await frame().evaluate(() => getComputedStyle(document.querySelector('section')!).display), 'none', 'the unit holding it stays')
  await filtered({}, null)
  await frame().waitForFunction(() => !document.querySelector('[data-thimble-drop]'))
})
