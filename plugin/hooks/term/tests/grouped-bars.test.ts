// A bar chart whose groups stand side by side in each category (Altair's `xOffset`, thimble.chart's stack=False, a value
// axis that does not stack) draws a bar per group, each from 0 to its own value, never one stacked bar per category
// with the category's total (bug hunt L1). `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { cardOfCell } from '../cell'
import type { ThimbleCell } from '../cell'
import { cardLayout } from '../draw'
import type { BarRow, Line } from '../draw'

const CREWS = ['heron crew', 'lark crew', 'finch crew']
const ROWS = [
  { round: 'r1', calls: 120, crew: 'heron crew' },
  { round: 'r1', calls: 300, crew: 'lark crew' },
  { round: 'r1', calls: 90, crew: 'finch crew' },
  { round: 'r2', calls: 2400, crew: 'heron crew' },
  { round: 'r2', calls: 1800, crew: 'lark crew' },
  { round: 'r2', calls: 2100, crew: 'finch crew' },
]
const cell = (id: string, spec: unknown) => ({ id, title: 'How many calls did each crew make in each round?', outputs: [{ 'application/vnd.vegalite.v6.json': spec }] }) as unknown as ThimbleCell
const text = (l: Line) => l.map(s => s.s).join('')
// as Altair writes `mark_bar().encode(x='round:N', xOffset='crew:N', y='calls:Q', color='crew:N')`
const ALTAIR = {
  data: { name: 'd0' },
  mark: { type: 'bar' },
  encoding: { x: { field: 'round', type: 'nominal' }, xOffset: { field: 'crew', type: 'nominal' }, y: { field: 'calls', type: 'quantitative' }, color: { field: 'crew', type: 'nominal' } },
  datasets: { d0: ROWS },
}
// as thimble.chart('bar', df, stack=False) writes it for text categories: bars lying down, the groups in its own order
const CHART = {
  data: { values: ROWS },
  mark: 'bar',
  encoding: {
    y: { field: 'round', type: 'nominal', sort: ['r2', 'r1'] },
    x: { field: 'calls', type: 'quantitative' },
    color: { field: 'crew', type: 'nominal', sort: CREWS },
    yOffset: { field: 'crew', type: 'nominal', sort: CREWS },
  },
}

test('grouped bars draw a bar per group from 0 to its own value, never a stacked bar with the total', () => {
  const { card } = cardOfCell(cell('g1altair', ALTAIR))
  expect(card.kind).toBe('bar')
  expect(card.grouped).toBe(true)
  const lay = cardLayout(card, 80, -1)
  const lines = lay.lines.map(text)
  // a row per bar: each round's three bars one under another, A to Z as Vega-Lite sets an offset with no sort
  const rows = lines.slice(0, 6)
  expect(rows.map(l => /(\S+)\s*$/.exec(l)![1])).toEqual(['90', '120', '300', '2,100', '2,400', '1,800'])
  // the round's name on its first bar's row only; no total (510, 6,300) anywhere
  expect(rows.map(l => l.slice(0, 4).trim())).toEqual(['r1', '', '', 'r2', '', ''])
  expect(lines.join('\n')).not.toMatch(/\b510\b|6,300/)
  // each bar as long as its own value, in its crew's hue; the longest reaches the bars' room
  const bars = lay.lines.slice(0, 6).map(l => l.find(s => s.s.startsWith('█'))!)
  const len = bars.map(b => b.s.length)
  expect(len[4]).toBeGreaterThan(len[5]!)
  expect(len[2]).toBeGreaterThan(len[1]!)
  expect(len[4]).toBeGreaterThan(10 * len[0]!)
  expect(bars[0]!.fg).toBe(bars[3]!.fg)
  expect(new Set(bars.slice(0, 3).map(b => b.fg)).size).toBe(3)
  expect(lines.join('\n')).toMatch(/● finch crew {2}● heron crew {2}● lark crew/)
  // each bar is one mark: its row picks it, and its readout names its round, its crew and its value
  expect(lay.items).toHaveLength(6)
  expect([0, 1, 2, 3, 4, 5].map(y => lay.hit(10, y))).toEqual([0, 1, 2, 3, 4, 5])
  expect(lay.items[4]).toMatchObject({ label: 'r2 · heron crew', value: '2,400 calls' })
})

test("thimble.chart's stack=False sets each category's bars in its groups' order, the categories in theirs", () => {
  const { card } = cardOfCell(cell('g1chart0', CHART))
  expect(card.grouped).toBe(true)
  expect((card.rows as BarRow[]).map(r => `${r.label} ${r.group}`)).toEqual(['r2 heron crew', 'r2 lark crew', 'r2 finch crew', 'r1 heron crew', 'r1 lark crew', 'r1 finch crew'])
  const lines = cardLayout(card, 80, -1).lines.map(text)
  expect(lines.slice(0, 6).map(l => /(\S+)\s*$/.exec(l)![1])).toEqual(['2,400', '1,800', '2,100', '120', '300', '90'])
  // a value axis told not to stack draws its groups side by side too
  const unstacked = { ...ALTAIR, encoding: { x: ALTAIR.encoding.x, y: { ...ALTAIR.encoding.y, stack: null }, color: ALTAIR.encoding.color } }
  expect(cardOfCell(cell('g1nostk0', unstacked)).card.grouped).toBe(true)
})

test('a bar chart whose groups stack still draws one bar per category with its total', () => {
  const stacked = { ...ALTAIR, encoding: { x: ALTAIR.encoding.x, y: ALTAIR.encoding.y, color: ALTAIR.encoding.color } }
  const { card } = cardOfCell(cell('g1stack0', stacked))
  expect(card.grouped).toBeUndefined()
  const lines = cardLayout(card, 80, -1).lines.map(text)
  expect(lines[0]).toMatch(/^r1 .*510 *$/)
  expect(lines[1]).toMatch(/^r2 .*6,300 *$/)
})
