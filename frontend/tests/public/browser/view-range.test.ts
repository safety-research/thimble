// The view kit's time range selector (backend/app/viewer_range.js) and a list's two tracks (viewer_colour.js) in a real
// browser, a page holding the view in a sandboxed frame: the viewfinder's edge zooms, its middle pans, a double click
// shows the whole span, a drag across the whole span frames a new range, the keys zoom and pan, and Ctrl with the wheel
// zooms around the pointer, telling onInput at each step and onChange once it stops; the hover tip stands under the overview, and the readout keeps the overview in place as it
// zooms; the overview draws its records in the Color by
// colours, grey with Off, one colour per pixel row; a long list gets the zoomed track at the outer edge beside the
// overview, its colours faded beyond the part in view, which lies under a lens joined to the overview's frame by two
// lines, the lens going down the zoomed track with the frame; a drag on the zoomed track scrolls the list at its scale,
// the lens following the pointer over records that hold still, and a press off the lens brings it there; hovering the
// overview previews the records there in plain rows with a straight bar. Through the real ViewerFrame, a colour picked for a label's value from its chip's swatch
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
  '--border-hairline:rgba(27,26,24,0.08);--font-body:sans-serif;--font-mono:monospace}'
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

describe("a long list's two tracks", () => {
  /** the tracks as laid out in the frame: each part's box, the lines' ends, and the frame's border */
  const tracks = (frame: () => Frame) =>
    frame().evaluate(() => {
      const box = (el: Element) => {
        const r = el.getBoundingClientRect()
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
      }
      const strip = document.querySelector('.thimble-colour-strip') as HTMLElement
      const whole = strip.querySelector('.thimble-colour-whole') as HTMLElement
      const zoom = strip.querySelector('.thimble-colour-zoom') as HTMLElement
      const thumb = whole.querySelector('.thimble-colour-thumb') as HTMLElement
      const lens = zoom.querySelector('.thimble-colour-lens') as HTMLElement
      const svg = strip.querySelector('.thimble-colour-link') as SVGSVGElement
      const sr = svg.getBoundingClientRect()
      const line = (edge: string) => {
        const l = svg.querySelector(`line[data-edge="${edge}"]`)!
        const n = (a: string) => Number(l.getAttribute(a))
        return { x1: sr.left + n('x1'), y1: sr.top + n('y1'), x2: sr.left + n('x2'), y2: sr.top + n('y2') }
      }
      const cv = zoom.querySelector('canvas') as HTMLCanvasElement
      const ctx = cv.getContext('2d')!
      const lensBox = box(lens)
      const zr = box(zoom)
      // the zoomed track's lane in the lens's middle and far from it
      const alpha = (y: number) => ctx.getImageData(Math.floor(cv.width * 0.3), Math.max(0, Math.min(cv.height - 1, Math.floor(y * (cv.height / zr.height)))), 1, 1).data[3]
      const mid = (lensBox.top + lensBox.bottom) / 2 - zr.top
      const list = document.getElementById('list')!
      return {
        zoom: getComputedStyle(zoom).display,
        whole: box(whole),
        zoomBox: zr,
        thumb: box(thumb),
        lens: lensBox,
        lensBg: getComputedStyle(lens).backgroundColor,
        radius: parseFloat(getComputedStyle(lens).borderTopLeftRadius),
        frameBorder: parseFloat(getComputedStyle(thumb).borderTopWidth),
        ring: ['top', 'right', 'bottom', 'left'].map((side) => getComputedStyle(thumb).getPropertyValue(`border-${side}-width`)),
        top: line('top'),
        bottom: line('bottom'),
        right: Math.round(list.getBoundingClientRect().right - strip.getBoundingClientRect().right),
        inView: alpha(mid),
        beyond: alpha(mid > zr.height / 2 ? 4 : zr.height - 4),
      }
    })
  const near = (a: number, b: number, tol = 1) => Math.abs(a - b) <= tol

  test('the overview at the left, the zoomed track at the edge, faded beyond the part in view under its lens, the lines joining frame and lens', async () => {
    const { page, frame } = await framed()
    const s = await tracks(frame)
    assert.equal(s.zoom, 'block')
    assert.ok(s.whole.right < s.zoomBox.left, 'the overview at the left, the zoomed track at the outer edge')
    // at the list's right edge, the lens (3px past the zoomed track) still inside it
    assert.ok(s.right >= 3 && s.right <= 6, `the tracks ${s.right}px in from the list's right edge`)
    assert.equal(s.thumb.width, s.whole.width, 'the frame around the part in view is as wide as the track')
    assert.ok(s.frameBorder >= 2, `the frame stands out: ${s.frameBorder}`)
    assert.ok(s.lens.left < s.zoomBox.left && s.lens.right > s.zoomBox.right, 'the lens a little wider than the zoomed track')
    assert.notEqual(s.lensBg, 'rgba(0, 0, 0, 0)')
    assert.ok(s.inView > 200 && s.beyond < 120, `faded beyond the part in view: ${s.inView} ${s.beyond}`)
    assert.ok(near(s.top.x1, s.whole.right) && near(s.top.y1, s.thumb.top) && near(s.top.x2, s.lens.left) && near(s.top.y2, s.lens.top + s.radius), `top line ${JSON.stringify([s.top, s.thumb, s.lens])}`)
    assert.ok(near(s.bottom.x1, s.whole.right) && near(s.bottom.y1, s.thumb.bottom) && near(s.bottom.x2, s.lens.left) && near(s.bottom.y2, s.lens.bottom - s.radius), `bottom line ${JSON.stringify([s.bottom, s.thumb, s.lens])}`)
    await page.close()
  })

  test("the lens goes down the zoomed track with the frame: at the list's top at the top, in its middle in the middle, at its end at the end", async () => {
    const { page, frame } = await framed()
    const at = async (f: number) => {
      await frame().evaluate((x) => {
        const l = document.getElementById('list')!
        l.scrollTop = x * (l.scrollHeight - l.clientHeight)
      }, f)
      // a jump: the tracks glide there, then stand still
      await page.waitForTimeout(350)
      const s = await tracks(frame)
      return { lens: (s.lens.top + 3 - s.zoomBox.top) / (s.zoomBox.height - (s.lens.height - 6)), frame: (s.thumb.top - s.whole.top) / (s.whole.height - s.thumb.height), s }
    }
    const top = await at(0)
    const mid = await at(0.5)
    const end = await at(1)
    assert.ok(near(top.lens, 0, 0.03) && near(top.frame, 0, 0.03), JSON.stringify(top))
    assert.ok(near(mid.lens, 0.5, 0.05) && near(mid.frame, 0.5, 0.05), JSON.stringify(mid))
    assert.ok(near(end.lens, 1, 0.03) && near(end.frame, 1, 0.03), JSON.stringify(end))
    assert.ok(near(end.s.top.y2, end.s.lens.top + end.s.radius) && near(end.s.bottom.y2, end.s.lens.bottom - end.s.radius) && near(end.s.bottom.y1, end.s.thumb.bottom), JSON.stringify(end.s))
    await page.close()
  })

  for (const dpr of [1, 2]) {
    test(`at a pixel ratio of ${dpr}, every edge stands on whole device pixels and each line's ends meet the corners within half a device pixel`, async () => {
      const { page, frame } = await framed(dpr)
      for (const f of [0, 0.5, 1]) {
        await frame().evaluate((x) => {
          const l = document.getElementById('list')!
          l.scrollTop = x * (l.scrollHeight - l.clientHeight)
        }, f)
        // a jump: the tracks glide there, and go onto the pixel grid once they have stood still a few frames
        await page.waitForTimeout(350)
        const s = await tracks(frame)
        const tol = 0.5 / dpr + 1e-6
        const on = (v: number) => Math.abs(v * dpr - Math.round(v * dpr)) < 1e-3
        const at = `${f} ${JSON.stringify(s)}`
        for (const v of [s.thumb.top, s.thumb.bottom, s.thumb.left, s.thumb.right, s.lens.top, s.lens.bottom, s.lens.left, s.lens.right]) assert.ok(on(v), `${v} off the grid, ${at}`)
        assert.equal(new Set(s.ring).size, 1, at)
        assert.ok(Math.abs(s.zoomBox.left - s.lens.left - 3) < 1e-3 && Math.abs(s.lens.right - s.zoomBox.right - 3) < 1e-3, at)
        const ends = [
          [s.top.x1, s.whole.right], [s.top.y1, s.thumb.top], [s.top.x2, s.lens.left], [s.top.y2, s.lens.top + s.radius],
          [s.bottom.x1, s.whole.right], [s.bottom.y1, s.thumb.bottom], [s.bottom.x2, s.lens.left], [s.bottom.y2, s.lens.bottom - s.radius],
        ]
        ends.forEach(([a, b], i) => assert.ok(Math.abs(a - b) <= tol, `end ${i}: ${a} against ${b}, ${at}`))
      }
      await page.close()
    })
  }

  test('hovering the overview previews the records there in plain rows without scrolling, and a click goes there', async () => {
    const { page, frame } = await framed()
    const tr = (await frame().locator('.thimble-colour-whole').boundingBox())!
    const zoomBefore = await tracks(frame)
    await page.mouse.move(tr.x + tr.width / 2, tr.y + tr.height * 0.75)
    await page.waitForTimeout(150)
    const peek = await frame().evaluate(() => {
      const p = document.querySelector('.thimble-colour-peek') as HTMLElement
      const row = p.querySelector('.thimble-peek-row') as HTMLElement
      return { shown: getComputedStyle(p).display, rows: [...p.querySelectorAll('.thimble-peek-row')].map((r) => r.textContent), top: document.getElementById('list')!.scrollTop, bar: getComputedStyle(row).boxShadow, radius: getComputedStyle(row).borderTopLeftRadius, swatches: p.querySelectorAll('.thimble-colour-sw').length }
    })
    assert.equal(peek.shown, 'block')
    assert.equal(peek.top, 0, 'nothing scrolls')
    assert.ok(peek.rows.length >= 3, JSON.stringify(peek))
    assert.match(peek.bar, /inset/, "a record's colour is a bar on its row's left edge")
    assert.equal(peek.radius, '0px')
    assert.equal(peek.swatches, 0)
    const zoomHover = await tracks(frame)
    assert.ok(near(zoomHover.lens.top, zoomBefore.lens.top), 'the zoomed track stays on the part in view while the overview is hovered')
    const n = Number(/message (\d+)/.exec(peek.rows[0] ?? '')?.[1])
    assert.ok(n > N * 0.65 && n < N * 0.85, `the records three quarters down: ${peek.rows}`)
    await page.mouse.down()
    await page.mouse.up()
    await page.waitForTimeout(100)
    const top = await frame().evaluate(() => { const l = document.getElementById('list')!; return (l.scrollTop + l.clientHeight / 2) / l.scrollHeight })
    assert.ok(Math.abs(top - 0.75) < 0.05, `the list goes there: ${top}`)
    await page.close()
  })
})

describe("a drag on the zoomed track", () => {
  /** The lens's top, the row of the zoomed track's canvas where the list's first half gives way to its second, the
   * list's scroll and the zoomed track's cursor. */
  const zoomed = (frame: () => Frame) =>
    frame().evaluate(() => {
      const zoom = document.querySelector('.thimble-colour-zoom') as HTMLElement
      const cv = zoom.querySelector('canvas') as HTMLCanvasElement
      const data = cv.getContext('2d')!.getImageData(Math.floor(cv.width / 2), 0, 1, cv.height).data
      // the first device row whose colour is more red than blue: the With links records' orange after the blue
      let edge = -1
      for (let y = 0; y < cv.height; y++) if (data[y * 4 + 3] > 0 && data[y * 4] > data[y * 4 + 2] + 40) {
        edge = y / (window.devicePixelRatio || 1)
        break
      }
      const list = document.getElementById('list')!
      const lens = zoom.querySelector('.thimble-colour-lens')!.getBoundingClientRect()
      return { lens: lens.top, lensH: lens.height, zoomTop: zoom.getBoundingClientRect().top, zoomH: zoom.getBoundingClientRect().height, edge, top: list.scrollTop, view: list.clientHeight, height: list.scrollHeight, cursor: getComputedStyle(zoom).cursor }
    })

  test("a drag on the lens scrolls the list at the zoomed track's scale: the lens follows the pointer over records that hold still", async () => {
    const { page, frame } = await framed()
    // the list's middle a view and a half below the part in view, so that the zoomed track shows where the first half
    // gives way to the second, below the lens as it goes up
    await frame().evaluate(() => {
      const l = document.getElementById('list')!
      l.scrollTop = l.scrollHeight / 2 - 2.5 * l.clientHeight
    })
    await page.waitForTimeout(250)
    const before = await zoomed(frame)
    assert.equal(before.cursor, 'grab', 'the zoomed track says it can be dragged')
    assert.ok(before.edge > 0, `the zoomed track shows the change of value: ${JSON.stringify(before)}`)
    const lens = (await frame().locator('.thimble-colour-lens').boundingBox())!
    const x = lens.x + lens.width / 2
    const y = lens.y + lens.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    for (let i = 1; i <= 15; i++) await page.mouse.move(x, y - 2 * i)
    await page.waitForTimeout(80)
    const during = await zoomed(frame)
    assert.equal(during.cursor, 'grabbing')
    assert.ok(Math.abs(during.lens - (before.lens - 30)) <= 1, `the lens follows the pointer: ${before.lens} → ${during.lens}`)
    assert.ok(Math.abs(during.edge - before.edge) <= 1, `the records hold still under it: ${before.edge} → ${during.edge}`)
    // 30 px of the zoomed track, which holds five of the list's heights: five times 30 px of the list, about
    const scale = (5 * before.view) / before.zoomH
    assert.ok(Math.abs(during.top - before.top + 30 * scale) <= 2 * scale, `the list scrolled ${during.top - before.top}, wanted ${-30 * scale}`)
    await page.mouse.up()
    // let go, the lens glides back to where the frame puts it: as far down the zoomed track as the list now stands
    await page.waitForTimeout(400)
    const after = await zoomed(frame)
    assert.equal(after.cursor, 'grab')
    const back = before.lens + ((after.top - before.top) / (before.height - before.view)) * (before.zoomH - (before.lensH - 6))
    assert.ok(Math.abs(after.lens - back) <= 1.5, `the lens back with the frame: ${before.lens} → ${after.lens}, wanted ${back}`)
    await page.close()
  })

  test('a press on the zoomed track off the lens brings the lens there, and a drag goes on from there', async () => {
    const { page, frame } = await framed()
    const lens = (await frame().locator('.thimble-colour-lens').boundingBox())!
    const before = await zoomed(frame)
    const x = lens.x + lens.width / 2
    const y = lens.y + lens.height + 50
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.waitForTimeout(80)
    const pressed = (await frame().locator('.thimble-colour-lens').boundingBox())!
    assert.ok(Math.abs(pressed.y + pressed.height / 2 - y) <= 1, `the lens's middle at ${pressed.y + pressed.height / 2}, the pointer at ${y}`)
    for (let i = 1; i <= 10; i++) await page.mouse.move(x, y + i)
    await page.waitForTimeout(80)
    const dragged = (await frame().locator('.thimble-colour-lens').boundingBox())!
    assert.ok(Math.abs(dragged.y - (pressed.y + 10)) <= 1, `the drag goes on: ${pressed.y} → ${dragged.y}`)
    const scale = (5 * before.view) / before.zoomH
    const top = await frame().evaluate(() => document.getElementById('list')!.scrollTop)
    assert.ok(Math.abs(top - before.top - (y + 10 - (lens.y + lens.height / 2)) * scale) <= 2 * scale, `the list scrolled ${top - before.top}`)
    await page.mouse.up()
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
