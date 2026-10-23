// The strip the view kit draws beside a list (backend/app/viewer_colour.js: Color by's strip and its loupe) stands fixed
// in the frame's viewport, so it follows its list when the page the list stands in scrolls, as a gallery or a long view
// does: the strip and an open loupe go with the list. In a view whose page never scrolls the list's own scroll is
// tests/public/browser/view-colour.test.ts.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, test } from 'vitest'
import type { Browser, Frame, Page } from 'playwright'
import { cleanup, FRONTEND, launch } from './page.ts'

const APP = path.join(FRONTEND, '..', 'backend', 'app')
const read = (name: string) => readFileSync(path.join(APP, name), 'utf8')
const inline = (js: string) => js.replace(/<\/script/g, '<\\/script')
// the kit as views.frame_document loads it
const KIT =
  `<script>${inline(read('viewer_bridge.js'))}</script><script>window.__thimbleLabelOrder = ${read('label_order.json')}</script>` +
  ['viewer_colour.js', 'viewer_controls.js', 'viewer_side.js', 'viewer_transcript.js', 'viewer_messages.js', 'viewer_search.js', 'viewer_table.js', 'viewer_tree.js', 'viewer_range.js']
    .map((n) => `<script>${inline(read(n))}</script>`)
    .join('') +
  `<style>${read('viewer_kit.css')}</style><style>${read('viewer_parts.css')}</style>`
const TOKENS = readFileSync(path.join(FRONTEND, 'src', 'styles', 'tokens.css'), 'utf8') + ':root{--font-body:sans-serif;--font-mono:monospace}'
// a gallery's page: sections one under another, the page scrolling; a tree of 300 files in a card 240 px tall, a list
// of 200 records Color by gives its strip in another card, a pane that scrolls in the page holding a third list, and
// far below them a table of 200 pull requests with no Color by and a side panel, in the right half of its card
const FILES = Array.from({ length: 300 }, (_, i) => ({ key: `run-${Math.floor(i / 30)}/agent-${i % 30}.jsonl`, n: i + 1 }))
const PULLS = Array.from({ length: 200 }, (_, i) => ({ ref: `forge.db#prs/${i + 1}`, title: `PR ${i + 1}`, author: `author-${i % 7}`, state: i % 4 ? 'open' : 'merged' }))
const RECORDS = Array.from({ length: 200 }, (_, i) => `<div class="rec" data-anchor="r.jsonl#L${i + 1}" data-colour="${i % 3 ? 'ok' : 'failed'}">record ${i + 1}</div>`).join('')
const PAGE = `<!doctype html><html><head><style>${TOKENS} body{margin:0;background:var(--surface-card);font:12px sans-serif}
.sec{margin:40px 16px;border:1px solid var(--border-subtle);border-radius:var(--radius-card);overflow:hidden}
#grow{height:0} #tree{height:240px} #list{height:200px;overflow:auto} .rec{box-sizing:border-box;height:24px;padding:4px 8px}
#pane{height:260px;overflow:auto;border:1px solid var(--border-subtle)} #inner{height:150px;overflow:auto} .tall{height:900px}
#tb-body{height:220px;margin-left:420px} #tb{height:100%}</style>${KIT}</head><body>
<div class="top" style="padding:8px"><span id="colour"></span></div>
<div class="sec" style="height:120px">above</div>
<div class="sec" id="s-tree"><div id="grow"></div><div id="tree"></div></div>
<div class="sec">a section under the tree<div style="height:300px"></div></div>
<div class="sec"><div id="list">${RECORDS}</div></div>
<div class="sec"><div id="pane"><div style="height:120px">above the inner list</div><div id="inner">${RECORDS.replace(/r\.jsonl/g, 'i.jsonl')}</div><div class="tall"></div></div></div>
<div class="tall"></div>
<div class="sec"><div id="tb-body"><div id="tb"></div></div></div>
<div class="tall"></div>
<script>
// each strip named by its list as it is made, the newest strip in the page
const named = (sel) => [...document.querySelectorAll('.thimble-colour-strip')].pop().setAttribute('data-test-list', sel)
window.colour = thimble.colorBy({ mount: '#colour', fields: [{ name: 'kind', title: 'Kind', values: ['ok', 'failed'] }], strip: '#list' })
named('#list')
window.tree = thimble.tree({ mount: '#tree', split: '/', items: ${JSON.stringify(FILES)} })
named('#tree')
tree.fold('run-0', false)
colour.strip('#inner')
named('#inner')
window.table = thimble.table({ mount: '#tb', rows: ${JSON.stringify(PULLS)}, color: false, side: thimble.side({ mount: '#tb-body', width: 0.45, min: 150 }),
  columns: [{ name: 'title', title: 'Pull request', sub: (p) => p.author }, { name: 'state', title: 'State', width: 80 }] })
named('#tb')
</script></body></html>`

type Box = { left: number; top: number; right: number; bottom: number; height: number; shown: boolean }
/** A strip: its box, the part of it that shows (where a pointer finds it, as it is cut), and its thumb's box. */
type StripBox = Box & { seen: { top: number; bottom: number } | null; thumb: { top: number; bottom: number } }

let browser: Browser
beforeAll(async () => {
  browser = await launch()
})
afterAll(async () => {
  await browser?.close()
  cleanup()
})

/** The page in a sandboxed frame as ViewerFrame holds a view, 800 x 600; the frame's errors in `errors`. */
async function framed(): Promise<{ page: Page; frame: () => Frame; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width: 840, height: 640 } })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await page.setContent(`<!doctype html><html><body style="margin:0"><iframe id="f" sandbox="allow-scripts" style="border:0;width:800px;height:600px"></iframe></body></html>`)
  await page.evaluate((d) => ((document.getElementById('f') as HTMLIFrameElement).srcdoc = d), PAGE)
  const frame = () => page.frames().find((f) => f !== page.mainFrame())!
  await page.waitForTimeout(300)
  await frame().waitForSelector('.thimble-tree-row', { state: 'attached' })
  await settle(frame())
  return { page, frame, errors }
}
/** Two animation frames and a little more, so a strip placed in the next frame stands where it goes. */
const settle = (f: Frame) => f.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 30)))))
/** Where an element stands in the frame, and whether it shows. */
const box = (f: Frame, sel: string) =>
  f.evaluate((s) => {
    const e = document.querySelector(s) as HTMLElement
    const r = e.getBoundingClientRect()
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, height: r.height, shown: getComputedStyle(e).display !== 'none' && r.height > 0 }
  }, sel)
/** The strip of the list `sel`, named as the page made it: its box, the part of it a pointer finds down its middle,
 * and its thumb. */
const stripOf = (f: Frame, sel: string): Promise<StripBox> =>
  f.evaluate((s) => {
    const e = document.querySelector(`.thimble-colour-strip[data-test-list="${s}"]`) as HTMLElement
    const r = e.getBoundingClientRect()
    const t = (e.querySelector('.thimble-colour-thumb') as HTMLElement).getBoundingClientRect()
    let seen: { top: number; bottom: number } | null = null
    const x = r.left + r.width / 2
    for (let y = Math.max(0, Math.floor(r.top)); y < Math.min(innerHeight, r.bottom); y++) {
      const hit = document.elementFromPoint(x, y + 0.5)
      if (!hit || !e.contains(hit)) continue
      if (!seen) seen = { top: y, bottom: y + 1 }
      else seen.bottom = y + 1
    }
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, height: r.height, shown: getComputedStyle(e).display !== 'none' && r.height > 0, seen, thumb: { top: t.top, bottom: t.bottom } }
  }, sel)
/** Whether the strip stands beside its list as its own scrollbar would: its box the list's 2 px in, its right edge 2 px
 * in from the list's, and the part of it that shows the part of that box `cut` leaves (the viewport by default). */
function beside(s: StripBox, list: Box, cut = { top: 0, bottom: 600 }, what = '') {
  assert.ok(s.shown && s.seen, `${what}: the strip shows`)
  assert.ok(Math.abs(s.right - (list.right - 2)) < 1, `${what}: the strip's right edge stands 2 px in from the list's: ${JSON.stringify([s, list])}`)
  assert.ok(Math.abs(s.top - (list.top + 2)) < 1 && Math.abs(s.bottom - (list.bottom - 2)) < 1, `${what}: the strip is the list's height, 2 px in: ${JSON.stringify([s, list])}`)
  const want = { top: Math.max(list.top + 2, cut.top), bottom: Math.min(list.bottom - 2, cut.bottom) }
  assert.ok(Math.abs(s.seen!.top - want.top) <= 1 && Math.abs(s.seen!.bottom - want.bottom) <= 1, `${what}: the strip shows only where the list shows: ${JSON.stringify([s, list, cut])}`)
}

describe('the strip on a page that scrolls', () => {

  test("Color by's strip and its open loupe go with their list as the page scrolls", async () => {
    const { page, frame, errors } = await framed()
    const f = frame()
    await f.evaluate(() => (document.getElementById('list') as HTMLElement).scrollIntoView({ block: 'center' }))
    await settle(f)
    const s0 = await stripOf(f, '#list')
    beside(s0, await box(f, '#list'), undefined, 'the list in view')
    // rest on the strip: the loupe opens beside it
    const p = await page.evaluate(() => (document.getElementById('f') as HTMLElement).getBoundingClientRect().top)
    await page.mouse.move(s0.left + 5, p + s0.top + s0.height / 2)
    await page.waitForTimeout(450)
    await f.waitForSelector('.thimble-colour-loupe[data-open]', { state: 'visible' })
    const l0 = await box(f, '.thimble-colour-loupe')
    // the page scrolls 60 px under the pointer's loupe: the strip and the loupe both move up 60 px with the list
    await f.evaluate(() => window.scrollBy(0, 60))
    await settle(f)
    const list = await box(f, '#list')
    const s1 = await stripOf(f, '#list')
    beside(s1, list, undefined, 'scrolled 60 px')
    // the open loupe stays at the strip's left, its top no higher than the strip's, as it opened
    const l1 = await box(f, '.thimble-colour-loupe')
    assert.ok(l1.shown && Math.abs(s1.left - l1.right - (s0.left - l0.right)) < 1, `the loupe stays at the strip's left: ${JSON.stringify([s0, l0, s1, l1])}`)
    assert.ok(l1.top >= s1.top - 0.5 && l1.top < s1.bottom, `the loupe stands beside the strip, never above it: ${JSON.stringify([s1, l1])}`)
    assert.ok(Math.abs(l1.top - s1.top - (l0.top - s0.top)) < 1, `the loupe moved with the strip: ${JSON.stringify([s0, l0, s1, l1])}`)
    // the page scrolls the list's top half out of the frame, and the pointer rests at the top of the part of the strip
    // that shows: the loupe opens beside that part, never above the frame where the strip is cut off
    await f.evaluate(() => window.scrollBy(0, (document.getElementById('list') as HTMLElement).getBoundingClientRect().top + 110))
    await settle(f)
    const list2 = await box(f, '#list')
    const s2 = await stripOf(f, '#list')
    beside(s2, list2, undefined, 'the list half out of view')
    await page.mouse.move(s2.left + 5, p + s2.seen!.top + 3)
    await page.waitForTimeout(450)
    await f.waitForSelector('.thimble-colour-loupe[data-open]', { state: 'visible' })
    const l2 = await box(f, '.thimble-colour-loupe')
    assert.ok(l2.top >= s2.seen!.top && l2.top < s2.seen!.bottom, `the loupe stands beside the part of the strip that shows: ${JSON.stringify([s2, l2])}`)
    // the list's top 100 px above the frame's bottom, the rest under it: the loupe takes no more rows than that part
    // holds and stays beside it, in the frame, never under the frame's bottom edge
    await page.mouse.move(5, 5)
    await f.evaluate(() => window.scrollBy(0, (document.getElementById('list') as HTMLElement).getBoundingClientRect().top - 500))
    await settle(f)
    const list3 = await box(f, '#list')
    const s3 = await stripOf(f, '#list')
    beside(s3, list3, undefined, 'the list under the frame\'s bottom')
    await page.mouse.move(s3.left + 5, p + s3.seen!.bottom - 3)
    await page.waitForTimeout(450)
    await f.waitForSelector('.thimble-colour-loupe[data-open]', { state: 'visible' })
    const l3 = await box(f, '.thimble-colour-loupe')
    const rows3 = await f.evaluate(() => document.querySelectorAll('.thimble-colour-loupe[data-open] .thimble-colour-loupe-row').length)
    assert.ok(rows3 >= 1 && rows3 < 17, `fewer rows than the loupe's 17, as many as the part that shows holds: ${rows3}`)
    assert.ok(l3.bottom <= 600 && l3.top >= s3.seen!.top - 1 && l3.bottom <= s3.seen!.bottom + 1, `the loupe stays in the frame, inside the part that shows: ${JSON.stringify([s3, l3])}`)
    assert.deepEqual(errors, [])
    await page.close()
  })

})
