// What a label card's table and examples show (src/canvas/details.ts): the shares are among the units that matched, not
// among every unit the label read, and an example is the words that earned the value, never how a unit begins.
import { describe, expect, test } from 'vitest'
import { exampleCandidates, exampleParts, labelShares, noMatchValues, pickExamples, unmatchedExample } from '../../src/canvas/details.ts'

describe('labelShares', () => {
  test('3 matches in 1,000 units: the shares sum to 100% over the matches, and the negative has none', () => {
    const labels = ['refund asked', 'refund given', 'no refund']
    const counts = { 'refund asked': 2, 'refund given': 1, 'no refund': 997 }
    const s = labelShares(labels, counts, 1000)
    expect(s.matched).toBe(3)
    expect(s.share).toEqual({ 'refund asked': '67%', 'refund given': '33%', 'no refund': '' })
    expect(parseInt(s.share['refund asked']) + parseInt(s.share['refund given'])).toBe(100)
  })

  test('the second of two values is the negative, and one value alone, or a label with no negative, shares over the whole', () => {
    const flagged = labelShares(['flagged', 'clean'], { flagged: 12, clean: 988 }, 1000)
    expect(flagged.share).toEqual({ flagged: '1.2%', clean: '' })
    expect(flagged.matched).toBe(12)
    const kinds = labelShares(['email', 'chat', 'phone'], { email: 50, chat: 30, phone: 20 }, 100)
    expect(kinds.negatives.size).toBe(0)
    expect(kinds.share).toEqual({ email: '50%', chat: '30%', phone: '20%' })
    expect(kinds.matched).toBe(100)
  })
})

describe('a value example', () => {
  test('is the matched span with the words around it', () => {
    const part = exampleParts({ text: 'Customer wrote: please refund my order, it never came.', match: 'please refund my order' }, 240)
    expect(part.match).toBe('please refund my order')
    expect(part.before).toBe('Customer wrote: ')
  })

  test('without a match, a whole file, a record cut short and a line with no word give none', () => {
    expect(unmatchedExample('agent', 'You are a support agent. Today is 2026-01-05.')).toBeNull()
    expect(unmatchedExample('record', '<system-reminder> As you answer the user…')).toBeNull()
    expect(unmatchedExample('record', '{')).toBeNull()
    expect(unmatchedExample('record', 'Refund sent for order 118.')).toEqual({ text: 'Refund sent for order 118.' })
    expect(unmatchedExample('record', 'Refund sent for order 118.', 'tickets/118.json#L1')).toBeNull()
    expect(unmatchedExample('record', 'Refund sent for order 118.', 'tickets.jsonl#L7')).toEqual({ text: 'Refund sent for order 118.' })
  })

  test('a value that says nothing matched shows an example only with the words that earned it', () => {
    const noMatch = noMatchValues(['refund asked', 'other request', 'no refund'])
    expect([...noMatch]).toEqual(['no refund'])
    expect([...noMatchValues(['flagged', 'clean'])]).toEqual(['clean'])
    expect([...noMatchValues(['not a merge', 'none', 'n/a', 'merged'])]).toEqual(['not a merge', 'none', 'n/a'])
    const plain = { text: 'system init session 4c1f 8e2a' }
    const earned = { text: 'Customer wrote: no refund needed.', match: 'no refund needed' }
    expect(exampleCandidates('no refund', noMatch, [plain, earned])).toEqual([earned])
    expect(exampleCandidates('no refund', noMatch, [plain])).toEqual([])
    // a catch-all among the matches keeps the words of its units
    expect(exampleCandidates('other request', noMatch, [plain])).toEqual([plain])
  })

  test("a value whose first example another value already shows takes its next one", () => {
    const shared = { text: 'Please refund order 118.' }
    const next = { text: 'Refund sent for order 119.' }
    const picked = pickExamples(['refund asked', 'refund given'], { 'refund asked': [shared], 'refund given': [shared, next] })
    expect(picked).toEqual({ 'refund asked': shared, 'refund given': next })
  })
})
