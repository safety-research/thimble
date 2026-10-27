// @vitest-environment jsdom
// The tour's Labels example (src/tour/examples.json txReader, labelsSide; src/tour/steps.ts drawRuler) agrees with
// itself: the ruler beside the transcript is drawn from the records it shows, a mark in a lane per label over each run
// of records lit in one colour, at their place in the file, in their cells' colour; and the Labels sidebar's legend
// names those colours and counts those records.
import { expect, test } from 'vitest'
import snaps from '../../src/tour/examples.json'
import { drawRuler } from '../../src/tour/steps.ts'

const LINES = 76
const html = (s: string) => {
  const d = document.createElement('div')
  d.innerHTML = s
  return d
}
/** Each lit gutter cell of the example's records: its lane (its place in the gutter), its record's line and colour. */
const litCells = (reader: Element) =>
  [...reader.querySelectorAll<HTMLElement>('.reader-record[data-line]')].flatMap((rec) =>
    [...rec.querySelectorAll<HTMLElement>('.reader-gutter-cell')].flatMap((cell, lane) => (cell.classList.contains('is-lit') ? [{ lane, line: Number(rec.dataset.line), colour: cell.style.background }] : [])),
  )

test('the transcript holds no picture of a ruler drawn in other colours', () => {
  expect(snaps.txReader).not.toMatch(/data:image|<img /)
})

test("the ruler's marks are the records' lit cells: in their lane, at their lines of the file, in their colour", () => {
  const reader = html(snaps.txReader)
  drawRuler(reader, LINES)
  const lanes = [...reader.querySelectorAll<HTMLElement>('.reader-ruler-bar > .reader-ruler-marks > *')]
  // a lane is 7 px wide, 2 px from the next, 3 px in (files/Ruler.tsx TRACK_LANES), and holds a row per line
  expect(lanes.map((l) => [l.style.left, l.style.width])).toEqual([['3px', '7px'], ['12px', '7px']])
  for (const l of lanes) expect(l.style.gridTemplateRows).toBe(`repeat(${LINES}, minmax(0, 1fr))`)
  // every line each mark spans, by lane, with its colour: exactly the lit cells
  const marks = lanes.flatMap((l, lane) => [...l.children].map((m) => ({ lane, m: m as HTMLElement })))
  const covered = marks.flatMap(({ lane, m }) => {
    const [from, end] = m.style.gridRow.split('/').map(Number)
    return Array.from({ length: end - from }, (_, i) => `${lane}:${from + i}:${m.style.background}`)
  })
  const cells = litCells(reader).map((c) => `${c.lane}:${c.line}:${c.colour}`)
  expect(cells.length).toBe(78)
  expect(covered.sort()).toEqual(cells.sort())
  // a run of records lit one after another in one colour is one mark
  expect(marks.length).toBeLessThan(cells.length)
})

test("the Labels sidebar's legend names the records' colours and counts the records lit in each", () => {
  const cells = litCells(html(snaps.txReader))
  const side = html(snaps.labelsSide)
  const rows = [...side.querySelectorAll<HTMLElement>('.lside-row')]
  expect(rows.map((r) => r.querySelector('.lside-name')?.textContent)).toEqual(['what the step does', 'coordinates with other agents'])
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
