// A held ⌘-click highlight stays on what it marks (src/pointer/highlight.ts): when the element moves (a card laid out
// again, the canvas panned or zoomed) the highlight moves with it within a frame, and when the element is gone (the card
// drawn anew) the highlight fades rather than staying where the element was.
import assert from 'node:assert/strict'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let page: Page

beforeAll(async () => {
  const script = await bundle('pointer-follow', [
    `import { highlight } from '${src('pointer/highlight.ts')}'`,
    `// the elements go in a stage of their own: the highlight is a node on the body the module keeps`,
    `const stage = document.body.appendChild(document.createElement('div'))`,
    `const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(undefined))))`,
    `const hl = () => { const n = document.querySelector('.pointer-hl'); const m = /translate3d\\(([-\\d.]+)px, ([-\\d.]+)px/.exec(n.style.transform); return { on: n.hasAttribute('data-on'), x: +m[1], y: +m[2], w: parseFloat(n.style.width), h: parseFloat(n.style.height) } }`,
    `window.__t = {`,
    `  // a region held on #a, which then moves by (dx, dy), and then is removed`,
    `  region: async (dx, dy) => {`,
    `    highlight.release()`,
    `    stage.innerHTML = '<div id="a" style="position:absolute;left:50px;top:60px;width:100px;height:40px;border-radius:4px"></div>'`,
    `    const a = document.getElementById('a')`,
    `    highlight.region(a); highlight.hold(); await frames()`,
    `    const before = hl()`,
    `    a.style.left = (50 + dx) + 'px'; a.style.top = (60 + dy) + 'px'; await frames()`,
    `    const moved = hl()`,
    `    a.remove(); await frames()`,
    `    const gone = hl()`,
    `    return { before, moved, gone }`,
    `  },`,
    `  // a 12px box held inside #line, on a plane that zooms to \`zoom\`; then #line is drawn anew`,
    `  box: async (zoom) => {`,
    `    highlight.release()`,
    `    stage.innerHTML = '<div id="plane" style="position:absolute;left:0;top:0;transform-origin:0 0"><div id="line" style="position:absolute;left:100px;top:100px;width:200px;height:100px"></div></div>'`,
    `    const line = document.getElementById('line')`,
    `    highlight.box(new DOMRect(150, 140, 12, 12), line); highlight.hold(); await frames()`,
    `    const before = hl()`,
    `    document.getElementById('plane').style.transform = 'scale(' + zoom + ')'; await frames()`,
    `    const zoomed = hl()`,
    `    line.replaceWith(line.cloneNode()); await frames()`,
    `    const redrawn = hl()`,
    `    return { before, zoomed, redrawn }`,
    `  },`,
    `}`,
  ])
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  await page.route('**/*', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>' }))
  await page.goto(`${ORIGIN}/`)
  await page.addScriptTag({ path: script })
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

type Hl = { on: boolean; x: number; y: number; w: number; h: number }
const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 0.5, `${what}: ${a}, want ${b}`)

test('a held region moves with its element and fades once the element is gone', async () => {
  const got: { before: Hl; moved: Hl; gone: Hl } = await page.evaluate(() => (window as any).__t.region(240, 130))
  assert.ok(got.before.on, 'the highlight shows on the element')
  near(got.before.x, 50, 'left')
  near(got.before.y, 60, 'top')
  assert.ok(got.moved.on, 'the highlight still shows after the element moved')
  near(got.moved.x, 290, 'left after the move')
  near(got.moved.y, 190, 'top after the move')
  assert.equal(got.gone.on, false, 'the highlight fades once its element is removed')
})

test('a held box inside an element zooms with it and fades once the element is drawn anew', async () => {
  const got: { before: Hl; zoomed: Hl; redrawn: Hl } = await page.evaluate(() => (window as any).__t.box(2))
  assert.ok(got.before.on, 'the box shows')
  near(got.before.x, 150, 'left')
  near(got.before.w, 12, 'width')
  assert.ok(got.zoomed.on, 'the box still shows at 200%')
  near(got.zoomed.x, 300, 'left at 200%')
  near(got.zoomed.y, 280, 'top at 200%')
  near(got.zoomed.w, 24, 'width at 200%')
  assert.equal(got.redrawn.on, false, 'the box fades once its element is replaced')
})
