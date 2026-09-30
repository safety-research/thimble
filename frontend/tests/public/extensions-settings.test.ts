import { describe, expect, it } from 'vitest'
import { changedExtensions } from '../../src/shell/ExtensionsSettings'

describe('changedExtensions', () => {
  it('sends only the switches that moved', () => {
    const row = { title: '', version: '', active: true, why: '', reason: '', note: '', locked: false }
    const loaded = [{ ...row, name: 'a', on: true }, { ...row, name: 'b', on: false }]
    expect(changedExtensions(loaded, { a: true, b: true })).toEqual({ b: true })
  })
})
