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
