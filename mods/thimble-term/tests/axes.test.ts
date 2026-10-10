// A chart's axes in the terminal (hooks/axis.ts, draw.ts lineLayout): round ticks for numbers, whole ones for whole
// data, and times named as the browser's date axis names their span, with the year where the span crosses one; for a
// line, an area and a scatter, which draw as a line card, and the times of bars over time and of a timeline.
// `claude plugin test mods/thimble-term`.
import { expect, test } from 'claude-code/testing'

import { numberTicks, timeTicks, wallClock } from '../hooks/axis'
import { cardOfCell } from '../hooks/cell'
import type { ThimbleCell } from '../hooks/cell'
import { cardLayout } from '../hooks/draw'
import type { CardData } from '../hooks/draw'

// the test's own output: its drawings, for a reader
declare const console: { log: (...args: unknown[]) => void }

const chart = (mark: string, x: { field: string; type: string; axis?: unknown }, rows: Record<string, unknown>[], color?: string): CardData => {
  const cell: ThimbleCell = {
    id: 'a1axes00',
    kind: 'plot',
    title: 'How many PRs had each run merged?',
    status: 'ok',
    outputs: [{ 'application/vnd.vegalite.v6.json': { mark, encoding: { x, y: { field: 'merged', type: 'quantitative' }, ...(color ? { color: { field: color, type: 'nominal' } } : {}) }, data: { values: rows } } }],
  }
  return cardOfCell(cell).card
}

const draw = (card: CardData, cols: number, what: string): string[] => {
  const rows = cardLayout(card, cols, -1).lines.map(l => l.map(s => s.s).join(''))
  console.log(`\n--- ${what}, ${cols} columns\n${rows.join('\n')}\n---`)
  return rows
}

// the axis's row (`└──┬──`) and the labels under it, each label with the cell it is centered on
const xAxis = (rows: string[]) => {
  const at = rows.findIndex(r => r.includes('└'))
  const labels = [...rows[at + 1]!.matchAll(/\S+(?: \S+)*/g)].map(m => ({ label: m[0], mid: m.index! + Math.floor(m[0].length / 2) }))
  return { axis: rows[at]!, labels }
}
const xLabels = (rows: string[]) => xAxis(rows).labels.map(l => l.label)
// the y labels from the top down, each on a row with a ┤
const yLabels = (rows: string[]) => rows.flatMap(r => (/^\s*(\S+) ┤/.exec(r) ? [/^\s*(\S+) ┤/.exec(r)![1]!] : []))

// four runs' merged PRs over 8 hours, the most 419, every few minutes from 07:19:34 (live QA on 0.7.0, 10-10)
const RUNS = ['emergent_prs', 'emergent_prs_issues', 'managed_prs', 'managed_prs_issues']
const TOPS = [180, 419, 160, 230]
const QA = RUNS.flatMap((run, j) =>
  Array.from({ length: 61 }, (_, i) => {
    const hours = +((i * 8.05) / 60).toFixed(3)
    const clock = new Date(Date.UTC(2026, 7, 28, 7, 19, 34) + j * 240_000 + hours * 3_600_000).toISOString().slice(0, 19).replace('T', ' ')
    return { hours, clock, run, merged: Math.round((TOPS[j]! * i) / 60) }
  }),
)

test('whole counts tick at whole, round steps: 0, 100 … 400 under a top of 419, never 209.5; each tick a ┤ on the axis', () => {
  const rows = draw(chart('line', { field: 'hours', type: 'quantitative' }, QA, 'run'), 130, 'merged PRs by hours since start')
  expect(yLabels(rows)).toEqual(['400', '300', '200', '100', '0'])
  expect(rows.join('\n')).not.toContain('209.5')
  // whole data never steps under 1, however few its values
  expect(numberTicks(0, 2, 6, true).labels).toEqual(['0', '1', '2'])
  // other numbers keep the decimals their step needs, all of one axis alike; large ones read in thousands
  expect(numberTicks(0, 1, 5).labels).toEqual(['0.0', '0.2', '0.4', '0.6', '0.8', '1.0'])
  expect(numberTicks(0, 112_700, 3, true).labels).toEqual(['0', '50k', '100k'])
})

test('a number x axis ticks at round numbers, 0 1 … 8 for 0 to 8.05 hours, never a value of the data (4.024, 8.05); each label under its ┬', () => {
  const rows = draw(chart('line', { field: 'hours', type: 'quantitative' }, QA, 'run'), 130, 'merged PRs by hours since start')
  const { axis, labels } = xAxis(rows)
  expect(labels.map(l => l.label)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8'])
  expect(rows.join('\n')).not.toMatch(/4\.024|8\.05/)
  for (const l of labels) expect(axis[l.mid]).toBe('┬')
  expect([...axis].filter(c => c === '┬').length).toBe(labels.length)
  // an x is a place, written without separators: years read 2016, never 2,016; the y axis's counts keep theirs
  const years = Array.from({ length: 10 }, (_, i) => ({ year: 2015 + i, merged: 1000 + i * 400 }))
  const yearRows = draw(chart('line', { field: 'year', type: 'ordinal' }, years), 80, 'merged PRs by year')
  expect(xLabels(yearRows)).toEqual(['2016', '2018', '2020', '2022', '2024'])
  expect(yLabels(yearRows)).toContain('4,000')
})

test('a time axis names its span as the browser does: the hour within a day (08:00 … 15:00, no seconds), the day and hour within three days, seconds only over a few minutes', () => {
  // the clock-time chart of the QA: Aug 28 07:19:34 to 15:30:36, labeled `Aug 28 07:19:34 … Aug 28 15:30:36`
  const rows = draw(chart('line', { field: 'clock', type: 'temporal' }, QA, 'run'), 130, 'merged PRs by clock time')
  expect(xLabels(rows)).toEqual(['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00'])
  expect(yLabels(rows)).toEqual(['400', '300', '200', '100', '0'])
  // in a narrow pane, as many as fit
  expect(xLabels(draw(chart('line', { field: 'clock', type: 'temporal' }, QA, 'run'), 40, 'merged PRs by clock time'))).toEqual(['09:00', '12:00', '15:00'])
  // a scatter of 100 seconds: its ticks step by 30 seconds and name them
  const secs = Array.from({ length: 21 }, (_, i) => ({ t: new Date(Date.UTC(2026, 7, 28, 7, 19, 34) + i * 5000).toISOString(), merged: i % 7 }))
  expect(xLabels(draw(chart('point', { field: 't', type: 'temporal' }, secs), 80, 'a scatter of 100 seconds'))).toEqual(['07:20:00', '07:20:30', '07:21:00'])
  // a day and a half: the day and the hour
  const days = [{ t: '2026-08-28 05:31:00', merged: 1 }, { t: '2026-08-29 06:38:00', merged: 3 }, { t: '2026-08-29 18:00:00', merged: 2 }]
  expect(xLabels(draw(chart('line', { field: 't', type: 'temporal' }, days), 100, 'a day and a half'))).toEqual(['Aug 28 12:00', 'Aug 29 00:00', 'Aug 29 12:00'])
  // a time is its wall clock as written, whatever zone it names
  expect(wallClock('2026-08-28T07:19:34+02:00')).toBe(Date.UTC(2026, 7, 28, 7, 19, 34))
  expect(timeTicks(Date.UTC(2026, 7, 28, 7), Date.UTC(2026, 7, 28, 7, 40), 4).labels).toEqual(['07:00', '07:15', '07:30'])
})

test('an axis over years names the month and the year; one that crosses a year names it on its first tick and on the first of the new year', () => {
  // live QA on 0.7.0 (10-10): an axis of several years read `Oct 20 … Dec 19`, with no year
  const years = Array.from({ length: 30 }, (_, i) => ({ t: new Date(Date.UTC(2019, 9, 20) + i * 26 * 86_400_000).toISOString().slice(0, 19), merged: i * 3 }))
  expect(xLabels(draw(chart('line', { field: 't', type: 'temporal' }, years), 80, 'a line over two years'))).toEqual(['Jan 2020', 'Jul 2020', 'Jan 2021', 'Jul 2021'])
  const winter = Array.from({ length: 40 }, (_, i) => ({ t: new Date(Date.UTC(2019, 10, 20) + i * 2 * 86_400_000).toISOString().slice(0, 10), merged: ((i * 7) % 13) + 0.5 }))
  expect(xLabels(draw(chart('area', { field: 't', type: 'temporal' }, winter), 80, 'an area across a new year'))).toEqual(['Dec 1, 2019', 'Jan 1, 2020', 'Feb 1'])
})

test("an axis that names its own values ticks at them, as the browser's does: thimble.chart's weekly line at its weeks' Mondays, never round Sundays", () => {
  // thimble.chart sets `axis.values` at each time of weekly or monthly data (kernel_thimble.py _step_ticks)
  const mondays = Array.from({ length: 5 }, (_, i) => new Date(Date.UTC(2026, 4, 18) + i * 7 * 86_400_000))
  const rows = mondays.map((d, i) => ({ week: d.toISOString().slice(0, 19), merged: i * 4 }))
  const values = mondays.map(d => ({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, date: d.getUTCDate() }))
  const weekly = chart('line', { field: 'week', type: 'temporal', axis: { values } }, rows)
  const wide = draw(weekly, 80, 'a weekly line with its own ticks')
  expect(xLabels(wide)).toEqual(['May 18', 'May 25', 'Jun 1', 'Jun 8', 'Jun 15'])
  expect([...xAxis(wide).axis].filter(c => c === '┬').length).toBe(5)
  // where they do not all fit, every second, as Vega leaves out labels that overlap
  expect(xLabels(draw(weekly, 30, 'a weekly line with its own ticks'))).toEqual(['May 18', 'Jun 1', 'Jun 15'])
  // across a new year, the first and the first of the new year name it
  const winter = [new Date(Date.UTC(2025, 11, 22)), new Date(Date.UTC(2025, 11, 29)), new Date(Date.UTC(2026, 0, 5))]
  const across = chart('line', { field: 'week', type: 'temporal', axis: { values: winter.map(d => ({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, date: d.getUTCDate() })) } }, winter.map((d, i) => ({ week: d.toISOString().slice(0, 10), merged: i })))
  expect(xLabels(draw(across, 60, 'weeks across a new year'))).toEqual(['Dec 22, 2025', 'Dec 29', 'Jan 5, 2026'])
})

test('bars over time and a timeline name the year of times that span more than one, and seconds only where two share a minute', () => {
  const bars = chartBars([
    { t: '2019-10-20T00:00:00', merged: 4 },
    { t: '2020-06-01T00:00:00', merged: 9 },
    { t: '2021-12-19T00:00:00', merged: 2 },
  ])
  expect(draw(bars, 60, 'bars over two years').map(r => r.split('  ')[0])).toEqual(['Oct 20, 2019', 'Jun 1, 2020', 'Dec 19, 2021'])
  const clock = chartBars([
    { t: '2026-08-28 07:19:34', merged: 4 },
    { t: '2026-08-28 09:02:10', merged: 9 },
  ])
  expect(draw(clock, 60, 'bars at clock times').map(r => r.split('  ')[0])).toEqual(['Aug 28 07:19', 'Aug 28 09:02'])
  const { card } = cardOfCell({ id: 't1times0', kind: 'timeline', title: 'When did each sweep start?', status: 'ok', payload: { dataset: { events: [['2020-06-01', 'second sweep'], ['2019-10-20', 'first sweep'], ['2021-12-19', 'third sweep']] } } })
  const rows = draw(card, 60, 'a timeline over two years')
  expect(rows[1]).toMatch(/^Oct 20, 2019 +Dec 19, 2021$/)
  expect(rows.slice(2).map(r => r.split('  ')[0])).toEqual(['Jun 1, 2020', 'Oct 20, 2019', 'Dec 19, 2021'])
})

function chartBars(rows: Record<string, unknown>[]): CardData {
  return cardOfCell({
    id: 'b1axes00',
    kind: 'plot',
    title: 'How many PRs were merged each time?',
    status: 'ok',
    outputs: [{ 'application/vnd.vegalite.v6.json': { mark: 'bar', encoding: { x: { field: 't', type: 'temporal' }, y: { field: 'merged', type: 'quantitative' } }, data: { values: rows } } }],
  }).card
}
