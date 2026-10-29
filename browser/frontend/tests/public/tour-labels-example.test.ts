// @vitest-environment jsdom
// The tour's Labels example (src/tour/steps.ts labelsExample, over src/tour/examples.json txReader and labelsSide) agrees
// with itself and with thimble as it is: one agent's transcript in the Transcript mode, colored by one label of a few
// values, each record's bar and row in its value's color and its hover naming the label and that value, as Files' reader
// draws them (views/common RecordCard, the one tooltip's data-tip); the strip the step draws beside the transcript, from
// the records' bars, one lane with a mark over each run of records of one color, at their place in the file; and the
// Labels sidebar's legend naming those colors and counting those records. The step says what a label is and no more: the
// colors name themselves where the analyst looks, a record its value on hover, which the step's demo shows.
import { expect, test } from 'vitest'
import { stripWidth } from '../../src/files/Tracks.tsx'
import { createTour, type Api, type Snaps } from '../../src/tour/engine.ts'
import snaps from '../../src/tour/examples.json'
import { tourSteps } from '../../src/tour/steps.ts'

/** the transcript's lines, those the Transcript mode hides included */
const LINES = 76
const LABEL = 'what the step does'
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
/** Each record of the transcript: its line, the color of its bar (none for none), the tint of its row and its hover. */
const records = (reader: Element) =>
  [...reader.querySelectorAll<HTMLElement>('.reader-record[data-line]')].map((rec) => ({
    line: Number(rec.dataset.line),
    bars: [...rec.querySelectorAll<HTMLElement>('.reader-bands > .reader-band')].map((b) => b.style.background),
    tint: rec.style.getPropertyValue('--cb-tint'),
    tip: rec.dataset.tip ?? null,
  }))
/** The label's values in the Labels sidebar: name, swatch color, whether the swatch is hollow (no color), count. */
const legend = () =>
  [...html(snaps.labelsSide).querySelectorAll<HTMLElement>('.lside-row .lside-value')].map((v) => ({
    name: v.querySelector('.lside-value-name')!.textContent!,
    color: v.querySelector<HTMLElement>('.lside-swatch')!.style.getPropertyValue('--sw'),
    hollow: v.querySelector('.lside-swatch')!.classList.contains('is-hollow'),
    n: Number(v.querySelector('.lside-n')!.textContent),
  }))

test('the transcript holds no picture of a strip drawn in other colors', () => {
  expect(snaps.txReader).not.toMatch(/data:image|<img |<canvas/)
})

test('the example shows one label of a few values, each in a color of its own: one bar a record, one lane in the strip, the label named in Color by', () => {
  const side = html(snaps.labelsSide)
  const rows = [...side.querySelectorAll<HTMLElement>('.lside-row')]
  expect(rows.map((r) => r.querySelector('.lside-name')?.textContent)).toEqual([LABEL])
  expect(side.querySelector('.lside-heading .lside-n')?.textContent).toBe('1')
  const colored = legend().filter((v) => !v.hollow)
  expect(colored.length).toBeGreaterThanOrEqual(3)
  expect(colored.length).toBeLessThanOrEqual(4)
  expect(new Set(colored.map((v) => v.color)).size).toBe(colored.length)
  const reader = html(snaps.txReader)
  expect(reader.querySelector('.reader-modes .seg-opt.active')?.textContent).toBe('Transcript')
  expect(reader.querySelector('.colorby .colorby-trigger b')?.textContent).toBe(LABEL)
  const recs = records(reader)
  expect(recs.length).toBeGreaterThan(60)
  expect(recs.every((r) => r.bars.length <= 1)).toBe(true)
  // the strip as wide as thimble draws it for one lane
  expect(reader.querySelector<HTMLElement>('.track-over')!.style.width).toBe(`${stripWidth(1)}px`)
})

test("each record's bar and row are in its value's color, none for a value with no color, and its hover names the label and that value", () => {
  const colorOf = new Map(legend().map((v) => [v.name, v.hollow ? '' : v.color]))
  const recs = records(html(snaps.txReader))
  for (const r of recs) {
    const value = r.tip?.startsWith(`${LABEL}: `) ? r.tip.slice(LABEL.length + 2) : null
    expect(value != null && colorOf.has(value), `line ${r.line}: ${r.tip}`).toBe(true)
    const color = colorOf.get(value!)!
    expect(r.bars, `line ${r.line}`).toEqual(color ? [color] : [])
    expect(r.tint, `line ${r.line}`).toBe(color)
  }
  // every value has records, the one with no color too
  expect(new Set(recs.map((r) => r.tip))).toEqual(new Set([...colorOf.keys()].map((v) => `${LABEL}: ${v}`)))
  // and no record's hover is the browser's own
  expect(html(snaps.txReader).querySelector('.reader-record[title]')).toBeNull()
})

test("the Labels sidebar's legend counts the label's records: those shown in each color, and as having none the ones the mode hides", () => {
  const recs = records(html(snaps.txReader))
  const values = legend()
  expect(values.reduce((a, v) => a + v.n, 0)).toBe(LINES)
  for (const v of values.filter((x) => !x.hollow)) expect(recs.filter((r) => r.bars[0] === v.color).length, v.name).toBe(v.n)
  const none = values.filter((x) => x.hollow)
  expect(none).toHaveLength(1)
  expect(recs.filter((r) => !r.bars.length).length + (LINES - recs.length)).toBe(none[0].n)
})

test("the step's strip marks the records' colors: one lane, a mark over each run of records of one color, at their lines of the file", () => {
  const reader = drawExample('Labels').els!.reader as HTMLElement
  const lanes = [...reader.querySelectorAll<HTMLElement>('.track-over > .tour-strip-lane')]
  // a lane is 7 px wide, 3 px in (files/Ruler.tsx TRACK_LANES), and holds a row per line
  expect(lanes.map((l) => [l.style.left, l.style.width])).toEqual([['3px', '7px']])
  expect(lanes[0].style.gridTemplateRows).toBe(`repeat(${LINES}, minmax(0, 1fr))`)
  const marks = [...lanes[0].children] as HTMLElement[]
  const covered = marks.flatMap((m) => {
    const [from, end] = m.style.gridRow.split('/').map(Number)
    return Array.from({ length: end - from }, (_, i) => `${from + i}:${m.style.background}`)
  })
  const bars = records(reader).flatMap((r) => r.bars.map((c) => `${r.line}:${c}`))
  // a bar for each record of a value in color, as the legend counts them
  expect(bars.length).toBe(legend().reduce((a, v) => a + (v.hollow ? 0 : v.n), 0))
  expect(covered.sort()).toEqual(bars.sort())
  // a run of records one after another in one color is one mark
  expect(marks.length).toBeLessThan(bars.length)
  expect(reader.querySelector('canvas')).toBeNull()
})

test('the Labels step says what a label is and no more: its records name their values on hover, which its demo shows', () => {
  const step = tourSteps('⌘').find((s) => s.title === 'Labels')!
  expect(step.body).toBe('A label sorts records into values, by a rule or by Claude’s reading. Labels, at the top, lists them. Open one to see its records and correct them.')
  expect(step.body).not.toMatch(/\b(bar|strip|colou?r|minimap)/i)
  expect(typeof step.tips).toBe('function')
  expect(typeof step.demo).toBe('function')
})
