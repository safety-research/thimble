// Records of any file (backend app/records.py) on the page: a database row, a PDF page, a JSON document's value and a
// CSV row parse as refs (src/lib/refs.ts), a view's page marks them by their labels like lines (src/files/labels.ts
// viewMarks), and the reader's line views find a CSV row's label at the line it starts on (src/files/marks.tsx
// rowsByRef).
import { describe, expect, test } from 'vitest'
import { viewMarks, withKeeps } from '../../src/files/labels.ts'
import { rowsByRef } from '../../src/files/marks.tsx'
import { addressLabel, addressLabels, parseRef, recordKey, recordOf, refLabel, surfaceOf } from '../../src/lib/refs.ts'
import type { Concept, LabelRow, LabelsForPath } from '../../src/lib/types.ts'

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

  test("an example's address names the trial a trajectory belongs to, not the trial's agent folder", () => {
    // `<job>/<trial>/agent/trajectory.json` with no digit in any folder, so the quotes of several trials all read
    // `agent › trajectory.json` and the card could not say whose each quote was
    const trial = (t: string) => `picnic-runs/${t}/agent/trajectory.json`
    expect(addressLabel(`${trial('picnic-lake__RvtmQxa')}#L16`)).toBe('picnic-lake__RvtmQxa › trajectory.json L16')
    expect(addressLabel(`${trial('picnic-hill__GdsaPwe')}#/steps/7`)).toBe('picnic-hill__GdsaPwe › trajectory.json /steps/7')
    expect(refLabel('batch2/agents/agent-03.jsonl#L412')).toBe('batch2 › agent-03.jsonl L412')
  })

  test("an example's addresses tell its trials apart in a job folder named by its date", () => {
    // the date is the first folder with a digit, so each trial's quotes read `2026-05-02__09-00-00 › … ›
    // trajectory.json`; the card's addresses name the folder in which the trials' paths part
    const trial = (t: string) => `jobs/2026-05-02__09-00-00/${t}/agent/trajectory.json`
    const refs = [`${trial('picnic-hill__GdsaPwe')}#/steps/3`, `${trial('picnic-lake__RvtmQxa')}#/steps/3`, `${trial('picnic-lake__RvtmQxa')}#L40`]
    expect(refs.map(addressLabel)).toEqual(['2026-05-02__09-00-00 › … › trajectory.json /steps/3', '2026-05-02__09-00-00 › … › trajectory.json /steps/3', '2026-05-02__09-00-00 › … › trajectory.json L40'])
    expect(addressLabels(refs)).toEqual(['picnic-hill__GdsaPwe › trajectory.json /steps/3', 'picnic-lake__RvtmQxa › trajectory.json /steps/3', 'picnic-lake__RvtmQxa › trajectory.json L40'])
    // folders left out between the folder named and the file's name show as they do on any chip
    expect(addressLabels(['jobs/2026-05-02/trial-a/logs/x.jsonl#L2', 'jobs/2026-05-02/trial-b/logs/x.jsonl#L2'])).toEqual(['trial-a › … › x.jsonl L2', 'trial-b › … › x.jsonl L2'])
    // addresses that differ already, and the passages of one file, keep their own
    expect(addressLabels(['batch2/agents/agent-03.jsonl#L412', 'batch3/agents/agent-03.jsonl#L9', 'batch3/agents/agent-03.jsonl#L12', 'notes.md'])).toEqual(['batch2 › agent-03.jsonl L412', 'batch3 › agent-03.jsonl L9', 'batch3 › agent-03.jsonl L12', 'notes.md'])
  })
})

const LABEL = { id: 'k1', name: 'refund', unit: 'record', marks: 'record', labels: ['refund', 'no'], classes: [{ name: 'refund', color: 3, highlight: true }, { name: 'no', color: 0, highlight: false }] } as unknown as Concept
const row = (ref: string, label: string, line?: number): LabelRow => ({ ref, label, confidence: 1, source: 'regex', ...(line ? { line } : {}) })

describe('marks on records that are no lines', () => {
  test('a view page marks a database row and a page, whichever way the page is written', () => {
    const list: LabelsForPath[] = [{ concept_id: 'k1', name: 'refund', labels: ['refund', 'no'], unit: 'record', rows: [row('forge.db#prs/7114', 'refund'), row('forge.db#prs/7101', 'no'), row('r.pdf#page=2', 'refund')] }]
    const byRef = rowsByRef(list)
    const marks = viewMarks([LABEL], byRef, ['forge.db#prs/7114', 'forge.db#prs/7101', 'r.pdf#p2', 'view:v/k'])
    expect(Object.keys(marks).sort()).toEqual(['forge.db#prs/7114', 'r.pdf#p2'])
    expect(marks['forge.db#prs/7114'].bar).toBe('var(--label-3)')
    const kept = withKeeps(marks, { concept: 'k1', value: 'refund' }, byRef, ['forge.db#prs/7114', 'forge.db#prs/7101', 'r.pdf#p2'])
    expect(Object.fromEntries(Object.entries(kept).map(([r, m]) => [r, m.keep]))).toEqual({ 'forge.db#prs/7114': true, 'r.pdf#p2': true })
  })

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
