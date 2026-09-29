// A value citation names a table cell, found the way the backend's cite.find_td finds it (src/lib/tableCell.ts).
import { describe, expect, test } from 'vitest'
import { locateCell, type Grid } from '../../src/lib/tableCell.ts'

// a table as readTable reads a drawn one: the corner, the columns, each row's label and values
const OUTCOMES: Grid = {
  corner: 'outcome',
  cols: ['prs', 'share'],
  rows: [
    { label: 'merged', values: ['212', '0.61'] },
    { label: 'closed', values: ['96', '0.28'] },
    { label: 'open', values: ['37', '0.11'] },
    { label: 'TOTAL', values: ['345', '1.00'] },
  ],
}

describe('the cell a value citation names', () => {
  test('found by its column and its row label, encoded or not', () => {
    expect(locateCell(OUTCOMES, 'prs', 'closed')).toEqual({ r: 1, c: 0 })
    expect(locateCell(OUTCOMES, 'share', 'TOTAL')).toEqual({ r: 3, c: 1 })
    const spaced: Grid = { corner: '', cols: ['review rounds'], rows: [{ label: 'waits, over 2 days apart', values: ['18'] }] }
    expect(locateCell(spaced, 'review%20rounds', 'waits%2C%20over%202%20days%20apart')).toEqual({ r: 0, c: 0 })
    expect(locateCell(OUTCOMES, 'prs', 'missing')).toBeNull()
    expect(locateCell(OUTCOMES, 'nope', 'merged')).toBeNull()
  })
})
