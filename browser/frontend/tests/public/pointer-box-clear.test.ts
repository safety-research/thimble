// The ⌘-click box keeps clear of the controls that float over a pane (src/pointer/PointerBox.tsx boxPlace, FLOATING;
// the board's bars, src/canvas/Controls.tsx): beside a card at the top of the board it goes under the bar of Card,
// Group and Comments rather than over it, still beside the card; beside a card at the bottom it goes over the zoom bar
// and the minimap; under a line of text it goes past the bar without covering the line; with no control in the way it
// goes where it always went.
import { expect, test } from 'vitest'
import type { Box } from '../../src/pointer/anchors.ts'
import { BOX_WIDTH, boxPlace, GAP_BESIDE, MARGIN, type Place } from '../../src/pointer/PointerBox.tsx'

// a 1440 × 1000 window with the chat at the left, the board beside it; the bars as the board draws them
const VW = 1440
const VH = 1000
const H = 38
const BESIDE: Place = { under: false, host: null, pane: { left: 332, top: 40, right: 1428, bottom: 988 } }
const BAR: Box = { left: 1173, top: 54, right: 1414, bottom: 88 }
const NAV: Box = { left: 1210, top: 798, right: 1414, bottom: 948 }
const box = (p: { left: number; top: number }): Box => ({ left: p.left, top: p.top, right: p.left + BOX_WIDTH, bottom: p.top + H })
const meet = (a: Box, b: Box) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top

test('beside a card at the top of the board, the box goes under the bar, still beside the card', () => {
  const card: Box = { left: 513, top: 44, right: 1090, bottom: 238 }
  const p = boxPlace(card, BOX_WIDTH, H, VW, VH, BESIDE, [BAR, NAV])
  expect(meet(box(p), BAR)).toBe(false)
  expect(p).toEqual({ left: card.right + GAP_BESIDE, top: BAR.bottom + MARGIN, under: false })
  expect(p.top).toBeLessThan(card.bottom)
  // with no control in the way, the place it always had
  expect(boxPlace(card, BOX_WIDTH, H, VW, VH, BESIDE)).toEqual({ left: card.right + GAP_BESIDE, top: card.top + 8, under: false })
})

test('beside a card at the bottom of the board, the box goes over the zoom bar and the minimap', () => {
  const card: Box = { left: 600, top: 760, right: 1100, bottom: 960 }
  const p = boxPlace(card, BOX_WIDTH, H, VW, VH, BESIDE, [BAR, NAV])
  expect(meet(box(p), NAV)).toBe(false)
  expect(p).toEqual({ left: card.right + GAP_BESIDE, top: NAV.top - MARGIN - H, under: false })
})

test('under a line of text by the bar, the box goes past the bar and leaves the line uncovered', () => {
  const line: Box = { left: 1200, top: 30, right: 1300, bottom: 48 }
  const p = boxPlace(line, BOX_WIDTH, H, VW, VH, { under: true }, [BAR, NAV])
  expect(meet(box(p), BAR)).toBe(false)
  expect(meet(box(p), line)).toBe(false)
  expect(p.top).toBe(BAR.bottom + MARGIN)
})
