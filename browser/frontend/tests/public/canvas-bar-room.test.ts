// The bar at the top of the board (Card, Group, Comments; canvas.css .bctl-top, 14 px down and 34 px tall) covers no
// card the canvas brings into view (src/canvas/layout.ts openOn, showCard; Canvas.tsx): a frame opens with its title
// under the bar, and a card taller than the room under the bar shows from its top, under the bar.
import { expect, test } from 'vitest'
import * as layout from '../../src/canvas/layout.ts'
import { openOn, TITLE, type Rect, type View } from '../../src/canvas/layout.ts'

/** the bar's bottom edge in the viewport, screen px */
const BAR_BOTTOM = 14 + 34
const top = (v: View, r: Rect) => v.y + r.y * v.scale

test("a frame opens with its title row under the bar", () => {
  const frame = { x: 40, y: 60, w: 760, h: 900 }
  const v = openOn({ x: 0, y: 0, scale: 0.8 }, frame, 700, 234)
  // the title row stands TITLE above the frame's box
  expect(top(v, frame) - TITLE * v.scale).toBeGreaterThanOrEqual(BAR_BOTTOM)
})

test('a card taller than the room under the bar shows from its top, under the bar; a short one stays centred', () => {
  const showCard = (layout as unknown as { showCard?: (v: View, r: Rect, vw: number, vh: number) => View }).showCard
  expect(typeof showCard).toBe('function')
  const tall = { x: 60, y: 400, w: 720, h: 1600 }
  const v = showCard!({ x: 0, y: 0, scale: 0.8 }, tall, 950, 760)
  expect(top(v, tall)).toBeGreaterThanOrEqual(BAR_BOTTOM)
  expect(top(v, tall)).toBeLessThan(BAR_BOTTOM + 24)
  expect(v.x + (tall.x + tall.w / 2) * v.scale).toBe(950 / 2)
  const short = { x: 60, y: 400, w: 720, h: 200 }
  const c = showCard!({ x: 0, y: 0, scale: 0.8 }, short, 950, 760)
  expect(top(c, short) + (short.h * c.scale) / 2).toBe(760 / 2)
})
