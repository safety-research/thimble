// The canvas's zoom by the wheel (src/canvas/layout.ts wheelView): a trackpad's pinch, which arrives as ctrl a few
// pixels an event, zooms by a few percent an event, so a pinch across the trackpad zooms by half or more; ⌘ alone, also
// the pointer's key, zooms at a fifth of that, so a ⌘ scroll on a trackpad, a run of small events, zooms by a bounded
// factor; a ⌘ or ctrl turn of a mouse's wheel, a notch of 100 pixels or 3 lines, zooms in by at most a quarter and out
// by at most a fifth; the point under the pointer stays put, and a turn without ⌘ or ctrl pans.
import { describe, expect, test } from 'vitest'
import { MAX_SCALE, wheelView, WHEEL_ZOOM_MAX, type View, type WheelLike } from '../../src/canvas/layout.ts'

const view: View = { x: 40, y: 30, scale: 0.8 }
const zoomed = (e: Omit<WheelLike, 'deltaX'>) => wheelView(view, { deltaX: 0, ...e }, 600, 400).scale / view.scale

describe('the wheel zooms the canvas', () => {
  test('a pinch zooms by a few percent an event, and a pinch across the trackpad by half or more', () => {
    expect(zoomed({ deltaY: -4, ctrlKey: true })).toBeGreaterThan(1.03)
    let v = view
    for (let i = 0; i < 12; i++) v = wheelView(v, { deltaX: 0, deltaY: -4, ctrlKey: true }, 600, 400)
    expect(v.scale / view.scale).toBeGreaterThan(1.5)
  })

  test("a mouse's notch, in pixels or lines, with ⌘ or ctrl, zooms by one bounded step", () => {
    for (const e of [{ deltaY: -100, metaKey: true }, { deltaY: -100, ctrlKey: true }, { deltaY: -3, deltaMode: 1, ctrlKey: true }, { deltaY: -1, deltaMode: 2, metaKey: true }]) {
      expect(zoomed(e), JSON.stringify(e)).toBeGreaterThan(1.1)
      expect(zoomed(e), JSON.stringify(e)).toBeLessThanOrEqual(WHEEL_ZOOM_MAX + 1e-9)
    }
    expect(zoomed({ deltaY: 100, ctrlKey: true })).toBeCloseTo(1 / WHEEL_ZOOM_MAX, 9)
    expect(zoomed({ deltaY: 1, deltaMode: 2, metaKey: true })).toBeCloseTo(1 / WHEEL_ZOOM_MAX, 9)
  })

  test("a ⌘ scroll on a trackpad, a run of small events, zooms by a bounded factor, where a pinch's rate meets the bound", () => {
    const run = (keys: Pick<WheelLike, 'ctrlKey' | 'metaKey'>) => {
      let v = view
      for (let i = 0; i < 20; i++) v = wheelView(v, { deltaX: 0, deltaY: -10, ...keys }, 600, 400)
      return v.scale / view.scale
    }
    expect(run({ metaKey: true })).toBeGreaterThan(1.2)
    expect(run({ metaKey: true })).toBeLessThan(1.6)
    expect(run({ metaKey: true, ctrlKey: true })).toBeCloseTo(MAX_SCALE / view.scale, 9)
  })

  test('the point under the pointer stays put, and a turn without ⌘ or ctrl pans', () => {
    const v = wheelView(view, { deltaX: 0, deltaY: -40, ctrlKey: true }, 600, 400)
    expect((600 - v.x) / v.scale).toBeCloseTo((600 - view.x) / view.scale, 9)
    expect((400 - v.y) / v.scale).toBeCloseTo((400 - view.y) / view.scale, 9)
    expect(wheelView(view, { deltaX: 10, deltaY: 40 }, 600, 400)).toEqual({ x: 30, y: -10, scale: 0.8 })
  })
})
