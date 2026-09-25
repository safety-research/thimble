import { describe, expect, it } from 'vitest'
import { isOrientWriterRecord, mainSkips, orientWriterOf, orientWriters } from '../../src/chat/model'
import type { ChatRecord } from '../../src/lib/types'

const orient = { id: 'o1', role: 'orient', created_at: '2026-09-25T20:09:10Z', status: 'done', ts_end: '2026-09-25T20:44:51Z' }
const marked = { id: 'w1', role: 'writer', created_at: '2026-09-25T20:44:56Z', status: 'running', ts_end: null, doc: 'report', orient: 'o1', orient_run: 0 }
const analyst = { id: 'w2', role: 'writer', created_at: '2026-09-25T20:45:10Z', status: 'done', ts_end: '2026-09-25T20:50:00Z', doc: 'report', orient: null }
// an older writer's meta names no orientation at all: told by when it started
const older = { id: 'w3', role: 'writer', created_at: '2026-09-25T20:44:56Z', status: 'done', ts_end: '2026-09-25T20:52:26Z', doc: 'report' }
const olderLate = { ...older, id: 'w4', created_at: '2026-09-25T21:30:00Z', ts_end: '2026-09-25T21:40:00Z' }

describe('orientWriters', () => {
  it('takes the writer whose meta names the orientation, and never one the analyst asked for', () => {
    const ws = orientWriters([orient, marked, analyst])
    expect(ws.map((w) => [w.chat, w.orient, w.run, w.status])).toEqual([['w1', 'o1', 0, 'running']])
    expect(ws[0].inferred).toBeUndefined()
  })
  it('tells an older writer by when it started: at the orientation\'s end, not long after', () => {
    const ws = orientWriters([orient, older, olderLate])
    expect(ws.map((w) => [w.chat, w.inferred])).toEqual([['w3', true]])
  })
  it('picks the card\'s writer by run, the latest when no run is named', () => {
    const later = { ...marked, id: 'w5', created_at: '2026-09-25T22:00:00Z', orient_run: 1 }
    const ws = orientWriters([orient, marked, later])
    expect(orientWriterOf(ws, 'o1', 0)?.chat).toBe('w1')
    expect(orientWriterOf(ws, 'o1', 1)?.chat).toBe('w5')
    expect(orientWriterOf(ws, 'o1')?.chat).toBe('w5')
    expect(orientWriterOf(ws, 'other', 0)).toBeNull()
  })
})

describe('main leaves out the orientation writer\'s rows', () => {
  const records: ChatRecord[] = [
    { type: 'chip', ts: '2026-09-25T20:44:51.9Z', kind: 'artifact', text: "the orientation's cards", ref: 'group:g1', chat: 'o1' },
    { type: 'agent', ts: '2026-09-25T20:44:56Z', chat: 'w1', role: 'writer', title: 'Write report' },
    { type: 'chip', ts: '2026-09-25T20:47:43Z', kind: 'artifact', text: 'wrote', ref: 'report:report', generation: 1, writer: 'w1' },
    { type: 'chip', ts: '2026-09-25T20:48:46Z', kind: 'artifact', text: 'revised', ref: 'report:report#s2', writer: 'w1' },
    // the analyst's own revision while the writer ran names no writer, and stays
    { type: 'chip', ts: '2026-09-25T20:49:00Z', kind: 'artifact', text: 'revised', ref: 'report:report#s3' },
    { type: 'agent', ts: '2026-09-25T20:55:00Z', chat: 'w2', role: 'writer', title: 'Write report' },
    { type: 'chip', ts: '2026-09-25T20:56:00Z', kind: 'artifact', text: 'revised', ref: 'report:report', generation: 4, writer: 'w2' },
  ]
  it('skips the start and the saves of the report pass\'s writer, and keeps a later writer\'s', () => {
    const skip = mainSkips(records, { spawned: new Set(), summaries: [], runs: [], orientWriters: orientWriters([orient, marked, analyst]) })
    expect([...skip].sort()).toEqual([1, 2, 3])
  })
  it('skips an older writer\'s saves by their time on its document', () => {
    const ws = orientWriters([orient, older])
    const save = (ts: string, ref = 'report:report'): ChatRecord => ({ type: 'chip', ts, kind: 'artifact', text: 'the report, generation 2', ref })
    expect(isOrientWriterRecord(save('2026-09-25T20:48:46Z'), ws)).toBe(true)
    expect(isOrientWriterRecord(save('2026-09-25T21:00:00Z'), ws)).toBe(false)
    expect(isOrientWriterRecord(save('2026-09-25T20:48:46Z', 'report:other'), ws)).toBe(false)
    expect(isOrientWriterRecord({ type: 'agent', ts: '2026-09-25T20:44:56Z', chat: 'w3', role: 'writer', title: 'Write report' }, ws)).toBe(true)
  })
})
