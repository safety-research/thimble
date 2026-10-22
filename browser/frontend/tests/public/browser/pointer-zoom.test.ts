// The ⌘ pointer on a zoomed canvas (src/pointer/anchors.ts): the board draws its cards under a CSS scale, so a card's
// box on screen is its layout box times the zoom. The text a card clips must be cut at the card's box on screen at any
// zoom: above 100% the lower part of a card still highlights, and a line the card hides still draws nothing.
import assert from 'node:assert/strict'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let page: Page

beforeAll(async () => {
  const script = await bundle('pointer-zoom', [
    `import { linePieces, visibleBox } from '${src('pointer/anchors.ts')}'`,
    `const range = (el) => { const r = document.createRange(); r.selectNodeContents(el); return r }`,
    `window.__t = {`,
    `  // a 300 x 200 card that clips, under a plane at \`zoom\`, with a line near its foot and a line past it`,
    `  card: (zoom) => {`,
    `    document.body.innerHTML = '<div id="plane" style="position:absolute;left:0;top:0;transform-origin:0 0"><article id="card" style="position:absolute;left:20px;top:20px;width:300px;height:200px;overflow:hidden;border:2px solid #999;font:14px/20px sans-serif"><p id="low" style="position:absolute;top:170px;left:10px;margin:0">the lower part of the card</p><p id="hidden" style="position:absolute;top:240px;left:10px;margin:0">past the foot of the card</p></article></div>'`,
    `    document.getElementById('plane').style.transform = 'scale(' + zoom + ')'`,
    `    const card = document.getElementById('card')`,
    `    const r = card.getBoundingClientRect()`,
    `    return { rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom }, clip: visibleBox(card), low: linePieces(range(document.getElementById('low'))).length, hidden: linePieces(range(document.getElementById('hidden'))).length }`,
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

type Got = { rect: { left: number; top: number; right: number; bottom: number }; clip: { left: number; top: number; right: number; bottom: number }; low: number; hidden: number }
const card = (zoom: number): Promise<Got> => page.evaluate((z) => (window as any).__t.card(z), zoom)

for (const zoom of [0.5, 1, 1.5, 2.5]) {
  test(`at ${zoom * 100}% a card clips its text at its padding box on screen`, async () => {
    const got = await card(zoom)
    const border = 2 * zoom
    for (const [side, want] of [['left', got.rect.left + border], ['top', got.rect.top + border], ['right', got.rect.right - border], ['bottom', got.rect.bottom - border]] as const)
      assert.ok(Math.abs(got.clip[side] - want) < 0.5, `${side}: clip ${got.clip[side]}, card ${want}`)
    assert.equal(got.low, 1, 'the line near the foot of the card highlights')
    assert.equal(got.hidden, 0, 'the line the card hides draws nothing')
  })
}
