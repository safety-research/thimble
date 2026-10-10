// The view kit's time range selector (backend/app/viewer_range.js) and a list's strip (viewer_colour.js) in a real
// browser, a page holding the view in a sandboxed frame: the viewfinder's edge zooms, its middle pans, a double click
// shows the whole span, a drag across the whole span frames a new range, the keys zoom and pan, and Ctrl with the wheel
// zooms around the pointer, telling onInput at each step and onChange once it stops; the hover tip stands under the overview, and the readout keeps the overview in place as it
// zooms; the overview draws its records in the Color by
// colours, grey with Off, one colour per pixel row; a long list gets one strip, no zoomed track, its thumb on the pixel
// grid once still; resting on it opens the loupe beside it, a line per record around the pointer with its line, its
// colour's cell and its text, which follows the pointer, stays where it is as the list moves by itself, goes to the
// thumb on the wheel over the strip or a drag of the thumb, and moved into holds still: a click goes to a record and
// leaves the rows, the wheel scrolls the list and the rows follow. Through the real ViewerFrame, a colour picked for a label's value from its chip's swatch
// goes to thimble as the label's colour, and hovering a chip of a label's value says what the value means from
// thimble's own answer. What the selector decides without layout is tests/public/range-kit.test.ts.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, test } from 'vitest'
import type { Browser, Frame, Page } from 'playwright'
import { bundle, cleanup, FRONTEND, launch, ORIGIN, src } from './page.ts'

const APP = path.join(FRONTEND, '..', 'backend', 'app')
const read = (name: string) => readFileSync(path.join(APP, name), 'utf8')
const inline = (js: string) => js.replace(/<\/script/g, '<\\/script')
const KIT = `<script>${inline(read('viewer_bridge.js'))}</script><script>window.__thimbleLabelOrder = ${read('label_order.json')}</script><script>${inline(read('viewer_colour.js'))}</script><script>${inline(read('viewer_range.js'))}</script><style>${read('viewer_kit.css')}</style>`
const TOKENS =
  ':root{--label-1:#025ac3;--label-2:#d0750a;--label-3:#08632f;--label-none:#a09c93;--ink-rgb:27,26,24;--surface-card:#fffdf8;' +
  '--text-primary:#000;--text-secondary:#4a4844;--text-tertiary:#726f69;--accent:#5135ff;--radius-chip:4px;--radius-ui:6px;' +
  '--h-row:28px;--control-sm:28px;--h-control:24px;--h-chip:20px;--text-xs:12px;--text-ui-sm:12px;--text-mono-sm:11px;--border-subtle:rgba(27,26,24,0.12);' +
  '--border-hairline:rgba(27,26,24,0.08);--font-body:sans-serif;--font-mono:monospace;--radius-hl:3px}'
const T0 = Date.UTC(2026, 5, 16) / 1000
// four hundred messages, one every ten minutes, the second half With links, in a list that scrolls
const N = 400
const VIEW = `<!doctype html><html><head><style>${TOKENS} body{margin:0;font:12px sans-serif;background:#fffdf8} .top{display:flex;align-items:center;gap:8px;padding:8px}
#range{padding:0 8px} #list{height:300px;overflow:auto} .msg{box-sizing:border-box;height:30px;padding:6px 8px 0 12px}</style>${KIT}</head><body>
<div class="top"><span id="colour"></span></div><div id="range"></div><div id="list"></div>
<script>
const rows = Array.from({ length: ${N} }, (_, i) => ({ t: ${T0} + i * 600, kind: i < ${N / 2} ? 'Text only' : 'With links', ref: 'm.jsonl#L' + (i + 1) }))
window.colour = thimble.colorBy({ mount: '#colour', fields: [{ name: 'kind', title: 'Kind', values: ['Text only', 'With links'] }], strip: '#list', onChange: draw })
window.range = thimble.timeRange({ mount: '#range', times: rows.map((r) => r.t), values: (i) => colour.valueOf(rows[i]), onChange: draw })
function draw() {
  document.getElementById('list').innerHTML = rows.filter((r) => range.has(r.t)).map((r) => '<div class="msg" data-anchor="' + r.ref + '"' + colour.attr(r) + '><time>' + new Date(r.t * 1000).toISOString().slice(11, 16) + '</time> message ' + r.ref.slice(9) + '</div>').join('')
}
draw()
</script></body></html>`

let browser: Browser

beforeAll(async () => {
  browser = await launch()
})
afterAll(async () => {
  await browser?.close()
  cleanup()
})

// three bursts of messages on three days, one every ten minutes, the nights between them narrow breaks on the axis
const BURSTS = [
  [Date.UTC(2026, 4, 12, 8) / 1000, 60],
  [Date.UTC(2026, 4, 13, 6) / 1000, 36],
  [Date.UTC(2026, 4, 14, 8) / 1000, 12],
]
const BROKEN = VIEW.replace(
  'const rows = Array.from({ length: ' + N + ' }, (_, i) => ({ t: ' + T0 + ' + i * 600,',
  'const rows = ' + JSON.stringify(BURSTS) + '.flatMap(([t0, n]) => Array.from({ length: n }, (_, i) => t0 + i * 600)).map((t, i) => ({ t,',
).replace("onChange: draw })\nfunction draw", "gap: 4 * 3600, onChange: draw })\nfunction draw")

async function framed(dpr = 1, doc = VIEW): Promise<{ page: Page; frame: () => Frame; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 }, deviceScaleFactor: dpr })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.setContent(`<!doctype html><html><body style="margin:0"><iframe id="f" sandbox="allow-scripts" style="border:0;width:800px;height:420px"></iframe></body></html>`)
  await page.evaluate((d) => ((document.getElementById('f') as HTMLIFrameElement).srcdoc = d), doc)
  const frame = () => page.frames().find((f) => f !== page.mainFrame())!
  await page.waitForTimeout(300)
  await frame().waitForSelector('.thimble-range-win', { state: 'attached' })
  await frame().waitForFunction(() => document.querySelectorAll('[data-thimble-colour]').length > 0)
  await page.waitForTimeout(150)
  return { page, frame, errors }
}
const state = (frame: () => Frame) => frame().evaluate(() => ({ from: (window as any).range.from as number, to: (window as any).range.to as number, full: (window as any).range.full as boolean, rows: document.querySelectorAll('.msg').length }))

describe('the time range selector in a frame', () => {
  test("the viewfinder's edge zooms, its middle pans, a double click shows the whole span, and the outside is dimmed", async () => {
    const { page, frame } = await framed()
    const box = (await frame().locator('.thimble-range-strip').boundingBox())!
    const s0 = await state(frame)
    assert.equal(s0.full, true)
    assert.equal(s0.rows, N)
    // the right edge, taken by its grip, dragged to the middle
    await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2)
    assert.equal(await frame().evaluate(() => getComputedStyle(document.querySelector('.thimble-range-grip-r')!).cursor), 'ew-resize')
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(100)
    const s1 = await state(frame)
    assert.equal(s1.full, false)
    assert.equal(s1.from, s0.from, 'the start stays where it was')
    assert.ok(Math.abs((s1.to - s1.from) / (s0.to - s0.from) - 0.5) < 0.03, JSON.stringify([s0, s1]))
    assert.ok(Math.abs(s1.rows - N / 2) <= 4, `the list holds the records in the range: ${s1.rows}`)
    const dim = await frame().evaluate(() => [document.querySelector<HTMLElement>('.thimble-range-dim-r')!.offsetWidth, document.querySelector<HTMLElement>('.thimble-range-win')!.offsetWidth])
    assert.ok(Math.abs(dim[0] - box.width / 2) <= 3 && Math.abs(dim[1] - box.width / 2) <= 3, `the right half is dimmed: ${dim}`)
    // the middle dragged a quarter of the way right: the range moves, its length kept
    await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(100)
    const s2 = await state(frame)
    assert.ok(s2.from > s1.from && Math.abs(s2.to - s2.from - (s1.to - s1.from)) < (s1.to - s1.from) * 0.02, JSON.stringify([s1, s2]))
    // a double click shows the whole span again
    await page.mouse.dblclick(box.x + box.width * 0.6, box.y + box.height / 2)
    await page.waitForTimeout(100)
    assert.equal((await state(frame)).full, true)
    await page.close()
  })

  test('at the whole span a drag across the overview frames a new range, as its crosshair says', async () => {
    const { page, frame } = await framed()
    const box = (await frame().locator('.thimble-range-strip').boundingBox())!
    const s0 = await state(frame)
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2)
    assert.equal(await frame().evaluate(() => getComputedStyle(document.querySelector('.thimble-range-strip')!).cursor), 'crosshair')
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(100)
    const s1 = await state(frame)
    const at = (f: number) => s0.from + (s0.to - s0.from) * f
    assert.equal(s1.full, false)
    assert.ok(Math.abs(s1.from - at(0.3)) < (s0.to - s0.from) * 0.02 && Math.abs(s1.to - at(0.6)) < (s0.to - s0.from) * 0.02, JSON.stringify([s0, s1]))
    await page.close()
  })

  test("the viewfinder's keys: + zooms, the arrows pan, - zooms out and Home shows the whole span, with no error", async () => {
    const { page, frame, errors } = await framed()
    const box = (await frame().locator('.thimble-range-strip').boundingBox())!
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    assert.equal(await frame().evaluate(() => document.activeElement?.className), 'thimble-range-win')
    await page.keyboard.press('Shift')
    await page.keyboard.press('+')
    await page.waitForTimeout(80)
    const z = await state(frame)
    assert.equal(z.full, false)
    await page.keyboard.press('ArrowLeft')
    await page.waitForTimeout(80)
    const l = await state(frame)
    assert.ok(l.from < z.from && Math.abs(l.to - l.from - (z.to - z.from)) < 1, JSON.stringify([z, l]))
    await page.keyboard.press('-')
    await page.waitForTimeout(80)
    const o = await state(frame)
    assert.ok(o.full || o.to - o.from > l.to - l.from, JSON.stringify([l, o]))
    await page.keyboard.press('Home')
    await page.waitForTimeout(80)
    assert.equal((await state(frame)).full, true)
    assert.deepEqual(errors, [])
    await page.close()
  })

  test("on an axis with breaks the keys pan and zoom in the overview's px, as the drags do, keep the viewfinder's width, and the range never collapses", async () => {
    const { page, frame, errors } = await framed(1, BROKEN)
    assert.ok(await frame().evaluate(() => (window as any).range.scale(600).broken), 'the overview has its breaks')
    const H = 3600
    const [d1, d2] = [BURSTS[0][0] as number, BURSTS[1][0] as number]
    // from the first day's afternoon to an hour into the second day's burst, across the night's break
    await frame().evaluate(([a, b]) => (window as any).range.set(a, b), [d1 + 6 * H, d2 + H])
    await page.waitForTimeout(80)
    const win = () => frame().evaluate(() => { const r = document.querySelector('.thimble-range-win')!.getBoundingClientRect(); return [r.left, r.width] })
    const [, w0] = await win()
    await frame().locator('.thimble-range-win').focus()
    for (const k of ['ArrowLeft', 'ArrowLeft', 'ArrowRight']) {
      await page.keyboard.press(k)
      await page.waitForTimeout(60)
      const s = await state(frame)
      const [, w] = await win()
      // an edge that would land in a break moves on to its side, and the other edge as far
      assert.ok(Math.abs(w - w0) <= 1, `${k} keeps the viewfinder's width on the screen: ${w} against ${w0}`)
      // a break's empty time drops out of a range whose edge leaves it, as in a drag, but the range never shrinks to a sliver
      assert.ok(s.to - s.from > 3 * H, `${k} leaves the range whole: ${(s.to - s.from) / H}h`)
    }
    const [, w1] = await win()
    await page.keyboard.press('+')
    await page.waitForTimeout(60)
    const z = await state(frame)
    assert.ok(Math.abs((await win())[1] - (w1 * 2) / 3) <= 11 && z.to - z.from > H, JSON.stringify([w1, await win(), z]))
    // beside the break, an arrow then - gives back the width + took
    const [, w2] = await win()
    await page.keyboard.press('ArrowLeft')
    await page.waitForTimeout(60)
    assert.ok(Math.abs((await win())[1] - w2) <= 1, JSON.stringify([w2, await win()]))
    await page.keyboard.press('-')
    await page.waitForTimeout(60)
    assert.ok(Math.abs((await win())[1] - w2 * 1.5) <= 11, JSON.stringify([w2, await win()]))
    assert.deepEqual(errors, [])
    await page.close()
  })

  test('hovering the overview gives the time and the records there in a tip under it, never cut off at the top', async () => {
    const { page, frame } = await framed()
    const box = (await frame().locator('.thimble-range-strip').boundingBox())!
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height / 2)
    await page.waitForTimeout(100)
    const tip = await frame().evaluate(() => {
      const t = document.querySelector('.thimble-tip') as HTMLElement
      const r = t.getBoundingClientRect()
      const s = document.querySelector('.thimble-range-strip')!.getBoundingClientRect()
      return { shown: t.style.display, top: r.top, stripBottom: s.bottom, text: t.textContent }
    })
    assert.equal(tip.shown, 'block')
    assert.ok(tip.top >= tip.stripBottom, JSON.stringify(tip))
    assert.match(tip.text ?? '', /records?$/)
    await page.close()
  })

  test("the readout keeps its width as the range zooms, so the overview keeps its place and width, and no date breaks", async () => {
    const { page, frame } = await framed()
    const look = () =>
      frame().evaluate(() => {
        const s = document.querySelector('.thimble-range-strip')!.getBoundingClientRect()
        const lines = [...document.querySelectorAll('.thimble-range-d')].map((d) => d.getClientRects().length)
        return { left: s.left, width: s.width, lines, text: document.querySelector('.thimble-range-dates')!.textContent }
      })
    // a range within a day, whose readout is short, then one across midnight, the widest
    await frame().evaluate((t0) => (window as any).range.set(t0 + 3600, t0 + 3 * 3600), T0)
    await page.waitForTimeout(80)
    const a = await look()
    assert.equal(a.text, '16 Jun 01:00 – 03:00')
    await frame().evaluate((t0) => (window as any).range.set(t0 + 18 * 3600, t0 + 30 * 3600), T0)
    await page.waitForTimeout(80)
    const b = await look()
    assert.equal(b.text, '16 Jun 18:00 – 17 Jun 06:00')
    assert.deepEqual([b.left, b.width], [a.left, a.width], JSON.stringify([a, b]))
    assert.ok(b.lines.every((n) => n === 1), 'each end on one line')
    await page.close()
  })

  test('Ctrl with the wheel zooms around the pointer, and the plain wheel leaves the range alone', async () => {
    const { page, frame } = await framed()
    const box = (await frame().locator('.thimble-range-strip').boundingBox())!
    const at = box.x + box.width * 0.25
    await page.mouse.move(at, box.y + box.height / 2)
    await page.mouse.wheel(0, 200)
    await page.waitForTimeout(250)
    assert.equal((await state(frame)).full, true)
    await page.keyboard.down('Control')
    await page.mouse.wheel(0, -200)
    await page.keyboard.up('Control')
    await page.waitForTimeout(300)
    const s = await state(frame)
    assert.equal(s.full, false)
    // the time under the pointer is where it was: a quarter of the way along the whole span
    const span = await frame().evaluate(() => (window as any).range.span as number[])
    const under = span[0] + (span[1] - span[0]) * 0.25
    assert.ok(s.from < under && s.to > under, JSON.stringify(s))
    assert.ok(Math.abs((under - s.from) / (s.to - s.from) - 0.25) < 0.05, 'and keeps its place in the viewfinder')
    await page.close()
  })

  test('the wheel tells onInput at each step that moves the viewfinder, and onChange once it stops', async () => {
    const doc = VIEW.replace('const rows = Array.from', 'window.inputs = []; window.changes = []\nconst rows = Array.from').replace(
      'onChange: draw })\nfunction draw',
      'onInput: (r) => inputs.push([r.from, r.to]), onChange: (r) => { changes.push([r.from, r.to]); draw() } })\nfunction draw',
    )
    const { page, frame } = await framed(1, doc)
    const seen = () => frame().evaluate(() => ({ inputs: (window as any).inputs.slice() as number[][], changes: (window as any).changes.slice() as number[][] }))
    const box = (await frame().locator('.thimble-range-strip').boundingBox())!
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2)
    await page.keyboard.down('Control')
    for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -100)
    await page.keyboard.up('Control')
    const a = await seen()
    assert.equal(a.inputs.length, 3, `one onInput per step: ${JSON.stringify(a)}`)
    await page.waitForTimeout(400)
    const b = await seen()
    assert.ok(b.changes.length >= 1 && b.changes.length <= 3, JSON.stringify(b))
    assert.deepEqual(b.changes.at(-1), a.inputs.at(-1), 'the range settles where the last step left it')
    const s = await state(frame)
    assert.deepEqual([s.from, s.to], a.inputs.at(-1))
    await page.close()
  })

  test('the overview draws its records in the Color by colours, and grey with Off', async () => {
    const { page, frame } = await framed()
    const px = () =>
      frame().evaluate(() => {
        const cv = document.querySelector('.thimble-range-strip canvas') as HTMLCanvasElement
        const ctx = cv.getContext('2d')!
        const at = (f: number) => [...ctx.getImageData(Math.floor(cv.width * f), cv.height - 3, 1, 1).data].slice(0, 3)
        return [at(0.2), at(0.8)]
      })
    assert.deepEqual(await px(), [[2, 90, 195], [208, 117, 10]], 'Text only first, With links after')
    await frame().locator('.thimble-colour-by').click()
    await frame().locator('.thimble-colour-menu [data-by="off"]').click()
    await page.waitForTimeout(200)
    const [a, b] = await px()
    assert.deepEqual(a, b, 'one grey for every record')
    assert.ok(Math.max(...a) - Math.min(...a) < 12, `a grey: ${a}`)
    assert.equal(await frame().locator('.thimble-colour-chip').count(), 0)
    await page.close()
  })

  test("the band of the time in view follows the list's rows as it scrolls and changes, under the viewfinder's frame", async () => {
    const { page, frame, errors } = await framed()
    // a row's time from its ref: message n is at T0 + (n - 1) * 600
    await frame().evaluate((t0) => (window as any).range.follow('#list', (el: HTMLElement) => t0 + (Number(el.dataset.anchor!.slice(9)) - 1) * 600, '.msg'), T0)
    // the band's px on the overview, and where the first and the last row in the list's view stand on the overview
    const band = () =>
      frame().evaluate((t0) => {
        const r = (window as any).range
        const strip = document.querySelector('.thimble-range-strip') as HTMLElement
        const vis = document.querySelector('.thimble-range-vis') as HTMLElement
        const x = (t: number) => ((t - r.span[0]) / (r.span[1] - r.span[0])) * strip.clientWidth
        const list = document.getElementById('list')!.getBoundingClientRect()
        const shown = [...document.querySelectorAll<HTMLElement>('#list .msg')].filter((m) => m.getBoundingClientRect().bottom > list.top && m.getBoundingClientRect().top < list.bottom)
        const times = shown.map((m) => t0 + (Number(m.dataset.anchor!.slice(9)) - 1) * 600)
        const b = vis.getBoundingClientRect()
        const s = strip.getBoundingClientRect()
        return { rows: shown.length, want: [x(Math.min(...times)), x(Math.max(...times))], got: [b.left - s.left, b.right - s.left], display: getComputedStyle(vis).display }
      }, T0)
    const near = (b: Awaited<ReturnType<typeof band>>) => b.display !== 'none' && Math.abs(b.got[0] - b.want[0]) <= 1.5 && Math.abs(b.got[1] - Math.max(b.want[1], b.want[0] + 3)) <= 1.5
    await page.waitForTimeout(100)
    const b0 = await band()
    assert.ok(b0.rows >= 10 && near(b0), `the band covers the rows in view at the top: ${JSON.stringify(b0)}`)
    // scrolled to the middle: the band moves to the rows now in view
    await frame().evaluate(() => (document.getElementById('list')!.scrollTop = 3000))
    await page.waitForTimeout(100)
    const b1 = await band()
    assert.ok(near(b1) && b1.got[0] > b0.got[1] + 50, `the band moves with the scroll: ${JSON.stringify([b0, b1])}`)
    // a wheel over the list scrolls it back up a little: the band follows
    const list = (await frame().locator('#list').boundingBox())!
    await page.mouse.move(list.x + list.width / 2, list.y + list.height / 2)
    await page.mouse.wheel(0, -900)
    await page.waitForTimeout(250)
    const b2 = await band()
    assert.ok(near(b2) && b2.got[0] < b1.got[0], `the band follows the wheel: ${JSON.stringify([b1, b2])}`)
    // the range zoomed in: the list holds other rows, and the band stands on those in view
    await frame().evaluate((t0) => (window as any).range.set(t0 + 300 * 600, t0 + 360 * 600), T0)
    await page.waitForTimeout(150)
    const b3 = await band()
    assert.ok(near(b3) && b3.got[0] >= b1.got[0], `the band follows the list's new rows: ${JSON.stringify([b2, b3])}`)
    // the band lies under the viewfinder's frame, filled where the frame is an outline
    const look = await frame().evaluate(() => {
      const vis = document.querySelector('.thimble-range-vis')!
      const win = document.querySelector('.thimble-range-win')!
      return {
        under: vis.parentElement === win.parentElement && !!(vis.compareDocumentPosition(win) & Node.DOCUMENT_POSITION_FOLLOWING),
        fill: getComputedStyle(vis).backgroundColor,
        frameFill: getComputedStyle(win).backgroundColor,
        edge: getComputedStyle(vis).borderLeftWidth,
      }
    })
    assert.ok(look.under, 'the frame is drawn over the band')
    assert.ok(look.fill !== look.frameFill && look.fill !== 'rgba(0, 0, 0, 0)' && look.edge === '1px', JSON.stringify(look))
    // set by hand: one moment is a band 3 px wide, and null hides it
    const one = await frame().evaluate((t0) => {
      const r = (window as any).range
      r.follow(null).set(null).visible(t0 + 100 * 600, t0 + 100 * 600)
      const w = document.querySelector('.thimble-range-vis')!.getBoundingClientRect().width
      r.visible(null)
      return [w, getComputedStyle(document.querySelector('.thimble-range-vis')!).display]
    }, T0)
    assert.deepEqual(one, [3, 'none'])
    assert.deepEqual(errors, [])
    await page.close()
  })

  test('a labels message that only brings marks for new refs leaves the overview as it is drawn', async () => {
    const { page, frame, errors } = await framed()
    const post = (msg: object) => page.evaluate((m) => (document.getElementById('f') as HTMLIFrameElement).contentWindow!.postMessage({ type: 'thimble:labels', on: [], filter: null, ...m }, '*'), msg)
    const mark = (id: string, value: string) => ({ bar: '#08632f', names: [id], values: [{ id, label: id, value, colour: '#08632f' }] })
    const marks = (from: number, to: number, id: string) => Object.fromEntries(Array.from({ length: to - from + 1 }, (_, k) => [`m.jsonl#L${from + k}`, mark(id, 'yes')]))
    // every paint of the overview's canvas, and every change to the control's elements (its axis, readout, viewfinder)
    await frame().evaluate(() => {
      const w = window as any
      w.__paints = 0
      w.__dom = 0
      const clear = CanvasRenderingContext2D.prototype.clearRect
      CanvasRenderingContext2D.prototype.clearRect = function (this: CanvasRenderingContext2D, x: number, y: number, cw: number, ch: number) {
        if (this.canvas.closest('.thimble-range-strip')) w.__paints++
        return clear.call(this, x, y, cw, ch)
      }
      new MutationObserver((recs) => (w.__dom += recs.length)).observe(document.querySelector('.thimble-range')!, { childList: true, subtree: true, attributes: true })
    })
    const counts = () => frame().evaluate(() => [(window as any).__paints, (window as any).__dom])
    const zero = () => frame().evaluate(() => ((window as any).__paints = (window as any).__dom = 0))
    await post({ marks: {} })
    await page.waitForTimeout(200)
    await zero()
    // colored by Kind: marks for refs thimble had not marked before change nothing the overview draws
    await post({ marks: marks(1, 40, 'k1') })
    await page.waitForTimeout(200)
    await post({ marks: marks(1, 80, 'k1') })
    await page.waitForTimeout(200)
    assert.deepEqual(await counts(), [0, 0], 'colored by a field, the overview is not drawn again')
    // the label k1 turned on takes the colour: the overview draws its marked records in it
    const k1 = { id: 'k1', name: 'k1', colour: '#08632f', values: [{ name: 'yes', colour: '#08632f' }] }
    const all = (n: number) => [{ ...k1, on: true, here: true, count: n, values: [{ name: 'yes', colour: '#08632f', highlight: true }] }]
    await post({ marks: marks(1, 80, 'k1'), on: [k1], all: all(80) })
    await page.waitForTimeout(250)
    assert.equal(await frame().evaluate(() => (window as any).colour.label), 'k1')
    assert.ok((await counts())[0] > 0, 'the overview is drawn in the label it is colored by')
    await zero()
    // colored by k1: marks of k1 for new refs color more records, so the overview is drawn again
    await post({ marks: marks(1, 160, 'k1'), on: [k1], all: all(80) })
    await page.waitForTimeout(250)
    assert.ok((await counts())[0] > 0, 'new records in the colour are drawn')
    await zero()
    // but marks of another label for new refs change nothing it draws
    await post({ marks: { ...marks(1, 160, 'k1'), ...marks(161, 240, 'k2') }, on: [k1], all: all(80) })
    await page.waitForTimeout(250)
    assert.equal((await counts())[0], 0, 'marks that change no value of k1 leave the overview alone')
    assert.deepEqual(errors, [])
    await page.close()
  })
})

describe("a long list's strip and its loupe", () => {
  /** the strip as laid out in the frame: its parts' boxes and looks */
  const strip = (frame: () => Frame) =>
    frame().evaluate(() => {
      const box = (el: Element) => {
        const r = el.getBoundingClientRect()
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
      }
      const el = document.querySelector('.thimble-colour-strip') as HTMLElement
      const track = el.querySelector('.thimble-colour-track') as HTMLElement
      const thumb = el.querySelector('.thimble-colour-thumb') as HTMLElement
      const list = document.getElementById('list')!
      return {
        tracks: el.querySelectorAll('.thimble-colour-track').length,
        zoomed: document.querySelectorAll('.thimble-colour-zoom, .thimble-colour-lens, .thimble-colour-link').length,
        track: box(track),
        thumb: box(thumb),
        trackRadius: getComputedStyle(track).borderTopLeftRadius,
        thumbRadius: getComputedStyle(thumb).borderTopLeftRadius,
        thumbBorder: getComputedStyle(thumb).borderTopWidth,
        right: Math.round(list.getBoundingClientRect().right - el.getBoundingClientRect().right),
      }
    })
  /** the loupe as drawn: whether open, naming one record or held still, its rows (line, cells, time, text, tints),
   * its box beside the strip, the bracket and the list's scroll */
  const loupe = (frame: () => Frame) =>
    frame().evaluate(() => {
      const el = document.querySelector('.thimble-colour-loupe') as HTMLElement
      const box = el.querySelector('.thimble-colour-loupe-box') as HTMLElement
      const rows = [...el.querySelectorAll('.thimble-colour-loupe-row')].map((r) => {
        const who = r.querySelector('.thimble-colour-loupe-t b')?.textContent ?? ''
        return {
          n: r.querySelector('.thimble-colour-loupe-n')!.textContent ?? '',
          cells: [...r.querySelectorAll('.thimble-colour-loupe-c i')].map((i) => getComputedStyle(i).backgroundColor),
          who,
          text: (r.querySelector('.thimble-colour-loupe-t')!.textContent ?? '').slice(who.length),
          seen: r.classList.contains('seen'),
          at: r.classList.contains('at'),
          shadow: getComputedStyle(r).boxShadow,
          edge: getComputedStyle(r).borderLeftWidth,
        }
      })
      const b = box.getBoundingClientRect()
      const s = document.querySelector('.thimble-colour-strip')!.getBoundingClientRect()
      const br = document.querySelector('.thimble-colour-bracket') as HTMLElement
      return {
        open: el.hasAttribute('data-open') && getComputedStyle(el).display !== 'none',
        one: el.hasAttribute('data-one'),
        frozen: el.hasAttribute('data-frozen'),
        rows,
        box: { left: b.left, right: b.right, top: b.top, bottom: b.bottom },
        strip: { left: s.left, top: s.top, bottom: s.bottom },
        radius: getComputedStyle(box).borderTopLeftRadius,
        bracket: br.hasAttribute('data-open') ? (({ left, right, top, bottom }) => ({ left, right, top, bottom }))(br.getBoundingClientRect()) : null,
        top: document.getElementById('list')!.scrollTop,
      }
    })
  type Loupe = Awaited<ReturnType<typeof loupe>>
  const line = (l: Loupe, k: number) => Number(l.rows[k]?.n.replace(/,/g, ''))
  const middle = (l: Loupe) => line(l, Math.floor(l.rows.length / 2))
  const BLUE = 'rgb(2, 90, 195)'
  const ORANGE = 'rgb(208, 117, 10)'
  /** the pointer resting on the strip a share `f` down it, long enough for the loupe to open */
  const rest = async (page: Page, frame: () => Frame, f: number, ms = 400) => {
    const tr = (await frame().locator('.thimble-colour-track').boundingBox())!
    await page.mouse.move(tr.x + tr.width / 2, tr.y + tr.height * f)
    await page.waitForTimeout(ms)
    return tr
  }

  test("one strip at the list's right edge at every length, its lane under a thumb in thimble's corners; no zoomed track, lens or lines", async () => {
    const { page, frame } = await framed()
    const s = await strip(frame)
    assert.equal(s.tracks, 1)
    assert.equal(s.zoomed, 0, 'no zoomed track, lens or lines from the frame')
    assert.ok(s.right >= 1 && s.right <= 4, `the strip ${s.right}px in from the list's right edge`)
    assert.equal(s.track.width, 13, 'one lane, 7 px wide, 3 px in from each edge')
    assert.equal(s.thumb.width, s.track.width, 'the thumb as wide as the strip')
    assert.deepEqual([s.trackRadius, s.thumbRadius, s.thumbBorder], ['3px', '4px', '1px'], "the radius tokens: the track's, the thumb's a chip's")
    await page.close()
  })

  for (const dpr of [1, 2]) {
    test(`at a pixel ratio of ${dpr}, the thumb's edges stand on whole device pixels once still`, async () => {
      const { page, frame } = await framed(dpr)
      for (const f of [0, 0.5, 1]) {
        await frame().evaluate((x) => {
          const l = document.getElementById('list')!
          l.scrollTop = x * (l.scrollHeight - l.clientHeight)
        }, f)
        // a jump: the thumb glides there, and goes onto the pixel grid once it has stood still a few frames
        await page.waitForTimeout(350)
        const s = await strip(frame)
        const on = (v: number) => Math.abs(v * dpr - Math.round(v * dpr)) < 1e-3
        for (const v of [s.thumb.top, s.thumb.bottom, s.thumb.left, s.thumb.right]) assert.ok(on(v), `${v} off the grid at ${f}: ${JSON.stringify(s)}`)
        assert.ok(Math.abs((s.thumb.top - s.track.top) / Math.max(1, s.track.height - s.thumb.height) - f) < 0.02, `the thumb ${f} of the way down: ${JSON.stringify(s)}`)
      }
      await page.close()
    })
  }

  test("resting on the strip 250 ms opens the loupe beside it: a line per record around the pointer, its line, its color's cell, its time and the start of its text", async () => {
    const { page, frame } = await framed()
    await rest(page, frame, 0.75, 120)
    assert.equal((await loupe(frame)).open, false, 'not before 250 ms')
    await page.waitForTimeout(300)
    const l = await loupe(frame)
    assert.equal(l.open, true)
    assert.equal(l.one, false)
    assert.equal(l.rows.length, 17)
    assert.ok(Math.abs(middle(l) - 0.75 * N) <= 3, `the records around the pointer, three quarters down: ${l.rows.map((r) => r.n)}`)
    assert.ok(l.rows.every((r, i) => !i || line(l, i) === line(l, i - 1) + 1), 'in order, a line each')
    const mid = l.rows[8]
    assert.equal(mid.at, true, 'the record under the pointer darker')
    assert.equal(mid.text, `message ${middle(l)}`, "the start of the record's text")
    assert.match(mid.who, /^\d\d:\d\d$/, 'its time')
    assert.deepEqual(mid.cells, [ORANGE], "a cell in the record's color")
    assert.equal(l.top, 0, 'nothing scrolls')
    assert.ok(l.box.right <= l.strip.left, `the loupe beside the strip, never over it: ${JSON.stringify(l.box)} ${JSON.stringify(l.strip)}`)
    assert.ok(l.box.top >= l.strip.top && l.box.bottom <= l.strip.bottom, 'within the list')
    assert.ok(l.bracket && l.bracket.right <= l.strip.left + 0.5, `a bracket beside the strip: ${JSON.stringify(l.bracket)}`)
    assert.equal(l.radius, '6px', "thimble's popover corners")
    assert.ok(l.rows.every((r) => r.shadow === 'none' && r.edge === '0px'), 'no colored stripe on a row: its color is its cell')
    // along the strip, it follows the pointer
    const tr = (await frame().locator('.thimble-colour-track').boundingBox())!
    await page.mouse.move(tr.x + tr.width / 2, tr.y + tr.height * 0.25)
    await page.waitForTimeout(80)
    const up = await loupe(frame)
    assert.ok(Math.abs(middle(up) - 0.25 * N) <= 3, `it follows the pointer: ${up.rows.map((r) => r.n)}`)
    assert.deepEqual(up.rows[8].cells, [BLUE])
    // off the strip, elsewhere than into it, it closes
    await page.mouse.move(10, tr.y + tr.height * 0.25)
    await page.waitForTimeout(80)
    assert.equal((await loupe(frame)).open, false)
    await page.close()
  })

  test('the list moving by itself leaves the loupe where it is; the wheel over the strip, a real scroll, takes it to the thumb', async () => {
    const { page, frame } = await framed()
    await rest(page, frame, 0.25)
    const before = await loupe(frame)
    assert.equal(before.open, true)
    // the list's place changes with no scroll of the analyst's (the page, a link): the rows stay
    await frame().evaluate(() => (document.getElementById('list')!.scrollTop = 6000))
    await page.waitForTimeout(350)
    const moved = await loupe(frame)
    assert.deepEqual(moved.rows.map((r) => r.n), before.rows.map((r) => r.n), 'the rows stay where they were')
    // the wheel over the strip: the rows of the part in view
    await page.mouse.wheel(0, 300)
    await page.waitForTimeout(350)
    const after = await loupe(frame)
    const view = await frame().evaluate(() => { const l = document.getElementById('list')!; return ((l.scrollTop + l.clientHeight / 2) / l.scrollHeight) * 400 })
    assert.ok(after.top > 6000, 'the wheel scrolled the list')
    assert.ok(Math.abs(middle(after) - view) <= 3, `the rows around the thumb: ${middle(after)} for ${view}`)
    assert.ok(after.rows.some((r) => r.seen), 'those in view tinted')
    await page.close()
  })

  test('a press on the thumb opens the loupe at it at once, and a drag of the thumb takes its rows along', async () => {
    const { page, frame } = await framed()
    const th = (await frame().locator('.thimble-colour-thumb').boundingBox())!
    const x = th.x + th.width / 2
    const y = th.y + th.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.waitForTimeout(60)
    const held = await loupe(frame)
    assert.equal(held.open, true, 'open at once')
    assert.ok(middle(held) <= 12, `the rows at the thumb, the list's top: ${held.rows.map((r) => r.n)}`)
    for (let i = 1; i <= 20; i++) await page.mouse.move(x, y + 6 * i)
    await page.waitForTimeout(120)
    const dragged = await loupe(frame)
    await page.mouse.up()
    const view = await frame().evaluate(() => { const l = document.getElementById('list')!; return ((l.scrollTop + l.clientHeight / 2) / l.scrollHeight) * 400 })
    assert.ok(dragged.top > 0, 'the drag scrolled the list')
    assert.ok(Math.abs(middle(dragged) - view) <= 4, `the rows follow the thumb: ${middle(dragged)} for ${view}`)
    await page.close()
  })

  test('moved into, the loupe holds still: the record under the pointer darker, a click goes there and leaves the rows, the wheel scrolls the list and the rows follow', async () => {
    const { page, frame } = await framed()
    await rest(page, frame, 0.5)
    const open = await loupe(frame)
    assert.equal(open.open, true)
    // across to the loupe at the same height: it holds still
    const rowY = (l: Loupe, k: number) => l.box.top + 5 + 16 * k + 8
    await page.mouse.move((open.box.left + open.box.right) / 2, rowY(open, 8))
    await page.waitForTimeout(80)
    const held = await loupe(frame)
    assert.equal(held.frozen, true)
    assert.deepEqual(held.rows.map((r) => r.n), open.rows.map((r) => r.n), 'its rows stay')
    assert.deepEqual([held.box.top, held.box.left], [open.box.top, open.box.left], 'and so does it')
    await page.mouse.move((open.box.left + open.box.right) / 2, rowY(open, 3))
    await page.waitForTimeout(80)
    const over = await loupe(frame)
    assert.deepEqual(over.rows.map((r) => r.at), over.rows.map((_, k) => k === 3), 'the row under the pointer darker')
    // a click goes to that record and chooses it; the rows stay under the pointer
    const want = line(over, 3)
    await page.mouse.click((open.box.left + open.box.right) / 2, rowY(open, 3))
    await page.waitForTimeout(150)
    const went = await frame().evaluate((n) => {
      const list = document.getElementById('list')!.getBoundingClientRect()
      const el = document.querySelector(`[data-anchor="m.jsonl#L${n}"]`)!
      const r = el.getBoundingClientRect()
      return { seen: r.top >= list.top && r.bottom <= list.bottom, chosen: el.hasAttribute('data-thimble-snap') }
    }, want)
    assert.deepEqual(went, { seen: true, chosen: true }, `the list went to line ${want}`)
    const clicked = await loupe(frame)
    assert.deepEqual(clicked.rows.map((r) => r.n), open.rows.map((r) => r.n), 'the rows stay where they are')
    assert.equal(clicked.open && clicked.frozen, true)
    // the wheel in it scrolls the list, its rows follow the scroll position and it keeps its place
    const was = clicked.top
    await page.mouse.wheel(0, 900)
    await page.waitForTimeout(350)
    const wheeled = await loupe(frame)
    const view = await frame().evaluate(() => { const l = document.getElementById('list')!; return ((l.scrollTop + l.clientHeight / 2) / l.scrollHeight) * 400 })
    assert.ok(wheeled.top > was + 500, `the list scrolled: ${was} → ${wheeled.top}`)
    assert.ok(Math.abs(middle(wheeled) - view) <= 3, `the rows follow: ${middle(wheeled)} for ${view}`)
    assert.equal(wheeled.box.top, open.box.top, 'the loupe keeps its place')
    // back onto the strip, it follows the pointer again; off both, it closes
    const tr = (await frame().locator('.thimble-colour-track').boundingBox())!
    await page.mouse.move(tr.x + tr.width / 2, tr.y + tr.height * 0.9)
    await page.waitForTimeout(80)
    const back = await loupe(frame)
    assert.equal(back.frozen, false)
    assert.ok(Math.abs(middle(back) - 0.9 * N) <= 3, `following the pointer again: ${middle(back)}`)
    await page.mouse.move(10, tr.y + tr.height * 0.9)
    await page.waitForTimeout(80)
    assert.equal((await loupe(frame)).open, false)
    await page.close()
  })

  test('a click on the strip sends the thumb there, its middle under the pointer', async () => {
    const { page, frame } = await framed()
    const tr = (await frame().locator('.thimble-colour-track').boundingBox())!
    await page.mouse.click(tr.x + tr.width / 2, tr.y + tr.height * 0.75)
    await page.waitForTimeout(100)
    const top = await frame().evaluate(() => { const l = document.getElementById('list')!; return (l.scrollTop + l.clientHeight / 2) / l.scrollHeight })
    assert.ok(Math.abs(top - 0.75) < 0.05, `the list goes there: ${top}`)
    await page.close()
  })
})

describe("a label's value's colour through ViewerFrame", () => {
  test("a colour picked from the chip's swatch of a label's value is the label's colour, given through thimble", async () => {
    const script = await bundle('view-range-colour', [
      `import { createElement } from 'react'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { ViewerFrame } from '${src('files/ViewerFrame.tsx')}'`,
      `const w = window`,
      `w.__acts = []`,
      `const k = { id: 'k1', name: 'asks', description: '', unit: 'record', kind: 'prompt', spec: '', labels: ['yes', 'no'], created_by: 'analyst', ts: '', classes: [{ name: 'yes', color: 2, highlight: true }, { name: 'no', color: 0, highlight: false }], shown: false }`,
      `const root = document.body.appendChild(document.createElement('div'))`,
      `root.style.cssText = 'width:800px;height:420px'`,
      `createRoot(root).render(createElement(ViewerFrame, { ws: 'w', slug: 'board', title: 'Board', byId: new Map([[k.id, k]]), labels: [k], labelActions: { setOn: () => {}, setColour: (id, value, n) => w.__acts.push(['colour', id, value, n]) } }))`,
    ])
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } })
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname === '/api/ws/w/views/board/frame') return route.fulfill({ status: 200, contentType: 'text/html', body: VIEW })
      if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>' })
    })
    await page.goto(`${ORIGIN}/`)
    // thimble's palette, which the page hears and names a colour by
    await page.addStyleTag({ content: 'iframe{width:800px;height:420px;border:0} :root{' + Array.from({ length: 18 }, (_, i) => `--label-${i + 1}:#${(0x204060 + i * 0x0b0907).toString(16).slice(-6)};`).join('') + '--label-none:#a09c93}' })
    await page.addScriptTag({ path: script })
    const frame = () => page.frames().find((f) => f !== page.mainFrame())!
    await page.waitForFunction(() => document.querySelector('iframe'))
    await page.waitForTimeout(500)
    await frame().waitForSelector('.thimble-colour-chip[data-label="k1"]')
    await frame().locator('.thimble-colour-chip').first().locator('.chip-sw').click()
    await frame().waitForSelector('.thimble-colour-palette')
    assert.equal(await frame().locator('.thimble-colour-palette .thimble-colour-pick').count(), 18)
    const on = await frame().evaluate(() => document.querySelector('.thimble-colour-palette .thimble-colour-pick.on')?.getAttribute('data-pick'))
    assert.equal(on, '1', "the value's own colour, thimble's second, is ringed")
    assert.equal(await frame().locator('.thimble-colour-palette [data-reset-colours]').count(), 0, "a label's colours are the label's own, with no Reset here")
    // red, which no value takes by itself, picked
    await frame().locator('.thimble-colour-palette .thimble-colour-pick[data-pick="12"]').click()
    await page.waitForFunction(() => (window as any).__acts.length > 0)
    assert.deepEqual(await page.evaluate(() => (window as any).__acts), [['colour', 'k1', 'yes', 13]])
    await page.close()
  })
})

describe("a label's value's meaning through ViewerFrame", () => {
  test("hovering a chip of a label's value says what the value means, from thimble's own answer, asked once", async () => {
    const DEF = { id: 'k1', name: 'asks', kind: 'prompt', text: 'Does the message ask another agent for something? yes = it asks. no = it does not.', spec: '', scope: 'm.jsonl', unit: 'record', labeled: 400, values: [{ name: 'yes', highlight: true, n: 40, meaning: 'it asks' }, { name: 'no', highlight: false, n: 360, meaning: 'it does not' }] }
    const script = await bundle('view-range-meaning', [
      `import { createElement } from 'react'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { ViewerFrame } from '${src('files/ViewerFrame.tsx')}'`,
      `const k = { id: 'k1', name: 'asks', description: '', unit: 'record', kind: 'prompt', spec: '', labels: ['yes', 'no'], created_by: 'analyst', ts: '', classes: [{ name: 'yes', color: 2, highlight: true }, { name: 'no', color: 0, highlight: false }], shown: true }`,
      `const root = document.body.appendChild(document.createElement('div'))`,
      `root.style.cssText = 'width:800px;height:420px'`,
      `createRoot(root).render(createElement(ViewerFrame, { ws: 'w', slug: 'board', title: 'Board', byId: new Map([[k.id, k]]), labels: [k], labelActions: { setOn: () => {}, setColour: () => {} } }))`,
    ])
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } })
    const asked: unknown[] = []
    await page.route('**/*', async (route) => {
      const req = route.request()
      const url = new URL(req.url())
      if (url.pathname === '/api/ws/w/views/board/frame') return route.fulfill({ status: 200, contentType: 'text/html', body: VIEW })
      if (url.pathname === '/api/ws/w/views/board/records') {
        const q = JSON.parse(req.postData() || '{}').query
        if (q && q.$thimble) asked.push(q)
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: q && q.$thimble === 'label' ? DEF : null }) })
      }
      if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>' })
    })
    await page.goto(`${ORIGIN}/`)
    await page.addStyleTag({ content: 'iframe{width:800px;height:420px;border:0}' })
    await page.addScriptTag({ path: script })
    const frame = () => page.frames().find((f) => f !== page.mainFrame())!
    await page.waitForFunction(() => document.querySelector('iframe'))
    await page.waitForTimeout(500)
    await frame().waitForSelector('.thimble-colour-chip[data-label="k1"]')
    await frame().locator('.thimble-colour-chip[data-label="k1"]').first().locator('.chip-text').hover()
    await frame().waitForFunction(() => {
      const t = document.querySelector('.thimble-tip') as HTMLElement | null
      return !!t && t.style.display === 'block'
    })
    assert.equal(await frame().evaluate(() => document.querySelector('.thimble-tip .thimble-tip-m')!.textContent), 'it asks')
    assert.deepEqual(asked, [{ $thimble: 'label', id: 'k1' }], 'one fetch, which thimble answers itself')
    await page.close()
  })
})
