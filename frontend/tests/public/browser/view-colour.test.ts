// The view kit's Colour by (backend/app/viewer_colour.js) in a real browser: a page holds a view in a sandboxed frame,
// and the bridge draws the chosen value's colour as a bar on each record's left edge and each chip shows it as a square;
// the coloured scrollbar shows where each value's records are, each pixel row in the value most of its records have,
// and scrolls the list; chips that do not fit go behind
// "N more". Through the real ViewerFrame
// the choice is kept per view and the page starts on it when it is built again. What the control decides without
// layout is tests/public/colour-kit.test.ts.
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
  ':root{--label-1:#025ac3;--label-2:#d0750a;--label-3:#08632f;--label-none:#a09c93;--ink-rgb:27,26,24;--surface-card:#fffdf8;' +
  '--text-primary:#000;--text-secondary:#4a4844;--text-tertiary:#726f69;--accent:#5135ff;--radius-chip:4px;--radius-ui:6px;' +
  '--h-row:28px;--control-sm:28px;--h-control:24px;--h-chip:20px;--text-xs:12px;--text-ui-sm:12px;--text-mono-sm:11px;--border-subtle:rgba(27,26,24,0.12);' +
  '--font-body:sans-serif;--font-mono:monospace}'
// sixty messages, the last ten With links, in a list that scrolls
const ROWS = Array.from({ length: 60 }, (_, i) => `<div class="msg" data-anchor="m.jsonl#L${i + 1}" data-colour="${i < 50 ? 'Text only' : 'With links'}">message ${i + 1}</div>`).join('')
const view = (kept?: unknown) => `<!doctype html><html><head><style>${TOKENS} body{margin:0;font:12px sans-serif} .top{display:flex;align-items:center;gap:8px;padding:8px} #list{height:300px;overflow:auto} .msg{box-sizing:border-box;height:30px;padding:6px 8px 0 12px}</style>
${kept ? `<script>window.__thimbleColour = ${JSON.stringify(kept)}</script>` : ''}<script>${BRIDGE}</script><script>${COLOUR}</script><style>${KIT}</style></head><body>
<div class="top"><input style="width:120px"><span id="colour"></span></div><div id="list">${ROWS}</div>
<script>window.colour = thimble.colourBy({ mount: '#colour', fields: [{ name: 'kind', title: 'Kind', values: ['Text only', 'With links'] }], strip: '#list' })</script>
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

  test('a list that draws only the rows in view gives every row its value, and the scrollbar draws those', async () => {
    const { page, frame } = await framed()
    // the page says the list holds 1,000 rows, the last tenth With links, though it shows only sixty
    await frame().evaluate(() => (window as any).colour.strip('#list', { rows: Array.from({ length: 1000 }, (_, i) => (i < 900 ? 'Text only' : 'With links')) }))
    await page.waitForTimeout(150)
    const px = await frame().evaluate(() => {
      const cv = document.querySelector('.thimble-colour-strip canvas') as HTMLCanvasElement
      const at = (f: number) => [...cv.getContext('2d')!.getImageData(Math.floor(cv.width / 2), Math.floor(cv.height * f), 1, 1).data].slice(0, 3)
      return { mid: at(0.85), end: at(0.97), strips: document.querySelectorAll('.thimble-colour-strip').length }
    })
    assert.deepEqual(px, { mid: [2, 90, 195], end: [208, 117, 10], strips: 1 }, 'the rows given, not the sixty drawn, and still one scrollbar')
    await page.close()
  })

  test("each pixel row of the scrollbar takes the one value most of its records have", async () => {
    const { page, frame } = await framed()
    // 1,000 rows, three to a pixel row: in the first half two of every three Text only, in the second two of three With links
    await frame().evaluate(() => (window as any).colour.strip('#list', { rows: Array.from({ length: 1000 }, (_, i) => ((i < 500) === (i % 3 !== 0) ? 'Text only' : 'With links')) }))
    await page.waitForTimeout(150)
    const rows = await frame().evaluate(() => {
      const cv = document.querySelector('.thimble-colour-strip canvas') as HTMLCanvasElement
      const data = cv.getContext('2d')!.getImageData(Math.floor(cv.width / 2), 0, 1, cv.height).data
      const out: string[] = []
      for (let y = 0; y < cv.height; y++) out.push([data[y * 4], data[y * 4 + 1], data[y * 4 + 2]].join(','))
      return out
    })
    const half = Math.floor(rows.length / 2)
    const text = '2,90,195'
    const links = '208,117,10'
    assert.equal(rows.slice(2, half - 2).filter((c) => c !== text).length, 0, 'the first half all Text only')
    assert.equal(rows.slice(half + 2, rows.length - 2).filter((c) => c !== links).length, 0, 'the second half all With links')
    await page.close()
  })

  test("the records with no value are the marks' grey on the scrollbar, under any value's colour, and leave it when their chip is off", async () => {
    const { page, frame } = await framed()
    // 1,000 rows: the first half take no value, but every tenth of them is With links; the second half Text only
    await frame().evaluate(() => (window as any).colour.strip('#list', { rows: Array.from({ length: 1000 }, (_, i) => (i < 500 ? (i % 10 === 0 ? 'With links' : null) : 'Text only')) }))
    await page.waitForTimeout(150)
    const rows = () =>
      frame().evaluate(() => {
        const cv = document.querySelector('.thimble-colour-strip canvas') as HTMLCanvasElement
        const data = cv.getContext('2d')!.getImageData(Math.floor(cv.width / 2), 0, 1, cv.height).data
        const out: string[] = []
        for (let y = 0; y < cv.height; y++) out.push([data[y * 4], data[y * 4 + 1], data[y * 4 + 2], data[y * 4 + 3]].join(','))
        return out
      })
    const px = await rows()
    const half = Math.floor(px.length / 2)
    const first = px.slice(2, half - 2)
    const links = '208,117,10,255'
    // every pixel row of the first half holds a With links record among the nine with none: the value shows, never the grey
    assert.equal(first.filter((c) => c !== links).length, 0, JSON.stringify([...new Set(first)]))
    // the rows with no value alone: the grey the no-value chip has
    await frame().evaluate(() => (window as any).colour.strip('#list', { rows: Array.from({ length: 1000 }, (_, i) => (i < 500 ? null : 'Text only')) }))
    await page.waitForTimeout(150)
    const grey = (await rows()).slice(2, half - 2)
    assert.equal(new Set(grey).size, 1, JSON.stringify([...new Set(grey)]))
    assert.notEqual(grey[0].split(',')[3], '0', 'drawn, not left blank')
    // the grey of every record with Color by Off
    await frame().locator('.thimble-colour-by').click()
    await frame().locator('.thimble-colour-menu [data-by="off"]').click()
    await page.waitForTimeout(200)
    assert.equal((await rows())[half + 10], grey[0], 'the grey the records take with Color by Off')
    await frame().locator('.thimble-colour-by').click()
    await frame().locator('.thimble-colour-menu [data-by="f:kind"]').click()
    await page.waitForTimeout(200)
    await frame().evaluate(() => (window as any).colour.strip('#list', { rows: Array.from({ length: 1000 }, (_, i) => (i < 500 ? null : 'Text only')) }))
    // the list's own records all take a value, so the page says how many take none, as a reader does
    await frame().evaluate(() => (window as any).colour.counts({ 'Text only': 500, '': 500 }))
    await page.waitForTimeout(200)
    // their chip turned off: they leave the scrollbar as any value does
    await frame().locator('.thimble-colour-chip', { hasText: 'No kind' }).click()
    await page.waitForTimeout(200)
    const gone = (await rows()).slice(2, half - 2)
    assert.equal(gone.filter((c) => c.split(',')[3] !== '0' && c === grey[0]).length, 0)
    await page.close()
  })

  test('a value turned off has its records dimmed and leaves the scrollbar', async () => {
    const { page, frame } = await framed()
    await frame().locator('.thimble-colour-chip').nth(1).click()
    await page.waitForTimeout(200)
    const s = await frame().evaluate(() => {
      const cv = document.querySelector('.thimble-colour-strip canvas') as HTMLCanvasElement
      const px = [...cv.getContext('2d')!.getImageData(Math.floor(cv.width / 2), Math.floor(cv.height * 0.95), 1, 1).data].slice(0, 3)
      return { opacity: getComputedStyle(document.querySelector('[data-anchor="m.jsonl#L60"]')!).opacity, px, pressed: document.querySelectorAll('.thimble-colour-chip')[1].getAttribute('aria-pressed') }
    })
    assert.deepEqual([s.opacity, s.pressed], ['0.25', 'false'])
    assert.notDeepEqual(s.px, [208, 117, 10])
    await page.close()
  })

  test('chips that do not fit the row go behind "N more", which lists them', async () => {
    const { page, frame } = await framed(330)
    const s = await frame().evaluate(() => ({
      shown: [...document.querySelectorAll<HTMLElement>('.thimble-colour-chip')].filter((c) => !c.hidden).length,
      more: (document.querySelector('.thimble-colour-more') as HTMLElement).hidden ? null : document.querySelector('.thimble-colour-more')!.textContent,
      wide: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    }))
    assert.ok(s.shown < 2 && s.more === `${2 - s.shown} more`, JSON.stringify(s))
    assert.ok(s.wide, 'the row does not overflow the page')
    await frame().locator('.thimble-colour-more').click()
    assert.deepEqual(await frame().locator('.thimble-colour-menu .thimble-colour-nm').allTextContents(), ['Text only', 'With links'])
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

describe('the menu', () => {
  test('each field and label says how many values it has, and shows them as chips on one line under its name, cut off with …', async () => {
    const { page, frame } = await framed()
    // a label with four values, three it colours by, in a menu narrow enough that they do not fit
    const label = { id: 'k1', name: 'edit purpose', on: false, here: true, colour: '#025ac3', values: [{ name: 'message to other runs', colour: '#025ac3', highlight: true }, { name: 'posts links', colour: '#d0750a', highlight: true }, { name: 'restores page', colour: '#08632f', highlight: true }, { name: 'other', colour: '#a09c93', highlight: false }], count: 12 }
    await page.evaluate((l) => (document.getElementById('f') as HTMLIFrameElement).contentWindow!.postMessage({ type: 'thimble:labels', marks: {}, on: [], filter: null, all: [l], palette: [] }, '*'), label)
    await page.waitForTimeout(100)
    await frame().locator('.thimble-colour-by').click()
    const rows = await frame().evaluate(() =>
      [...document.querySelectorAll('.thimble-colour-menu .thimble-colour-choice')].map((r) => {
        const p = r.querySelector('.thimble-colour-preview') as HTMLElement
        return { name: r.querySelector('.thimble-colour-nm')!.textContent, n: r.querySelector('.thimble-colour-top .thimble-colour-n')?.textContent, chips: [...r.querySelectorAll('.thimble-colour-pchip')].map((c) => c.textContent), cut: p ? getComputedStyle(p).textOverflow : null, lines: p ? Math.round(p.getBoundingClientRect().height) : 0 }
      }),
    )
    assert.deepEqual(rows.map((r) => [r.name, r.n, r.chips]), [
      ['Kind', '2 values', ['Text only', 'With links']],
      ['edit purpose', '3 values', ['message to other runs', 'posts links', 'restores page']],
    ])
    assert.ok(rows.every((r) => r.cut === 'ellipsis' && r.lines <= 20), JSON.stringify(rows))
    // a label's row has its switch and no button for its definition: choosing it opens thimble's label editor
    assert.deepEqual(await frame().evaluate(() => [...document.querySelectorAll('.thimble-colour-label button')].map((b) => b.getAttribute('role') ?? b.className)), ['switch'])
    await page.close()
  })
})

describe("a value's colour", () => {
  const look = (frame: () => Frame) =>
    frame().evaluate(() => {
      const chip = document.querySelectorAll('.thimble-colour-chip')[1] as HTMLElement
      const cv = document.querySelector('.thimble-colour-strip canvas') as HTMLCanvasElement
      const px = [...cv.getContext('2d')!.getImageData(Math.floor(cv.width / 2), Math.floor(cv.height * 0.95), 1, 1).data].slice(0, 3)
      return {
        chip: getComputedStyle(chip.querySelector('.chip-sw')!).backgroundColor,
        pressed: chip.getAttribute('aria-pressed'),
        bar: getComputedStyle(document.querySelector('[data-anchor="m.jsonl#L60"]')!).boxShadow,
        track: px,
      }
    })

  test("a click on a chip's swatch opens the palette, and the colour picked recolours the value everywhere and is kept", async () => {
    const { page, frame } = await framed()
    // thimble's palette as it hands it over, its colours as written in the tokens
    const palette = ['#025ac3', '#d0750a', '#08632f', '#1392d4', '#897301', '#009c85', '#844500', '#013c77', '#2aa02b', '#025a7c', '#622b01', '#0389a0', '#a09c93']
    await page.evaluate((pal) => (document.getElementById('f') as HTMLIFrameElement).contentWindow!.postMessage({ type: 'thimble:labels', marks: {}, on: [], filter: null, all: [], palette: pal }, '*'), palette)
    await page.waitForTimeout(100)
    await frame().locator('.thimble-colour-chip').nth(1).locator('.chip-sw').click()
    const pal = await frame().evaluate(() => {
      const m = document.querySelector('.thimble-colour-palette')
      return m ? { picks: m.querySelectorAll('.thimble-colour-pick').length, on: [...m.querySelectorAll('.thimble-colour-pick')].findIndex((b) => b.classList.contains('on')), head: m.querySelector('.thimble-colour-head')!.textContent, reset: !!m.querySelector('[data-reset-colours]') } : null
    })
    assert.deepEqual(pal, { picks: 12, on: 1, head: 'With links', reset: false }, 'twelve colours, the value\'s own ringed')
    assert.equal((await look(frame)).pressed, 'true', 'the swatch does not turn the value off')
    // the third colour, #08632f
    await frame().locator('.thimble-colour-palette .thimble-colour-pick').nth(2).click()
    await page.waitForTimeout(200)
    const after = await look(frame)
    assert.equal(await frame().locator('.thimble-colour-palette').count(), 0)
    assert.equal(after.chip, 'rgb(8, 99, 47)')
    assert.match(after.bar, /rgb\(8, 99, 47\)/)
    assert.deepEqual(after.track, [8, 99, 47])
    const kept = await page.evaluate(() => (window as unknown as { __kept: { picked?: unknown }[] }).__kept)
    assert.deepEqual(kept[kept.length - 1].picked, { kind: { 'With links': 2 } })
    // Reset colors gives the value its own colour back
    await frame().locator('.thimble-colour-chip').nth(1).locator('.chip-sw').click()
    await frame().locator('.thimble-colour-palette [data-reset-colours]').click()
    await page.waitForTimeout(200)
    assert.equal((await look(frame)).chip, 'rgb(208, 117, 10)')
    const again = await page.evaluate(() => (window as unknown as { __kept: { picked?: unknown }[] }).__kept)
    assert.deepEqual(again[again.length - 1].picked, {})
    await page.close()
  })

  test('the colour kept for the view is where the page starts', async () => {
    const { page, frame } = await framed(700, { v: 1, picked: { kind: { 'With links': 2 } } })
    await page.waitForTimeout(150)
    const s = await look(frame)
    assert.equal(s.chip, 'rgb(8, 99, 47)')
    assert.deepEqual(s.track, [8, 99, 47])
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

describe("the key's chips", () => {
  test('the chip of the records with no value has the grey the marks draw them in, and an outline only when turned off', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => `<div class="msg" data-anchor="m.jsonl#L${i + 1}" data-colour="${i < 8 ? 'Text only' : ''}">message ${i + 1}</div>`).join('')
    const { page, frame } = await own(rows, `window.colour = thimble.colorBy({ mount: '#colour', fields: [{ name: 'kind', title: 'Kind' }] })`)
    await frame().waitForFunction(() => document.querySelectorAll('.thimble-colour-chip').length === 2)
    const sw = () =>
      frame().evaluate(() => {
        const chip = [...document.querySelectorAll('.thimble-colour-chip')].find((c) => c.textContent!.startsWith('No kind'))!
        const s = getComputedStyle(chip.querySelector('.chip-sw')!)
        return { text: chip.textContent, bg: s.backgroundColor, ring: s.boxShadow, pressed: chip.getAttribute('aria-pressed') }
      })
    const on = await sw()
    assert.equal(on.text, 'No kind4')
    assert.equal(on.bg, 'rgba(27, 26, 24, 0.34)', 'filled with the grey of a record that takes no value')
    await frame().locator('.thimble-colour-chip', { hasText: 'No kind' }).click()
    await page.waitForTimeout(100)
    const off = await sw()
    assert.equal(off.pressed, 'false')
    assert.equal(off.bg, 'rgba(0, 0, 0, 0)', 'turned off, an outline')
    assert.match(off.ring, /inset/)
    await page.close()
  })

  test('Reset keeps its place unseen while hidden, so the chips fit one box and showing it moves no chip behind "N more", even after its text changes width', async () => {
    const vals = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot']
    const rows = Array.from({ length: 30 }, (_, i) => `<div class="msg" data-anchor="m.jsonl#L${i + 1}" data-colour="${vals[i % vals.length]}">message ${i + 1}</div>`).join('')
    const { page, frame } = await own(rows, `window.colour = thimble.colorBy({ mount: '#colour', fields: [{ name: 'kind', title: 'Kind', values: ${JSON.stringify(vals)} }] })`, 640)
    await frame().waitForFunction(() => document.querySelectorAll('.thimble-colour-chip').length === 6)
    await page.waitForTimeout(100)
    // a web font arriving after the first fit: Reset's text a little wider than when the row was first laid out
    await frame().evaluate(() => document.head.insertAdjacentHTML('beforeend', '<style>.thimble-reset{font-size:15px;letter-spacing:0.5px}</style>'))
    await page.evaluate(() => ((document.getElementById('f') as HTMLIFrameElement).style.width = '641px'))
    await page.waitForTimeout(150)
    const row = () =>
      frame().evaluate(() => {
        const reset = document.querySelector('.thimble-reset') as HTMLElement
        const rs = getComputedStyle(reset)
        return {
          shown: [...document.querySelectorAll<HTMLElement>('.thimble-colour-chip')].map((c) => (c.hidden ? 0 : Math.round(c.getBoundingClientRect().left))),
          more: (document.querySelector('.thimble-colour-more') as HTMLElement).hidden ? '' : document.querySelector('.thimble-colour-more')!.textContent,
          box: (document.querySelector('.thimble-colour-chips') as HTMLElement).clientWidth,
          reset: reset.hidden,
          laid: [rs.display !== 'none' && reset.getBoundingClientRect().width > 0, rs.visibility],
        }
      })
    const before = await row()
    assert.equal(before.reset, true)
    assert.deepEqual(before.laid, [true, 'hidden'], 'hidden, Reset keeps its place unseen')
    assert.ok(before.more, `the row is full: ${JSON.stringify(before)}`)
    // unseen, it takes no focus
    await frame().evaluate(() => (document.querySelector('.thimble-reset') as HTMLElement).focus())
    assert.notEqual(await frame().evaluate(() => document.activeElement?.className ?? ''), (await frame().evaluate(() => document.querySelector('.thimble-reset')!.className)))
    await frame().locator('.thimble-colour-chip').first().click()
    await page.waitForTimeout(150)
    const after = await row()
    assert.deepEqual([after.reset, after.laid], [false, [true, 'visible']])
    assert.deepEqual([after.shown, after.more, after.box], [before.shown, before.more, before.box], 'the same chips in the same places, in a box of the same width')
    await page.close()
  })

  test("hovering a field's value says what it means, as the page declares it, else what the field is", async () => {
    const rows = Array.from({ length: 6 }, (_, i) => `<div class="msg" data-anchor="m.jsonl#L${i + 1}" data-colour="${i < 3 ? 'Text only' : 'With links'}">message ${i + 1}</div>`).join('')
    const { page, frame } = await own(rows, `window.colour = thimble.colorBy({ mount: '#colour', fields: [{ name: 'kind', title: 'Kind', description: 'what the message holds besides text', values: ['Text only', { name: 'With links', meaning: 'links to a page of the wiki' }] }] })`)
    await frame().waitForFunction(() => document.querySelectorAll('.thimble-colour-chip').length === 2)
    const hover = async (name: string) => {
      await frame().locator('.thimble-colour-chip', { hasText: name }).locator('.chip-text').hover()
      await page.waitForTimeout(100)
      return frame().evaluate(() => {
        const t = document.querySelector('.thimble-tip') as HTMLElement | null
        return t && t.style.display === 'block' ? [t.querySelector('.thimble-tip-h')!.textContent, t.querySelector('.thimble-tip-m')!.textContent] : null
      })
    }
    assert.deepEqual(await hover('With links'), ['With links', 'links to a page of the wiki'])
    assert.deepEqual(await hover('Text only'), ['Text only', 'what the message holds besides text'])
    assert.equal(await frame().locator('.thimble-colour-chip[title]').count(), 0, 'no native tooltip besides')
    await page.close()
  })

  test("a field's `meanings` say what its values mean without declaring them, so the values keep the records' order and colors", async () => {
    // With links on four records, Text only on two: undeclared, the commoner comes first, in the first color
    const rows = Array.from({ length: 6 }, (_, i) => `<div class="msg" data-anchor="m.jsonl#L${i + 1}" data-colour="${i < 2 ? 'Text only' : 'With links'}">message ${i + 1}</div>`).join('')
    const field = (extra: string) => `window.colour = thimble.colorBy({ mount: '#colour', fields: [{ name: 'kind', title: 'Kind', description: 'what the message holds besides text'${extra} }] })`
    const chips = async (frame: () => Frame) => {
      await frame().waitForFunction(() => document.querySelectorAll('.thimble-colour-chip').length === 2)
      return frame().evaluate(() => [...document.querySelectorAll('.thimble-colour-chip')].map((c) => [c.querySelector('.chip-text')!.textContent, getComputedStyle(c.querySelector('.chip-sw')!).backgroundColor]))
    }
    const plain = await own(rows, field(''))
    const before = await chips(plain.frame)
    await plain.page.close()
    const { page, frame } = await own(rows, field(", meanings: { 'With links': 'links to a page of the wiki' }"))
    assert.deepEqual(await chips(frame), before)
    assert.equal(before[0][0], 'With links')
    await frame().locator('.thimble-colour-chip', { hasText: 'With links' }).locator('.chip-text').hover()
    await page.waitForTimeout(100)
    const said = await frame().evaluate(() => {
      const t = document.querySelector('.thimble-tip') as HTMLElement | null
      return t && t.style.display === 'block' ? t.querySelector('.thimble-tip-m')!.textContent : null
    })
    assert.equal(said, 'links to a page of the wiki')
    await page.close()
  })

  test('"Other" names the values under it with their counts on hover, as a chip in the row and as an item of the "N more" menu', async () => {
    // fourteen kinds, kind k on 15 - k records, so the last two go under "Other"
    const kinds = Array.from({ length: 14 }, (_, k) => `kind ${String.fromCharCode(97 + k)}`)
    const rows = kinds.flatMap((n, k) => Array.from({ length: 15 - k }, () => n)).map((n, i) => `<div class="msg" data-anchor="m.jsonl#L${i + 1}" data-colour="${n}">message ${i + 1}</div>`).join('')
    const script = `window.colour = thimble.colorBy({ mount: '#colour', fields: [{ name: 'kind', title: 'Kind' }] })`
    const tipText = (frame: () => Frame) =>
      frame().evaluate(() => {
        const t = document.querySelector('.thimble-tip') as HTMLElement | null
        return t && t.style.display === 'block' ? [t.querySelector('.thimble-tip-h')!.textContent, t.querySelector('.thimble-tip-m')!.textContent] : null
      })
    const want = ['Other', 'kind m 3 · kind n 2']
    // wide enough for every chip: the row's "Other" chip
    const wide = await own(rows, script, 2400)
    await wide.frame().waitForFunction(() => document.querySelectorAll('.thimble-colour-chip[data-other]').length === 1)
    await wide.frame().locator('.thimble-colour-chip[data-other] .chip-text').hover()
    await wide.page.waitForTimeout(100)
    assert.deepEqual(await tipText(wide.frame), want)
    await wide.page.close()
    // narrow: "Other" goes behind "N more", whose item says the same beside the menu
    const { page, frame } = await own(rows, script, 700)
    await frame().waitForFunction(() => !(document.querySelector('.thimble-colour-more') as HTMLElement).hidden)
    assert.ok(await frame().locator('.thimble-colour-chip[data-other]').isHidden(), 'the row has no room for "Other"')
    await frame().locator('.thimble-colour-more').click()
    const item = frame().locator('.thimble-colour-menu .thimble-colour-item', { hasText: 'Other' })
    await item.hover()
    await page.waitForTimeout(100)
    assert.deepEqual(await tipText(frame), want)
    const [menu, tip] = await frame().evaluate(() => [document.querySelector('.thimble-colour-menu')!, document.querySelector('.thimble-tip')!].map((e) => e.getBoundingClientRect().toJSON()))
    assert.ok(tip.left >= menu.right - 4 || tip.right <= menu.left + 4, `the tip stands beside the menu, not over it: ${JSON.stringify([menu, tip])}`)
    await page.close()
  })
})

describe("a label's texts", () => {
  // one record whose text two labels mark: "connection pool" by Database connections (k1, orange), "charged twice" by
  // Charged twice (k2, green); and one whose span comes from before spans named their label
  const ROWS2 = `<div class="msg" data-anchor="m.jsonl#L1" data-colour="Chat">the connection pool was charged twice</div><div class="msg" data-anchor="m.jsonl#L2" data-colour="Chat">pool again</div>`
  const label = (id: string, name: string, value: string, colour: string) => ({ id, name, colour, values: [{ name: value, colour }] })
  const MSG = {
    type: 'thimble:labels',
    marks: {
      'm.jsonl#L1': {
        bar: '#d0750a',
        names: ['Database connections', 'Charged twice'],
        values: [{ id: 'k1', label: 'Database connections', value: 'connections', colour: '#d0750a' }, { id: 'k2', label: 'Charged twice', value: 'charged twice', colour: '#08632f' }],
        spans: [{ text: 'connection pool', colour: '#d0750a', id: 'k1' }, { text: 'charged twice', colour: '#08632f', id: 'k2' }],
      },
      'm.jsonl#L2': { bar: '#d0750a', names: ['Database connections'], values: [{ id: 'k1', label: 'Database connections', value: 'connections', colour: '#d0750a' }], spans: [{ text: 'pool', colour: '#d0750a' }] },
    },
    on: [label('k1', 'Database connections', 'connections', '#d0750a'), label('k2', 'Charged twice', 'charged twice', '#08632f')],
    filter: null,
    all: [
      { ...label('k1', 'Database connections', 'connections', '#d0750a'), on: true, here: true, values: [{ name: 'connections', colour: '#d0750a', highlight: true }], count: 2 },
      { ...label('k2', 'Charged twice', 'charged twice', '#08632f'), on: true, here: true, values: [{ name: 'charged twice', colour: '#08632f', highlight: true }], count: 1 },
    ],
  }
  const lit = (frame: () => Frame) =>
    frame().evaluate(() => {
      const out: Record<string, string[]> = {}
      for (const k of CSS.highlights.keys()) if (k.startsWith('thimble-label-')) out[k === 'thimble-label-grey' ? 'grey' : 'colour'] = [...(out[k === 'thimble-label-grey' ? 'grey' : 'colour'] ?? []), ...[...CSS.highlights.get(k)!].map((r) => r.toString())]
      for (const k in out) out[k].sort()
      return out
    })

  test('only the chosen label takes its colours; the other labels that are on, a field and Off highlight in grey', async () => {
    const { page, frame } = await own(ROWS2, `window.colour = thimble.colorBy({ mount: '#colour', fields: [{ name: 'kind', title: 'Kind' }] })`, 700, { v: 1, by: 'l:k1', seen: ['k1', 'k2'] })
    await page.evaluate((m) => (document.getElementById('f') as HTMLIFrameElement).contentWindow!.postMessage(m, '*'), MSG)
    await frame().waitForFunction(() => [...CSS.highlights.keys()].some((k) => k.startsWith('thimble-label-')))
    await page.waitForTimeout(150)
    assert.deepEqual(await lit(frame), { colour: ['connection pool', 'pool'], grey: ['charged twice'] }, "Database connections' texts in its colour, the span that names no label by its colour")
    // a field chosen
    await frame().locator('.thimble-colour-by').click()
    await frame().locator('.thimble-colour-menu [data-by="f:kind"]').click()
    await page.waitForTimeout(200)
    assert.deepEqual(await lit(frame), { grey: ['charged twice', 'connection pool', 'pool'] })
    // Off
    await frame().locator('.thimble-colour-by').click()
    await frame().locator('.thimble-colour-menu [data-by="off"]').click()
    await page.waitForTimeout(200)
    assert.deepEqual(await lit(frame), { grey: ['charged twice', 'connection pool', 'pool'] })
    const grey = await frame().evaluate(() => [...document.querySelectorAll('style[data-thimble="labels"]')].map((s) => s.textContent).join(''))
    assert.match(grey, /::highlight\(thimble-label-grey\)\{background-color:var\(--hl-bg/)
    await page.close()
  })
})

describe('a lane of the tracks for each label that is on', () => {
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

  test('two labels on are two lanes, each in its own colours and named on hover; one turned off leaves one lane', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => `<div class="msg" data-anchor="m.jsonl#L${i + 1}">message ${i + 1}</div>`).join('')
    const { page, frame } = await own(rows, `window.colour = thimble.colorBy({ mount: '#colour', fields: [{ name: 'kind', title: 'Kind' }], strip: '#list' })`, 700, { v: 1, by: 'l:k1', seen: ['k1', 'k2'] })
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
    assert.equal(one.width, 12, 'one lane, as wide as the track always is')
    assert.equal(one.at[0][0], ORANGE)
    assert.notEqual(one.at[0][1], GREEN)
    await page.close()
  })
})
