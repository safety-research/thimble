// @vitest-environment jsdom
// Labels in a view, the page half: the Files label filter's verdict on each record a view's page shows
// (src/files/labels.ts withKeeps).
import { describe, expect, test } from 'vitest'
import { withKeeps, type ViewMark } from '../../src/files/labels.ts'
import type { LabelRow } from '../../src/lib/types.ts'

describe('what a view page hears of the labels', () => {
  test('the filter keeps a record whose row takes its value, and a record it drops and no label marks is left out', () => {
    const rows = new Map<string, Map<string, LabelRow>>([
      ['a.jsonl#L1', new Map([['k1', { label: 'asks' } as LabelRow]])],
      ['a.jsonl#L2', new Map([['k1', { label: 'other' } as LabelRow]])],
      ['a.jsonl#L3', new Map([['k1', { label: 'other', analyst: 'asks' } as LabelRow]])],
    ])
    const marks: Record<string, ViewMark> = { 'a.jsonl#L1': { bar: 'var(--label-3)', names: ['asks'], spans: [] } }
    const refs = ['a.jsonl#L1', 'a.jsonl#L2', 'a.jsonl#L3', 'a.jsonl#L4', 'view:v/k']
    expect(withKeeps(marks, null, rows, refs)).toBe(marks)
    expect(withKeeps(marks, { concept: 'k1', value: 'asks' }, rows, refs)).toEqual({
      'a.jsonl#L1': { bar: 'var(--label-3)', names: ['asks'], spans: [], keep: true },
      'a.jsonl#L3': { keep: true },
    })
  })
})
