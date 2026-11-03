// @vitest-environment jsdom
// Rewind main to one of the analyst's messages (src/chat/rewind.ts, backend runtime.rewind_main): the ↶ on a message
// asks first, under the message; Rewind posts main's rewind, the chat then hides that message and everything after it up
// to the rewind's line, and the message's words come back in main's composer. `/rewind` asks it for the latest message.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ChatPanel } from '../../src/chat/ChatPanel.tsx'
import { foldRecords, mainSkips, REWIND_CHIP, rewoundRecords } from '../../src/chat/model.ts'
import { isRewindCommand, lastRewindable } from '../../src/chat/rewind.ts'
import { bus } from '../../src/lib/bus.ts'
import type { ChatMeta, ChatRecord } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const T = '2026-10-15T10:00:00+00:00'
const ATTACHED = { session: 's1', cwd: '/corpus', at: T, model: 'claude-opus-5-5' }
const LINE = 'Rewound to before your message. Claude no longer sees it or anything after it; files and cards it changed stay as they are.'
const TALK: ChatRecord[] = [
  { type: 'user', text: 'How many runs failed?', by: 'browser', event: 'e1' },
  { type: 'text', delta: 'Twelve of the forty.' },
  { type: 'done' } as unknown as ChatRecord,
  { type: 'user', text: 'Was it the config change?', by: 'browser', event: 'e2' },
  { type: 'text', delta: 'Yes, every failure came after it.' },
  { type: 'done' } as unknown as ChatRecord,
]
const REWOUND: ChatRecord = { type: 'chip', kind: REWIND_CHIP, text: LINE, event: 'e2' }
const CTX = { spawned: new Set<string>(), summaries: [], runs: [] }

describe('which records a rewind hides', () => {
  test('from the message the line names up to the line, which stays', () => {
    expect([...rewoundRecords([...TALK, REWOUND])]).toEqual([3, 4, 5])
    expect(mainSkips([...TALK, REWOUND], CTX).has(4)).toBe(true)
    const rows = foldRecords([...TALK, REWOUND], mainSkips([...TALK, REWOUND], CTX))
    expect(rows.filter((r) => r.kind === 'user').map((r) => (r as { text: string }).text)).toEqual(['How many runs failed?'])
    // a later rewind to an earlier message hides the earlier line too
    const again: ChatRecord[] = [...TALK, REWOUND, { type: 'user', text: 'Any after noon?', by: 'browser', event: 'e3' }, { ...REWOUND, event: 'e1' }]
    expect([...rewoundRecords(again)].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  test('/rewind is the command alone, and it goes to the latest message the chat still shows', () => {
    expect(isRewindCommand(' /rewind ')).toBe(true)
    expect(isRewindCommand('/rewind the last one')).toBe(false)
    expect(lastRewindable(TALK, new Set())).toEqual({ event: 'e2', index: 3 })
    expect(lastRewindable([...TALK, REWOUND], rewoundRecords([...TALK, REWOUND]))).toEqual({ event: 'e1', index: 0 })
    expect(lastRewindable([{ type: 'user', text: 'typed in the terminal', by: 'terminal' }], new Set())).toBeNull()
  })
})

describe("Rewind in main's chat", () => {
  let events: ChatRecord[]
  let posted: { url: string; body: unknown }[]

  beforeEach(() => {
    events = [...TALK]
    posted = []
    const main = { id: 'main', kind: 'main', role: 'main', title: 'main', created_at: T, parent: null, running: false, attached: ATTACHED, module: true } as unknown as ChatMeta
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
    Element.prototype.scrollIntoView = () => undefined  // jsdom lays nothing out
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const u = String(url)
      if (init?.method === 'POST' && !u.includes('/telemetry')) posted.push({ url: u, body: init.body ? JSON.parse(String(init.body)) : null })
      let body: unknown = {}
      if (u.endsWith('/chats/main/rewind')) {
        events = [...events, { ...REWOUND, event: (posted[posted.length - 1].body as { event: string }).event }]
        body = { text: 'Was it the config change?', event: 'e2' }
      } else if (u.endsWith('/chats/main')) body = { meta: main, events }
      else if (/\/chats(\?|$)/.test(u)) body = [main]
      else if (/\/(proposals|notices|views)(\?|$)/.test(u)) body = []
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    })
  })
  afterEach(() => {
    unmountAll()
    vi.unstubAllGlobals()
  })

  const messages = (el: HTMLElement) => [...el.querySelectorAll('.chat-user .chat-message')].map((m) => m.textContent)
  const box = (el: HTMLElement) => el.querySelector<HTMLTextAreaElement>('.chat-composer textarea')!

  test('asks under the message first, then rewinds: the chat hides it and what came after, and its words are back in the box', async () => {
    const el = await mount(<ChatPanel ws="mini" />)
    await settle()
    const ups = el.querySelectorAll<HTMLButtonElement>('.chat-user button.chat-rewind')
    expect(ups).toHaveLength(2)
    await act(async () => ups[1].click())
    const ask = el.querySelector('.chat-user[data-event="e2"] .chat-rewind-ask')
    expect(ask?.textContent).toContain('Claude forgets it and everything after it')
    expect(posted).toEqual([])
    const go = [...ask!.querySelectorAll('button')].find((b) => b.textContent === 'Rewind')!
    await act(async () => go.click())
    await settle()
    expect(posted).toEqual([{ url: '/api/ws/mini/chats/main/rewind', body: { event: 'e2' } }])
    await act(async () => bus.emit('chat', { chat: 'main' }))
    await act(async () => new Promise((r) => setTimeout(r, 200)))
    expect(messages(el)).toEqual(['How many runs failed?'])
    expect(el.querySelector('[data-chip="rewind"]')?.textContent).toBe(LINE)
    expect(el.querySelector('.chat-rewind-ask')).toBeNull()
    expect(box(el).value).toBe('Was it the config change?')
  })

  test('/rewind asks it for the latest message, and Cancel leaves the chat as it was', async () => {
    const el = await mount(<ChatPanel ws="mini" />)
    await settle()
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => {
      setValue.call(box(el), '/rewind')
      box(el).dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => el.querySelector<HTMLButtonElement>('.chat-composer button.composer-send')!.click())
    await settle()
    expect(posted).toEqual([])  // the command goes to no session
    const ask = el.querySelector('.chat-user[data-event="e2"] .chat-rewind-ask')
    expect(ask).not.toBeNull()
    await act(async () => [...ask!.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!.click())
    expect(el.querySelector('.chat-rewind-ask')).toBeNull()
    expect(messages(el)).toEqual(['How many runs failed?', 'Was it the config change?'])
    expect(posted).toEqual([])
  })
})
