// The top bar's tab dots (src/shell/dots.ts): which stream events light which tab.
import { describe, expect, test } from 'vitest'
import { tabOfEvent } from '../../src/shell/dots.ts'

describe('the Canvas tab', () => {
  test('a card made or deleted lights it, the orientation\'s among them; an edit does not', () => {
    expect(tabOfEvent('cell', { op: 'created' })).toBe('canvas')
    expect(tabOfEvent('cell', { op: 'deleted' })).toBe('canvas')
    expect(tabOfEvent('cell', { op: 'edited' })).toBeNull()
    expect(tabOfEvent('orient', { status: 'done' })).toBeNull()
  })
})

describe('the Files tab', () => {
  test('a view built lights it; a view proposal, a build queued, under way or failed, and one dropped or deleted do not', () => {
    expect(tabOfEvent('view', { slug: 'timeline', status: 'built' })).toBe('files')
    for (const status of ['suggested', 'queued', 'building', 'failed', 'dropped', 'deleted', 'chat'])
      expect(tabOfEvent('view', { slug: 'timeline', status }), status).toBeNull()
  })
  test("a held proposal's view (an orientation's from before 0.8.0, until it first passes) does not light it; a label's change does", () => {
    expect(tabOfEvent('view', { slug: 'timeline', status: 'built', held: true })).toBeNull()
    expect(tabOfEvent('concepts', { concept: 'k1', what: 'applied' })).toBe('files')
  })
})
