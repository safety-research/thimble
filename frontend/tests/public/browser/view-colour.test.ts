// The view kit's Colour by (backend/app/viewer_colour.js) in a real browser: a page holds a view in a sandboxed frame,
// and the bridge draws the chosen value's colour as a bar on each record's left edge and the chips show it on theirs;
// the coloured scrollbar shows where each value's records are and scrolls the list; chips that do not fit go behind
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
  '--h-row:28px;--control-sm:28px;--h-control:24px;--text-ui-sm:12px;--text-mono-sm:11px;--font-body:sans-serif;--font-mono:monospace}'
// sixty messages, the last ten With links, in a list that scrolls
const ROWS = Array.from({ length: 60 }, (_, i) => `<div class="msg" data-anchor="m.jsonl#L${i + 1}" data-colour="${i < 50 ? 'Text only' : 'With links'}">message ${i + 1}</div>`).join('')
const VIEW = `<!doctype html><html><head><style>${TOKENS} body{margin:0;font:12px sans-serif} .top{display:flex;align-items:center;gap:8px;padding:8px} #list{height:300px;overflow:auto} .msg{box-sizing:border-box;height:30px;padding:6px 8px 0 12px}</style>
<script>${BRIDGE}</script><script>${COLOUR}</script><style>${KIT}</style></head><body>
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

/** A page that holds the view in a sandboxed frame `width` px wide, as ViewerFrame does. */
async function framed(width = 700): Promise<{ page: Page; frame: () => Frame }> {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } })
  await page.setContent(`<!doctype html><html><body style="margin:0"><iframe id="f" sandbox="allow-scripts" style="border:0;width:${width}px;height:400px"></iframe></body></html>`)
  await page.evaluate((doc) => ((document.getElementById('f') as HTMLIFrameElement).srcdoc = doc), VIEW)
  const frame = () => page.frames().find((f) => f !== page.mainFrame())!
  await page.waitForFunction(() => document.getElementById('f') && (document.getElementById('f') as HTMLIFrameElement).contentWindow)
  await page.waitForTimeout(300)
  await frame().waitForSelector('.thimble-colour-chip', { state: 'attached' })
  await frame().waitForFunction(() => document.querySelectorAll('[data-thimble-colour]').length === 60)
  return { page, frame }
}

describe('Colour by in a frame', () => {
  test("each record's value is a bar on its left edge, and each chip's is a bar on its own", async () => {
    const { page, frame } = await framed()
    const s = await frame().evaluate(() => ({
      first: getComputedStyle(document.querySelector('[data-anchor="m.jsonl#L1"]')!).boxShadow,
      last: getComputedStyle(document.querySelector('[data-anchor="m.jsonl#L60"]')!).boxShadow,
      chips: [...document.querySelectorAll('.thimble-colour-chip')].map((c) => [c.textContent ?? '', getComputedStyle(c).boxShadow, getComputedStyle(c).color]),
    }))
    assert.match(s.first, /rgb\(2, 90, 195\) 3px 0px 0px 0px inset/, 'the first value takes the first palette colour, inside the padding')
    assert.match(s.last, /rgb\(208, 117, 10\) 3px 0px 0px 0px inset/)
    assert.deepEqual(s.chips.map((c) => c[0]), ['Text only50', 'With links10'])
    assert.match(s.chips[0][1], /rgb\(2, 90, 195\) 3px 0px 0px 0px inset/, "the chip's edge, not its text, carries the colour")
    assert.equal(s.chips[0][2], 'rgb(0, 0, 0)', "the chip's text stays the text colour")
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
      if (url.pathname === '/api/ws/w/views/board/frame') return route.fulfill({ status: 200, contentType: 'text/html', body: VIEW })
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
    await page.waitForFunction(() => !!localStorage.getItem('thimble:w:view-colour:board'))
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
