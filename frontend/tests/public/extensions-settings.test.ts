import { describe, expect, it } from 'vitest'
import { answeredRuns, asksToRun, changedExtensions, changedViews } from '../../src/shell/ExtensionsSettings'

const view = { name: 'Tally', shown: true, note: '', locked: false }
const row = { version: '', active: true, why: '', note: '', locked: false }
const loaded = [
  { ...row, name: 'a', on: true, views: [{ ...view, slug: 'tally', on: true }] },
  { ...row, name: 'b', on: false, views: [{ ...view, slug: 'tally', on: false }] },
]

describe('changedExtensions', () => {
  it('sends only the switches that moved', () => {
    expect(changedExtensions(loaded, { a: true, b: true })).toEqual({ b: true })
  })
})

describe('changedViews', () => {
  it('sends only the view switches that moved, by extension and view', () => {
    expect(changedViews(loaded, { 'a/tally': true, 'b/tally': true })).toEqual([['b', 'tally', true]])
  })
})

describe('asksToRun', () => {
  const swarm = { ...row, name: 'swarm', on: false, views: [], orients: true }
  it('asks when a switch with orientation instructions goes on where an orientation ran', () => {
    expect(asksToRun(swarm, true, true)).toBe(true)
    expect(asksToRun(swarm, true, false)).toBe(false)
    expect(asksToRun(swarm, false, true)).toBe(false)
    expect(asksToRun({ ...swarm, orients: false }, true, true)).toBe(false)
  })
  it('asks while the server offers it, and never for a locked row', () => {
    expect(asksToRun({ ...swarm, on: true, offer: true }, true, true)).toBe(true)
    expect(asksToRun({ ...swarm, on: true, offer: false }, true, true)).toBe(false)
    expect(asksToRun({ ...swarm, locked: true }, true, true)).toBe(false)
  })
  it('sends only the answers of rows that still ask', () => {
    const data = { extensions: [swarm, { ...swarm, name: 'other' }], conflicts: [], orientation_ran: true }
    expect(answeredRuns(data, { swarm: true, other: false }, { swarm: true, other: true })).toEqual([['swarm', true]])
  })
})
