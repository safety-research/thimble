// @vitest-environment jsdom
// The end of a side thread (src/chat/ChatPanel.tsx ThreadView): a run that ended with an answer ends on the answer, with
// no action under it that sends the answer to main, so nothing in a side thread starts a turn of main.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ThreadView } from '../../src/chat/ChatPanel.tsx'
import { foldRecords } from '../../src/chat/model.ts'
import type { ChatState } from '../../src/chat/useChat.ts'
import type { ChatMeta, ChatRecord } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const posted: string[] = []
beforeEach(() => {
  posted.length = 0
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if ((init?.method ?? 'GET') !== 'GET' && !String(url).includes('/telemetry')) posted.push(`${init?.method} ${url}`)
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

const answered: ChatRecord[] = [
  { type: 'user', text: 'Why is Agent 3 so high?' },
  { type: 'text', delta: 'Agent 3 ran 31 of the 40 runs, most of them retries after a timeout.', reply: true, by: 'terminal' },
  { type: 'done', result: null },
]
const meta = (id: string): ChatMeta =>
  ({ id, kind: 'thread', role: 'thread', title: 'runs-per-agent', created_at: '2026-10-07T10:00:00+00:00', parent: 'main', anchor: null, anchor_text: 'Runs per agent', model: null, effort: null, group: null }) as ChatMeta
const chat = (m: ChatMeta, records: ChatRecord[]): ChatState => ({
  meta: m, records, rows: foldRecords(records), loading: false, error: null, streaming: false, running: false,
  send: async () => true, interrupt: async () => undefined, reload: async () => undefined,
})

describe('a side thread whose run ended with an answer', () => {
  test('ends on its answer, with nothing under it that sends the answer to main', async () => {
    // a meta as 0.7.0's server gave it, which offered the answer to main
    const m = { ...meta('t1'), hand_back: 'offer' } as ChatMeta
    const el = await mount(<ThreadView ws="w" meta={m} chat={chat(m, answered)} main={chat(meta('main'), [])} branches={[]} />)
    await settle()
    expect(el.textContent).toContain('Agent 3 ran 31 of the 40 runs')
    expect(el.textContent).not.toMatch(/hand(ed)? back/i)
    expect(el.querySelector('.chat-hand-back')).toBeNull()
    expect([...el.querySelectorAll('button')].map((b) => b.textContent?.trim())).toEqual([])
    expect(posted).toEqual([])
  })
})
