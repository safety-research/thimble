// @vitest-environment jsdom
// What the ask box of a ⌘-drag over several anchors is about (src/pointer/capture.ts commonElement): the nearest element
// that holds them all when it has a box on screen. The canvas's cards sit on its plane, an element of no size at the
// board's origin, which shows nowhere once the board is panned from its start: a drag across two cards there is about
// the first card, so the box shows beside the cards and its picture is of a card.
import { afterEach, expect, test } from 'vitest'
import { commonElement } from '../../src/pointer/capture.ts'

/** `el` with the box on screen `box` holds: jsdom lays nothing out. */
function boxed<T extends HTMLElement>(el: T, box: { left: number; top: number; width: number; height: number }): T {
  el.getBoundingClientRect = () => new DOMRect(box.left, box.top, box.width, box.height)
  return el
}

afterEach(() => {
  document.body.innerHTML = ''
})

test('a drag across two cards on the canvas is about the first card, not the plane of no size that holds them', () => {
  const plane = boxed(document.body.appendChild(document.createElement('div')), { left: 340, top: -2600, width: 0, height: 0 })
  const a = boxed(plane.appendChild(document.createElement('div')), { left: 600, top: 120, width: 560, height: 420 })
  const b = boxed(plane.appendChild(document.createElement('div')), { left: 600, top: 560, width: 560, height: 300 })
  expect(commonElement([a, b])).toBe(a)
})

test('a drag across two passages of one block is about the block that holds them', () => {
  const block = boxed(document.body.appendChild(document.createElement('div')), { left: 600, top: 120, width: 560, height: 200 })
  const a = boxed(block.appendChild(document.createElement('span')), { left: 600, top: 120, width: 560, height: 40 })
  const b = boxed(block.appendChild(document.createElement('span')), { left: 600, top: 180, width: 300, height: 40 })
  expect(commonElement([a, b])).toBe(block)
})
