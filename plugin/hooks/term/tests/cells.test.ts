// Each kind of thimble card in its drawing form (hooks/cell.ts): a table, a bar chart, a diagram and a timeline, an
// example, a note, a custom card's words or table and a code card, a label's counts, a takeaway's links check; a chip
// naming its place short, a card by `card:<name>`. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { cardOfCell, htmlTable, labelCard, linksOf } from '../cell'
import type { ThimbleCell } from '../cell'
import { cardLayout, placeWords } from '../draw'
import { CHIP_MAX, chipLabel, noteLabelName, noteName, width } from '../lib'
import type { BarRow, Cell } from '../draw'
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

test('an example card lists its records; a note is prose; a custom card its words or its table; a code card what it printed', () => {
  const ex = cardOfCell(of('a20ecb55')).card
  expect(ex.kind).toBe('example')
  expect(ex.examples!.map(x => x.ref)).toEqual(['README.md#L3', 'README.md#L5'])
  expect(text('a20ecb55').join('\n')).toContain('README.md line 3')
  expect(text('n0note00')).toEqual(['The dse wiki was used as a relay and as a message board.'])
  expect(text('c0cust00')).toEqual(['45%', 'of all saves landed in one afternoon'])
  // a custom card's table is a table card; one with no words draws nothing of its own (its link opens the browser)
  const table = '<h2>Saves</h2><table><tr><th>wiki</th><th>saves</th></tr><tr><td>dse</td><td>1,204</td></tr><tr><td>probier</td><td>88</td></tr></table>'
  const custom = cardOfCell({ ...of('c0cust00'), payload: { html: table } } as ThimbleCell).card
  expect(custom.kind).toBe('table')
  expect(custom.columns).toEqual(['wiki', 'saves'])
  expect(custom.rows).toEqual([['dse', 1204], ['probier', 88]])
  expect(cardOfCell({ ...of('c0cust00'), payload: { html: '<canvas></canvas>' } } as ThimbleCell).card.note).toBe('')
  expect(text('k0code00')).toEqual(['revisions.jsonl 14591', 'events.jsonl 19913'])
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
  // the counts with the analyst's verdicts, as the label panel shows them (live check term-fix6, new quirk 1: the card
  // kept the label's own counts after a verdict)
  const set = labelCard(of('l0label0'), { ...LABEL, verdicts: { counts: { none: 9401, 'proxy-link': 5190 }, set: 1 } } as never)
  expect((set.rows as BarRow[]).map(r => [r.label, r.value])).toEqual([['proxy-link', 5190], ['none', 9401]])
})

test("a card's takeaway as thimble's links check left it: linked and contradicted citations by value and ref", () => {
  const links = linksOf({ id: 'x', verification: { links: { status: 'partial', checked: true, resolved: [{ value: '4579', ref: 'card:x#pages/TOTAL' }], broken: [{ value: '12', ref: 'a.csv#row=1', why: 'the place shows 13', source: '13' }], typed: [{ value: '14,591', ref: 'card:x@out1#L2', line: 4, why: 'typed in the code, line 4, not computed' }] } } } as ThimbleCell)
  expect(links).toEqual({ pending: false, checked: true, ok: ['4579|card:x#pages/TOTAL'], broken: [{ key: '12|a.csv#row=1', why: 'the place shows 13', source: '13' }], typed: [{ key: '14,591|card:x@out1#L2', why: 'typed in the code, line 4, not computed' }] })
  expect(linksOf({ id: 'y' } as ThimbleCell)).toBeUndefined()
})

test("a place cited with a passage of its line reads as its line; a chip names its place short, a card `card:<name>`, a file's line by the file's name and the line", () => {
  // live check term-fix5, new quirks 3 and 4: `↗ agent-chat.jsonl#L2.b0:c0-120`, and `card L1`
  expect(placeWords('collusion-wiki/agent-chat.jsonl#L2.b0:c0-120')).toBe('collusion-wiki/agent-chat.jsonl line 2')
  expect(placeWords('collusion-wiki/agent-chat.jsonl#L2.b1')).toBe('collusion-wiki/agent-chat.jsonl line 2')
  // a chip (Matt, 2026-10-07): `[ card ]`, `[ events.jsonl line 12 ]`, `[ label name ]`; never `agent-chat:2`, which
  // reads as an id (live check term-fix9, low quirk)
  const chip = (ref: string) => chipLabel({ raw: `[[${ref}]]`, ref, display: null })
  expect(chip('agent-chat.jsonl#L2.b0:c0-120')).toBe('[ agent-chat.jsonl line 2 ]')
  expect(chip('events.jsonl#L12')).toBe('[ events.jsonl line 12 ]')
  expect(chip('agent-chat.jsonl#L1-L2')).toBe('[ agent-chat.jsonl lines 1-2 ]')
  expect(chip('data/runs.json#/runs/3')).toBe('[ runs.json item 4 ]')
  expect(chip('README.md')).toBe('[ README.md ]')
  // a long name cut in its middle, its line kept, the chip short
  const long = chip('a/collusion-wiki-revisions-of-every-page.jsonl#L10879')
  expect(long).toMatch(/^\[ collus\S*…\S*-page\.jsonl line 10879 \]$/)
  expect(width(long)).toBeLessThanOrEqual(CHIP_MAX + 4)
  // a card by its name (Matt, 2026-10-16): its id, which is the name of its question, or an older card's name once read;
  // `card` while an older card's random id is all there is, never the id
  expect(chip('card:c0ffee00')).toBe('[ card ]')
  expect(chip('card:c0ffee00#wiki/dse')).toBe('[ card ]')
  expect(chip('card:how-many-prs')).toBe('[ card:how-many-prs ]')
  expect(chip('card:how-many-prs#wiki/dse')).toBe('[ card:how-many-prs ]')
  expect(chip('cell:prs-merged-week-12')).toBe('[ card:prs-merged-week-12 ]')
  noteName('c0ffee00', 'wikis-most-revisions')
  expect(chip('card:c0ffee00')).toBe('[ card:wikis-most-revisions ]')
  expect(chip('card:c0ffee00@out0#L1')).toBe('[ card output line 1 ]')
  expect(chip('card:c0ffee00@out0#L1-L3')).toBe('[ card output lines 1-3 ]')
  expect(chip('call:a1b2c3#L4')).toBe('[ output line 4 ]')
  expect(chip('report:report#4255ef27')).toBe('[ report ]')
  expect(chip('report:slides')).toBe('[ slides ]')
  expect(chip('concept:eb534ca4')).toBe('[ label ]')
  noteLabelName('eb534ca4', 'edit purpose')
  expect(chip('concept:eb534ca4')).toBe('[ edit purpose ]')
  expect(chip('concept:eb534ca4/yes')).toBe('[ edit purpose · yes ]')
  // a citation with words is its words, a chip or not
  expect(chipLabel({ raw: '[[3|card:c0ffee00#n/all]]', ref: 'card:c0ffee00#n/all', display: '3' })).toBe('3')
})
