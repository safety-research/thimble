// @vitest-environment jsdom
// Stop for main and its side threads in the browser (src/chat/ChatPanel.tsx, composerStopOf): while main's turn runs,
// the send square of main's composer is Stop, as Esc is in Claude Code; a click posts main's interrupt (backend
// agents.interrupt_route, which ends the turn through thimble's hooks module). Without that module in main's session
// the click says to press Esc in the terminal. Once main's turn has ended the square is Send again. A side thread whose
// fork runs has Stop too, which posts the thread's interrupt (its fork stopped as an agent is).
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ChatPanel } from '../../src/chat/ChatPanel.tsx'
import { bus } from '../../src/lib/bus.ts'
import type { ChatMeta } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const T = '2026-10-15T10:00:00+00:00'
const ATTACHED = { session: 's1', cwd: '/corpus', at: T, model: 'claude-opus-5-5' }
let main: ChatMeta
let thread: ChatMeta
let interrupt: { stopped: boolean; kind?: string; reason?: string }
let posted: string[] = []

beforeEach(() => {
  posted = []
  main = { id: 'main', kind: 'main', role: 'main', title: 'main', created_at: T, parent: null, running: true, attached: ATTACHED, module: true } as unknown as ChatMeta
  interrupt = { stopped: true }
  thread = { id: 'th1', kind: 'thread', role: 'thread', title: 'runs-per-agent', created_at: T, parent: 'main', anchor: 'card:abc123', anchor_text: 'Runs per agent', running: true, fork: { agent_id: 'afork1' } } as unknown as ChatMeta
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const u = String(url)
    if (init?.method && init.method !== 'GET' && !u.includes('/telemetry')) posted.push(`${init.method} ${u}`)
    const body = u.endsWith('/interrupt')
      ? interrupt
      : u.endsWith('/chats/main')
        ? { meta: main, events: [{ type: 'user', text: 'Count the runs per agent.', by: 'browser' }] }
        : u.endsWith('/chats/th1')
          ? { meta: thread, events: [{ type: 'user', text: 'Why is Agent 3 so high?' }] }
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
})

const square = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('button.composer-send')!

describe("main's composer while main's turn runs", () => {
  test('shows Stop main in place of Send, and a click posts main’s interrupt', async () => {
    const el = await mount(<ChatPanel ws="mini" />)
    await settle()
    expect(square(el).getAttribute('aria-label')).toBe('Stop main')
    await act(async () => square(el).click())
    await settle()
    expect(posted).toEqual(['POST /api/ws/mini/chats/main/interrupt'])
    // main's turn ended: the mirror says so, and the square is Send again
    main = { ...main, running: false }
    await act(async () => bus.emit('chat', { chat: 'main' }))
    await act(async () => new Promise((r) => setTimeout(r, 200)))
    expect(square(el).getAttribute('aria-label')).toBe('Send')
  })

  test('shows Send while main is idle', async () => {
    main = { ...main, running: false }
    const el = await mount(<ChatPanel ws="mini" />)
    await settle()
    expect(square(el).getAttribute('aria-label')).toBe('Send')
  })
})

describe("a side thread's composer while its fork runs", () => {
  test("shows Stop the thread, which posts the thread's interrupt; Send again once the thread stops", async () => {
    main = { ...main, running: false }
    const el = await mount(<ChatPanel ws="mini" />)
    await settle()
    await act(async () => bus.emit('openChat', { chatId: 'th1' }))
    await settle()
    expect(square(el).getAttribute('aria-label')).toBe('Stop the thread')
    await act(async () => square(el).click())
    await settle()
    expect(posted).toEqual(['POST /api/ws/mini/chats/th1/interrupt'])
    thread = { ...thread, running: false }
    await act(async () => bus.emit('chat', { chat: 'th1' }))
    await act(async () => new Promise((r) => setTimeout(r, 200)))
    expect(square(el).getAttribute('aria-label')).toBe('Send')
  })
})
