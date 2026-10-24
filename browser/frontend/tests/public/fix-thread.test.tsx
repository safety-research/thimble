// @vitest-environment jsdom
// A fix of the person's thimble is main's subagent, which runs in the background in a thread of its own (backend
// fixes.fixer_chat): the tree lists it by the fix's name (`fixing <name>`, `changing <name>` for a round of a fix they
// have), and main's chat shows the person's message as they typed it, then the fixer's card where main started it, with
// its steps and a link to its thread. A round of the fix is the card of that run alone. A message typed in the fix's
// thread is a round of that fix.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { foldRecords } from '../../src/chat/model.ts'
import { ThreadsContext } from '../../src/chat/Notes.tsx'
import { Rows } from '../../src/chat/Rows.tsx'
import { composerTarget, pickItems, threadKind, threadNodes } from '../../src/chat/threads.ts'
import type { ChatMeta, ChatRecord } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const main = { id: 'main', kind: 'main', role: 'main', title: 'main', created_at: '2026-10-23T10:00:00Z', parent: null } as ChatMeta
const fixer = (over: Partial<ChatMeta> = {}): ChatMeta =>
  ({ id: 'f1', kind: 'agent', role: 'fixer', title: 'fixing Card counts its rows', created_at: '2026-10-23T10:01:00Z', parent: 'main', status: 'running', fix: 4, ...over }) as ChatMeta

afterEach(() => unmountAll())

describe('the fix in the tree', () => {
  test('listed under main by its name, not its number, running while its fixer works', () => {
    expect(threadKind(fixer())).toBe('fix')
    const items = pickItems([main, fixer()], () => false, () => false)
    const it = items.find((x) => x.id === 'f1')!
    expect([it.kind, it.label, it.title, it.parent, it.running, it.hidden]).toEqual(['fix', 'main/fixing Card counts its rows', 'fixing Card counts its rows', 'main', true, false])
    const node = threadNodes(items).find((n) => n.id === 'f1')!
    expect(node.name).toBe('fixing Card counts its rows')
    const ended = pickItems([main, fixer({ status: 'done', title: 'changing Card counts its rows', ts_end: '2026-10-23T10:05:00Z' } as Partial<ChatMeta>)], () => false, () => false).find((x) => x.id === 'f1')!
    expect([ended.title, ended.running, ended.ended, ended.hidden]).toEqual(['changing Card counts its rows', false, 'done', false])
  })

  test('a message typed in its thread goes to the fix, as a round of it', () => {
    expect(composerTarget('fix', fixer(), null)).toEqual({ to: 'fix', fix: 4 })
  })
})

describe("main's chat", () => {
  const t = (s: number) => `2026-10-23T10:0${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}Z`
  // the fix's chat: two runs, each opened by the person's words
  const fixLog = [
    { type: 'user', ts: t(60), text: 'make the card count its rows', by: 'browser' },
    { type: 'tool_use', ts: t(70), id: 'a', name: 'Read', input: { file_path: 'browser/frontend/src/canvas/Card.tsx' } },
    { type: 'tool_result', ts: t(71), id: 'a', summary: 'ok' },
    { type: 'tool_use', ts: t(80), id: 'b', name: 'Edit', input: { file_path: 'browser/frontend/src/canvas/Card.tsx' } },
    { type: 'tool_result', ts: t(81), id: 'b', summary: 'ok' },
    { type: 'user', ts: t(200), text: 'and the columns', by: 'browser' },
    { type: 'tool_use', ts: t(210), id: 'c', name: 'Edit', input: { file_path: 'browser/frontend/src/canvas/Card.tsx' } },
  ]
  beforeEach(() => {
    vi.stubGlobal('fetch', async (url: string) => {
      const body = String(url).endsWith('/chats/f1') ? { meta: fixer(), events: fixLog } : { problem: '', fixes: [] }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    })
  })
  afterEach(() => vi.unstubAllGlobals())
  const records = [
    { type: 'user', ts: t(60), text: '/thimble-fix make the card count its rows', by: 'browser' },
    { type: 'agent', ts: t(60), chat: 'f1', role: 'fixer', title: 'fixing make the card count its rows', by: 'browser' },
    { type: 'text', ts: t(61), delta: 'I started a fix.', by: 'terminal' },
    { type: 'chip', ts: t(150), kind: 'fix', text: 'thimble fixed: Card counts its rows · tests pass', ref: 'fix:4', status: 'ready' },
    { type: 'user', ts: t(200), text: '/thimble-fix and the columns', by: 'browser' },
    { type: 'agent', ts: t(200), chat: 'f1', role: 'fixer', title: 'changing Card counts its rows', by: 'browser', run: 1 },
  ] as unknown as ChatRecord[]

  test('the message as typed, then the fixer as a subagent card where main started it, with its thread', async () => {
    const el = await mount(
      <ThreadsContext.Provider value={{ labels: new Map([['f1', 'main/fixing make the card count its rows']]) }}>
        <Rows rows={foldRecords(records)} ws="w" chat="main" streaming={false} />
      </ThreadsContext.Provider>,
    )
    await settle()
    await settle()
    expect(el.querySelector('.chat-user')?.textContent).toContain('/thimble-fix make the card count its rows')
    const [first, round] = [...el.querySelectorAll('.chat-agent[data-role="fixer"]')]
    // each card is its own run: the first ended once the round began, the round's runs now
    expect(first.querySelector('.chat-agent-name')?.textContent).toBe('fixing make the card count its rows')
    expect(first.querySelector('.chat-agent-meta')?.textContent).toBe('2 steps · 21s')
    expect(first.getAttribute('data-status')).toBe('done')
    expect(round.querySelector('.chat-agent-meta')?.textContent).toBe('1 step')
    expect(round.getAttribute('data-status')).toBe('running')
    expect(first.querySelector('.chat-thread-chip')?.getAttribute('data-thread')).toBe('f1')
    // open, its steps in plain words
    await act(async () => (first.querySelector('.chat-agent-chip') as HTMLButtonElement).click())
    expect(first.querySelectorAll('.chat-agent-steps li')).toHaveLength(2)
    // how the first run ended is a row between the two cards, in the order it happened
    const order = [...el.querySelectorAll('.chat-agent, .chat-fix, .chat-fix-said')].map((n) => n.getAttribute('data-role') ?? n.getAttribute('data-kind'))
    expect(order).toEqual(['fixer', 'ready', 'fixer'])
  })
})
