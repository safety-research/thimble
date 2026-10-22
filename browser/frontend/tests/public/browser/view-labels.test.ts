// The frame half of a view's bridge (backend/app/viewer_bridge.js) drawing the labels that are on, in a real browser: a
// page holds a view in a sandboxed frame as ViewerFrame does, and a `labels` message draws its marks, a bar in the
// label's colour and the marked text highlighted through the CSS Custom Highlight API, which leaves the view's DOM as
// it wrote it; thimble.markOf hands the page those colours resolved, so a canvas can draw them. What the bridge reports
// and posts is tests/public/bridge.test.ts, under jsdom, which has no layout and no highlights.
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
// table row whose text starts at its edge, a marked word split over two elements, a canvas whose data-anchor is the
// drawn mark under the pointer, and a lane of another unit that draws its labels' colours itself
const VIEW = `<!doctype html><html><head>
<style>:root{--label-2:#e69f00;--label-6:#56b4e9} article{padding-left:12px} td{padding:2px 8px 2px 0}</style>
<script>${BRIDGE.replace(/<\/script/g, '<\\/script')}</script></head><body>
<section data-anchor="view:board/p1">
  <article id="one" data-anchor="a.jsonl#L1">the <b>dead</b>line passed; the deadline moved</article>
  <table><tr id="two" data-anchor="a.jsonl#L2"><td>row two</td></tr></table>
  <article id="five" data-anchor="a.jsonl#L5">nothing marks this</article>
  <canvas width="40" height="10" data-anchor="a.jsonl#L2"></canvas>
</section>
<div id="lane" data-anchor="view:board/p2" data-anchor-unmarked style="padding-left:12px">lane</div>
</body></html>`

const MARKS = {
  'a.jsonl#L1': { bar: 'var(--label-2)', names: ['coord'], spans: [{ text: 'deadline', colour: 'var(--label-2)' }] },
  'a.jsonl#L2': { bar: 'var(--label-6)', names: ['lang', 'coord'], spans: [] },
  'a.jsonl#L3': { bar: 'var(--label-6)', names: ['lang'], spans: [] },
  'view:board/p2': { bar: 'var(--label-6)', names: ['lang'], spans: [] },
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
      shadow: { one: getComputedStyle(el('one')).boxShadow, two: getComputedStyle(el('two')).boxShadow, five: getComputedStyle(el('five')).boxShadow, lane: getComputedStyle(el('lane')).boxShadow },
      ranges: hl.flatMap((k) => [...CSS.highlights.get(k)!].map((r) => [k, r.toString()])),
      html: el('one').innerHTML,
    }
  })

test('labels draws a bar in the label colour and highlights the marked text without touching the view', async () => {
  const before = (await state()).html
  await send(MARKS)
  await frame().waitForFunction(() => document.querySelectorAll('[data-thimble-label]').length === 2)
  const s = await state()
  assert.deepEqual(s.labels, [['a.jsonl#L1', 'coord'], ['a.jsonl#L2', 'lang, coord']], 'no bar across a whole canvas, and no mark on a lane that draws its own')
  assert.match(s.shadow.one, /rgb\(230, 159, 0\) 3px 0px 0px 0px inset/, 'the bar of --label-2 inside the left edge, in the padding')
  assert.match(s.shadow.two, /rgb\(86, 180, 233\) -6px 0px 0px -3px/, 'a table row whose text starts at its edge: the bar just outside it')
  assert.equal(s.shadow.five, 'none', 'a record no label marks')
  assert.equal(s.shadow.lane, 'none', 'an element marked data-anchor-unmarked')
  assert.deepEqual(s.ranges, [['thimble-label-0', 'deadline'], ['thimble-label-0', 'deadline']], 'both occurrences, one across two elements')
  assert.equal(s.html, before, "the view's own DOM is as it wrote it")
})

test('the anchors report names the records in view, and a scroll names those it brings into view', async () => {
  const tall = await browser.newPage()
  const rows = Array.from({ length: 200 }, (_, i) => `<div style="height:40px" data-anchor="b.jsonl#L${i + 1}">record ${i + 1}</div>`).join('')
  const doc = `<!doctype html><html><head><script>${BRIDGE.replace(/<\/script/g, '<\\/script')}</script></head><body style="margin:0">${rows}</body></html>`
  await tall.setContent('<!doctype html><html><body><iframe id="f" sandbox="allow-scripts" style="border:0;width:600px;height:400px"></iframe></body></html>')
  await tall.evaluate((d) => {
    const got: { type: string; refs: string[]; seen?: string[] }[] = ((window as any).__got = [])
    addEventListener('message', (e) => {
      const m = (e.data || {}) as { type?: string; refs?: string[]; seen?: string[] }
      if (m.type === 'thimble:anchors' || m.type === 'thimble:seen') got.push(m as (typeof got)[number])
    })
    ;(document.getElementById('f') as HTMLIFrameElement).srcdoc = d
  }, doc)
  await tall.waitForFunction(() => (window as any).__got.length > 0)
  const first = await tall.evaluate(() => (window as any).__got[0])
  assert.equal(first.refs.length, 200, 'every anchored record is reported')
  assert.deepEqual(first.seen, Array.from({ length: 10 }, (_, i) => `b.jsonl#L${i + 1}`), 'the ten in the 400 px frame are in view')
  const inner = tall.frames().find((f) => f !== tall.mainFrame())!
  await inner.evaluate(() => window.scrollTo(0, 4000))
  await tall.waitForFunction(() => (window as any).__got.some((m: { type: string }) => m.type === 'thimble:seen'))
  const seen = await tall.evaluate(() => (window as any).__got.find((m: { type: string }) => m.type === 'thimble:seen').refs)
  assert.deepEqual(seen, Array.from({ length: 10 }, (_, i) => `b.jsonl#L${i + 101}`), 'the records the scroll brought into view, once')
  await tall.close()
})

test("thimble.markOf gives the page each label's colour as one a canvas can draw", async () => {
  await send({ 'a.jsonl#L1': { bar: 'var(--label-2)', names: ['coord'], values: [{ id: 'k2', label: 'coord', value: 'yes', colour: 'var(--label-2)' }], spans: [{ text: 'deadline', colour: 'var(--label-2)' }] } })
  await frame().waitForFunction(() => (window as any).thimble.markOf('a.jsonl#L1')?.bar === 'rgb(230, 159, 0)')
  const got = await frame().evaluate(() => {
    const m = (window as any).thimble.markOf('a.jsonl#L1')
    const cv = document.createElement('canvas')
    const ctx = cv.getContext('2d')!
    ctx.fillStyle = m.bar
    ctx.fillRect(0, 0, 1, 1)
    return { value: m.values[0].colour, span: m.spans[0].colour, px: [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3) }
  })
  assert.deepEqual(got, { value: 'rgb(230, 159, 0)', span: 'rgb(230, 159, 0)', px: [230, 159, 0] }, 'var(--label-2) of the frame, drawn on a canvas')
})
