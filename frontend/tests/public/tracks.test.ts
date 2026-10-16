// The reader's strip (src/files/Tracks.tsx): its thumb stands for what the reader shows, at least FRAME_MIN_PX tall,
// as a scrollbar's thumb (a drag holds it where it is held); each pixel row takes the one value most of its records
// have; a label's paint comes from the ruler's counts per bin; the strip is as wide as its lanes in the scrollbar's
// geometry, or a plain scrollbar with none; a record's row in the loupe and its one-line tooltip carry its line, a cell
// per lane (the find's in the accent, each color lane the record's own color once it is read, the strip's color for its
// bin, faded, until then), its metadata (its time and who said it) and the start of its text.
import { describe, expect, test } from 'vitest'
import { followOf, labelPaint } from '../../src/files/Tracks'
import type { LabelRuler } from '../../src/lib/types'

describe('the thumb stands as a scrollbar\'s', () => {
  test('how far through the file the reader stands is its top through the part it can scroll over', () => {
    expect(followOf({ top: 0, height: 0.1 })).toBe(0)
    expect(followOf({ top: 0.45, height: 0.1 })).toBeCloseTo(0.5)
    expect(followOf({ top: 0.9, height: 0.1 })).toBeCloseTo(1)
    expect(followOf({ top: 0, height: 1 })).toBe(0)
  })
})

describe('the overview takes one value per pixel row', () => {

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
