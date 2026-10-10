// The reader's strip (src/files/Tracks.tsx): its thumb stands for what the reader shows, at least FRAME_MIN_PX tall,
// as a scrollbar's thumb (a drag holds it where it is held); each pixel row takes the one value most of its records
// have; a label's paint comes from the ruler's counts per bin; the strip is as wide as its lanes in the scrollbar's
// geometry, or a plain scrollbar with none; a record's row in the loupe and its one-line tooltip carry its line, a cell
// per lane (the find's in the accent, each color lane the record's own color once it is read, the strip's color for its
// bin, faded, until then), its metadata (its time and who said it) and the start of its text.
import { describe, expect, test } from 'vitest'
import { binOfRow, colorLanes, followOf, frameGeom, frameOf, FRAME_MIN_PX, labelPaint, lineAt, majorityRows, paintAt, PLAIN_PX, recordRow, rowValues, snap, snapPatch, stripWidth, ticksIn, type LoupeRecord, type OverviewPaint } from '../../src/files/Tracks'
import type { LabelRuler } from '../../src/lib/types'

describe('the thumb stands as a scrollbar\'s', () => {
  test('how far through the file the reader stands is its top through the part it can scroll over', () => {
    expect(followOf({ top: 0, height: 0.1 })).toBe(0)
    expect(followOf({ top: 0.45, height: 0.1 })).toBeCloseTo(0.5)
    expect(followOf({ top: 0.9, height: 0.1 })).toBeCloseTo(1)
    expect(followOf({ top: 0, height: 1 })).toBe(0)
  })

  test("the thumb stands for what the reader shows, at least FRAME_MIN_PX tall, at the track's end only at the file's end", () => {
    expect(frameOf({ top: 0.5, height: 0.25 }, 800)).toEqual({ top: 400, height: 200 })
    expect(frameOf({ top: 0.9999, height: 0.0001 }, 800)).toEqual({ top: 800 - FRAME_MIN_PX, height: FRAME_MIN_PX })
    expect(frameOf({ top: 0.5, height: 0.0001 }, 800).top).toBeCloseTo((800 - FRAME_MIN_PX) / 2, 0)
    // a plain scrollbar's thumb takes its own least height
    expect(frameOf({ top: 0, height: 0.0001 }, 800, 32).height).toBe(32)
  })

  test('a drag holds the thumb where it is held, wherever the reader has got to', () => {
    const place = { top: 0.45, height: 0.1 }
    const g = frameGeom(place, 600, null)
    expect(g.f).toBeCloseTo(0.5)
    expect(g.frameTop / (600 - g.frameH)).toBeCloseTo(0.5)
    const held = frameGeom(place, 600, 0.8 * (600 - g.frameH))
    expect(held.f).toBeCloseTo(0.8)
    expect(held.frameTop).toBeCloseTo(0.8 * (600 - g.frameH))
    // held past either end: at the end
    expect(frameGeom(place, 600, 9999).f).toBe(1)
    expect(frameGeom(place, 600, -5).f).toBe(0)
    expect([snap(10.26, 2), snap(10.26, 1), snap(10.2, 3)]).toEqual([10.5, 10, 31 / 3])
  })

  test("the strip is as wide as its lanes in the scrollbar's geometry, a plain scrollbar with none", () => {
    expect(stripWidth(0)).toBe(PLAIN_PX)
    expect(stripWidth(1)).toBe(13)
    expect(stripWidth(3)).toBe(31)
    // Color by off: no lane of colors; a choice and two more: three
    expect(colorLanes({ kind: 'none' }, 0)).toBe(0)
    expect(colorLanes({ kind: 'none' }, 1)).toBe(2)
    expect(colorLanes({ kind: 'counts', counts: [[1]], colors: ['x'], off: [false] }, 2)).toBe(3)
  })
})

describe('the overview takes one value per pixel row', () => {
  test('the value most records in the row have, the first of those as many, none where the row holds none', () => {
    // three values over eight bins, drawn on four rows (two bins a row) and on sixteen (half a bin a row)
    const counts = [
      [5, 0, 1, 1, 0, 0, 2, 0],
      [1, 0, 3, 0, 0, 0, 2, 0],
      [0, 0, 0, 4, 0, 0, 0, 1],
    ]
    expect(Array.from(majorityRows(counts, 4))).toEqual([0, 2, -1, 0])
    const fine = Array.from(majorityRows(counts, 16))
    expect(fine.slice(0, 8)).toEqual([0, 0, -1, -1, 1, 1, 2, 2])
    expect(fine.every((v) => v >= -1 && v <= 2)).toBe(true)
  })

  test("a label's paint is its highlighted values' records per bin, from the ruler's counts, those turned off without color", () => {
    const k = {
      id: 'k1',
      labels: ['coordination', 'link posting', 'other'],
      classes: [
        { name: 'coordination', color: 1, highlight: true },
        { name: 'link posting', color: 2, highlight: true },
        { name: 'other', color: 0, highlight: false },
      ],
    }
    const ruler: LabelRuler = {
      path: 'r.jsonl',
      total: 400,
      bins: 4,
      labels: [{ concept_id: 'k1', bins: { coordination: [0, 2], 'link posting': [0, 1, 2], other: [3] }, counts: { coordination: [9, 1], 'link posting': [2, 7, 4], other: [30] } }],
    }
    const paint = labelPaint(k, ruler, new Set(['link posting']))
    expect(paint).toEqual({ kind: 'counts', counts: [[9, 0, 1, 0], [2, 7, 4, 0]], colors: ['var(--label-1)', 'var(--label-2)'], off: [false, true] })
    // a ruler that gives no counts: a bin that holds a value counts one
    const bare = labelPaint(k, { ...ruler, labels: [{ concept_id: 'k1', bins: ruler.labels[0].bins }] }, new Set())
    expect(bare && bare.kind === 'counts' && bare.counts).toEqual([[1, 0, 1, 0], [1, 1, 1, 0]])
    expect(labelPaint({ ...k, id: 'k2' }, ruler, new Set())).toBeNull()
  })
})

test('a point of the overview names its line and its bin', () => {
  expect(lineAt(0, 100)).toBe(1)
  expect(lineAt(0.5, 100)).toBe(51)
  expect(lineAt(1, 100)).toBe(100)
  expect(binOfRow(0, 100, 1000)).toBe(5)
  expect(binOfRow(99, 100, 1000)).toBe(995)
})

describe('a click on the overview snaps to a thin patch of color near it', () => {
  test("each row's value is the one its paint colors it in, none for a value turned off or with no color", () => {
    const bins = { kind: 'bins' as const, at: [0, 0, 1, -1, 2, 0, 0, 0], colors: ['blue', 'orange', null], off: [false, false, false] }
    expect(Array.from(rowValues(bins, 8))).toEqual([0, 0, 1, -1, -1, 0, 0, 0])
    expect(Array.from(rowValues({ ...bins, off: [false, true, false] }, 8))).toEqual([0, 0, -1, -1, -1, 0, 0, 0])
    expect(Array.from(rowValues({ kind: 'density', bytes: [1, 2, 3] }, 3))).toEqual([-1, -1, -1])
  })

  test('the nearest thin run within reach, at its first row; a click in a tall run, or far from a thin one, does not snap', () => {
    // a tall run of value 0, a thin run of value 1 two rows tall at rows 10 and 11, then value 0 again
    const values = [...Array(10).fill(0), 1, 1, ...Array(20).fill(0)]
    // a click two rows below the thin run, in the tall run: the thin run's first row
    expect(snapPatch(values, 13, 4, 8)).toEqual({ row: 10, value: 1 })
    expect(snapPatch(values, 7, 4, 8)).toEqual({ row: 10, value: 1 })
    expect(snapPatch(values, 11, 4, 8)).toEqual({ row: 10, value: 1 })
    // too far from it, and in a tall run: where it is clicked
    expect(snapPatch(values, 20, 4, 8)).toBeNull()
    // no value near: none
    expect(snapPatch([-1, -1, -1, -1, -1, -1, -1, -1, -1, -1], 5, 4, 8)).toBeNull()
    // two thin runs within reach: the nearer
    expect(snapPatch([-1, 2, -1, -1, -1, -1, 3, -1, -1], 5, 4, 8)).toEqual({ row: 6, value: 3 })
  })
})


describe('the loupe shows each record in its own color', () => {
  const counts: OverviewPaint = { kind: 'counts', counts: [[0, 3, 0, 0], [0, 1, 0, 2]], colors: ['blue', 'orange'], off: [false, false] }
  const bins: OverviewPaint = { kind: 'bins', at: [0, -1, 1, 1], colors: ['blue', 'orange'], off: [false, true] }

  test("a line's color on the strip: its bin's value most records have, none for a value turned off", () => {
    // 400 lines over 4 bins: lines 101 to 200 in the second bin
    expect(paintAt(counts, 150, 400)).toBe('blue')
    expect(paintAt(counts, 50, 400)).toBeNull()
    expect(paintAt(counts, 350, 400)).toBe('orange')
    expect(paintAt(bins, 1, 400)).toBe('blue')
    expect(paintAt(bins, 150, 400)).toBeNull()
    expect(paintAt(bins, 250, 400)).toBeNull()
    expect(paintAt({ kind: 'none' }, 1, 400)).toBeNull()
  })

  test("the marks on lines a to b, from the first that ends at a or after", () => {
    const ticks = [{ from: 1, to: 1, colour: 'k' }, { from: 5, to: 9, colour: 'k' }, { from: 12, to: 12, colour: 'k' }, { from: 30, to: 30, colour: 'k' }]
    expect(ticksIn(ticks, 6, 12).map((t) => t.from)).toEqual([5, 12])
    expect(ticksIn(ticks, 13, 29)).toEqual([])
    expect(ticksIn(ticks, 1, 1).map((t) => t.from)).toEqual([1])
  })

  test("a record's row: its line, a cell per lane (the find's in the accent, a record read in its own color, one not read in the strip's, faded), its metadata and its text", () => {
    const rec: LoupeRecord = { line: 102, lanes: ['blue', null], meta: ['09:12:04', 'GPT-5.4'], text: 'drafting the next update\n for the page' }
    const paints = [counts, { kind: 'none' } as OverviewPaint]
    const ink = 'var(--text-accent)'
    expect(recordRow(102, 400, rec, [ink], paints)).toEqual({ num: '102', cells: [{ colour: ink }, { colour: 'blue' }, null], meta: ['09:12:04', 'GPT-5.4'], text: 'drafting the next update\n for the page' })
    // not read yet: the strip's color for its bin, faded, and no text
    expect(recordRow(150, 400, undefined, [null], paints)).toEqual({ num: '150', cells: [null, { colour: 'blue', faded: true }, null], meta: [], text: '' })
    // read and found to have none: no cell
    expect(recordRow(150, 400, null, [], paints)).toEqual({ num: '150', cells: [null, null], meta: [], text: '' })
    // a line number is plain, as the reader writes it, never with a thousands separator
    expect(recordRow(3998, 10_000, { ...rec, line: 3998 }, [], paints).num).toBe('3998')
    expect(recordRow(12_150, 20_000, null, [], paints).num).toBe('12150')
  })
})
