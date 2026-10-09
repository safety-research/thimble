// The loupe beside a ruler's strip (src/files/Loupe.tsx) and the report's (src/files/Ruler.tsx pageLoupe): it opens
// only where the strip can no longer tell the records apart, shows them at twice the strip's size or more, centred on
// the pointer and kept inside the file, beside the strip and inside the box it opens over, with a bracket beside the
// strip over the stretch it shows; on the report, a few screens of the page, only on a page long enough that it shows
// them larger than the strip does.
import { describe, expect, test } from 'vitest'
import { bracketOf, LOUPE_PAD_PX, LOUPE_PX, LOUPE_ROW_PX, loupeLaneAt, loupeLayout, loupeStart, loupeTop, recordLoupe } from '../../src/files/Loupe'
import { pageLoupe } from '../../src/files/Ruler'

describe("the loupe's records", () => {
  test('no loupe while the strip draws each record LOUPE_ROW_PX tall or taller', () => {
    expect(recordLoupe(100, 600).units).toBe(0)
    expect(recordLoupe(200, 600).units).toBe(0)
    expect(recordLoupe(0, 600).units).toBe(0)
    expect(recordLoupe(1000, 0).units).toBe(0)
  })

  test('a long file: LOUPE_PX of records LOUPE_ROW_PX each; a shorter one at twice the strip, the loupe smaller', () => {
    expect(recordLoupe(10_000, 600)).toEqual({ units: LOUPE_PX / LOUPE_ROW_PX, rowPx: LOUPE_ROW_PX })
    // 300 records in 600 px: the strip draws each 2 px, the loupe 4
    expect(recordLoupe(300, 600)).toEqual({ units: LOUPE_PX / 4, rowPx: 4 })
    for (const total of [201, 250, 400, 1000, 5000, 100_000]) {
      const { units, rowPx } = recordLoupe(total, 600)
      expect(rowPx).toBeGreaterThanOrEqual(Math.min(6, (2 * 600) / total))
      expect(units * rowPx).toBeLessThanOrEqual(LOUPE_PX)
      expect(units).toBeLessThanOrEqual(total)
    }
  })

  test('centred on the pointer, on a whole record, kept inside the file', () => {
    expect(loupeStart(5000.4, 10_000, 72, true)).toBe(5000 - 36)
    expect(loupeStart(10, 10_000, 72, true)).toBe(0)
    expect(loupeStart(9990, 10_000, 72, true)).toBe(10_000 - 72)
    // a file shorter than the loupe: its first record at the top
    expect(loupeStart(20, 50, 72, true)).toBe(0)
    // a page's px, not whole
    expect(loupeStart(1000.5, 20_000, 1600, false)).toBeCloseTo(200.5)
  })

  test('beside the strip, centred on the pointer, inside the box it opens over', () => {
    expect(loupeTop(400, 232, 100, 800)).toBe(284)
    expect(loupeTop(110, 232, 100, 800)).toBe(100)
    expect(loupeTop(790, 232, 100, 800)).toBe(800 - 232)
  })

  test('the bracket over the stretch shown: at least 4 px tall, centred on it, on the strip', () => {
    expect(bracketOf(100, 120, 600)).toEqual({ top: 100, height: 20 })
    expect(bracketOf(100, 101, 600)).toEqual({ top: 98.5, height: 4 })
    expect(bracketOf(599, 600, 600)).toEqual({ top: 596, height: 4 })
  })

  test("its layout: the numbers, the bar beside what is on screen, then the lanes; a pointer's lane, none left of them", () => {
    const L = loupeLayout(3, 72, 3, 30)
    expect(L.height).toBe(72 * 3 + 2 * LOUPE_PAD_PX)
    expect(L.barX).toBeGreaterThan(L.numX)
    expect(L.laneX).toBeGreaterThan(L.barX)
    expect(L.width).toBe(L.laneX + 3 * 7 + 2 * 2 + 8)
    expect(loupeLaneAt(L.laneX + 1, L.laneX, 3)).toBe(0)
    expect(loupeLaneAt(L.laneX + 9 + 3, L.laneX, 3)).toBe(1)
    expect(loupeLaneAt(L.laneX + 100, L.laneX, 3)).toBe(2)
    expect(loupeLaneAt(L.laneX - 10, L.laneX, 3)).toBeNull()
    // no numbers: the bar at the edge
    expect(loupeLayout(1, 10, 3, 0).barX).toBeLessThan(L.barX)
  })
})

describe("the report's loupe", () => {
  test('two screens of the page, only where that shows them at twice the strip or more', () => {
    // a page of 20 screens of 800 px beside a 790 px strip: the loupe shows 1,600 px of it at LOUPE_PX
    const long = pageLoupe(16_000, 790, 800)
    expect(long.units).toBe(1600)
    expect(long.rowPx).toBeCloseTo(LOUPE_PX / 1600)
    expect(long.rowPx).toBeGreaterThanOrEqual((2 * 790) / 16_000)
    // a page of six screens: the strip shows it large enough, so no loupe
    expect(pageLoupe(4800, 790, 800).units).toBe(0)
    // a page shorter than two screens, or none
    expect(pageLoupe(1200, 790, 800).units).toBe(0)
    expect(pageLoupe(0, 790, 800).units).toBe(0)
  })
})
