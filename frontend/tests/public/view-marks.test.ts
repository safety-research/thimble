// The marks a view's page gets of the labels that are on (src/files/labels.ts viewMarks, which ViewerFrame sends as the
// bridge's `labels` message): each names every label that highlights the record with its value, and every colour is one
// a canvas can draw, the token a label's colour is resolved to (thimble.markOf hands them to the page as they are).
import { describe, expect, test } from 'vitest'
import { pageColour, viewMarks } from '../../src/files/labels.ts'
import type { Concept, LabelRow } from '../../src/lib/types.ts'

const K = { id: 'k1', name: 'refund', unit: 'record', marks: 'record', labels: ['refund', 'no'], classes: [{ name: 'refund', color: 3, highlight: true }, { name: 'no', color: 0, highlight: false }] } as unknown as Concept
const rows = new Map([['a.jsonl#L1', new Map([['k1', { ref: 'a.jsonl#L1', label: 'refund', confidence: 1, source: 'regex', spans: ['money back'] } as LabelRow]])]])

describe('the marks a view page gets', () => {
  test('name each label with its value, and every colour is one a canvas can draw', () => {
    const resolve = (t: string) => ({ '--label-3': '#08632f' })[t] ?? ''
    const m = viewMarks([K], rows, ['a.jsonl#L1', 'a.jsonl#L2'], resolve)
    expect(Object.keys(m)).toEqual(['a.jsonl#L1'])
    expect(m['a.jsonl#L1']).toEqual({ bar: '#08632f', names: ['refund'], values: [{ id: 'k1', label: 'refund', value: 'refund', colour: '#08632f' }], spans: [{ text: 'money back', colour: '#08632f' }] })
  })

  test('a token the theme does not define stays a token, and a colour stays as it is', () => {
    expect(pageColour('var(--label-9)', () => '')).toBe('var(--label-9)')
    expect(pageColour('#123456', () => 'x')).toBe('#123456')
    expect(pageColour(' var(--label-1) ', (t) => (t === '--label-1' ? 'rgb(2, 90, 195)' : ''))).toBe('rgb(2, 90, 195)')
  })
})
