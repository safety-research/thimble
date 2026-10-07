// The geometry of the reader's two tracks (src/files/Tracks.tsx): the zoomed track's stretch follows the overview's
// frame, so that its lens stands as far down it as the frame stands down the overview (in the middle of the file in
// the middle, at the file's ends at the track's ends, kept inside the content there); the two lines join the frame's
// top and bottom to the lens's; each pixel row of the overview takes the one value most of its records have; a label's
// paint comes from the ruler's counts per bin; the overview's frame is at least FRAME_MIN_PX tall.
import { describe, expect, test } from 'vitest'
import { binOfRow, followOf, frameOf, FRAME_MIN_PX, labelPaint, LENS_OUT_PX, LENS_RADIUS_PX, lensOf, lineAt, LINK_PX, linkOf, majorityRows, markerText, snap, zoomWindow, ZOOM_SPAN } from '../../src/files/Tracks'
import type { LabelRuler } from '../../src/lib/types'

describe('the zoomed track follows the frame', () => {
  test('how far through the file the reader stands is its top through the part it can scroll over', () => {
    expect(followOf({ top: 0, height: 0.1 })).toBe(0)
    expect(followOf({ top: 0.45, height: 0.1 })).toBeCloseTo(0.5)
    expect(followOf({ top: 0.9, height: 0.1 })).toBeCloseTo(1)
    expect(followOf({ top: 0, height: 1 })).toBe(0)
  })

  test('the reader stands as far down the stretch as it is through the file, so the lens moves with the frame', () => {
    const h = 400
    const span = h * ZOOM_SPAN
    // in the middle of a long file the part shown is in the middle of the stretch
    const [a, b] = zoomWindow(50_000, h, 100_000, 0.5)
    expect(b - a).toBe(span)
    expect(50_000 - a).toBe((span - h) / 2)
    // a tenth of the way through, a tenth of the way down the stretch: the lens is not held in the middle
    for (const f of [0.1, 0.3, 0.8]) {
      const [from] = zoomWindow(20_000, h, 100_000, f)
      const lens = (20_000 - from) / span
      const frame = f * (1 - h / span)
      expect(lens).toBeCloseTo(frame)
    }
  })

  test("at the file's ends the stretch stays inside the content, and the part shown moves within it", () => {
    const h = 400
    expect(zoomWindow(0, h, 20_000, 0)).toEqual([0, h * ZOOM_SPAN])
    expect(zoomWindow(19_600, h, 20_000, 1)).toEqual([20_000 - h * ZOOM_SPAN, 20_000])
    // near the top: the stretch starts at the content's top, and the part shown stands below it, not in its middle
    const [from] = zoomWindow(10, h, 20_000, 0.02)
    expect(from).toBe(0)
    // a whole file shorter than the stretch: the stretch is the file
    expect(zoomWindow(0, h, 300, 0)).toEqual([0, h])
    expect(zoomWindow(500, h, 1200, 1)).toEqual([0, 1200])
  })

  test('the stretch is not held at the edge of the records the reader holds when the file goes on past them', () => {
    const h = 400
    // the reader holds records 5,001 to 5,200 of a long file: the first of them is not the file's first
    const [from, to] = zoomWindow(200, h, 30_000, 0.5, false, true)
    expect(from).toBe(200 - (h * ZOOM_SPAN - h) / 2)
    expect(to - from).toBe(h * ZOOM_SPAN)
  })

  test("the overview's frame stands for what the reader shows, at least FRAME_MIN_PX tall, on the track", () => {
    expect(frameOf({ top: 0.5, height: 0.25 }, 800)).toEqual({ top: 400, height: 200 })
    expect(frameOf({ top: 0.999, height: 0.0001 }, 800)).toEqual({ top: 800 - FRAME_MIN_PX, height: FRAME_MIN_PX })
  })

  test("the two lines join the frame's corners to the lens's left edge where its corners' curves end, on whole device pixels", () => {
    const lens = lensOf(300, 460)
    expect(lens).toEqual({ top: 300 - LENS_OUT_PX, height: 160 + 2 * LENS_OUT_PX })
    const x = LINK_PX - LENS_OUT_PX
    const r = LENS_RADIUS_PX
    // at a pixel ratio of 2 a 1px line is two device pixels wide: its ends are the corners themselves
    const two = linkOf({ top: 395, height: 8 }, lens, 2)
    expect(two.top).toEqual([0, 395, x, 297 + r])
    expect(two.bottom).toEqual([0, 403, x, 463 - r])
    // at 1, one device pixel wide: its ends half a pixel into the frame's and the lens's edges
    const one = linkOf({ top: 395, height: 8 }, lens, 1)
    expect(one.top).toEqual([-0.5, 395.5, x + 0.5, 297 + r])
    expect(one.bottom).toEqual([-0.5, 402.5, x + 0.5, 463 - r])
    // the wedge reaches the edges themselves
    expect(one.points).toBe(`0,395 ${x},${297 + r} ${x},${463 - r} 0,403`)
    expect([snap(10.26, 2), snap(10.26, 1), snap(10.2, 3)]).toEqual([10.5, 10, 31 / 3])
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

  test("a label's paint is its highlighted values' records per bin, from the ruler's counts, those turned off faded", () => {
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
    expect(paint).toEqual({ kind: 'counts', counts: [[9, 0, 1, 0], [2, 7, 4, 0]], colors: ['var(--label-1)', 'var(--label-2)'], faded: [false, true] })
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

test("a marker says the label's name, with its value when the label has several", () => {
  expect(markerText({ id: 'a', name: 'edit purpose', valued: true, total: 10, ticks: [] }, { from: 1, to: 1, colour: '', value: 'posts links' })).toBe('edit purpose: posts links')
  expect(markerText({ id: 'b', name: 'says so', total: 10, ticks: [] }, { from: 1, to: 1, colour: '', value: 'says so' })).toBe('says so')
})
