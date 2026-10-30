// Records of any file (backend app/records.py) on the page: a database row, a PDF page, a JSON document's value and a
// CSV row parse as refs (src/lib/refs.ts), a view's page marks them by their labels like lines (src/files/labels.ts
// viewMarks), and the reader's line views find a CSV row's label at the line it starts on (src/files/marks.tsx
// rowsByRef).
import { describe, expect, test } from 'vitest'
import { viewMarks, withKeeps } from '../../src/files/labels.ts'
import { rowsByRef } from '../../src/files/marks.tsx'
import { addressLabel, parseRef, recordKey, recordOf, refLabel, refPaths, surfaceOf } from '../../src/lib/refs.ts'
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

  test("an example's addresses name the folder that tells its records' files apart", () => {
    // trials' trajectories read the same alone: `agent › trajectory.json` when no folder above them holds a digit, and
    // `<date> › … › trajectory.json` in a job folder named by its date; on one card each names its trial
    const runs = (t: string) => `picnic-runs/${t}/agent/trajectory.json`
    const dated = (t: string) => `jobs/2026-05-02__09-00-00/${t}/agent/trajectory.json`
    expect(addressLabel(`${runs('picnic-lake__RvtmQxa')}#L16`)).toBe('agent › trajectory.json L16')
    expect(addressLabel(`${dated('picnic-lake__RvtmQxa')}#L16`)).toBe('2026-05-02__09-00-00 › … › trajectory.json L16')
    for (const at of [runs, dated]) {
      const refs = [`${at('picnic-hill__GdsaPwe')}#/steps/3`, `${at('picnic-lake__RvtmQxa')}#/steps/3`, `${at('picnic-lake__RvtmQxa')}#L40`]
      expect(refs.map((r) => addressLabel(r, refPaths(refs)))).toEqual(['picnic-hill__GdsaPwe › … › trajectory.json /steps/3', 'picnic-lake__RvtmQxa › … › trajectory.json /steps/3', 'picnic-lake__RvtmQxa › … › trajectory.json L40'])
    }
    // the folder right over the file reads with no folders left out
    const results = ['jobs/2026-05-02__09-00-00/picnic-hill__GdsaPwe/result.json#L5', 'jobs/2026-05-02__09-00-00/picnic-lake__RvtmQxa/result.json#L5']
    expect(results.map((r) => addressLabel(r, refPaths(results)))).toEqual(['picnic-hill__GdsaPwe › result.json L5', 'picnic-lake__RvtmQxa › result.json L5'])
    // addresses that differ already, and the passages of one file, keep their own
    const own = ['batch2/agents/agent-03.jsonl#L412', 'batch3/agents/agent-03.jsonl#L9', 'batch3/agents/agent-03.jsonl#L12', 'notes.md']
    expect(own.map((r) => addressLabel(r, refPaths(own)))).toEqual(['batch2 › agent-03.jsonl L412', 'batch3 › agent-03.jsonl L9', 'batch3 › agent-03.jsonl L12', 'notes.md'])
  })

  test('a folder named agent reads as any other folder', () => {
    expect(refLabel('agent/notes.md#L1')).toBe('agent › notes.md L1')
    expect(refLabel('src/agent/main.py#L3')).toBe('agent › main.py L3')
    expect(refLabel('harness/agent/agent.py')).toBe('agent › agent.py')
    expect(refLabel('runs/r1/agent/log.txt#L2')).toBe('r1 › … › log.txt L2')
    expect(refLabel('jobs/run-7/picnic-lake__RvtmQxa/agent/trajectory.json#L5')).toBe('run-7 › … › trajectory.json L5')
    expect(addressLabel('src/agent/main.py#L3')).toBe('agent › main.py L3')
  })

  test("a chip names the folder that tells its file apart from the files cited with it, as an example's addresses do", () => {
    const trial = (t: string, at: string) => `jobs/2026-05-02__09-00-00/${t}/agent/trajectory.json#${at}`
    const refs = [trial('picnic-hill__GdsaPwe', 'L66'), trial('picnic-lake__RvtmQxa', 'L66'), trial('picnic-lake__RvtmQxa', 'L40.b0'), 'notes.md#L2']
    expect(refs.map((r) => refLabel(r))).toEqual(['2026-05-02__09-00-00 › … › trajectory.json L66', '2026-05-02__09-00-00 › … › trajectory.json L66', '2026-05-02__09-00-00 › … › trajectory.json L40.b0', 'notes.md L2'])
    expect(refs.map((r) => refLabel(r, refPaths(refs)))).toEqual(['picnic-hill__GdsaPwe › … › trajectory.json L66', 'picnic-lake__RvtmQxa › … › trajectory.json L66', 'picnic-lake__RvtmQxa › … › trajectory.json L40.b0', 'notes.md L2'])
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
