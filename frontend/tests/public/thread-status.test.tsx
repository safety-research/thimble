// @vitest-environment jsdom
// What a ⌘-click thread shows while it works (src/chat/threadStatus.ts, src/chat/ThreadRows.tsx): where its question is
// before its fork has written anything, and the edits main made itself to the card the thread is about, which land in
// main's log rather than the thread's; and the highlight's carry of a box drawn inside an element (src/pointer/highlight
// carried).
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { foldRecords, type Row } from '../../src/chat/model.ts'
import { mainEdits, threadStage } from '../../src/chat/threadStatus.ts'
import type { ChatRecord } from '../../src/lib/types.ts'
import { unmountAll } from './mount.tsx'

const EDIT = 'mcp__plugin_thimble_thimble__edit_card'

beforeEach(() => {
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

describe('threadStage', () => {
  test('the question waits for main until the thread is forked, then its fork works on it', () => {
    expect(threadStage({}, true)).toBe('sent')
    expect(threadStage(null, true)).toBe('sent')
    expect(threadStage({ fork: { agent_id: 'a1' } }, true)).toBe('working')
  })
})

// a thread asked at 00:00:00 about card c1, whose fork finished at 00:01:00
const thread: ChatRecord[] = [
  { type: 'user', ts: '2026-10-01T00:00:00.000+00:00', text: 'make this a bar chart', by: 'browser' },
  { type: 'done', ts: '2026-10-01T00:01:00.000+00:00', result: null },
]
const call = (id: string, ts: string, card: string, result = true): ChatRecord[] => [
  { type: 'tool_use', ts, id, name: EDIT, input: { card: `card:${card}`, code: 'chart' } },
  ...(result ? [{ type: 'tool_result' as const, ts, id, summary: `card:${card}` }] : []),
]
const mainRows = (...records: ChatRecord[][]): Row[] => foldRecords(records.flat())

describe('mainEdits', () => {
  test("main's edit of the card asked about, made while the thread ran, goes under the question", () => {
    const edits = mainEdits(thread, mainRows(call('t1', '2026-10-01T00:00:20.000+00:00', 'c1')), ['card:c1'])
    expect([...edits.keys()]).toEqual([0])
    expect(edits.get(0)!.map((r) => r.id)).toEqual(['t1'])
  })
})
