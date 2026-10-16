// The canvas's Fit (src/canvas/layout.ts fitView) shows the whole board, below the 20% the zoom controls stop at when
// the board needs it; from there − and zooming out keep the zoom and + goes back up through 20%.
import { describe, expect, test } from 'vitest'
import { fitView, MIN_SCALE } from '../../src/canvas/layout.ts'

describe('Fit on a board taller than 20% shows', () => {
  const tall = { x: 0, y: 0, w: 700, h: 30000 }

  test('every card in the viewport', () => {
    const v = fitView(tall, 1200, 800, 48, 0)
    expect(v.scale).toBeLessThan(MIN_SCALE)
    expect(v.y + tall.h * v.scale).toBeLessThanOrEqual(800 - 48 + 0.001)
    expect(v.y).toBeGreaterThanOrEqual(48 - 0.001)
  })
})
