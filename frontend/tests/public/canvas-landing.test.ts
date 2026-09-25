// canvas/landing.ts: where the canvas lands on a switch to its tab while it wears its dot. An analyst who has seen none
// of the board's cards starts at the deck (or the top frame); one who has been exploring goes to the newest card made
// meanwhile.
import { describe, expect, it } from 'vitest'
import { SEEN_CAP, addSeen, canvasLanding, hasExplored } from '../../src/canvas/landing'

const board = ['deck1', 'deck2', 'yw1', 'new1', 'new2']

describe('canvasLanding', () => {
  it('lands a fresh analyst at the deck, not the newest card', () => {
    expect(canvasLanding({ seen: new Set(), cards: board, arrived: ['new1', 'new2'], start: 'deck' })).toEqual({ kind: 'frame', id: 'deck' })
  })

  it('counts the cards that just arrived as unseen, even when an earlier visit saw them', () => {
    expect(canvasLanding({ seen: new Set(['new2']), cards: board, arrived: ['new1', 'new2'], start: 'deck' })).toEqual({ kind: 'frame', id: 'deck' })
  })

  it('ignores cards seen that are no longer on the board (a fresh workspace under the same name)', () => {
    expect(hasExplored(new Set(['gone']), board)).toBe(false)
    expect(canvasLanding({ seen: new Set(['gone']), cards: board, arrived: ['new1'], start: 'top' })).toEqual({ kind: 'frame', id: 'top' })
  })

  it('sends an analyst who has been exploring to the newest card made meanwhile', () => {
    expect(canvasLanding({ seen: new Set(['deck1', 'yw1']), cards: board, arrived: ['new1', 'new2'], start: 'deck' })).toEqual({ kind: 'card', id: 'new2' })
  })

  it('prefers the newest card still on the board, else the newest made (the canvas waits for it)', () => {
    expect(canvasLanding({ seen: new Set(['deck1']), cards: ['deck1', 'new1'], arrived: ['new1', 'new2'], start: 'deck' })).toEqual({ kind: 'card', id: 'new1' })
    expect(canvasLanding({ seen: new Set(['deck1']), cards: ['deck1'], arrived: ['new1', 'new2'], start: 'deck' })).toEqual({ kind: 'card', id: 'new2' })
  })

  it('stays put with no card made meanwhile, or on an empty board with no start', () => {
    expect(canvasLanding({ seen: new Set(), cards: board, arrived: [], start: 'deck' })).toEqual({ kind: 'stay' })
    expect(canvasLanding({ seen: new Set(), cards: [], arrived: ['x'], start: null })).toEqual({ kind: 'stay' })
  })
})

describe('addSeen', () => {
  it('adds only new ids and returns the same list when nothing is new', () => {
    const a = ['a', 'b']
    expect(addSeen(a, ['b'])).toBe(a)
    expect(addSeen(a, ['c', 'c', 'a'])).toEqual(['a', 'b', 'c'])
  })

  it('keeps the latest SEEN_CAP ids', () => {
    const many = Array.from({ length: SEEN_CAP }, (_, i) => `c${i}`)
    const next = addSeen(many, ['z'])
    expect(next.length).toBe(SEEN_CAP)
    expect(next[0]).toBe('c1')
    expect(next[next.length - 1]).toBe('z')
  })
})
