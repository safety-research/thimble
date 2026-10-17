// What the strip behind the composer says while main or a side thread works (src/chat/working.ts, src/chat/ChatPanel.tsx
// taskStrip): the step under way, or the subagent a call waits on, or Thinking, and the time since the turn started.
import { describe, expect, test } from 'vitest'
import { taskStrip } from '../../src/chat/ChatPanel.tsx'
import { foldRecords } from '../../src/chat/model.ts'
import { currentStep, elapsedText, turnStart } from '../../src/chat/working.ts'
import type { ChatRecord } from '../../src/lib/types.ts'

const at = (s: number) => new Date(Date.UTC(2026, 9, 1, 12, 0, s)).toISOString()
const ask = (s: number, text = 'how many pages?'): ChatRecord => ({ type: 'user', ts: at(s), text, by: 'browser' })
const call = (id: string, s: number, name: string, input: unknown): ChatRecord => ({ type: 'tool_use', ts: at(s), id, name, input })
const result = (id: string, s: number): ChatRecord => ({ type: 'tool_result', ts: at(s), id, summary: 'ok' })

describe('the step under way', () => {
  test('a call that runs is named as a step under way, with what it is about', () => {
    const rows = foldRecords([ask(0), call('t1', 2, 'Bash', { command: 'wc -l pages.jsonl', description: 'Count the pages' })])
    expect(currentStep(rows)).toBe('Running · Count the pages')
    expect(taskStrip('main', true, rows)?.title).toBe('Running · Count the pages')
    expect(taskStrip('thread', true, rows, new Map(), false, 'working')?.title).toBe('Running · Count the pages')
  })

  test('a call of a subagent names the subagent it waits on', () => {
    const rows = foldRecords([ask(0), call('t1', 1, 'Agent', { description: 'Survey the edit wars', subagent_type: 'general-purpose', prompt: '…' })])
    expect(currentStep(rows)).toBe('Waiting on Survey the edit wars')
  })

  test('with no call running, the turn thinks; a thread still waiting for its fork says it starts', () => {
    const rows = foldRecords([ask(0), call('t1', 1, 'Read', { file_path: 'pages.jsonl' }), result('t1', 2)])
    expect(currentStep(rows)).toBe('Thinking')
    expect(taskStrip('thread', true, foldRecords([ask(0)]), new Map(), false, 'sent')?.title).toBe('Starting this thread…')
    expect(taskStrip('main', false, rows)).toBeNull()
  })

  test('of calls made at once, the one still running', () => {
    const rows = foldRecords([ask(0), call('t1', 1, 'Read', { file_path: 'a.jsonl' }), call('t2', 1, 'Read', { file_path: 'b.jsonl' }), result('t2', 2)])
    expect(currentStep(rows)).toBe('Reading · a.jsonl')
  })
})

describe('the time so far', () => {
  test("counts from the turn's first record after the last one that ended", () => {
    expect(turnStart([ask(0), { type: 'done', ts: at(30) }, ask(40, 'and the editors?'), call('t1', 42, 'Read', { file_path: 'a' })])).toBe(Date.parse(at(40)))
    expect(turnStart([ask(5)])).toBe(Date.parse(at(5)))
    expect(turnStart([{ type: 'done', ts: at(30) }])).toBeNull()
  })

  test('reads as seconds, then minutes and seconds, then hours and minutes', () => {
    expect(elapsedText(8_400)).toBe('8s')
    expect(elapsedText(65_000)).toBe('1m 05s')
    expect(elapsedText(3_720_000)).toBe('1h 02m')
  })
})
