// @vitest-environment jsdom
// The tour's Labels example (src/tour/steps.ts labelsExample, over src/tour/examples.json txReader and labelsSide)
// agrees with itself: the ruler the step draws beside the transcript is drawn from the records it shows, a mark in a
// lane per label over each run of records lit in one colour, at their place in the file, in their cells' colour; and
// the Labels sidebar's legend names those colours and counts those records. The example shows one label, with few
// values, and the step says what the bars beside the records and the strip at the right of the transcript mean, in
// words that hold for every record it shows.
import { expect, test } from 'vitest'
import { rulerWidth } from '../../src/files/Ruler.tsx'
import { createTour, type Api, type Snaps } from '../../src/tour/engine.ts'
import snaps from '../../src/tour/examples.json'
import { tourSteps } from '../../src/tour/steps.ts'

const LINES = 76
const html = (s: string) => {
  const d = document.createElement('div')
  d.innerHTML = s
  return d
}
/** The example of the step titled `title`, drawn as the tour draws it (engine.ts startRun) on a page with nothing of
 * thimble's: by the tour's own api, into a layer of the test's own, since the tour makes its layers when it starts. */
const drawExample = (title: string) => {
  const api: Api = { ...createTour(snaps as Snaps).api, ex: document.createElement('div') }
  return tourSteps('⌘').find((s) => s.title === title)!.example!(api)
}
/** Each lit gutter cell of the example's records: its lane (its place in the gutter), its record's line and colour. */
const litCells = (reader: Element) =>
  [...reader.querySelectorAll<HTMLElement>('.reader-record[data-line]')].flatMap((rec) =>
    [...rec.querySelectorAll<HTMLElement>('.reader-gutter-cell')].flatMap((cell, lane) => (cell.classList.contains('is-lit') ? [{ lane, line: Number(rec.dataset.line), colour: cell.style.background }] : [])),
  )

test('the transcript holds no picture of a ruler drawn in other colours', () => {
  expect(snaps.txReader).not.toMatch(/data:image|<img /)
})

test("the step's ruler marks the records' lit cells: in their lane, at their lines of the file, in their colour", () => {
  const reader = drawExample('Labels').els!.reader as HTMLElement
  const lanes = [...reader.querySelectorAll<HTMLElement>('.reader-ruler-bar > .reader-ruler-marks > *')]
  // a lane is 7 px wide, 2 px from the next, 3 px in (files/Ruler.tsx TRACK_LANES), and holds a row per line
  expect(lanes.map((l) => [l.style.left, l.style.width])).toEqual([['3px', '7px']])
  for (const l of lanes) expect(l.style.gridTemplateRows).toBe(`repeat(${LINES}, minmax(0, 1fr))`)
  // every line each mark spans, by lane, with its colour: exactly the lit cells
  const marks = lanes.flatMap((l, lane) => [...l.children].map((m) => ({ lane, m: m as HTMLElement })))
  const covered = marks.flatMap(({ lane, m }) => {
    const [from, end] = m.style.gridRow.split('/').map(Number)
    return Array.from({ length: end - from }, (_, i) => `${lane}:${from + i}:${m.style.background}`)
  })
  const cells = litCells(reader).map((c) => `${c.lane}:${c.line}:${c.colour}`)
  expect(cells.length).toBe(18)
  expect(covered.sort()).toEqual(cells.sort())
  // a run of records lit one after another in one colour is one mark
  expect(marks.length).toBeLessThan(cells.length)
})

test("the Labels sidebar's legend names the records' colours and counts the records lit in each", () => {
  const cells = litCells(html(snaps.txReader))
  const side = html(snaps.labelsSide)
  const rows = [...side.querySelectorAll<HTMLElement>('.lside-row')]
  expect(rows.map((r) => r.querySelector('.lside-name')?.textContent)).toEqual(['coordinates with other agents'])
  const named = new Set<string>()
  for (const row of rows) {
    const values = [...row.querySelectorAll<HTMLElement>('.lside-value')].map((v) => ({
      colour: v.querySelector<HTMLElement>('.lside-swatch')!.style.getPropertyValue('--sw'),
      hollow: v.querySelector('.lside-swatch')!.classList.contains('is-hollow'),
      n: Number(v.querySelector('.lside-n')!.textContent),
    }))
    // every value of a label together counts the file's records
    expect(values.reduce((a, v) => a + v.n, 0)).toBe(LINES)
    for (const v of values.filter((v) => !v.hollow)) {
      named.add(v.colour)
      expect(cells.filter((c) => c.colour === v.colour).length, v.colour).toBe(v.n)
    }
  }
  expect([...new Set(cells.map((c) => c.colour))].every((c) => named.has(c))).toBe(true)
})

test('the example shows one label, with few values: one lane beside the records and one label in the sidebar', () => {
  const side = html(snaps.labelsSide)
  const rows = [...side.querySelectorAll<HTMLElement>('.lside-row')]
  expect(rows.length).toBe(1)
  expect(side.querySelector('.lside-heading .lside-n')?.textContent).toBe('1')
  expect(rows[0].querySelectorAll('.lside-value').length).toBeLessThanOrEqual(3)
  const reader = html(snaps.txReader)
  const gutters = [...reader.querySelectorAll('.reader-record[data-line] .reader-gutter')]
  expect(gutters.length).toBeGreaterThan(0)
  expect(gutters.every((g) => g.querySelectorAll('.reader-gutter-cell').length === 1)).toBe(true)
  expect(reader.querySelectorAll('.reader-lanehead-tag').length).toBe(1)
  expect(reader.querySelector<HTMLElement>('.reader-body')!.style.getPropertyValue('--lanes')).toBe('1')
  // the ruler as wide as thimble draws it for one lane
  expect(reader.querySelector<HTMLElement>('.reader-ruler-bar')!.style.width).toBe(`${rulerWidth(1)}px`)
})

test('the Labels step says what the bars and the strip at the right mean, in words true of every record it shows', () => {
  const body = tourSteps('⌘').find((s) => s.title === 'Labels')!.body as string
  // the strip beside the transcript is named by what it is: the Canvas has its own Minimap
  expect(body).not.toMatch(/minimap/i)
  expect(body).toMatch(/The bar beside a record is in the color of its value, or empty if its value has no color\./)
  expect(body).toMatch(/The strip at the right shows where the colored bars are in the whole file\./)
  // and so it is for every record of the example: its bar is lit in the color of a value with a color, or it is empty,
  // and empty only where the label has a value with no color (a hollow swatch)
  const values = [...html(snaps.labelsSide).querySelectorAll<HTMLElement>('.lside-value .lside-swatch')].map((s) => ({ colour: s.style.getPropertyValue('--sw'), hollow: s.classList.contains('is-hollow') }))
  const coloured = new Set(values.filter((v) => !v.hollow).map((v) => v.colour))
  const cells = [...html(snaps.txReader).querySelectorAll<HTMLElement>('.reader-record[data-line] .reader-gutter-cell')]
  const lit = cells.filter((c) => c.classList.contains('is-lit'))
  const empty = cells.filter((c) => !c.classList.contains('is-lit'))
  expect(lit.length).toBeGreaterThan(0)
  expect(empty.length).toBeGreaterThan(0)
  expect(lit.every((c) => coloured.has(c.style.background))).toBe(true)
  expect(empty.every((c) => !c.style.background)).toBe(true)
  expect(values.some((v) => v.hollow)).toBe(true)
})
