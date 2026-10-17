// A start-to-end bar chart (Altair `mark_bar` with `x` and `x2` times, the runs' names down `y`: a Gantt chart) draws
// as bars on a time axis, each row's bar from its start to its end in its group's hue, never as a table of raw ISO
// times (bug hunt C9); a long name in the label column is cut in its middle, never broken inside a word.
// `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { cardOfCell } from '../cell'
import type { ThimbleCell } from '../cell'
import { cardLayout, fold } from '../draw'
import { width } from '../lib'

const RUNS = [
  { run: 'alpha-tool__underspecified-fan-out', task: 'alpha', start: '2026-08-25T01:16:51.813000+00:00', end: '2026-08-25T03:40:02.100000+00:00', hours: 2.39 },
  { run: 'beta-nano__goal', task: 'beta', start: '2026-08-25T02:05:00+00:00', end: '2026-08-25T02:35:00+00:00', hours: 0.5 },
  { run: 'gamma-sim__specified', task: 'gamma', start: '2026-08-25T04:00:00+00:00', end: '2026-08-25T06:30:00+00:00', hours: 2.5 },
]
const GANTT = {
  mark: 'bar',
  encoding: { x: { field: 'start', type: 'temporal' }, x2: { field: 'end' }, y: { field: 'run', type: 'nominal', sort: { field: 'start' } }, color: { field: 'task', type: 'nominal' } },
  data: { values: RUNS },
}
const cell = (spec: unknown) => ({ id: 'g0gantt0', title: 'When did each run start and end?', outputs: [{ 'application/vnd.vegalite.v6.json': spec }] }) as unknown as ThimbleCell

test('a start-to-end bar chart draws as bars on a time axis, in the order its rows sort, not as a table of ISO times', () => {
  const { card } = cardOfCell(cell(GANTT))
  expect(card.kind).toBe('dots')
  expect(card.strips!.map(r => r.name)).toEqual(['alpha-tool__underspecified-fan-out', 'beta-nano__goal', 'gamma-sim__specified'])
  const lay = cardLayout(card, 80, -1)
  const lines = lay.lines.map(l => l.map(x => x.s).join(''))
  const all = lines.join('\n')
  expect(all).not.toContain('2026-08-25T')
  // a bar per run, where its start and end fall on the axis: the first starts at the axis's left, the last ends at its right
  const bars = lines.slice(0, 3).map(l => /█+/.exec(l))
  const [a, b, c] = bars.map(m => ({ from: m?.index ?? -1, to: (m?.index ?? -1) + (m?.[0].length ?? 0) }))
  expect(bars.every(Boolean)).toBe(true)
  expect(b!.from).toBeGreaterThan(a!.from)
  expect(b!.to).toBeLessThan(a!.to)
  expect(c!.from).toBeGreaterThan(a!.to)
  expect(lines[2]!.trimEnd().endsWith('█')).toBe(true)
  // each bar in its task's hue
  const hues = lay.lines.slice(0, 3).map(l => l.find(x => x.s.startsWith('█'))!.fg)
  expect(new Set(hues).size).toBe(3)
  // the time axis under the bars, its ticks as times; the tasks' legend
  expect(lines[3]).toMatch(/^ +─*┬[─┬]*$/)
  expect(lines[4]).toMatch(/\d{2}:\d{2}/)
  expect(all).toMatch(/● alpha.*● beta.*● gamma/)
  // a bar's readout: its start, its end and how long it lasted
  const it = lay.items.find(i => i.label.startsWith('beta-nano'))!
  expect(it.value).toBe('Aug 25 02:05 to Aug 25 02:35 · 30 min · beta')
})

test('a long name in the label column is cut in its middle, never broken inside a word', () => {
  const { card } = cardOfCell(cell(GANTT))
  const lines = cardLayout(card, 50, -1).lines.map(l => l.map(x => x.s).join(''))
  expect(lines.some(l => /^alpha-to\S*…\S*-fan-out +█/.test(l))).toBe(true)
  expect(lines.some(l => l.startsWith('platform') || l.startsWith('underspecified'))).toBe(false)
  expect(fold('alpha-tool__underspecified-fan-out', 20)).toEqual([expect.stringContaining('…')])
  expect(width(fold('alpha-tool__underspecified-fan-out', 20)[0]!)).toBeLessThanOrEqual(20)
  // a name with spaces still folds at a space
  expect(fold('runs that ended with a failing test', 20)).toEqual(['runs that ended with', 'a failing test'])
})
