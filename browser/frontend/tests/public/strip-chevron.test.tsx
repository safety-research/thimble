// @vitest-environment jsdom
// The strip behind the composer opens on its steps (src/chat/ChatPanel.tsx TaskStrip): the subagents and workflow
// agents of a session thimble runs beside main, such as a writer (taskStrip). Its chevron, and the button it makes of
// the strip's head, show only while there are steps to open: main's strip and a side thread's list none, so they show
// the spinner and the title alone, as a writer's does before its first agent. That agent gives the strip its chevron in
// the writer's thread, and the chevron opens the steps it lists.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ChatPanel } from '../../src/chat/ChatPanel.tsx'
import { bus } from '../../src/lib/bus.ts'
import type { ChatMeta, ChatRecord } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const T = '2026-10-15T10:00:00+00:00'
const LATER = '2026-10-15T10:00:05+00:00'
const ATTACHED = { session: 's1', cwd: '/corpus', at: T, model: 'claude-opus-5-5' }
const MAIN = { id: 'main', kind: 'main', role: 'main', title: 'main', created_at: T, parent: null, running: true, attached: ATTACHED, unread: [] } as unknown as ChatMeta
const THREAD = { id: 'th1', kind: 'thread', role: 'thread', title: 'push-retries', created_at: T, parent: 'main', anchor: null, anchor_text: null, running: true, fork: { agent_id: 'afork1' } } as unknown as ChatMeta
const WRITER = { id: 'wr1', kind: 'agent', role: 'writer', title: 'report', doc: 'report', created_at: T, parent: 'main', status: 'running' } as unknown as ChatMeta
/** the first agent of the writer's workflow, a step of its session, and its record in the writer's log */
const STEP = { id: 'st1', kind: 'agent', role: 'step', title: 'Survey: the runs', created_at: LATER, parent: 'wr1', status: 'running' } as unknown as ChatMeta
const STEP_STARTED: ChatRecord = { type: 'agent', ts: LATER, chat: 'st1', role: 'step', title: 'Survey: the runs' }

let main: ChatMeta
let others: ChatMeta[]
let logs: Record<string, ChatRecord[]>

beforeEach(() => {
  localStorage.clear()
  main = MAIN
  others = []
  logs = {
    // main works on a question with a call of its own, no subagent or workflow
    main: [
      { type: 'user', text: 'Count the runs per agent.', by: 'browser' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls runs' } },
    ],
    th1: [{ type: 'user', ts: T, text: 'Why did agent-05 push three times?', by: 'browser' }],
    wr1: [{ type: 'user', ts: T, text: 'Write the report.', by: 'browser' }],
  }
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', async (url: string) => {
    const u = String(url)
    const one = [main, ...others].find((m) => u.endsWith(`/chats/${m.id}`))
    const body = one
      ? { meta: one, events: logs[one.id] ?? [] }
      : /\/chats(\?|$)/.test(u)
        ? [main, ...others]
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

/** The chat panel showing the thread `current`. */
async function show(current: string): Promise<HTMLElement> {
  unmountAll()
  localStorage.setItem('thimble:mini:thread-current', JSON.stringify(current))
  const el = await mount(<ChatPanel ws="mini" />)
  await settle()
  await settle()
  return el
}

/** The strip as it shows: its title and count, whether its head is a button with the chevron and is open, and the
 * steps it lists. */
const strip = (el: HTMLElement) => {
  const s = el.querySelector('.chat-strip')
  return (
    s && {
      title: s.querySelector('.chat-strip-title')?.textContent,
      count: s.querySelector('.chat-strip-meta')?.textContent ?? '',
      chevron: !!s.querySelector('.chat-strip-caret'),
      button: !!s.querySelector('button.chat-strip-head'),
      expanded: s.querySelector('.chat-strip-head')?.getAttribute('aria-expanded') ?? null,
      steps: [...s.querySelectorAll('.chat-strip-steps .toolcard-step-text')].map((t) => t.textContent),
    }
  )
}

/** The writer's first agent starts: the writer's log and the chats list hold it, and the stream says that the log
 * changed. */
async function firstAgent() {
  logs = { ...logs, wr1: [...logs.wr1, STEP_STARTED] }
  others = [...others, STEP]
  await act(async () => bus.emit('chat', { chat: 'wr1' }))
  await act(async () => new Promise((r) => setTimeout(r, 400)))
}

describe('the chevron of the strip behind the composer', () => {
  test("is not there in main's chat while main works with no workflow, nor in a side thread's: they list no steps", async () => {
    const alone = { title: 'Working', count: '', chevron: false, button: false, expanded: null, steps: [] }
    expect(strip(await show('main'))).toEqual(alone)
    others = [THREAD]
    expect(strip(await show('th1'))).toEqual(alone)
  })

  test("comes with the writer's first agent in its thread, and opens the steps", async () => {
    others = [WRITER]
    const el = await show('wr1')
    expect(strip(el)).toEqual({ title: 'Writing', count: '', chevron: false, button: false, expanded: null, steps: [] })
    await firstAgent()
    expect(strip(el)).toEqual({ title: 'Writing', count: '0/1', chevron: true, button: true, expanded: 'false', steps: [] })
    await act(async () => el.querySelector<HTMLButtonElement>('.chat-strip button.chat-strip-head')!.click())
    expect(strip(el)).toEqual({ title: 'Writing', count: '0/1', chevron: true, button: true, expanded: 'true', steps: ['the runs'] })
  })
})
