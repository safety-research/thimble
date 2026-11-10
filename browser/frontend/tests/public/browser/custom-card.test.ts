// A custom card's frame (canvas/DataViz CustomFrame) in a real browser, which lays the page out as jsdom cannot: the
// frame is as tall as the card's whole page, margins included. A top margin of the page's first element or a bottom
// margin of its last runs past the body's edge (it joins the body's own margin), and the frame holds it, so the card's
// last line is never cut.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Frame, Page } from 'playwright'
import { bundle, cleanup, FRONTEND, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let page: Page

beforeAll(async () => {
  const script = await bundle('custom-card', [
    `import { createRoot } from 'react-dom/client'`,
    `import { flushSync } from 'react-dom'`,
    `import { CustomFrame } from '${src('canvas/DataViz.tsx')}'`,
    `const mount = (html) => { const el = document.createElement('div'); el.style.width = '680px'; el.id = 'm' + Math.random().toString(36).slice(2); document.body.appendChild(el); flushSync(() => createRoot(el).render(<CustomFrame html={html} title="card" />)); return el.id }`,
    `window.__t = { custom: mount }`,
  ])
  browser = await launch()
  page = await browser.newPage()
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url())
    if (url.protocol === 'data:' || url.protocol === 'blob:') return route.continue()
    if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"detail":"not found"}' })
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>' })
  })
  await page.goto(`${ORIGIN}/?ws=mini`)
  await page.addStyleTag({ content: readFileSync(`${FRONTEND}/src/styles/canvas.css`, 'utf8') })
  await page.addScriptTag({ path: script })
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A custom card of `html`, once its page has said its height and the frame has kept one height for a moment: the
 * frame's height, px, and the frame, to read the page inside it. */
async function drawn(html: string): Promise<{ height: number; frame: Frame }> {
  const id: string = await page.evaluate((h) => (window as any).__t.custom(h), html)
  const el = await page.waitForSelector(`#${id} .canvas-card-frame[data-settled="true"] iframe`)
  let height = -1
  for (let i = 0; i < 50; i++) {
    const now = (await el.boundingBox())?.height ?? 0
    if (now === height) break
    height = now
    await settle(100)
  }
  const frame = await el.contentFrame()
  assert.ok(frame, 'the card has its frame')
  return { height, frame }
}

test("the frame holds the margins of the page's first and last elements and the body's own margin", async () => {
  // each page as tall as its blocks and margins say, whatever the fonts; the body's own margin is the browser's 8 px
  const pages: [string, number][] = [
    ['<div style="height:100px"></div>', 8 + 100 + 8],
    ['<div style="height:100px;margin-top:24px"></div>', 24 + 100 + 8],
    ['<div style="height:100px;margin-bottom:30px"></div>', 8 + 100 + 30],
    ['<style>body{margin:0}</style><div style="height:100px;margin:16px 0 30px"></div>', 16 + 100 + 30],
    ['<section><div style="height:100px;margin:20px 0"></div></section>', 20 + 100 + 20],
    ['<style>body{margin:4px;padding:6px}</style><div style="height:100px;margin:20px 0"></div>', 4 + 6 + 20 + 100 + 20 + 6 + 4],
    // a page that sets the html element's height still gets the room its body needs
    ['<style>html{height:100%}</style><div style="height:300px"></div>', 8 + 300 + 8],
  ]
  const got: number[] = []
  for (const [html] of pages) got.push((await drawn(html)).height)
  assert.deepEqual(got, pages.map(([, px]) => px))
})

test('a card whose grid has a top margin shows its last line whole', async () => {
  // a card shaped like one a session drew, a grid with a 24 px top margin: its frame was 16 px shorter than its page,
  // and its last line was cut in half
  const html = `<style>
.g{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;text-align:center;margin-top:24px}
.n{font-size:72px;font-weight:700;line-height:1}
.l{margin-top:10px;font-size:15px}
.s{font-size:13px;opacity:.7}
</style>
<div class="g">
  <div><div class="n">14</div><div class="l">Run 1<br>first try</div><div class="s">of 176 tasks</div></div>
  <div><div class="n">7</div><div class="l">Run 2<br>second try</div><div class="s">of 176 tasks</div></div>
  <div><div class="n">2</div><div class="l">Run 3<br>first try</div><div class="s">of 176 tasks</div></div>
  <div><div class="n">4</div><div class="l">Run 4<br>second try</div><div class="s">of 177 tasks</div></div>
</div>`
  const { height, frame } = await drawn(html)
  // the grid starts below its 24 px margin, and the page ends 8 px (the body's margin) below the grid
  const laid = await frame.evaluate(() => {
    const grid = document.querySelector('.g')!.getBoundingClientRect()
    const last = Math.max(...Array.from(document.querySelectorAll('.s'), (s) => s.getBoundingClientRect().bottom))
    return { top: grid.top, bottom: grid.bottom, last, room: innerHeight, scroll: document.documentElement.scrollHeight }
  })
  assert.equal(laid.top, 24)
  assert.equal(height, Math.ceil(laid.bottom + 8), JSON.stringify(laid))
  assert.ok(laid.last <= laid.room && laid.scroll <= laid.room, JSON.stringify(laid))
})
