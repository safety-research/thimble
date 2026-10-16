// The label's records with no category fit and its unsure records first (src/canvas/details.ts fitOf and unsureFirst,
// src/canvas/LabelDetails.tsx EXAMPLES), in the order the terminal's Labels view lists them (backend concepts.unsure):
// no fit (no value, a value off the label's list, or one that says nothing) first, then the unsure ones (confidence
// below 0.6) lowest first, then the rest as the server gave them; the analyst's own value always fits.
import { describe, expect, test } from 'vitest'
import { fitOf, QUIET_VALUES, UNSURE_BELOW, UNSURE_LABEL, unsureFirst } from '../../src/canvas/details.ts'
import type { LabelRow } from '../../src/lib/types.ts'

const VALUES = ['coordination', 'status report', 'other']
const row = (ref: string, label: string | null, confidence: number | null, analyst: string | null = null): LabelRow =>
  ({ ref, label, confidence, analyst, source: 'model' }) as LabelRow

describe('fit', () => {
  test('no value, a value off the list, or a value that says nothing is no fit; below 0.6 is unsure', () => {
    expect(UNSURE_BELOW).toBe(0.6)
    expect([...QUIET_VALUES].sort()).toEqual(['n/a', 'neither', 'no', 'no match', 'none', 'not', 'other', 'unknown'])
    expect(fitOf(row('a', null, null), VALUES)).toBe('no-fit')
    expect(fitOf(row('b', 'gossip', 0.9), VALUES)).toBe('no-fit')
    expect(fitOf(row('c', 'other', 0.95), VALUES)).toBe('no-fit')
    expect(fitOf(row('d', 'coordination', 0.59), VALUES)).toBe('unsure')
    expect(fitOf(row('e', 'coordination', 0.6), VALUES)).toBe('sure')
    expect(fitOf(row('f', 'coordination', null), VALUES)).toBe('sure')
    expect(fitOf(row('g', null, 0.1, 'coordination'), VALUES)).toBe('sure')
  })
})

describe('the order', () => {
  test('no fit first, then unsure by confidence, lowest first, then the rest in their order', () => {
    const rows = [
      row('sure-1', 'coordination', 0.9),
      row('unsure-55', 'status report', 0.55),
      row('nofit-off', 'gossip', 0.99),
      row('sure-2', 'status report', 0.8),
      row('unsure-20', 'coordination', 0.2),
      row('nofit-null', null, null),
      row('analyst', null, 0.1, 'coordination'),
    ]
    expect(unsureFirst(rows, VALUES).map((r) => r.ref)).toEqual(['nofit-off', 'nofit-null', 'unsure-20', 'unsure-55', 'sure-1', 'sure-2', 'analyst'])
    expect(UNSURE_LABEL).toBe('no fit · unsure')
  })
})
