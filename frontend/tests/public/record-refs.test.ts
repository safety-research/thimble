// Records of any file (backend app/records.py) on the page: a database row, a PDF page, a JSON document's value and a
// CSV row parse as refs (src/lib/refs.ts), a view's page marks them by their labels like lines (src/files/labels.ts
// viewMarks), and the reader's line views find a CSV row's label at the line it starts on (src/files/marks.tsx
// rowsByRef).
import { describe, expect, test } from 'vitest'
import { rowsByRef } from '../../src/files/marks.tsx'
import { addressLabel, parseRef, recordKey, recordOf, refLabel, surfaceOf } from '../../src/lib/refs.ts'
import type { LabelRow, LabelsForPath } from '../../src/lib/types.ts'

describe('record refs', () => {
  test('a page, a JSON value and a CSV row parse, name their record and open in Files', () => {
    expect(parseRef('docs/audit.pdf#page=4')).toEqual({ kind: 'page', path: 'docs/audit.pdf', page: 4 })
    expect(parseRef('docs/audit.pdf#p4')).toEqual({ kind: 'page', path: 'docs/audit.pdf', page: 4 })
    expect(parseRef('runs.json#/runs/3')).toEqual({ kind: 'pointer', path: 'runs.json', pointer: '/runs/3' })
    expect(parseRef('data/orders.csv#row=12')).toEqual({ kind: 'csvrow', path: 'data/orders.csv', row: 12 })
    expect(parseRef('notes.txt#/x')).toEqual({ kind: 'path', path: 'notes.txt', locator: '/x' })
    for (const r of ['docs/audit.pdf#page=4', 'runs.json#/runs/3', 'data/orders.csv#row=12']) expect(surfaceOf(r)).toBe('files')
    expect(refLabel('docs/audit.pdf#page=4')).toBe('docs › audit.pdf p. 4')
    expect(refLabel('orders.csv#row=12')).toBe('orders.csv row 12')
    expect(addressLabel('runs.json#/runs/3')).toBe('runs.json /runs/3')
    expect(recordKey('docs/audit.pdf#page=4')).toBe('docs/audit.pdf#p4')
    expect(recordKey('docs/audit.pdf#p4')).toBe('docs/audit.pdf#p4')
    expect(recordOf('a.jsonl#L3')).toEqual({ path: 'a.jsonl', line: 3 })
    expect(recordOf('forge.db#prs/12')).toEqual({ path: 'forge.db' })
    expect(recordOf('docs/audit.pdf#p4')).toEqual({ path: 'docs/audit.pdf' })
    expect(recordOf('a.jsonl#L3-L5')).toBeNull()
    expect(recordOf('view:board/t1')).toBeNull()
    expect(recordOf('a.jsonl')).toBeNull()
    expect(recordOf('budget.xlsx#Q3!B2')).toEqual({ path: 'budget.xlsx' })
    expect(recordOf('pandas-dev/pandas#57012')).toBeNull()
  })
})
const row = (ref: string, label: string, line?: number): LabelRow => ({ ref, label, confidence: 1, source: 'regex', ...(line ? { line } : {}) })

describe('marks on records that are no lines', () => {

  test("a CSV row's label is found at its own ref and at the line it starts on, where a line's own row wins", () => {
    const list: LabelsForPath[] = [
      { concept_id: 'k1', name: 'refund', labels: ['refund', 'no'], unit: 'record', rows: [row('o.csv#row=1', 'refund', 2), row('o.csv#row=2', 'no', 4), row('o.csv#L4', 'refund')] },
    ]
    const byRef = rowsByRef(list)
    expect(byRef.get('o.csv#row=1')?.get('k1')?.label).toBe('refund')
    expect(byRef.get('o.csv#L2')?.get('k1')?.ref).toBe('o.csv#row=1')
    expect(byRef.get('o.csv#L4')?.get('k1')?.ref).toBe('o.csv#L4')
  })
})
