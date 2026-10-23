// The view kit's time range selector (backend/app/viewer_range.js) and a list's strip (viewer_colour.js) in a real
// browser, a page holding the view in a sandboxed frame: the viewfinder's edge zooms, its middle pans and a double click
// shows the whole span; the wheel tells onInput at each step and onChange once it stops; the overview draws its records
// in the Color by colours, the one series color with Off; resting on a long list's strip opens the loupe beside it, a
// line per record around the pointer with its line, its colour's cell and its text. Through the real ViewerFrame, a
// colour picked for a label's value from its chip's swatch goes to thimble as the label's colour. What the selector
// decides without layout is tests/public/range-kit.test.ts.
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
  ':root{--label-1:#025ac3;--label-2:#d0750a;--label-3:#08632f;--label-none:#a09c93;--viz-1:#5e4bd6;--ink-rgb:27,26,24;--surface-card:#fffdf8;' +
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
window.colour = thimble.colorBy({ mount: '#colour', fields: [{ name: 'kind', title: 'Kind', values: ['Text only', 'With links'] }], initial: 'kind', strip: '#list', onChange: draw })
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

  test('the overview draws its records in the Color by colours, and in the one series color with Off', async () => {
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
    assert.deepEqual(a, b, 'one color for every record')
    assert.deepEqual(a, [94, 75, 214], 'the one series color, as a chart of one series')
    assert.equal(await frame().locator('.thimble-colour-chip').count(), 0)
    await page.close()
  })

})

describe("a long list's strip and its loupe", () => {
  /** the loupe as drawn: whether open, naming one record or held still, its rows (line, cells, time, text, tints),
   * its box beside the strip, the bracket and the list's scroll */
  const loupe = (frame: () => Frame) =>
    frame().evaluate(() => {
      const el = document.querySelector('.thimble-colour-loupe') as HTMLElement
      const box = el.querySelector('.thimble-colour-loupe-box') as HTMLElement
      const rows = [...el.querySelectorAll('.thimble-colour-loupe-row')].map((r) => {
        const who = [...r.querySelectorAll('.thimble-colour-loupe-m')].map((m) => m.textContent).join('')
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
