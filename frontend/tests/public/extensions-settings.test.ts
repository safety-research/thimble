import { describe, expect, it } from 'vitest'
import { asksToRun, changedExtensions, extensionCalls } from '../../src/shell/ExtensionsSettings'

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

describe('extensionCalls', () => {
  it('adds an extension thimble ships when its switch goes on, and switches the others', () => {
    const swarmOrient = { ...row, name: 'swarm-orient', on: false, views: [], addable: true }
    expect(extensionCalls([...loaded, swarmOrient], { a: false, b: true, 'swarm-orient': true })).toEqual([['a', 'off'], ['b', 'on'], ['swarm-orient', 'add']])
    expect(extensionCalls([swarmOrient], { 'swarm-orient': false })).toEqual([])
  })
})

describe('asksToRun', () => {
  const swarmOrient = { ...row, name: 'swarm-orient', on: false, views: [], orients: true }
  it('asks while the server offers it, and never for a locked row', () => {
    expect(asksToRun({ ...swarmOrient, on: true, offer: true }, true, true)).toBe(true)
    expect(asksToRun({ ...swarmOrient, on: true, offer: false }, true, true)).toBe(false)
    expect(asksToRun({ ...swarmOrient, locked: true }, true, true)).toBe(false)
  })
})
