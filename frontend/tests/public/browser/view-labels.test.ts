// The frame half of a view's bridge (backend/app/viewer_bridge.js) drawing the labels that are on, in a real browser: a
// page holds a view in a sandboxed frame as ViewerFrame does, and a `labels` message draws its marks, a bar in the
// label's colour and the marked text highlighted through the CSS Custom Highlight API, which leaves the view's DOM as
// it wrote it. What the bridge reports and posts is tests/public/bridge.test.ts, under jsdom, which has no layout and
// no highlights.
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
