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
