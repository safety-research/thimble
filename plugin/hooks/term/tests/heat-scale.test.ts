// A heatmap shades its cells on the chart's own color scale (log, symlog, sqrt), a cell that holds a number never reads
// as 0, and the numbers a text layer writes on the cells are drawn on them, as the browser draws them (bug hunt K1: a
// symlog heatmap drew linearly, and 70 of its 77 cells showed the dot of a 0). `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { cardOfCell } from '../cell'
import type { ThimbleCell } from '../cell'
import { cardLayout } from '../draw'
import type { Line } from '../draw'

const TASKS = ['Sort', 'Merge', 'Scan', 'Trim', 'Ping']
const BATCHES = ['batch-1', 'batch-2', 'batch-3', 'batch-4', 'batch-5', 'batch-6']
// one task called far more than the others, a few calls of some, none of others
const RUNS: number[][] = [
  [600, 70, 45, 2, 0],
  [1200, 300, 60, 17, 0],
  [450, 60, 50, 1, 0],
  [5200, 150, 140, 4, 3],
  [300, 40, 40, 0, 0],
  [700, 90, 60, 1, 0],
]
const ROWS = BATCHES.flatMap((batch, b) => TASKS.map((task, t) => ({ batch, task, calls: RUNS[b]![t]! })))
const AXES = { x: { field: 'task', type: 'nominal', sort: TASKS }, y: { field: 'batch', type: 'nominal' } }
const heat = (scale: unknown, text: boolean) => ({
  data: { name: 'd0' },
  datasets: { d0: ROWS },
  layer: [
    { mark: { type: 'rect' }, encoding: { ...AXES, color: { field: 'calls', type: 'quantitative', title: 'Calls', ...(scale ? { scale } : {}) } } },
    ...(text ? [{ mark: { type: 'text' }, encoding: { ...AXES, text: { field: 'calls', type: 'quantitative' } } }] : []),
  ],
})
const cell = (id: string, spec: unknown) => ({ id, title: 'How often was each task called in each batch?', outputs: [{ 'application/vnd.vegalite.v6.json': spec }] }) as unknown as ThimbleCell
const text = (l: Line) => l.map(s => s.s).join('')

test('a symlog heatmap shades on its log scale, and no cell that holds a number reads as 0', () => {
  const { card } = cardOfCell(cell('h1heat00', heat({ type: 'symlog' }, false)))
  expect(card.kind).toBe('heat')
  const lay = cardLayout(card, 100, -1)
  const lines = lay.lines.map(text)
  const cells = (row: number) => lines[row]!.slice(9).trim().split(/\s+/)
  // batch-1: 600 is high on the log scale (it would be the lowest shade on a linear one), 70 and 45 in the middle, 2
  // the lowest shade, and only the 0 a dot
  expect(cells(0)).toEqual(['▓▓▓▓▓▓▓', '▒▒▒▒▒▒▒', '▒▒▒▒▒▒▒', '░░░░░░░', '·'])
  expect(cells(3)[0]).toBe('█'.repeat(7))
  // a dot for each 0 and for nothing else
  const zeros = RUNS.flat().filter(n => n === 0).length
  expect(lines.slice(0, 6).join('').split('·').length - 1).toBe(zeros)
  // the key: the dot for 0, each shade with the least number it holds, and the scale
  expect(lines.at(-1)).toBe('· 0  ░ ≥1  ▒ ≥8  ▓ ≥72  █ ≥612   Calls, log scale')
})

test('a linear heatmap still marks every cell that holds a number apart from the cells that hold 0', () => {
  const { card } = cardOfCell(cell('h1heat01', heat(null, false)))
  const lines = cardLayout(card, 100, -1).lines.map(text)
  const zeros = RUNS.flat().filter(n => n === 0).length
  expect(lines.slice(0, 6).join('').split('·').length - 1).toBe(zeros)
  // 600 of 5,200 on a linear scale: the lowest shade, not the dot of a 0
  expect(lines[0]!.slice(9).trim().split(/\s+/)[0]).toBe('░'.repeat(7))
  expect(lines.at(-1)).toBe('· 0  ░ ≥1  ▒ ≥1,300  ▓ ≥2,600  █ ≥3,900   Calls')
})

test('a heatmap whose text layer writes its numbers draws each number on its cell, on its shade', () => {
  const { card } = cardOfCell(cell('h1heat02', heat({ type: 'log' }, true)))
  const lay = cardLayout(card, 100, -1)
  const lines = lay.lines.map(text)
  expect(lines[3]).toMatch(/^batch-4 +5,200 +150 +140 +4 +3 *$/)
  // a number on its shade's tint; a 0 dim on none
  const row = lay.lines[0]!
  const at = (w: string) => row.find(s => s.s.trim() === w)!
  expect(at('600').bg).toBeTruthy()
  expect(at('2').bg).toBeTruthy()
  expect(at('600').bg).not.toBe(at('2').bg)
  expect(at('0').bg).toBeUndefined()
  // the log scale has no place for 0: its shades from the least number above 0
  expect(lines.at(-1)).toMatch(/^0 +≥1 +≥9 +≥73 +≥613 +Calls, log scale$/)
})
