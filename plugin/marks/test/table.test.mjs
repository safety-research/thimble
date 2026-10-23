import assert from 'node:assert/strict'
import { test } from 'node:test'

import { tableLines } from '../table.mjs'

const t = { corner: 'agent', cols: ['merged', 'total', 'share'], rows: [{ label: 'agent-03', values: ['4', '10', '0.4'] }, { label: 'agent-07', values: ['12', '40', '0.3'] }], at: { r: 1, c: 0 }, above: 0, below: 0 }

test('a cited cell shows as the header over its row, the cell tinted', () => {
  const [head, row] = tableLines(t, 80)
  assert.equal(head.text, 'agent     merged  total  share')
  assert.equal(row.text, 'agent-07      12     40    0.3')
  assert.equal(row.text.slice(...row.spans[0]), '12')
})

test('a range or a pair cites more than one cell: each cited row is a line, its cells tinted', () => {
  const [head, first, second] = tableLines({ ...t, at: { r: 1, c: 1 }, also: [{ r: 0, c: 1 }] }, 80)
  assert.equal(head.text, 'agent     merged  total  share')
  assert.equal(first.text.slice(...first.spans[0]), '40')
  assert.equal(second.text.slice(...second.spans[0]), '10')
})
