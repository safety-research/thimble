// A start-to-end chart of rules (thimble.chart's range: a rule from `x` to `x2` with a dot at each end; Altair's
// `mark_rule` with `x` and `x2`) draws each row from its start to its end on an axis over both, never a dot at its start
// alone on an axis that leaves the ends out (bug hunt L2). `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { cardOfCell } from '../cell'
import type { ThimbleCell } from '../cell'
import { cardLayout } from '../draw'
import type { Line } from '../draw'

const RUNS = [
  { job: 'kestrel-batch', 'first (UTC)': '2026-03-02T01:15:00', 'last (UTC)': '2026-03-02T02:30:00', lane: 'short' },
  { job: 'osprey-batch', 'first (UTC)': '2026-03-02T01:20:00', 'last (UTC)': '2026-03-02T14:00:00', lane: 'long' },
  { job: 'wren-batch', 'first (UTC)': '2026-03-03T03:00:00', 'last (UTC)': '2026-03-03T14:00:00', lane: 'long' },
]
const ORDER = RUNS.map(r => r.job)
const y = { field: 'job', type: 'nominal', sort: ORDER }
const color = { field: 'lane', type: 'nominal', sort: ['short', 'long'] }
const end = (field: string) => ({
  transform: [{ calculate: JSON.stringify(field), as: '__thimble_end' }],
  mark: { type: 'point', style: 'thimble-end' },
  encoding: { x: { field, type: 'temporal' }, y, color, opacity: { field: '__thimble_end', type: 'ordinal' } },
})
// as thimble.chart('range', df) writes it: a muted rule with no color of its own, then a dot at each end in the color
const RANGE = {
  data: { values: RUNS },
  layer: [
    { mark: { type: 'rule', style: 'thimble-span' }, encoding: { x: { field: 'first (UTC)', type: 'temporal' }, x2: { field: 'last (UTC)' }, y } },
    end('first (UTC)'),
    end('last (UTC)'),
  ],
}
const cell = (id: string, spec: unknown) => ({ id, title: 'When did each job run?', outputs: [{ 'application/vnd.vegalite.v6.json': spec }] }) as unknown as ThimbleCell
const text = (l: Line) => l.map(s => s.s).join('')

test('a range draws each row as a line from its start to a dot at its end, on an axis over every start and end', () => {
  const { card } = cardOfCell(cell('r2range0', RANGE))
  expect(card.kind).toBe('dots')
  expect(card.strips!.map(s => s.name)).toEqual(ORDER)
  const lay = cardLayout(card, 100, -1)
  const lines = lay.lines.map(text)
  // each row: a line in the rule gray, then one dot in its lane's hue at its end
  const spans = lines.slice(0, 3).map(l => /(─*)●/.exec(l)!)
  expect(spans.every(Boolean)).toBe(true)
  const at = spans.map(m => ({ from: m.index, to: m.index + m[0].length - 1 }))
  // osprey starts with kestrel and runs half a day past its end; wren starts the next day and ends at the axis's right
  expect(Math.abs(at[1]!.from - at[0]!.from)).toBeLessThanOrEqual(1)
  expect(at[1]!.to - at[0]!.to).toBeGreaterThan(15)
  expect(at[2]!.from).toBeGreaterThan(at[1]!.to)
  expect(lines[2]!.trimEnd().endsWith('●')).toBe(true)
  const dots = lay.lines.slice(0, 3).map(l => l.find(s => s.s === '●')!.fg)
  expect(dots[1]).toBe(dots[2])
  expect(dots[0]).not.toBe(dots[1])
  // the axis reaches the last end (Mar 3 14:00), and the key names the two ends and the lanes
  expect(lines.find(l => /Mar 3/.test(l))).toBeDefined()
  expect(lines.join('\n')).toMatch(/──● first \(UTC\) to last \(UTC\) {2}● short {2}● long/)
  // a range is one mark, whose readout names its start, its end and how long it lasted
  expect(lay.items[1]).toMatchObject({ label: 'osprey-batch' })
  expect(lay.items[1]!.value).toMatch(/^Mar 2 01:20 to Mar 2 14:00 · 12 h 40 min/)
})

test('a range whose end is before its start draws its dot on the left; a rule alone draws as a bar', () => {
  const scores = [
    { model: 'alder', before: 0.4, after: 0.7 },
    { model: 'birch', before: 0.6, after: 0.5 },
  ]
  const ny = { field: 'model', type: 'nominal' }
  const nums = {
    data: { values: scores },
    layer: [
      { mark: 'rule', encoding: { x: { field: 'before', type: 'quantitative' }, x2: { field: 'after' }, y: ny } },
      { mark: 'point', encoding: { x: { field: 'before', type: 'quantitative' }, y: ny } },
      { mark: 'point', encoding: { x: { field: 'after', type: 'quantitative' }, y: ny } },
    ],
  }
  const lines = cardLayout(cardOfCell(cell('r2nums00', nums)).card, 80, -1).lines.map(text)
  expect(lines[0]).toMatch(/^alder +─+●$/)
  expect(lines[1]).toMatch(/^birch +●─+$/)
  // Altair's mark_rule from x to x2 with no dots: a bar from its start to its end, in its color's hue
  const rule = { data: { values: RUNS }, mark: { type: 'rule' }, encoding: { x: { field: 'first (UTC)', type: 'temporal' }, x2: { field: 'last (UTC)' }, y, color } }
  const { card } = cardOfCell(cell('r2rule00', rule))
  expect(card.kind).toBe('dots')
  const ruled = cardLayout(card, 100, -1).lines.map(text)
  expect(ruled.slice(0, 3).every(l => /█+/.test(l))).toBe(true)
})
