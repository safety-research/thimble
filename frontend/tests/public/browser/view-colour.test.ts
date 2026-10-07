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
const COLOUR = inline(read('viewer_colour.js'))
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
