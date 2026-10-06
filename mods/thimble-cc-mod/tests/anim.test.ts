// A card's focus (hooks/anim.ts): the value a citation or a report's caption names, as the item cardLayout draws for it.
// `claude plugin test mods/thimble-cc-mod`.
import { expect, test } from 'claude-code/testing'

import { focusFromRef, focusItem } from '../hooks/anim'
import { cardLayout } from '../hooks/draw'
import type { CardData } from '../hooks/draw'

const base = { question: 'q', x: '', y: '', note: '', source: {} }
const LINE: CardData = {
  ...base,
  id: 'l1',
  kind: 'line',
  x: 'day',
  y: 'saves',
  series: [
    { name: 'saves', points: [['2026-06-15', 1200], ['2026-06-16', 2400], ['2026-06-17', 3100], ['2026-06-18', 6543], ['2026-06-19', 2800], ['2026-06-20', 900]] },
    { name: 'reverts', points: [['2026-06-15', 100], ['2026-06-16', 300], ['2026-06-17', 800], ['2026-06-18', 1900], ['2026-06-19', 700], ['2026-06-20', 200]] },
  ],
}
const BAR: CardData = {
  ...base,
  id: 'b1',
  kind: 'bar',
  y: 'revisions',
  rows: [
    { label: 'dse', value: 13403, group: '' },
    { label: 'probier', value: 1013, group: '' },
    { label: 'sandbox', value: 2.5, group: '' },
  ],
  total: 14418.5,
}
const TIMELINE: CardData = {
  ...base,
  id: 't1',
  kind: 'timeline',
  events: [
    { time: '2026-06-18T17:15:00Z', label: 'First revision', ref: '' },
    { time: '2026-06-18T19:02:00Z', label: 'The bot starts reverting edits on the main page', ref: 'revisions.jsonl#L4' },
    { time: '2026-06-18T21:26:00Z', label: 'Last revert', ref: 'revisions.jsonl#L9' },
  ],
}
const TABLE: CardData = {
  ...base,
  id: 'tb1',
  kind: 'table',
  columns: ['agent', 'edits', 'reverts'],
  rows: [
    ['alpha', 120, 4],
    ['beta', 87, 19],
    ['gamma', 33, 0],
    ['delta', 9, 1],
  ],
}
const EXAMPLE: CardData = {
  ...base,
  id: 'e1',
  kind: 'example',
  examples: [
    { ref: 'chat.jsonl#L12', quote: 'I will revert every edit that touches the main page until someone stops me.', note: 'announces the reverts' },
    { ref: 'chat.jsonl#L40', quote: 'Fine, I stop now.', note: 'gives up' },
  ],
}
const DIAGRAM: CardData = {
  ...base,
  id: 'd1',
  kind: 'diagram',
  nodes: [
    { id: 'p', label: 'Planner' },
    { id: 'c', label: 'Coder' },
    { id: 'r', label: 'Reviewer' },
    { id: 'm', label: 'Merger' },
  ],
  edges: [
    { source: 'p', target: 'c', label: 'assigns' },
    { source: 'c', target: 'r', label: 'opens a pull request' },
    { source: 'r', target: 'm', label: 'approves' },
  ],
}
const item = (card: CardData, cols: number, f: Parameters<typeof focusItem>[2]) => {
  const items = cardLayout(card, cols, -1).items
  return items[focusItem(card, items, f)]
}

test('a focus names the item it cites on each kind of card; one that names nothing names none', () => {
  expect(item(LINE, 60, { series: 'saves', x: '2026-06-18' })?.open).toBe('card:l1#saves/2026-06-18')
  expect(item(BAR, 60, { row: 'probier' })?.label).toContain('probier')
  expect(item(TIMELINE, 60, { event: 2 })?.text).toContain('The bot starts')
  expect(item(TABLE, 60, { row: 'beta', series: 'reverts' })?.text).toBe('19')
  expect(item(EXAMPLE, 60, { row: 'chat.jsonl#L40' })?.open).toBe('chat.jsonl#L40')
  expect(item(DIAGRAM, 70, { node: 'c' })?.label).toContain('Coder')
  expect(item(BAR, 60, { row: 'nowhere' })).toBeUndefined()
})

test('a citation\'s place becomes the focus of the value it cites', () => {
  expect(focusFromRef(LINE, 'card:l1#saves/2026-06-18')).toEqual({ series: 'saves', x: '2026-06-18' })
  expect(focusFromRef(BAR, 'card:b1#revisions/probier')).toEqual({ row: 'probier' })
  expect(focusFromRef(TABLE, 'card:tb1#reverts/beta')).toEqual({ series: 'reverts', row: 'beta' })
  expect(focusFromRef(TIMELINE, 'card:t1#time/2')).toEqual({ event: 2 })
  expect(focusFromRef(TIMELINE, 'revisions.jsonl#L9')).toEqual({ event: 3 })
  expect(focusFromRef(EXAMPLE, 'chat.jsonl#L40')).toEqual({ row: 'chat.jsonl#L40' })
  expect(focusFromRef(DIAGRAM, 'card:d1#node/r')).toEqual({ node: 'r' })
  expect(focusFromRef(BAR, 'card:other#revisions/probier')).toBe(undefined)
  // and the focus names the item cardLayout's readout and citations use
  const items = cardLayout(LINE, 60, -1).items
  expect(items[focusItem(LINE, items, { series: 'saves', x: '2026-06-18' })]!.open).toBe('card:l1#saves/2026-06-18')
})
