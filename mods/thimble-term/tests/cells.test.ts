// Each kind of thimble card in thimble-cc-mod's drawing form (hooks/cell.ts), and how it draws: the map of card kinds.
// `claude plugin test mods/thimble-term`.
import { expect, test } from 'claude-code/testing'

import { busyWords, cardOfCell, htmlTable, labelCard } from '../hooks/cell'
import type { ThimbleCell } from '../hooks/cell'
import { cardLayout } from '../hooks/draw'
import type { BarRow, Cell } from '../hooks/draw'
import { CELLS, LABEL } from './fixtures'

const of = (id: string) => CELLS[id] as unknown as ThimbleCell
const text = (id: string, cols = 70) => {
  const { card } = cardOfCell(of(id), id === 'l0label0' ? (LABEL as never) : null)
  return cardLayout(card, cols, -1).lines.map(l => l.map(s => s.s).join(''))
}

test("a pandas table's html is a table card: the index named, numbers as numbers", () => {
  const { card } = cardOfCell(of('ff73e071'))
  expect(card.kind).toBe('table')
  expect(card.columns).toEqual(['wiki', 'pages', 'revisions'])
  expect((card.rows as Cell[][])[2]).toEqual(['TOTAL', 4579, 14591])
  expect(text('ff73e071').join('\n')).toContain('probier')
  expect(htmlTable('<p>no table</p>')).toEqual([])
})

test("a table card's frame: its label column first, then the shown columns", () => {
  const { card } = cardOfCell(of('a0frame0'))
  expect(card.kind).toBe('table')
  expect(card.columns).toEqual(['file', 'records'])
  expect((card.rows as Cell[][])[1]).toEqual(['events.jsonl', 19913])
})

test('a one-layer Altair bar chart draws as text bars; a faceted one as a table of its rows', () => {
  const bar = cardOfCell(of('b0bar000')).card
  expect(bar.kind).toBe('bar')
  expect((bar.rows as BarRow[])[0]).toEqual({ label: 'dse', value: 13403, group: '' })
  expect(text('b0bar000').some(l => /dse +█+ +13,403/.test(l))).toBe(true)
  const facet = cardOfCell(of('c5466383')).card
  expect(facet.kind).toBe('table')
  expect(facet.columns).toEqual(['day', 'event_type', 'rows'])
})

test('a diagram from its payload (from and to) and a timeline from its output draw directly', () => {
  const d = cardOfCell(of('d0diag00')).card
  expect(d.kind).toBe('diagram')
  expect(d.edges).toEqual([{ source: 'agents', target: 'dse', label: 'saves' }, { source: 'admin', target: 'dse', label: 'deletions' }])
  // a node only an edge names is drawn by its name
  expect(d.nodes!.map(n => n.id)).toEqual(['agents', 'dse', 'admin'])
  expect(text('d0diag00').join('\n')).toContain('dse wiki')
  const t = cardOfCell(of('e0time00')).card
  expect(t.kind).toBe('timeline')
  expect(text('e0time00').join('\n')).toContain('peak afternoon')
})

test('an example card lists its records; a note is prose; a custom card its words; a code card what it printed', () => {
  const ex = cardOfCell(of('a20ecb55')).card
  expect(ex.kind).toBe('example')
  expect(ex.examples!.map(x => x.ref)).toEqual(['README.md#L3', 'README.md#L5'])
  expect(text('a20ecb55').join('\n')).toContain('README.md line 3')
  expect(text('n0note00')).toEqual(['The dse wiki was used as a relay and as a message board.'])
  expect(text('c0cust00')).toEqual(['45%', 'of all saves landed in one afternoon'])
  expect(text('k0code00')).toEqual(['revisions.jsonl 14591', 'events.jsonl 19913'])
})

test("a card whose run failed says why; one waiting for its run says so", () => {
  const { error } = cardOfCell(of('x0err000'))
  expect(error).toBe("KeyError: 'wiki'")
  expect(busyWords(of('w0wait00'))).toBe('waiting for its run')
  expect(busyWords(of('ff73e071'))).toBe('')
})

test("a label card: its counts as bars in the label's order; the records it carries are drawn in the label panel, not on it", () => {
  const card = labelCard(of('l0label0'), LABEL as never)
  expect(card.kind).toBe('label')
  expect((card.rows as BarRow[]).map(r => [r.label, r.value])).toEqual([['proxy-link', 5191], ['none', 9400]])
  expect(card.label).toMatchObject({ slug: 'd9b51617', kind: 'regex', labeled: 14591, total: 14591, trial: false, paths: ['revisions.jsonl'] })
  expect(card.examples![0]).toMatchObject({ ref: 'revisions.jsonl#L10566', value: 'proxy-link', why: 'r.jina.ai link', set: false })
  expect(card.examples![1]).toMatchObject({ value: 'none', set: true })
  const lines = text('l0label0', 90)
  expect(lines.some(l => /proxy-link .*5,191/.test(l))).toBe(true)
  // a label card is a bar card of its counts: its records and their verdicts are the label panel's
  expect(lines.some(l => l.includes('agree'))).toBe(false)
  // before the label is read, a line that says so
  expect(labelCard(of('l0label0'), null).kind).toBe('note')
})

test('no card drawing shows a hex id', () => {
  for (const id of Object.keys(CELLS)) {
    const lines = text(id, 90).join('\n')
    expect(lines).not.toMatch(/\b(card|cell):[0-9a-f]{6,}/)
    expect(lines).not.toContain(id)
  }
})
