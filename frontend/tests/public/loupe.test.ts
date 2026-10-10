// The loupe beside a ruler's strip (src/files/Loupe.tsx) and the report's (src/files/Ruler.tsx): it opens only where the
// strip can no longer tell the records apart, as a short list of LOUPE_ROWS lines, the pointer's record in the middle
// line, kept inside the file, beside the strip and inside the box it opens over, with a bracket beside the strip over
// the stretch it shows. What it shows follows the pointer, the scroll position after a wheel or a drag of the thumb, or
// stays where it is once the pointer is in it; the reader's place changing by itself never moves it to the thumb. On
// the report a line is a passage, and the loupe opens only on a page long enough.
import { describe, expect, test } from 'vitest'
import { anchorAfter, bracketOf, loupeHeight, LOUPE_PAD_PX, LOUPE_ROW_PX, LOUPE_ROWS, loupeStart, loupeTop, loupeWidth, oneLine, onScreen, recordLoupe, rowKey, type LoupeAnchor, type LoupeEvent } from '../../src/files/Loupe'
import { pageLoupe, passageAt, passageCells, passagePx } from '../../src/files/Ruler'

describe("the loupe's rows", () => {
  test('no loupe while the strip draws each record TELL_APART_PX tall or taller; LOUPE_ROWS lines past that', () => {
    expect(recordLoupe(100, 600)).toBe(0)
    expect(recordLoupe(200, 600)).toBe(0)
    expect(recordLoupe(0, 600)).toBe(0)
    expect(recordLoupe(1000, 0)).toBe(0)
    for (const total of [201, 1000, 10_000, 100_000]) expect(recordLoupe(total, 600)).toBe(LOUPE_ROWS)
    expect(LOUPE_ROWS).toBe(17)
    expect(LOUPE_ROW_PX).toBe(16)
  })

  test("the pointer's record in the middle line, kept inside the file", () => {
    expect(loupeStart(5000.4, 10_000, 17)).toBe(5000 - 8)
    expect(loupeStart(5000.99, 10_000, 17)).toBe(5000 - 8)
    expect(loupeStart(3, 10_000, 17)).toBe(0)
    expect(loupeStart(9999.5, 10_000, 17)).toBe(10_000 - 17)
    // fewer records than lines: from the first
    expect(loupeStart(5, 9, 9)).toBe(0)
  })

  test('its size: the lines, the paper above and below, its edge; as wide as the room leaves, 200 to 320 px', () => {
    expect(loupeHeight(17)).toBe(17 * 16 + 2 * LOUPE_PAD_PX + 2)
    expect(loupeWidth(1000)).toBe(320)
    expect(loupeWidth(300)).toBe(276)
    expect(loupeWidth(100)).toBe(200)
  })

  test('beside the strip, centred on the pointer, inside the box it opens over', () => {
    expect(loupeTop(400, 282, 100, 800)).toBe(259)
    expect(loupeTop(110, 282, 100, 800)).toBe(100)
    expect(loupeTop(790, 282, 100, 800)).toBe(800 - 282)
  })

  test('the records on screen are those the view overlaps', () => {
    expect(onScreen(10, [10.5, 30.2])).toBe(true)
    expect(onScreen(30, [10.5, 30.2])).toBe(true)
    expect(onScreen(9, [10.5, 30.2])).toBe(false)
    expect(onScreen(31, [10.5, 30.2])).toBe(false)
    expect(onScreen(9, [10, 30])).toBe(false)
    expect(onScreen(30, [10, 30])).toBe(false)
  })

  test('the bracket over the stretch shown: at least 4 px tall, centred on it, on the strip', () => {
    expect(bracketOf(100, 120, 600)).toEqual({ top: 100, height: 20 })
    expect(bracketOf(100, 101, 600)).toEqual({ top: 98.5, height: 4 })
    expect(bracketOf(599, 600, 600)).toEqual({ top: 596, height: 4 })
  })

  test("a record's text on one line, cut with an ellipsis; a row's key changes with what it shows", () => {
    expect(oneLine('  drafting the next\n update  for the page ')).toBe('drafting the next update for the page')
    expect(oneLine('x'.repeat(400))).toHaveLength(200)
    expect(oneLine('x'.repeat(400)).endsWith('…')).toBe(true)
    const row = { num: '3,998', cells: [null, { colour: 'blue' }], meta: ['09:12:04', 'GPT-5.4'], text: 'drafting' }
    expect(rowKey(row)).toBe(rowKey({ ...row }))
    expect(rowKey(row)).not.toBe(rowKey({ ...row, cells: [null, { colour: 'blue', faded: true }] }))
    expect(rowKey(row)).not.toBe(rowKey({ ...row, text: 'drafted' }))
    expect(rowKey(row)).not.toBe(rowKey({ ...row, meta: ['09:12:04', 'GPT-5.5'] }))
    expect(rowKey(row)).not.toBe(rowKey({ ...row, meta: ['09:12:04 GPT-5.4'] }))
  })
})

describe('what the loupe follows', () => {
  const run = (from: LoupeAnchor, evs: LoupeEvent[]) => evs.reduce(anchorAfter, from)

  test('the pointer along the strip, the scroll position after a wheel or a drag of the thumb, its own rows once in it', () => {
    expect(anchorAfter('view', 'strip')).toBe('pointer')
    expect(anchorAfter('fixed', 'strip')).toBe('pointer')
    expect(anchorAfter('pointer', 'wheel')).toBe('view')
    expect(anchorAfter('fixed', 'wheel')).toBe('view')
    expect(anchorAfter('pointer', 'thumb')).toBe('view')
    expect(anchorAfter('pointer', 'into')).toBe('fixed')
    // a click in a loupe that followed the wheel keeps its rows
    expect(anchorAfter('view', 'click')).toBe('fixed')
  })

  test("the reader's place changing by itself never changes what it follows: a loupe on the pointer stays there", () => {
    for (const a of ['pointer', 'view', 'fixed'] as const) expect(anchorAfter(a, 'scroll')).toBe(a)
    // along the strip while the reader moves under it (records loading, a browser rounding its scroll): the pointer
    expect(run('pointer', ['strip', 'scroll', 'strip', 'scroll', 'scroll', 'strip', 'scroll'])).toBe('pointer')
    // a click in the loupe goes to a record, and the reader's jump there leaves its rows
    expect(run('pointer', ['into', 'click', 'scroll', 'scroll'])).toBe('fixed')
    // the wheel in the loupe: its rows follow the scroll position
    expect(run('pointer', ['into', 'wheel', 'scroll'])).toBe('view')
  })
})

describe("the report's loupe", () => {
  test('only on a page where two screens at the loupe\'s height are twice the strip or more', () => {
    expect(pageLoupe(16_000, 790, 800)).toBe(true)
    expect(pageLoupe(22_400, 548, 560)).toBe(true)
    // a page of six screens, or four: the strip shows it large enough
    expect(pageLoupe(4800, 790, 800)).toBe(false)
    expect(pageLoupe(2240, 548, 560)).toBe(false)
    // a page shorter than two screens, or none
    expect(pageLoupe(1200, 790, 800)).toBe(false)
    expect(pageLoupe(0, 790, 800)).toBe(false)
  })

  test('a line per passage: a place of the page is the passage from its top to the next one, and back', () => {
    const tops = [0, 100, 160, 400]
    expect(passageAt(tops, 0, 1000)).toBe(0)
    expect(passageAt(tops, 50, 1000)).toBe(0.5)
    expect(passageAt(tops, 130, 1000)).toBe(1.5)
    expect(passageAt(tops, 700, 1000)).toBe(3.5)
    expect(passageAt(tops, -20, 1000)).toBe(0)
    for (const y of [0, 37, 100, 159, 160, 399, 401, 999]) expect(passagePx(tops, passageAt(tops, y, 1000), 1000)).toBeCloseTo(y)
    expect(passagePx(tops, 4, 1000)).toBe(1000)
    expect(passageAt([], 10, 100)).toBe(0)
  })

  test("a passage's cells: per lane the color of a mark over it, none where a mark stops at its edge", () => {
    const passages = [
      { top: 0, bottom: 90, text: 'Title', heading: true },
      { top: 100, bottom: 150, text: 'First' },
      { top: 160, bottom: 390, text: 'Second' },
    ]
    const columns = [
      { id: 'a', name: 'A', total: 400, ticks: [{ from: 101, to: 150, colour: 'blue' }] },
      { id: 'b', name: 'B', total: 400, ticks: [{ from: 200, to: 220, colour: 'green' }, { from: 1, to: 100, colour: 'green' }] },
    ]
    expect(passageCells(passages, columns)).toEqual([
      [null, { colour: 'green' }],
      [{ colour: 'blue' }, null],
      [null, { colour: 'green' }],
    ])
  })
})
