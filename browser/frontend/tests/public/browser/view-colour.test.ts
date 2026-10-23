// The view kit's Colour by (backend/app/viewer_colour.js) in a real browser: a page holds a view in a sandboxed frame,
// and the bridge draws the chosen value's colour as a bar on each record's left edge and each chip shows it as a square;
// the coloured scrollbar shows where each value's records are and scrolls the list; a value turned off keeps its
// records without the bar; chips that do not fit go behind "N more"; two labels chosen are two lanes. Through the real
// ViewerFrame the choice is kept per view and the page starts on it when it is built again. What the control decides
// without layout is tests/public/colour-kit.test.ts.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, test } from 'vitest'
import type { Browser, Frame, Page } from 'playwright'
import { bundle, cleanup, FRONTEND, launch, ORIGIN, src } from './page.ts'

const APP = path.join(FRONTEND, '..', 'backend', 'app')
const read = (name: string) => readFileSync(path.join(APP, name), 'utf8')
const inline = (js: string) => js.replace(/<\/script/g, '<\\/script')
const BRIDGE = inline(read('viewer_bridge.js'))
// the kit's Color by, after the order new values take the palette in, which views.frame_document puts before it
const COLOUR = `window.__thimbleLabelOrder = ${read('label_order.json')}\n` + inline(read('viewer_colour.js'))
const KIT = read('viewer_kit.css')
const TOKENS =
  ':root{--label-1:#025ac3;--label-2:#d0750a;--label-3:#08632f;--label-13:#d0342c;--label-none:#a09c93;--ink-rgb:27,26,24;--surface-card:#fffdf8;' +
  '--text-primary:#000;--text-secondary:#4a4844;--text-tertiary:#726f69;--accent:#5135ff;--radius-chip:4px;--radius-ui:6px;' +
  '--h-row:28px;--control-sm:28px;--h-control:24px;--h-chip:20px;--text-xs:12px;--text-ui-sm:12px;--text-mono-sm:11px;--border-subtle:rgba(27,26,24,0.12);' +
  '--font-body:sans-serif;--font-mono:monospace}'
// sixty messages, the last ten With links, in a list that scrolls
const ROWS = Array.from({ length: 60 }, (_, i) => `<div class="msg" data-anchor="m.jsonl#L${i + 1}" data-colour="${i < 50 ? 'Text only' : 'With links'}">message ${i + 1}</div>`).join('')
const view = (kept?: unknown) => `<!doctype html><html><head><style>${TOKENS} body{margin:0;font:12px sans-serif} .top{display:flex;align-items:center;gap:8px;padding:8px} #list{height:300px;overflow:auto} .msg{box-sizing:border-box;height:30px;padding:6px 8px 0 12px}</style>
${kept ? `<script>window.__thimbleColour = ${JSON.stringify(kept)}</script>` : ''}<script>${BRIDGE}</script><script>${COLOUR}</script><style>${KIT}</style></head><body>
<div class="top"><input style="width:120px"><span id="colour"></span></div><div id="list">${ROWS}</div>
<script>window.colour = thimble.colourBy({ mount: '#colour', initial: 'kind', fields: [{ name: 'kind', title: 'Kind', values: ['Text only', 'With links'] }], strip: '#list' })</script>
</body></html>`

let browser: Browser

beforeAll(async () => {
  browser = await launch()
})
afterAll(async () => {
  await browser?.close()
  cleanup()
})

/** A page that holds the view in a sandboxed frame `width` px wide, as ViewerFrame does, the page starting on what
 * thimble kept for it (`kept`); what the view asks thimble to keep is collected in window.__kept. */
async function framed(width = 700, kept?: unknown): Promise<{ page: Page; frame: () => Frame }> {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } })
  await page.setContent(`<!doctype html><html><body style="margin:0"><iframe id="f" sandbox="allow-scripts" style="border:0;width:${width}px;height:400px"></iframe></body></html>`)
  await page.evaluate(() => {
    const w = window as unknown as { __kept: unknown[] }
    w.__kept = []
    window.addEventListener('message', (e) => e.data && e.data.type === 'thimble:colour' && w.__kept.push(e.data.state))
  })
  await page.evaluate((doc) => ((document.getElementById('f') as HTMLIFrameElement).srcdoc = doc), view(kept))
  const frame = () => page.frames().find((f) => f !== page.mainFrame())!
  await page.waitForFunction(() => document.getElementById('f') && (document.getElementById('f') as HTMLIFrameElement).contentWindow)
  await page.waitForTimeout(300)
  await frame().waitForSelector('.thimble-colour-chip', { state: 'attached' })
  await frame().waitForFunction(() => document.querySelectorAll('[data-thimble-colour]').length === 60)
  return { page, frame }
}

describe('Colour by in a frame', () => {
  test("each record's value is a bar on its left edge, and each chip's a square swatch before its name", async () => {
    const { page, frame } = await framed()
    const s = await frame().evaluate(() => ({
      first: getComputedStyle(document.querySelector('[data-anchor="m.jsonl#L1"]')!).boxShadow,
      last: getComputedStyle(document.querySelector('[data-anchor="m.jsonl#L60"]')!).boxShadow,
      chips: [...document.querySelectorAll('.thimble-colour-chip')].map((c) => {
        const sw = getComputedStyle(c.querySelector('.chip-sw')!)
        const cs = getComputedStyle(c)
        return [c.textContent ?? '', sw.backgroundColor, `${sw.width} ${sw.height}`, cs.color, cs.borderRadius, cs.height]
      }),
    }))
    assert.match(s.first, /rgb\(2, 90, 195\) 3px 0px 0px 0px inset/, 'the first value takes the first palette colour, inside the padding')
    assert.match(s.last, /rgb\(208, 117, 10\) 3px 0px 0px 0px inset/)
    assert.deepEqual(s.chips.map((c) => c[0]), ['Text only50', 'With links10'])
    assert.equal(s.chips[0][1], 'rgb(2, 90, 195)', "the chip's swatch, not its text, carries the colour")
    assert.equal(s.chips[0][2], '8px 8px', 'the swatch is a square')
    assert.equal(s.chips[0][3], 'rgb(74, 72, 68)', "the chip's text stays a text colour")
    assert.deepEqual([s.chips[0][4], s.chips[0][5]], ['4px', '24px'], "thimble's chip corners, a control's height")
    await page.close()
  })

  test('the coloured scrollbar shows where each value is, follows the list and scrolls it', async () => {
    const { page, frame } = await framed()
    const strip = await frame().evaluate(() => {
      const el = document.querySelector('.thimble-colour-strip') as HTMLElement
      const cv = el.querySelector('canvas') as HTMLCanvasElement
      const ctx = cv.getContext('2d')!
      const at = (f: number) => [...ctx.getImageData(Math.floor(cv.width / 2), Math.floor(cv.height * f), 1, 1).data].slice(0, 3)
      const list = document.getElementById('list')!
      const r = list.getBoundingClientRect()
      const s = el.getBoundingClientRect()
      return { top: at(0.3), bottom: at(0.95), right: Math.round(r.right - s.right), height: Math.round(s.height), listHeight: Math.round(r.height), native: getComputedStyle(list).scrollbarWidth }
    })
    assert.deepEqual(strip.top, [2, 90, 195], 'the Text only records fill the top five sixths')
    assert.deepEqual(strip.bottom, [208, 117, 10], 'the With links records the last sixth')
    assert.ok(strip.right >= 0 && strip.right <= 4 && strip.listHeight - strip.height <= 4, `it stands at the list's right edge, its height (${JSON.stringify(strip)})`)
    assert.equal(strip.native, 'none', "the list's own scrollbar gives way to it")
    const thumb = () => frame().evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector('.thimble-colour-thumb')!).transform).m42)
    assert.equal(await thumb(), 0)
    await frame().evaluate(() => (document.getElementById('list')!.scrollTop = 99999))
    await page.waitForTimeout(100)
    assert.ok((await thumb()) > 200, 'the thumb frames the end of the list')
    // a press on the track's top takes the list back there
    const box = (await frame().locator('.thimble-colour-strip').boundingBox())!
    await page.mouse.click(box.x + box.width / 2, box.y + 5)
    await page.waitForTimeout(100)
    assert.ok((await frame().evaluate(() => document.getElementById('list')!.scrollTop)) < 300)
    await page.close()
  })

  test('a value turned off keeps its records, neither hidden nor dimmed, without the bar, and in grey on the scrollbar', async () => {
    const { page, frame } = await framed()
    await frame().locator('.thimble-colour-chip').nth(1).click()
    await page.waitForTimeout(200)
    const s = await frame().evaluate(() => {
      const cv = document.querySelector('.thimble-colour-strip canvas') as HTMLCanvasElement
      const px = [...cv.getContext('2d')!.getImageData(Math.floor(cv.width / 2), Math.floor(cv.height * 0.95), 1, 1).data]
      const last = document.querySelector('[data-anchor="m.jsonl#L60"]') as HTMLElement
      const cs = getComputedStyle(last)
      return {
        opacity: cs.opacity, display: cs.display, height: last.getBoundingClientRect().height, shadow: cs.boxShadow, bar: last.hasAttribute('data-thimble-bar'),
        first: last.parentElement!.children.length, px, plain: document.querySelector('.thimble-colour-strip')!.hasAttribute('data-plain'),
        pressed: document.querySelectorAll('.thimble-colour-chip')[1].getAttribute('aria-pressed'),
      }
    })
    assert.deepEqual([s.opacity, s.display, s.height, s.pressed, s.first], ['1', 'block', 30, 'false', 60])
    assert.equal(s.bar, false)
    assert.doesNotMatch(s.shadow, /208, 117, 10/)
    // drawn in grey on the scrollbar, which keeps its colours: no orange, a grey that is drawn
    assert.equal(s.plain, false)
    const [r, g, b, a] = s.px
    assert.ok(a > 0 && Math.max(r, g, b) - Math.min(r, g, b) <= 6 && !(r === 208 && g === 117), JSON.stringify(s.px))
    await page.close()
  })

  test('chips that do not fit the row go behind "N more", which lists them with what a chip offers: its toggle and its color', async () => {
    const { page, frame } = await framed(330)
    const s = await frame().evaluate(() => ({
      shown: [...document.querySelectorAll<HTMLElement>('.thimble-colour-chip')].filter((c) => !c.hidden).length,
      more: (document.querySelector('.thimble-colour-more') as HTMLElement).hidden ? null : document.querySelector('.thimble-colour-more')!.textContent,
      wide: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    }))
    assert.ok(s.shown < 2 && s.more === `${2 - s.shown} more`, JSON.stringify(s))
    assert.ok(s.wide, 'the row does not overflow the page')
    await frame().locator('.thimble-colour-more').click()
    // the values it hides, each with its box and its swatch
    const hidden = ['Text only', 'With links'].slice(s.shown)
    assert.deepEqual(await frame().locator('.thimble-colour-menu .thimble-colour-nm').allTextContents(), hidden)
    const last = hidden.at(-1)!
    const item = frame().locator('.thimble-colour-menu .thimble-colour-val', { hasText: last })
    // its swatch opens the picker under it, in the menu; a color picked recolors the value and the menu stays
    await item.locator('[data-palette]').click()
    assert.equal(await frame().locator('.thimble-colour-menu .thimble-colour-inpick [data-pick]').count(), 18)
    await frame().locator('.thimble-colour-menu .thimble-colour-inpick [data-pick="12"]').click()
    await page.waitForTimeout(150)
    assert.equal(await frame().evaluate((v) => (window as any).colour.colourOf(v), last), 'rgb(208, 52, 44)', 'red, picked')
    assert.equal(await frame().locator('.thimble-colour-menu').count(), 1, 'the menu stays open')
    // its box turns it off
    await frame().locator('.thimble-colour-menu .thimble-colour-val', { hasText: last }).click()
    await page.waitForTimeout(150)
    assert.equal(await frame().evaluate((v) => (window as any).colour.isOn(v), last), false)
    await page.close()
  })
})

describe('Colour by through ViewerFrame', () => {
  test('the choice is kept per view, and the page built again starts on it', async () => {
    const script = await bundle('view-colour', [
      `import { createElement } from 'react'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { ViewerFrame } from '${src('files/ViewerFrame.tsx')}'`,
      `const root = createRoot(document.body.appendChild(document.createElement('div')))`,
      `let n = 0`,
      `window.__mount = () => root.render(createElement('div', { key: ++n, style: { width: '700px', height: '400px' } }, createElement(ViewerFrame, { ws: 'w', slug: 'board', title: 'Board', labels: [] })))`,
      `window.__mount()`,
    ])
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } })
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname === '/api/ws/w/views/board/frame') return route.fulfill({ status: 200, contentType: 'text/html', body: view() })
      if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>' })
    })
    await page.goto(`${ORIGIN}/`)
    await page.addStyleTag({ content: 'iframe{width:700px;height:400px;border:0}' })
    await page.addScriptTag({ path: script })
    const frame = () => page.frames().find((f) => f !== page.mainFrame())!
    await page.waitForFunction(() => document.querySelector('iframe'))
    await page.waitForTimeout(500)
    await frame().waitForSelector('.thimble-colour-chip')
    await frame().locator('.thimble-colour-chip').first().click()
    // the colours the values took are kept as soon as the page counts them; the chip turned off comes after
    await page.waitForFunction(() => (localStorage.getItem('thimble:w:view-colour:board') ?? '').includes('"off":{"f:kind"'))
    const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('thimble:w:view-colour:board')!))
    assert.deepEqual([kept.by ?? null, kept.off], [null, { 'f:kind': ['Text only'] }])
    await page.evaluate(() => (window as any).__mount())
    await page.waitForTimeout(500)
    await frame().waitForSelector('.thimble-colour-chip')
    await page.waitForTimeout(200)
    assert.deepEqual(await frame().locator('.thimble-colour-chip').evaluateAll((cs) => cs.map((c) => c.getAttribute('aria-pressed'))), ['false', 'true'])
    await page.close()
  })
})

/** A view of its own, `body` its records and `script` what it runs, held in a sandboxed frame `width` px wide. */
async function own(body: string, script: string, width = 700, kept?: unknown): Promise<{ page: Page; frame: () => Frame }> {
  const doc = `<!doctype html><html><head><style>${TOKENS} body{margin:0;font:12px sans-serif} .top{display:flex;align-items:center;gap:8px;padding:8px} #list{height:300px;overflow:auto} .msg{box-sizing:border-box;height:30px;padding:6px 8px 0 12px}</style>
${kept ? `<script>window.__thimbleColour = ${JSON.stringify(kept)}</script>` : ''}<script>${BRIDGE}</script><script>${COLOUR}</script><style>${KIT}</style></head><body>
<div class="top"><input style="width:120px"><span id="colour"></span></div><div id="list">${body}</div><script>${script}</script></body></html>`
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } })
  await page.setContent(`<!doctype html><html><body style="margin:0"><iframe id="f" sandbox="allow-scripts" style="border:0;width:${width}px;height:400px"></iframe></body></html>`)
  await page.evaluate((d) => ((document.getElementById('f') as HTMLIFrameElement).srcdoc = d), doc)
  const frame = () => page.frames().find((f) => f !== page.mainFrame())!
  await page.waitForTimeout(300)
  await frame().waitForSelector('.thimble-colour-by', { state: 'attached' })
  return { page, frame }
}

describe("a lane of the tracks for each of Color by's choices past the first", () => {
  // sixty messages: "Passed on" (k1, orange) marks messages 5 to 10, "Links" (k2, green) messages 40 to 45
  const mark = (id: string, name: string, colour: string) => ({ values: [{ id, label: name, value: 'yes', colour }], names: [name], bar: colour })
  const marks: Record<string, unknown> = {}
  for (let i = 5; i <= 10; i++) marks[`m.jsonl#L${i}`] = mark('k1', 'Passed on', '#d0750a')
  for (let i = 40; i <= 45; i++) marks[`m.jsonl#L${i}`] = mark('k2', 'Links', '#08632f')
  const label = (id: string, name: string, colour: string) => ({ id, name, colour, values: [{ name: 'yes', colour }] })
  const both = [label('k1', 'Passed on', '#d0750a'), label('k2', 'Links', '#08632f')]
  const msg = (on: typeof both) => ({ type: 'thimble:labels', marks, on, filter: null, all: both.map((l) => ({ ...l, on: on.some((o) => o.id === l.id), here: true, values: [{ name: 'yes', colour: l.colour, highlight: true }], count: 6 })) })
  /** the overview's lanes: their names, widths, and the colour each draws a share down the track */
  const lanes = (frame: () => Frame) =>
    frame().evaluate(() => {
      const whole = document.querySelector('.thimble-colour-whole') as HTMLElement
      const cv = whole.querySelector('canvas') as HTMLCanvasElement
      const ctx = cv.getContext('2d')!
      const dpr = window.devicePixelRatio || 1
      const marks = [...whole.querySelectorAll('.thimble-colour-lane')].map((e) => ({ left: (e as HTMLElement).offsetLeft, width: (e as HTMLElement).offsetWidth, title: e.getAttribute('title') }))
      const at = (left: number, w: number, f: number) => Array.from(ctx.getImageData(Math.floor((left + w / 2) * dpr), Math.floor(f * cv.height), 1, 1).data.slice(0, 3)).join(',')
      const cols = marks.length ? marks : [{ left: 0, width: whole.offsetWidth, title: null }]
      return { width: whole.offsetWidth, marks, at: cols.map((m) => [at(m.left, m.width, 7.5 / 60), at(m.left, m.width, 42.5 / 60)]) }
    })
  const ORANGE = '208,117,10'
  const GREEN = '8,99,47'

  test('two labels chosen are two lanes, each in its own colours and named on hover; one turned off leaves one lane', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => `<div class="msg" data-anchor="m.jsonl#L${i + 1}">message ${i + 1}</div>`).join('')
    const { page, frame } = await own(rows, `window.colour = thimble.colorBy({ mount: '#colour', initial: 'kind', fields: [{ name: 'kind', title: 'Kind' }], strip: '#list' })`, 700, { v: 1, by: 'l:k1', picks: ['l:k1', 'l:k2'], seen: ['k1', 'k2'] })
    const post = (m: unknown) => page.evaluate((x) => (document.getElementById('f') as HTMLIFrameElement).contentWindow!.postMessage(x, '*'), m)
    await post(msg(both))
    await frame().waitForFunction(() => document.querySelectorAll('.thimble-colour-lane').length === 2)
    await page.waitForTimeout(200)
    const two = await lanes(frame)
    assert.deepEqual(two.marks.map((m) => m.title), ['Passed on', 'Links'], 'each lane names its label on hover')
    assert.ok(two.marks.every((m) => m.width >= 3 && m.width <= 12) && two.width <= 25, `the lanes narrower: ${JSON.stringify(two)}`)
    assert.equal(two.at[0][0], ORANGE, 'the first lane, the choice, orange where "Passed on" marks')
    assert.equal(two.at[1][1], GREEN, 'the second lane green where "Links" marks')
    assert.ok(two.at[0][1] !== GREEN && two.at[1][0] !== ORANGE, `each lane only its label: ${JSON.stringify(two.at)}`)
    // "Links" turned off: one lane, "Passed on"
    await post(msg([both[0]]))
    await frame().waitForFunction(() => document.querySelectorAll('.thimble-colour-lane').length === 0)
    await page.waitForTimeout(200)
    const one = await lanes(frame)
    assert.equal(one.width, 13, 'one lane, 7 px wide, 3 px in from the strip\'s edges')
    assert.equal(one.at[0][0], ORANGE)
    assert.notEqual(one.at[0][1], GREEN)
    await page.close()
  })

})
