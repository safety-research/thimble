// @vitest-environment jsdom
// The end of an orientation's or a writer's thread that sent its summary to main (src/chat/ChatPanel.tsx
// orientMessages, src/chat/HandBack.tsx HandedBack): the SubagentHandback call and the text after it become one folded
// hand-back row, drawn as the quiet line `Summary sent to main`, which a click opens on the summary as the thread's
// markdown and a second click folds; with no summary there is no extra row. What main receives is not changed here.
// Where the call shows unfolded, as a call's line, it reads `Sent its summary to main`, and its summary shows once the
// line is opened.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { orientMessages } from '../../src/chat/ChatPanel.tsx'
import { foldRecords } from '../../src/chat/model.ts'
import type { ChatRecord } from '../../src/lib/types.ts'
import { unmountAll } from './mount.tsx'

beforeEach(() => {
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

const SUMMARY = 'The wiki holds **1,204 revisions** of 87 pages.\n\n- Three pages hold a third of all edits.'
const records = (message: unknown): ChatRecord[] => [
  { type: 'user', text: 'Orient me in this wiki dataset.' },
  { type: 'text', delta: 'Counting revisions per page.' },
  { type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'wc -l revisions.jsonl' } },
  { type: 'tool_result', id: 'u1', summary: '1204 revisions.jsonl' },
  { type: 'tool_use', id: 'u2', name: 'SubagentHandback', input: { message } },
  { type: 'tool_result', id: 'u2', summary: 'Delivered.' },
  { type: 'text', delta: 'Done.' },
  { type: 'done', result: null },
]

describe('orientMessages', () => {
  test('the hand-back call and the text after it become one hand-back row holding the summary, at the end', () => {
    const rows = orientMessages(foldRecords(records(`  ${SUMMARY}\n`)))
    const last = rows[rows.length - 1]
    expect(last).toMatchObject({ kind: 'handback', text: SUMMARY })
    expect(rows.filter((r) => r.kind === 'handback')).toHaveLength(1)
    expect(rows.some((r) => r.kind === 'tool' && r.name === 'SubagentHandback')).toBe(false)
    expect(rows.filter((r) => r.kind === 'text').map((r) => (r.kind === 'text' ? r.text : ''))).toEqual(['Counting revisions per page.'])
    expect(rows.some((r) => r.kind === 'user'), "the first message is the card's").toBe(false)
  })
})
