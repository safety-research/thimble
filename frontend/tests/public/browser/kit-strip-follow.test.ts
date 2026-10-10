// The strip the view kit draws beside a list (backend/app/viewer_colour.js: Color by's strip, its loupe, and the plain
// track the tree, the table and the search give a list) stands fixed in the frame's viewport, so it follows its list
// when anything the list stands in moves it: on a page that scrolls, as a gallery or a long view does, the strip and an
// open loupe go with the list as the page scrolls, the strip and its thumb as one with the list, as the list's own
// scrollbar would, cut where the page or a box around the list cuts the list (an open loupe stays beside the part not
// cut), and hide when the list is out of view; a box above the list that grows moves them with it. In a view whose page never
// scrolls the list's own scroll is tests/public/browser/view-colour.test.ts.
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
// of 200 records Color by gives its strip in another card, and a pane that scrolls in the page holding a third list
const FILES = Array.from({ length: 300 }, (_, i) => ({ key: `run-${Math.floor(i / 30)}/agent-${i % 30}.jsonl`, n: i + 1 }))
const RECORDS = Array.from({ length: 200 }, (_, i) => `<div class="rec" data-anchor="r.jsonl#L${i + 1}" data-colour="${i % 3 ? 'ok' : 'failed'}">record ${i + 1}</div>`).join('')
const PAGE = `<!doctype html><html><head><style>${TOKENS} body{margin:0;background:var(--surface-card);font:12px sans-serif}
.sec{margin:40px 16px;border:1px solid var(--border-subtle);border-radius:var(--radius-card);overflow:hidden}
#grow{height:0} #tree{height:240px} #list{height:200px;overflow:auto} .rec{box-sizing:border-box;height:24px;padding:4px 8px}
#pane{height:260px;overflow:auto;border:1px solid var(--border-subtle)} #inner{height:150px;overflow:auto} .tall{height:900px}</style>${KIT}</head><body>
<div class="top" style="padding:8px"><span id="colour"></span></div>
<div class="sec" style="height:120px">above</div>
<div class="sec" id="s-tree"><div id="grow"></div><div id="tree"></div></div>
<div class="sec">a section under the tree<div style="height:300px"></div></div>
<div class="sec"><div id="list">${RECORDS}</div></div>
<div class="sec"><div id="pane"><div style="height:120px">above the inner list</div><div id="inner">${RECORDS.replace(/r\.jsonl/g, 'i.jsonl')}</div><div class="tall"></div></div></div>
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
/** Whether the thumb stands where it stood on its list, as the list's own scrollbar's would. */
function moved(s: StripBox, list: Box, s0: StripBox, list0: Box, what = '') {
  assert.ok(Math.abs(s.thumb.top - list.top - (s0.thumb.top - list0.top)) < 1 && Math.abs(s.thumb.bottom - s.thumb.top - (s0.thumb.bottom - s0.thumb.top)) < 1, `${what}: the thumb goes with the list, as tall: ${JSON.stringify([s0.thumb, list0, s.thumb, list])}`)
}

describe('the strip on a page that scrolls', () => {
  test("the tree's track goes with the tree as the page scrolls, is cut at the top of the frame, and hides once the tree is out of view", async () => {
    const { page, frame, errors } = await framed()
    const f = frame()
    const tree0 = await box(f, '#tree')
    const s0 = await stripOf(f, '#tree')
    beside(s0, tree0, undefined, 'at first')
    // the page scrolls 200 px: the track moves up with the tree, never staying over the section under it
    await f.evaluate(() => window.scrollBy(0, 200))
    await settle(f)
    const tree = await box(f, '#tree')
    const s = await stripOf(f, '#tree')
    beside(s, tree, undefined, 'scrolled 200 px')
    moved(s, tree, s0, tree0, 'scrolled 200 px')
    // the tree's top above the frame: the track is the part of it in view
    await f.evaluate(() => window.scrollTo(0, (document.getElementById('tree') as HTMLElement).getBoundingClientRect().top + window.scrollY + 120))
    await settle(f)
    const half = await box(f, '#tree')
    assert.ok(half.top < 0 && half.bottom > 0, JSON.stringify(half))
    const sHalf = await stripOf(f, '#tree')
    beside(sHalf, half, undefined, 'the tree half out of view')
    // cut, not squeezed: the thumb stands where it stood on the tree, as tall
    moved(sHalf, half, s0, tree0, 'the tree half out of view')
    // the tree out of view: no track of it anywhere in the frame
    await f.evaluate(() => window.scrollBy(0, 400))
    await settle(f)
    assert.ok((await box(f, '#tree')).bottom < 0)
    const gone = await f.evaluate(() => [...document.querySelectorAll<HTMLElement>('.thimble-colour-strip')].filter((e) => getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().height > 0).map((e) => e.getBoundingClientRect().top))
    const list = await box(f, '#list')
    const inner = await box(f, '#inner')
    // the strips that show are those of the lists in view, none at the place the tree was
    assert.equal(gone.length, [list, inner].filter((b) => b.bottom > 0 && b.top < 600).length, JSON.stringify({ gone, list, inner }))
    // back to the top: the track is beside the tree again
    await f.evaluate(() => window.scrollTo(0, 0))
    await settle(f)
    beside(await stripOf(f, '#tree'), await box(f, '#tree'), undefined, 'back at the top')
    assert.deepEqual(errors, [])
    await page.close()
  })

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
    assert.deepEqual(errors, [])
    await page.close()
  })

  test('a list in a pane that scrolls: its strip follows the pane, is cut where the pane cuts the list, and hides once the pane hides it', async () => {
    const { page, frame, errors } = await framed()
    const f = frame()
    await f.evaluate(() => (document.getElementById('pane') as HTMLElement).scrollIntoView({ block: 'start' }))
    await settle(f)
    const pane = await f.evaluate(() => {
      const e = document.getElementById('pane') as HTMLElement
      const r = e.getBoundingClientRect()
      return { top: r.top + e.clientTop, bottom: r.top + e.clientTop + e.clientHeight }
    })
    const inner0 = await box(f, '#inner')
    const s0 = await stripOf(f, '#inner')
    beside(s0, inner0, pane, 'the pane at its top')
    // the pane scrolls 60 px: the strip goes up with the list
    await f.evaluate(() => ((document.getElementById('pane') as HTMLElement).scrollTop = 60))
    await settle(f)
    beside(await stripOf(f, '#inner'), await box(f, '#inner'), pane, 'the pane scrolled 60 px')
    // the pane scrolls the list half under its top edge: the strip is the part the pane shows, never over its edge
    await f.evaluate(() => ((document.getElementById('pane') as HTMLElement).scrollTop = 190))
    await settle(f)
    const half = await box(f, '#inner')
    assert.ok(half.top < pane.top && half.bottom > pane.top, JSON.stringify([half, pane]))
    const sHalf = await stripOf(f, '#inner')
    beside(sHalf, half, pane, 'the list half under the pane\'s top')
    moved(sHalf, half, s0, inner0, 'the list half under the pane\'s top')
    // the list scrolled out of the pane: its strip hides
    await f.evaluate(() => ((document.getElementById('pane') as HTMLElement).scrollTop = 400))
    await settle(f)
    assert.ok((await box(f, '#inner')).bottom < pane.top)
    const shown = await f.evaluate((top) => [...document.querySelectorAll<HTMLElement>('.thimble-colour-strip')].some((e) => getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().height > 0 && e.getBoundingClientRect().bottom > top - 1 && e.getBoundingClientRect().top < top + 1), pane.top)
    assert.equal(shown, false, 'no strip stands at the pane\'s top edge')
    assert.deepEqual(errors, [])
    await page.close()
  })

  test('a box above the list that grows moves the strip with the list, with no scroll and no resize of the list', async () => {
    const { page, frame, errors } = await framed()
    const f = frame()
    const before = await stripOf(f, '#tree')
    await f.evaluate(() => ((document.getElementById('grow') as HTMLElement).style.height = '50px'))
    await settle(f)
    const tree = await box(f, '#tree')
    const after = await stripOf(f, '#tree')
    beside(after, tree, undefined, 'the box above grown 50 px')
    assert.ok(Math.abs(after.top - before.top - 50) < 1, JSON.stringify([before, after]))
    assert.deepEqual(errors, [])
    await page.close()
  })
})
