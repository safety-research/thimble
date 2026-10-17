// A table card's text cells whole (live feedback, 10-17: "Table is poorly formatted (clicking on reason doesn't expand
// things)"): a long reason, and a link with no place to break, in as many rows as they take, nothing cut with `…`.
// `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { cardLayout } from '../draw'
import type { CardData } from '../draw'

const REASON = 'restored the sourced paragraph on the harbor survey that an anonymous editor removed without a summary, and asked on the talk page for a source before it comes out again'
const LINK = `https://archive.example.org/harbor-survey/${'q7'.repeat(70)}`

const card = (rows: (string | number)[][]): CardData => ({
  id: 't4bl3c3l',
  kind: 'table',
  question: 'Who undid whose edits from Mar 1 to Mar 7, and why?',
  x: '',
  y: '',
  note: '',
  source: {},
  columns: ['date', 'undone by', 'editor undone', 'reason'],
  rows,
})

const text = (c: CardData, cols: number) => cardLayout(c, cols, -1).lines.map(l => l.map(s => s.s).join(''))

/** The words of the `reason` column, read down its rows from its header (its block's first column, the dates, left out). */
function reasonColumn(rows: string[]): string[] {
  const head = rows.findIndex(r => /\breason\b/.test(r))
  const at = rows[head]!.indexOf('reason')
  return rows.slice(head + 2).map(r => r.slice(at).trimEnd())
}

test('a table card shows each text cell whole, in as many rows as it takes, as the browser does', () => {
  const rows = text(card([['03-01 08:57', 'Wren Alder', 'Ostrander', REASON], ['03-02 06:27', 'Ostrander', 'Wren Alder', 'Undue']]), 80)
  // nothing cut, and the reason's words all there in order
  expect(rows.some(r => r.includes('…'))).toBe(false)
  const reason = reasonColumn(rows)
  // the whole reason, over rows of its own, then the second row's
  expect(reason.filter(Boolean).join(' ')).toBe(`${REASON} Undue`)
  expect(reason.filter(Boolean).length).toBeGreaterThan(2)
})

test('a run with no place to break, wider than its column, is broken where the row ends rather than cut', () => {
  const rows = text(card([['03-01 08:57', 'Wren Alder', 'Ostrander', LINK]]), 80)
  expect(rows.some(r => r.includes('…'))).toBe(false)
  expect(rows.every(r => r.length <= 80)).toBe(true)
  expect(reasonColumn(rows).join('')).toBe(LINK)
})
