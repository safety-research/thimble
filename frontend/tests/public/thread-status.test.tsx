// @vitest-environment jsdom
// What a ⌘-click thread shows while it works (src/chat/threadStatus.ts, src/chat/ThreadRows.tsx): where its question is
// before its fork has written anything, and the edits main made itself to the card the thread is about, which land in
// main's log rather than the thread's; and the highlight's carry of a box drawn inside an element (src/pointer/highlight
// carried).
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { foldRecords, type Row } from '../../src/chat/model.ts'
import { ThreadRows } from '../../src/chat/ThreadRows.tsx'
import { mainEdits, threadStage } from '../../src/chat/threadStatus.ts'
import type { ChatRecord } from '../../src/lib/types.ts'
import { carried } from '../../src/pointer/highlight.ts'
import { mount, unmountAll } from './mount.tsx'

const EDIT = 'mcp__plugin_thimble_thimble__edit_card'

beforeEach(() => {
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

describe('threadStage', () => {
  test('a thread that does not run has no stage', () => {
    expect(threadStage({ fork: { agent_id: 'a1' } }, false)).toBeNull()
  })
  test('the question waits for main until the thread is forked, then its fork works on it', () => {
    expect(threadStage({}, true)).toBe('sent')
    expect(threadStage(null, true)).toBe('sent')
    expect(threadStage({ fork: { agent_id: 'a1' } }, true)).toBe('working')
  })
  test('a fork that can no longer be reached waits for main to fork anew', () => {
    expect(threadStage({ fork: { agent_id: 'a1', ended: '2026-10-01T00:00:05+00:00' } }, true)).toBe('sent')
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
  test('an edit of another card, or one made before the question or after the run ended, is not the thread’s', () => {
    const rows = mainRows(
      call('other', '2026-10-01T00:00:20.000+00:00', 'c2'),
      call('before', '2026-09-30T23:59:00.000+00:00', 'c1'),
      call('after', '2026-10-01T00:05:00.000+00:00', 'c1'),
    )
    expect(mainEdits(thread, rows, ['card:c1']).size).toBe(0)
  })
  test('a part of a card names the card, and a run still going takes later edits', () => {
    const running = thread.slice(0, 1)
    const edits = mainEdits(running, mainRows(call('t1', '2026-10-01T00:05:00.000+00:00', 'c1')), ['card:c1@out0#L3'])
    expect(edits.get(0)!.map((r) => r.id)).toEqual(['t1'])
  })
})

describe('ThreadRows', () => {
  test("main's edit is a line under the question with the card's chip, running until its result comes", async () => {
    const rows = foldRecords(thread.slice(0, 1))
    const running = mainEdits(thread, mainRows(call('t1', '2026-10-01T00:00:20.000+00:00', 'c1', false)), ['card:c1'])
    const el = await mount(<ThreadRows rows={rows} edits={running} ws="w" chat="th1" />)
    const line = el.querySelector('.chat-main-edit')!
    expect(line).not.toBeNull()
    expect(line.getAttribute('data-state')).toBe('running')
    expect(line.querySelector('.spinner')).not.toBeNull()
    expect(line.querySelector('[data-ref="card:c1"], .refchip')).not.toBeNull()
    // the line comes after the analyst's question
    expect(el.querySelector('.chat-user')!.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    unmountAll()
    const done = mainEdits(thread, mainRows(call('t1', '2026-10-01T00:00:20.000+00:00', 'c1')), ['card:c1'])
    const el2 = await mount(<ThreadRows rows={rows} edits={done} ws="w" chat="th1" />)
    expect(el2.querySelector('.chat-main-edit')!.getAttribute('data-state')).toBe('done')
    expect(el2.querySelector('.chat-main-edit .spinner')).toBeNull()
  })
})

describe('carried', () => {
  const from = { left: 100, top: 100, right: 300, bottom: 200 }
  const rect = { left: 150, top: 140, right: 162, bottom: 152 }
  test('a box moves with its element when the canvas pans', () => {
    expect(carried(rect, from, { left: 40, top: 70, right: 240, bottom: 170 })).toEqual({ left: 90, top: 110, right: 102, bottom: 122 })
  })
  test('a box scales with its element when the canvas zooms', () => {
    expect(carried(rect, from, { left: 100, top: 100, right: 500, bottom: 300 })).toEqual({ left: 200, top: 180, right: 224, bottom: 204 })
  })
  test('an element drawn anew, scaled one way only, carries no box', () => {
    expect(carried(rect, from, { left: 100, top: 100, right: 300, bottom: 260 })).toBeNull()
  })
  test('a flat element (a level line) still carries its box', () => {
    const line = { left: 100, top: 150, right: 300, bottom: 150 }
    expect(carried(rect, line, { left: 120, top: 160, right: 320, bottom: 160 })).toEqual({ left: 170, top: 150, right: 182, bottom: 162 })
  })
})
