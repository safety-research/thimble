// @vitest-environment jsdom
// A side thread while it starts speaks from its own point of view (src/chat/threadStatus.ts STAGE_TEXT,
// src/chat/ChatPanel.tsx, src/components/ThreadTree.tsx): a short turn of main starts the thread's fork, but the thread
// never names main or shows main's state for it. While its question waits for the fork the strip says it is starting,
// and the folded tree's card does not count main's run as work elsewhere; once the fork runs the strip says it works.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ChatPanel, taskStrip } from '../../src/chat/ChatPanel.tsx'
import { STAGE_TEXT } from '../../src/chat/threadStatus.ts'
import { attention, type ThreadNode } from '../../src/components/ThreadTree.tsx'
import type { ChatMeta } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const T = '2026-10-15T10:00:00+00:00'
const ATTACHED = { session: 's1', cwd: '/corpus', at: T, model: 'claude-opus-5-5' }
let main: ChatMeta
let thread: ChatMeta

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('thimble:mini:thread-current', JSON.stringify('th1'))
  // main's short turn that starts the fork runs; the thread runs, its question not yet with a fork
  main = { id: 'main', kind: 'main', role: 'main', title: 'main', created_at: T, parent: null, running: true, attached: ATTACHED, module: true } as unknown as ChatMeta
  thread = { id: 'th1', kind: 'thread', role: 'thread', title: 'push-retries', created_at: T, parent: 'main', anchor: 'agents/agent-05.jsonl#L12', anchor_text: 'git push', running: true } as unknown as ChatMeta
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', async (url: string) => {
    const u = String(url)
    const body = u.endsWith('/chats/main')
      ? { meta: main, events: [] }
      : u.endsWith('/chats/th1')
        ? { meta: thread, events: [{ type: 'user', ts: T, text: 'Why did agent-05 push three times?', by: 'browser' }] }
        : /\/chats(\?|$)/.test(u)
          ? [main, thread]
          : /\/(proposals|notices|views)(\?|$)/.test(u)
            ? []
            : {}
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe("the thread's strip", () => {
  test('says the thread is starting, then that it works, and never names main', () => {
    expect(taskStrip('thread', true, [], new Map(), false, 'sent')?.title).toBe('Starting this thread…')
    expect(taskStrip('thread', true, [], new Map(), false, 'working')?.title).toBe('Working')
    for (const text of Object.values(STAGE_TEXT)) expect(text).not.toMatch(/main/i)
  })
})

describe('the folded tree card', () => {
  const nodes = [
    { id: 'main', name: 'main', path: 'main', parent: null, running: true },
    { id: 'th1', name: 'push-retries', path: 'main/push-retries', parent: 'main', running: true },
    { id: 'th2', name: 'other', path: 'main/other', parent: 'main', running: true },
  ] as ThreadNode[]
  test("leaves out the run of the chat that starts the current thread, and counts the others' runs", () => {
    expect(attention(nodes, 'th1').running).toBe(2)
    expect(attention(nodes, 'th1', 'main').running).toBe(1)
  })
})

describe('a thread whose question waits for its fork, while main runs the turn that starts it', () => {
  test('its chat says it is starting, names main nowhere but the line it branched from, and its card counts no run', async () => {
    const el = await mount(<ChatPanel ws="mini" />)
    await settle()
    await settle()
    expect(el.querySelector('.chat')?.getAttribute('data-thread-kind')).toBe('thread')
    expect(el.querySelector('.chat-strip-title')?.textContent).toBe('Starting this thread…')
    expect(el.querySelector('.tt-summary .tt-active')).toBeNull()
    const said = [...el.querySelectorAll('.chat-foot, .chat-head, .chat-flow > :not(.chat-divider):not(.divider)')].map((n) => n.textContent ?? '').join(' ')
    expect(said).not.toMatch(/\bmain is\b|sent to main|working on it/i)
  })

  test('once its fork runs, the strip says it works', async () => {
    thread = { ...thread, fork: { agent_id: 'afork1' } } as unknown as ChatMeta
    main = { ...main, running: false }
    const el = await mount(<ChatPanel ws="mini" />)
    await settle()
    await settle()
    expect(el.querySelector('.chat-strip-title')?.textContent).toBe('Working')
  })
})
