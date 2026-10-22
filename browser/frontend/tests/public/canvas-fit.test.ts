// The canvas's Fit (src/canvas/layout.ts fitView) shows the whole board, below the 20% the zoom controls stop at when
// the board needs it; from there − and zooming out keep the zoom and + goes back up through 20%.
import { describe, expect, test } from 'vitest'
import { fitView, MIN_SCALE, stepZoom, wheelView, zoomTo } from '../../src/canvas/layout.ts'

describe('Fit on a board taller than 20% shows', () => {
  const tall = { x: 0, y: 0, w: 700, h: 30000 }

  test('every card in the viewport', () => {
    const v = fitView(tall, 1200, 800, 48, 0)
    expect(v.scale).toBeLessThan(MIN_SCALE)
    expect(v.y + tall.h * v.scale).toBeLessThanOrEqual(800 - 48 + 0.001)
    expect(v.y).toBeGreaterThanOrEqual(48 - 0.001)
  })

  test('a zoom that − and the wheel do not lower further, and that + raises to 20%', () => {
    const v = fitView(tall, 1200, 800, 48, 0)
    expect(stepZoom(v.scale, -1)).toBe(v.scale)
    expect(zoomTo(v, stepZoom(v.scale, -1), 600, 400).scale).toBe(v.scale)
    expect(wheelView(v, { deltaX: 0, deltaY: 200, ctrlKey: true }, 600, 400).scale).toBe(v.scale)
    expect(stepZoom(v.scale, 1)).toBe(MIN_SCALE)
    expect(wheelView(v, { deltaX: 0, deltaY: -10, ctrlKey: true }, 600, 400).scale).toBeGreaterThan(v.scale)
  })

  test('while a board that fits at 20% or more keeps the floor', () => {
    expect(fitView({ x: 0, y: 0, w: 700, h: 2000 }, 1200, 800, 48, 0).scale).toBeGreaterThanOrEqual(MIN_SCALE)
    expect(zoomTo({ x: 0, y: 0, scale: 0.3 }, 0.05, 0, 0).scale).toBe(MIN_SCALE)
  })
})
