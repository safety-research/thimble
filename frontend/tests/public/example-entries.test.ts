// An example card's refs as its entries (src/canvas/quotes.ts exampleEntries, entryParts): refs that name one record
// are one entry, which shows that record once with every quoted passage highlighted; refs of different records stay
// one entry each, as they were.
import { describe, expect, test } from 'vitest'
import { entryParts, exampleEntries, type QuotePart } from '../../src/canvas/quotes.ts'
import type { ResolvedRef } from '../../src/lib/types.ts'

const LONG =
  'Here is the plan for Saturday. We meet at the north gate of Willow Park at eleven. Maya brings two folding tables and the striped blanket. ' +
  'For food we have sandwiches, a pasta salad and lemonade, and Priya offered to bake a lemon cake. The bins by the gate close at six, so we start packing up at half past five.'
const step = (content: string) => ({ role: 'user', content })
const pointer = (ref: string, record: unknown): ResolvedRef => ({ ref, kind: 'pointer', path: 'plan.json', record, blocks: [{ kind: 'raw', text: JSON.stringify(record, null, 2) }], excerpt: '' }) as unknown as ResolvedRef
const RECORDS: Record<string, ResolvedRef> = {
  'plan.json#/steps/0': pointer('plan.json#/steps/0', step(LONG)),
  'plan.json#/steps/1': pointer('plan.json#/steps/1', step('I will bring the ice.')),
}
const got = (r: string) => RECORDS[r]
/** each highlighted passage of the parts, in order */
const marked = (parts: QuotePart[] | null) => (parts ?? []).flatMap((p) => ('marks' in p && p.marks ? p.marks.map(([a, b]) => p.text.slice(a, b)) : []))

describe('example entries', () => {
  test('three quotes of one JSON value are one entry with three highlights', () => {
    const quotes = ['north gate of Willow Park', 'Priya offered to bake a lemon cake', 'start packing up at half past five']
    const entries = exampleEntries(['plan.json#/steps/0', 'plan.json#/steps/0', 'plan.json#/steps/0'], quotes)
    expect(entries).toHaveLength(1)
    expect(entries[0].ref).toBe('plan.json#/steps/0')
    expect(marked(entryParts(entries[0], got))).toEqual(quotes)
  })
})

describe("a database row's fields, those the card's claim is about first (bug hunt B17)", () => {
  const row = (ref: string, table: string, record: Record<string, unknown>): ResolvedRef =>
    ({ ref, kind: 'row', path: 'runs/s3/forge.db', table, record, excerpt: JSON.stringify(record) }) as unknown as ResolvedRef
  const PR = 'runs/s3/forge.db#prs/66972'
  const REVIEW = 'runs/s3/forge.db#reviews/14'
  const ROWS: Record<string, ResolvedRef> = {
    [PR]: row(PR, 'prs', { number: 66972, body: '- [ ] closes #66675\r\n\r\n- [x] I used AI to develop this pull request.', title: 'DEPS: Remove hypothesis', author: 'gh:mroeschke', state: 'merged', claimed_by: 'agent-16', merged_by: 'agent-16' }),
    [REVIEW]: row(REVIEW, 'reviews', { id: 14, pr: 66972, created_at: '2026-08-28T22:32:26Z', verdict: 'approve', reviewer: 'agent-16', body: 'Reviewed: verified clean merge onto current main and ran the full set of touched test modules.' }),
  }
  const words = 'What do merges look like when one agent claimed and merged a PR alone? Agent-16 wrote the only review.'
  const kinds = (parts: QuotePart[] | null) => (parts ?? []).map((p) => (p.kind === 'field' ? `field ${p.key}` : p.kind === 'fields' ? `fields ${p.pairs.map(([k]) => k).join(' ')}` : p.kind))

  test('the value its takeaway cites first, under its name; the fields its words name first on the fields line; the body with its line ends', () => {
    const [e] = exampleEntries([PR], [''])
    const parts = entryParts(e, (r) => ROWS[r], { said: ['"DEPS: Remove hypothesis"'], words })
    expect(kinds(parts)).toEqual(['field title', 'fields claimed_by merged_by number author state', 'field body'])
    const body = parts!.find((p) => p.kind === 'field' && p.key === 'body') as Extract<QuotePart, { kind: 'field' }>
    expect(body.text).toBe('- [ ] closes #66675\n\n- [x] I used AI to develop this pull request.')
  })

  test('the words it quotes from a review: that field first, marked; the reviewer its words name first on the line', () => {
    const [e] = exampleEntries([REVIEW], ['verified clean merge'])
    const parts = entryParts(e, (r) => ROWS[r], { words })
    expect(kinds(parts)).toEqual(['field body', 'fields reviewer id pr created_at verdict'])
    expect(marked(parts)).toEqual(['verified clean merge'])
  })
})

describe("a markdown chat log's line, quoted (bug hunt D9)", () => {
  // `**R3:** …` showed as `**R3:** I could not find…`: the speaker's markdown kept, as the Transcript mode no longer shows it
  const LINE = '**R3:** I could not find the *stop* button. It sat under [the menu](https://example.org) somewhere.'
  const turn = { speaker: 'R3', at: 8 }
  const span = (start: number, end: number): ResolvedRef =>
    ({ ref: `R3/notes.md#L12.b0:c${start}-${end}`, kind: 'span', path: 'R3/notes.md', line: 12, block: 0, start, end, blocks: [{ kind: 'text', text: LINE }], excerpt: LINE.slice(start, end), meta: { turn } }) as unknown as ResolvedRef

  test("a passage of a speaker's line shows under the speaker's name, the words around it without markdown", () => {
    const at = LINE.indexOf('It sat')
    const r = span(at, LINE.length)
    const [part] = entryParts(exampleEntries([r.ref])[0], () => r)!
    expect(part).toEqual({ kind: 'span', key: 'R3', before: 'I could not find the stop button. ', text: 'It sat under the menu somewhere.', after: '' })
  })

  test("a speaker's whole line shows its words under the speaker's name, on one line", () => {
    const r = { ...span(0, 0), ref: 'R3/notes.md#L12', kind: 'record' } as unknown as ResolvedRef
    expect(entryParts(exampleEntries([r.ref])[0], () => r)).toEqual([{ kind: 'field', key: 'R3', text: 'I could not find the stop button. It sat under the menu somewhere.' }])
  })
})
