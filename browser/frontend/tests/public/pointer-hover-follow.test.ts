// @vitest-environment jsdom
// The ⌘ pointer's highlight while it follows the pointer, not held (src/pointer/highlight.ts): it stays on its target
// each frame, as a held one does, so when the target moves under a still pointer (a ⌘ scroll zooms the canvas, a card
// is laid out again) the highlight moves with it rather than staying where the target was, and when the target leaves
// the page it fades rather than staying on an empty board.
import { afterEach, expect, test } from 'vitest'
import { highlight, REGION_PAD as P } from '../../src/pointer/highlight.ts'

const frames = (n = 3) => new Promise<void>((r) => {
  const step = (k: number) => (k ? requestAnimationFrame(() => step(k - 1)) : r())
  step(n)
})
const hl = () => {
  const n = document.querySelector<HTMLElement>('.pointer-hl')!
  const m = /translate3d\(([-\d.]+)px, ([-\d.]+)px/.exec(n.style.transform)!
  return { on: n.hasAttribute('data-on'), x: +m[1], y: +m[2], w: parseFloat(n.style.width), h: parseFloat(n.style.height) }
}
/** An element whose box on screen is what `box` holds now: jsdom lays nothing out. */
function placed(box: { left: number; top: number; width: number; height: number }): HTMLElement {
  const el = document.body.appendChild(document.createElement('div'))
  el.getBoundingClientRect = () => new DOMRect(box.left, box.top, box.width, box.height)
  return el
}

afterEach(() => {
  highlight.release()
  document.querySelectorAll('body > div:not(.pointer-hl)').forEach((n) => n.remove())
})

test('a highlight that follows the pointer moves with its target when the target moves under a still pointer', async () => {
  const box = { left: 50, top: 60, width: 100, height: 40 }
  const a = placed(box)
  highlight.region(a)
  await frames()
  // a region with no radius of its own (jsdom computes none) is grown by REGION_PAD on each side
  expect(hl()).toMatchObject({ on: true, x: 50 - P, y: 60 - P, w: 100 + 2 * P, h: 40 + 2 * P })
  // the canvas zooms out about the pointer: the element shrinks and moves, and no mouse move or scroll comes
  Object.assign(box, { left: 80, top: 70, width: 50, height: 20 })
  await frames()
  expect(hl()).toMatchObject({ on: true, x: 80 - P, y: 70 - P, w: 50 + 2 * P, h: 20 + 2 * P })
})

test('a highlight that follows the pointer fades once its target leaves the page', async () => {
  const a = placed({ left: 50, top: 60, width: 100, height: 40 })
  highlight.region(a)
  await frames()
  expect(hl().on).toBe(true)
  a.remove()
  await frames()
  expect(hl().on).toBe(false)
})
