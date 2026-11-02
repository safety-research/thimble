// @vitest-environment jsdom
// While main works (B14, src/chat/ChatPanel.tsx): main's chat says so for the whole turn, with the strip a side thread
// shows (taskStrip), and the composer keeps main's Stop while the analyst writes (src/components/Composer.tsx). A message
// sent meanwhile waits until main reads it (backend runtime.unread, main's meta `unread`, src/chat/useChat.ts): the
// analyst's tile a step quieter, after the turn's rows, so the rest of the turn does not read as its answer; once main
// reads it, the log holds it where main read it.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ChatPanel } from '../../src/chat/ChatPanel.tsx'
import { bus } from '../../src/lib/bus.ts'
import type { ChatMeta, ChatRecord } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const T = '2026-10-15T10:00:00+00:00'
const ATTACHED = { session: 's1', cwd: '/corpus', at: T, model: 'claude-opus-5-5' }
const FIRST = 'Count the runs per agent.'
const SECOND = 'And how many files are there?'
let main: ChatMeta
let events: ChatRecord[]
let posted: string[]

beforeEach(() => {
  posted = []
  main = { id: 'main', kind: 'main', role: 'main', title: 'main', created_at: T, parent: null, running: true, attached: ATTACHED, module: true, unread: [] } as unknown as ChatMeta
  events = [
    { type: 'user', text: FIRST, by: 'browser' },
    { type: 'tool_use', id: 't1', name: 'mcp__plugin_thimble_thimble__list_cards', input: { group: 'all' } },
  ]
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const u = String(url)
    if (init?.method && init.method !== 'GET' && !u.includes('/telemetry')) posted.push(`${init.method} ${u}`)
    const body = u.endsWith('/events')
      ? { id: 'e2', kind: 'main', delivered: 1 }
      : u.endsWith('/interrupt')
        ? { stopped: true }
        : u.endsWith('/chats/main')
        ? { meta: main, events }
        : /\/chats(\?|$)/.test(u)
          ? [main]
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

/** Main's chat read again, as on the stream's `chat` record. */
async function reread() {
  await act(async () => bus.emit('chat', { chat: 'main' }))
  await act(async () => new Promise((r) => setTimeout(r, 200)))
}

const flowTail = (el: HTMLElement) => el.querySelector('.chat-flow')!.lastElementChild as HTMLElement
const loggedLines = (el: HTMLElement) => [...el.querySelectorAll('.chat-user:not(.chat-pending) .chat-message')].map((m) => m.textContent)
const squares = (el: HTMLElement) => [...el.querySelectorAll<HTMLButtonElement>('.chat-composer button.composer-send')].map((b) => b.getAttribute('aria-label'))

describe("main's chat while main works", () => {
  test('shows the strip for the whole turn, and a message sent meanwhile waits after the turn until main reads it', async () => {
    main = { ...main, unread: [{ event: 'e2', text: SECOND }] }
    const el = await mount(<ChatPanel ws="mini" />)
    await settle()
    expect(el.querySelector('.chat-strip .chat-strip-title')?.textContent).toBe('Working')
    expect(flowTail(el).matches('.chat-pending')).toBe(true)
    expect(flowTail(el).textContent).toContain(SECOND)
    expect(loggedLines(el)).toEqual([FIRST])
    // main reads it with the result of its call: the log holds it there, and nothing waits
    main = { ...main, unread: [] }
    events = [...events, { type: 'tool_result', id: 't1', summary: 'no cards' }, { type: 'user', text: SECOND, by: 'browser', event: 'e2' }]
    await reread()
    expect(el.querySelector('.chat-pending')).toBeNull()
    expect(loggedLines(el)).toEqual([FIRST, SECOND])
    expect(el.querySelector('.chat-strip')).not.toBeNull()
    // the turn ends: no strip
    main = { ...main, running: false }
    events = [...events, { type: 'text', delta: 'Agent 3 ran most; there are 12 files.', by: 'terminal' }, { type: 'done' }]
    await reread()
    expect(el.querySelector('.chat-strip')).toBeNull()
  })

  test('keeps Stop main beside Send while the analyst writes, and shows what they send waiting', async () => {
    const el = await mount(<ChatPanel ws="mini" />)
    await settle()
    expect(squares(el)).toEqual(['Stop main'])
    const box = el.querySelector<HTMLTextAreaElement>('.chat-composer textarea')!
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => {
      setValue.call(box, SECOND)
      box.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(squares(el)).toEqual(['Stop main', 'Send'])
    // the server keeps it for main's next step (backend runtime.deliver)
    main = { ...main, unread: [{ event: 'e2', text: SECOND }] }
    await act(async () => el.querySelector<HTMLButtonElement>('.chat-composer button.composer-send[aria-label="Send"]')!.click())
    await settle()
    expect(posted).toEqual(['POST /api/ws/mini/events'])
    expect(squares(el)).toEqual(['Stop main'])
    expect(flowTail(el).matches('.chat-pending')).toBe(true)
    expect(flowTail(el).textContent).toContain(SECOND)
    expect(el.querySelectorAll('.chat-pending')).toHaveLength(1)
    expect(loggedLines(el)).toEqual([FIRST])
  })

  test("leaves main's Stop free once it answers, as the message that waited starts main's next turn at once", async () => {
    main = { ...main, unread: [{ event: 'e2', text: SECOND }] }
    const el = await mount(<ChatPanel ws="mini" />)
    await settle()
    // the stopped turn ended, and main reads the message as its next turn (backend runtime.after_stop): main runs on
    main = { ...main, unread: [] }
    events = [...events, { type: 'done' }, { type: 'user', text: SECOND, by: 'browser', event: 'e2' }]
    await act(async () => el.querySelector<HTMLButtonElement>('.chat-composer button.composer-send')!.click())
    await settle()
    expect(posted).toEqual(['POST /api/ws/mini/chats/main/interrupt'])
    await reread()
    const stop = el.querySelector<HTMLButtonElement>('.chat-composer button.composer-send')!
    expect(stop.getAttribute('aria-label')).toBe('Stop main')
    expect(stop.getAttribute('aria-busy')).not.toBe('true')
    expect(loggedLines(el)).toEqual([FIRST, SECOND])
    expect(el.querySelector('.chat-pending')).toBeNull()
  })
})
