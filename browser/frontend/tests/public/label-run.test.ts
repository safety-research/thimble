// A label run in the chat (src/chat/LabelRun.tsx, backend labels/asks.py): its records fold into one row that takes
// each later state, and the row says how far a run is.
import { describe, expect, test } from 'vitest'
import { runProgress } from '../../src/chat/LabelRun'
import { foldRecords, type LabelRunRow } from '../../src/chat/model'
import type { ChatRecord } from '../../src/lib/types'

const asked: ChatRecord = { type: 'label_run', id: 'r1', concept: 'c1', name: 'edit purpose', state: 'asked', text: 'Read 14,591 records of revisions.jsonl with Claude: about 860 calls, about 6 min, about $25.', units: 14591, sample: 300 }

describe('a label run in the chat', () => {
  test('is one row that takes each later state of its run', () => {
    const rows = foldRecords([
      { type: 'user', text: "What's going on?" },
      asked,
      { type: 'text', delta: 'The label waits for your choice.' },
      { type: 'label_run', id: 'r1', concept: 'c1', name: 'edit purpose', state: 'running', text: 'Reading 300 records with Claude', total: 300 },
      { type: 'label_run', id: 'r1', concept: 'c1', name: 'edit purpose', state: 'done', text: 'Read 300 records: coordination 120 · other 180.', total: 300, done: 300 },
    ])
    const runs = rows.filter((r): r is LabelRunRow => r.kind === 'label_run')
    expect(runs).toHaveLength(1)
    expect(rows.map((r) => r.kind)).toEqual(['user', 'label_run', 'text'])
    expect(runs[0]).toMatchObject({ state: 'done', text: 'Read 300 records: coordination 120 · other 180.', units: 14591, sample: 300 })
  })

  test('says how far a run is and how long it took', () => {
    expect(runProgress({ done: 2340, total: 14591, seconds: 81 })).toBe('2,340 of 14,591 records · 1 min 21 s')
    expect(runProgress({ done: 0, total: 300, seconds: 4 })).toBe('0 of 300 records · 4 s')
    expect(runProgress(null)).toBe('')
  })
})
