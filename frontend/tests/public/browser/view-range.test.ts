// The view kit's time range selector (backend/app/viewer_range.js) and a list's two tracks (viewer_colour.js) in a real
// browser, a page holding the view in a sandboxed frame: the viewfinder's edge zooms, its middle pans, a double click
// shows the whole span and Ctrl with the wheel zooms around the pointer; the overview draws its records in the Color by
// colours, grey with Off, one colour per pixel row; a long list gets the zoomed track at the outer edge beside the
// overview, its colours faded beyond the part in view, which lies under a lens joined to the overview's frame by two
// lines, the lens going down the zoomed track with the frame; hovering the overview previews the records there in plain
// rows with a straight bar. Through the real ViewerFrame, a colour picked for a label's value from its chip's swatch
// goes to thimble as the label's colour, and a label's definition opens
// in Color by's menu from thimble's own answer, and Open label opens thimble's label editor. What the selector decides
// without layout is tests/public/range-kit.test.ts.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, test } from 'vitest'
import type { Browser, Frame, Page } from 'playwright'
import { bundle, cleanup, FRONTEND, launch, ORIGIN, src } from './page.ts'

const APP = path.join(FRONTEND, '..', 'backend', 'app')
const read = (name: string) => readFileSync(path.join(APP, name), 'utf8')
const inline = (js: string) => js.replace(/<\/script/g, '<\\/script')
const KIT = `<script>${inline(read('viewer_bridge.js'))}</script><script>${inline(read('viewer_colour.js'))}</script><script>${inline(read('viewer_range.js'))}</script><style>${read('viewer_kit.css')}</style>`
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

async function framed(dpr = 1): Promise<{ page: Page; frame: () => Frame }> {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 }, deviceScaleFactor: dpr })
  await page.setContent(`<!doctype html><html><body style="margin:0"><iframe id="f" sandbox="allow-scripts" style="border:0;width:800px;height:420px"></iframe></body></html>`)
  await page.evaluate((doc) => ((document.getElementById('f') as HTMLIFrameElement).srcdoc = doc), VIEW)
  const frame = () => page.frames().find((f) => f !== page.mainFrame())!
  await page.waitForTimeout(300)
  await frame().waitForSelector('.thimble-range-win', { state: 'attached' })
  await frame().waitForFunction(() => document.querySelectorAll('[data-thimble-colour]').length > 0)
  await page.waitForTimeout(150)
  return { page, frame }
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
      await page.waitForTimeout(80)
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
        await page.waitForTimeout(80)
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
    await page.addStyleTag({ content: 'iframe{width:800px;height:420px;border:0} :root{' + Array.from({ length: 12 }, (_, i) => `--label-${i + 1}:#${(0x204060 + i * 0x0b0907).toString(16).slice(-6)};`).join('') + '--label-none:#a09c93}' })
    await page.addScriptTag({ path: script })
    const frame = () => page.frames().find((f) => f !== page.mainFrame())!
    await page.waitForFunction(() => document.querySelector('iframe'))
    await page.waitForTimeout(500)
    await frame().waitForSelector('.thimble-colour-chip[data-label="k1"]')
    await frame().locator('.thimble-colour-chip').first().locator('.chip-sw').click()
    await frame().waitForSelector('.thimble-colour-palette')
    assert.equal(await frame().locator('.thimble-colour-palette .thimble-colour-pick').count(), 12)
    const on = await frame().evaluate(() => [...document.querySelectorAll('.thimble-colour-palette .thimble-colour-pick')].findIndex((b) => b.classList.contains('on')))
    assert.equal(on, 1, "the value's own colour, thimble's second, is ringed")
    assert.equal(await frame().locator('.thimble-colour-palette [data-reset-colours]').count(), 0, "a label's colours are the label's own, with no Reset here")
    await frame().locator('.thimble-colour-palette .thimble-colour-pick').nth(4).click()
    await page.waitForFunction(() => (window as any).__acts.length > 0)
    assert.deepEqual(await page.evaluate(() => (window as any).__acts), [['colour', 'k1', 'yes', 5]])
    await page.close()
  })
})

describe("a label's definition through ViewerFrame", () => {
  test("opens in Color by's menu from thimble's answer, and Open label opens the label's editor", async () => {
    const DEF = { id: 'k1', name: 'asks', kind: 'prompt', text: 'Does the message ask another agent for something? yes = it asks. no = it does not.', spec: '', scope: 'm.jsonl', unit: 'record', labeled: 400, values: [{ name: 'yes', highlight: true, n: 40, meaning: 'it asks' }, { name: 'no', highlight: false, n: 360, meaning: 'it does not' }] }
    const script = await bundle('view-range-def', [
      `import { createElement } from 'react'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { ViewerFrame } from '${src('files/ViewerFrame.tsx')}'`,
      `const w = window`,
      `w.__acts = []`,
      `const k = { id: 'k1', name: 'asks', description: '', unit: 'record', kind: 'prompt', spec: '', labels: ['yes', 'no'], created_by: 'analyst', ts: '', classes: [{ name: 'yes', color: 2, highlight: true }, { name: 'no', color: 0, highlight: false }], shown: false }`,
      `const root = document.body.appendChild(document.createElement('div'))`,
      `root.style.cssText = 'width:800px;height:420px'`,
      `createRoot(root).render(createElement(ViewerFrame, { ws: 'w', slug: 'board', title: 'Board', byId: new Map([[k.id, k]]), labels: [], labelActions: { edit: (id) => w.__acts.push(['edit', id]) } }))`,
    ])
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } })
    const asked: unknown[] = []
    await page.route('**/*', async (route) => {
      const req = route.request()
      const url = new URL(req.url())
      if (url.pathname === '/api/ws/w/views/board/frame') return route.fulfill({ status: 200, contentType: 'text/html', body: VIEW })
      if (url.pathname === '/api/ws/w/views/board/records') {
        const q = JSON.parse(req.postData() || '{}').query
        asked.push(q)
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
    await frame().waitForSelector('.thimble-colour-by')
    await frame().locator('.thimble-colour-by').click()
    await frame().locator('.thimble-colour-menu [data-info="k1"]').click()
    await frame().waitForSelector('.thimble-colour-menu .thimble-def-text')
    assert.deepEqual(asked, [{ $thimble: 'label', id: 'k1' }], 'one fetch, which thimble answers itself')
    const def = await frame().evaluate(() => {
      const d = document.querySelector('.thimble-colour-menu .thimble-def')!
      return { text: d.querySelector('.thimble-def-text')!.textContent, values: [...d.querySelectorAll('.thimble-def-val')].map((v) => v.textContent), n: d.querySelector('.thimble-def-n')!.textContent }
    })
    assert.equal(def.text, DEF.text)
    assert.deepEqual(def.values, ['yes40it asks', 'no360it does not'])
    assert.equal(def.n, '400 records')
    await frame().locator('.thimble-colour-menu [data-open-label="k1"]').click()
    await page.waitForFunction(() => (window as any).__acts.length > 0)
    assert.deepEqual(await page.evaluate(() => (window as any).__acts), [['edit', 'k1']])
    await page.close()
  })
})
