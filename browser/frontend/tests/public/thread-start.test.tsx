// @vitest-environment jsdom
// A side thread while it starts speaks from its own point of view (src/chat/threadStatus.ts STAGE_TEXT,
// src/chat/ChatPanel.tsx): a short turn of main starts the thread's fork, but the thread never names main or shows
// main's state for it. While its question waits for the fork the strip says it is starting; once the fork runs the
// strip says it works. Until main's turn that took the question to the fork ends, the thread's folded card does not
// count main's run as work elsewhere (mainRelays). While a command of its fork waits for the analyst (an ask about a
// host on the thread's meta, or a request main's session relays for the thread), the strip shows the wait dot in place
// of the spinner; a thread asked from it is a session of its own, whose wait leaves the strip as it is.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ChatPanel, taskStrip } from '../../src/chat/ChatPanel.tsx'
import { mainRelays, STAGE_TEXT } from '../../src/chat/threadStatus.ts'
import { attention, type ThreadNode } from '../../src/components/ThreadTree.tsx'
import type { ChatMeta, ChatRecord } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const T = '2026-10-15T10:00:00+00:00'
const ATTACHED = { session: 's1', cwd: '/corpus', at: T, model: 'claude-opus-5-5' }
const LATER = '2026-10-15T10:00:05+00:00'
const QUESTION: ChatRecord = { type: 'user', ts: T, text: 'Why did agent-05 push three times?', by: 'browser' }
let main: ChatMeta
let thread: ChatMeta
let others: ChatMeta[]
let mainEvents: ChatRecord[]

beforeEach(() => {
  others = []
  localStorage.clear()
  localStorage.setItem('thimble:mini:thread-current', JSON.stringify('th1'))
  // main's short turn that starts the fork runs; the thread runs, its question not yet with a fork
  main = { id: 'main', kind: 'main', role: 'main', title: 'main', created_at: T, parent: null, running: true, attached: ATTACHED } as unknown as ChatMeta
  thread = { id: 'th1', kind: 'thread', role: 'thread', title: 'push-retries', created_at: T, parent: 'main', anchor: 'agents/agent-05.jsonl#L12', anchor_text: 'git push', running: true } as unknown as ChatMeta
  mainEvents = [{ type: 'done', ts: '2026-10-15T09:59:00+00:00' }]
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', async (url: string) => {
    const u = String(url)
    const body = u.endsWith('/chats/main')
      ? { meta: main, events: mainEvents }
      : u.endsWith('/chats/th1')
        ? { meta: thread, events: [QUESTION] }
        : /\/chats(\?|$)/.test(u)
          ? [main, thread, ...others]
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

describe("main's turn that takes the thread's question to its fork", () => {
  const done: ChatRecord = { type: 'done', ts: '2026-10-15T09:59:00+00:00' }
  const EARLIER = '2026-10-15T09:59:30+00:00'
  const call = (ts: string): ChatRecord => ({ type: 'tool_use', ts, id: 't1', name: 'ScheduleWakeup', input: {} })
  test("is one while main and the thread run, main's last turn ended before the question, and main did nothing else since", () => {
    expect(mainRelays([done], true, [QUESTION], true)).toBe(true)
    expect(mainRelays([], true, [QUESTION], true)).toBe(true)
    // a call of main's in that turn after the question, such as the fork's, leaves it one
    expect(mainRelays([done, call(LATER)], true, [QUESTION], true)).toBe(true)
  })
  test("is none for a turn of main's own: the analyst asked main, main was at work before the question, or a turn ended after it", () => {
    expect(mainRelays([done, { type: 'user', ts: T, text: 'count the merges', by: 'browser' }], true, [QUESTION], true)).toBe(false)
    expect(mainRelays([done, call(EARLIER)], true, [QUESTION], true)).toBe(false)
    expect(mainRelays([{ type: 'done', ts: LATER }], true, [QUESTION], true)).toBe(false)
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

describe("a thread whose fork's command waits for the analyst", () => {
  const ASK = { id: 'h1', host: 'data.example-lab.test', since: LATER, call: { tool: 'Bash', input: { command: 'curl -sS https://data.example-lab.test/api/runs' } } }
  beforeEach(() => {
    thread = { ...thread, fork: { agent_id: 'afork1' } } as unknown as ChatMeta
    main = { ...main, running: false }
  })
  /** The thread's chat as it shows: its strip's title, and whether it shows the wait dot or the spinner. */
  const strip = async () => {
    const el = await mount(<ChatPanel ws="mini" />)
    await settle()
    await settle()
    const s = el.querySelector('.chat-strip')
    return { title: s?.querySelector('.chat-strip-title')?.textContent, dot: !!s?.querySelector('.chat-strip-wait-dot'), spinner: !!s?.querySelector('.spinner'), ask: !!el.querySelector('.chat-host-ask') }
  }

  test('on an ask about a host, its strip shows the wait dot in place of the spinner', async () => {
    thread = { ...thread, hosts: [ASK] } as unknown as ChatMeta
    expect(await strip()).toEqual({ title: 'Working', dot: true, spinner: false, ask: true })
  })

  test("on a request main's session relays for the thread, too", async () => {
    main = { ...main, permissions: [{ id: 'p1', tool: 'Bash', what: 'Run a command', since: LATER, chat: 'th1', terminal: true }] } as unknown as ChatMeta
    expect(await strip()).toEqual({ title: 'Working', dot: true, spinner: false, ask: false })
  })

  test('a thread asked from it that waits leaves its strip at work', async () => {
    others = [{ id: 'th2', kind: 'thread', role: 'thread', title: 'retry-counts', created_at: LATER, parent: 'th1', anchor: null, anchor_text: null, running: true, fork: { agent_id: 'afork2' }, hosts: [ASK] } as unknown as ChatMeta]
    expect(await strip()).toEqual({ title: 'Working', dot: false, spinner: true, ask: false })
  })
})
