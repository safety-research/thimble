// @vitest-environment jsdom
// Labels in every view, the page half: what a view's page hears of the labels (files/labels.ts pageLabels), the Files
// label filter's verdict on each record the page shows (withKeeps), and the view's own pane, which shows its Labels
// sidebar beside it (ViewSurface), a funnel on each label's row that sets the Files filter and, pressed, clears it,
// and the filter as a chip that clears it. The server is a fake fetch.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { pageLabels, withKeeps, type ViewMark } from '../../src/files/labels.ts'
import { ViewSurface } from '../../src/files/ViewSurface.tsx'
import type { Concept, LabelRow } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const concept = (id: string, name: string, shown: boolean, classes: Concept['classes']): Concept =>
  ({ id, name, unit: 'record', kind: 'regex', labels: (classes ?? []).map((c) => c.name), classes, shown, marks: 'record' }) as unknown as Concept

const ASKS = concept('k1', 'asks', true, [{ name: 'asks', color: 3, highlight: true }, { name: 'other', color: 0, highlight: false }])
const TONE = concept('k2', 'tone', false, [{ name: 'calm', color: 5, highlight: true }, { name: 'curt', color: 6, highlight: true }])
const resolve = (t: string) => `#${t.slice(2)}`

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
