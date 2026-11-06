// @vitest-environment jsdom
// Rewind main to one of the analyst's messages (src/chat/rewind.ts, backend runtime.rewind_main): the ↶ on a message
// asks first, under the message; Rewind posts main's rewind, the chat then hides that message and everything after it up
// to the rewind's line, and the message's words come back in main's composer, with those of a message that waited for
// main, which shows waiting no more; a page that never got the rewind's reply takes them from the line, once. A rewind
// goes back only within main's current chat. `/rewind`, one of the composer's commands, lists the analyst's messages
// there, newest first, each with its first words and its time (src/chat/RewindPicker.tsx), as Claude Code's /rewind
// lists the prompts of its session: the keys or the pointer pick how far back to go, the pick rewinds main to before
// that message, and Esc or a press outside closes the list with nothing changed.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ChatPanel } from '../../src/chat/ChatPanel.tsx'
import { COMMANDS, commandsFor, REWIND_COMMAND } from '../../src/chat/commands.ts'
import { foldRecords, mainSkips, REWIND_CHIP, rewoundRecords } from '../../src/chat/model.ts'
import { isRewindCommand, NOTHING_TO_REWIND, rewindChoices } from '../../src/chat/rewind.ts'
import { oneLine } from '../../src/chat/RewindPicker.tsx'
import { bus } from '../../src/lib/bus.ts'
import { hhmm } from '../../src/lib/time.ts'
import type { ChatMeta, ChatRecord } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const T = '2026-10-15T10:00:00+00:00'
const T2 = '2026-10-15T10:07:00+00:00'
const T3 = '2026-10-15T11:42:00+00:00'
const ATTACHED = { session: 's1', cwd: '/corpus', at: T, model: 'claude-opus-5-5' }
const LINE = 'Rewound to before your message. Claude no longer sees it or anything after it; files and cards it changed stay as they are.'
const TALK: ChatRecord[] = [
  { type: 'user', ts: T, text: 'How many runs failed?', by: 'browser', event: 'e1' },
  { type: 'text', delta: 'Twelve of the forty.' },
  { type: 'done' } as unknown as ChatRecord,
  { type: 'user', ts: T2, text: 'Was it the config change?', by: 'browser', event: 'e2' },
  { type: 'text', delta: 'Yes, every failure came after it.' },
  { type: 'done' } as unknown as ChatRecord,
]
const REWOUND: ChatRecord = { type: 'chip', kind: REWIND_CHIP, text: LINE, event: 'e2' }
const CTX = { spawned: new Set<string>(), summaries: [], runs: [] }
// the line where a chat of main starts, and one where an earlier chat comes back (backend runtime.Space.switch)
const NEW_CHAT: ChatRecord = { type: 'chip', kind: 'session', text: 'New chat' }
const RESUMED: ChatRecord = { type: 'chip', kind: 'session', text: 'Resumed the chat that began with: How many runs failed?' }
const LATER: ChatRecord = { type: 'user', ts: T3, text: 'Which runs passed?', by: 'browser', event: 'e3' }

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

  test('/rewind is the command alone, and it lists the messages the chat still shows, newest first', () => {
    expect(isRewindCommand(' /rewind ')).toBe(true)
    expect(isRewindCommand('/rewind the last one')).toBe(false)
    expect(isRewindCommand('/rewinds')).toBe(false)
    // one of the composer's commands, which a "/" lists with what it does
    expect(COMMANDS.find((c) => c.name === REWIND_COMMAND)?.about).toBeTruthy()
    expect(commandsFor('/rew').map((c) => c.name)).toEqual([REWIND_COMMAND])
    expect(rewindChoices(TALK, new Set())).toEqual([
      { event: 'e2', index: 3, text: 'Was it the config change?', ts: T2 },
      { event: 'e1', index: 0, text: 'How many runs failed?', ts: T },
    ])
    expect(rewindChoices([...TALK, REWOUND], rewoundRecords([...TALK, REWOUND])).map((c) => c.event)).toEqual(['e1'])
    expect(rewindChoices([{ type: 'user', text: 'typed in the terminal', by: 'terminal' }], new Set())).toEqual([])
  })

  test("/rewind goes back no further than main's current chat, which starts at its latest chat line", () => {
    expect(rewindChoices([...TALK, NEW_CHAT], new Set())).toEqual([])
    expect(rewindChoices([...TALK, RESUMED], new Set())).toEqual([])
    expect(rewindChoices([...TALK, NEW_CHAT, LATER], new Set())).toEqual([{ event: 'e3', index: 7, text: 'Which runs passed?', ts: T3 }])
    // a line of the session that starts no chat is no chat line
    expect(rewindChoices([...TALK, { type: 'chip', kind: 'session', text: 'Stopped' }], new Set()).map((c) => c.event)).toEqual(['e2', 'e1'])
  })

  test("a message's row has its words on one line", () => {
    expect(oneLine('  Which runs\n\nfailed  after\tnoon?\n')).toBe('Which runs failed after noon?')
  })
})

describe("Rewind in main's chat", () => {
  let events: ChatRecord[]
  let posted: { url: string; body: unknown }[]
  // what the server says waits for main's running turn (meta `unread`), and the words its rewind gives back, which its
  // line keeps too; while `reply` is set, the rewind's reply waits for it, its line already written
  let unread: { event: string; text: string }[]
  let back: string
  let reply: Promise<void> | null

  beforeEach(() => {
    events = [...TALK]
    posted = []
    unread = []
    back = 'Was it the config change?'
    reply = null
    localStorage.clear()
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
    Element.prototype.scrollIntoView = () => undefined  // jsdom lays nothing out
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const u = String(url)
      if (init?.method === 'POST' && !u.includes('/telemetry')) posted.push({ url: u, body: init.body ? JSON.parse(String(init.body)) : null })
      let body: unknown = {}
      const main = { id: 'main', kind: 'main', role: 'main', title: 'main', created_at: T, parent: null, running: unread.length > 0, unread, attached: ATTACHED } as unknown as ChatMeta
      if (u.endsWith('/chats/main/rewind')) {
        events = [...events, { ...REWOUND, event: (posted[posted.length - 1].body as { event: string }).event, words: back }]
        unread = []
        body = { text: back, event: 'e2' }
        if (reply) await reply
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
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  /** `/rewind` typed in main's composer and sent */
  const rewindCommand = async (el: HTMLElement) => {
    await act(async () => {
      setValue.call(box(el), '/rewind')
      box(el).dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => el.querySelector<HTMLButtonElement>('.chat-composer button.composer-send')!.click())
    await settle()
  }
  // the list `/rewind` opens: its rows, the words and time of each, the one the keys are on, and a key pressed in it
  const list = (el: HTMLElement) => el.querySelector<HTMLElement>('.chat-composer [role="listbox"]')
  const rows = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('.chat-composer [role="option"]')]
  const words = (el: HTMLElement) => rows(el).map((o) => o.querySelector('.chat-rewind-choice-words')?.textContent)
  const times = (el: HTMLElement) => rows(el).map((o) => o.querySelector('time')?.textContent)
  const active = (el: HTMLElement) => rows(el).find((o) => o.getAttribute('aria-selected') === 'true')?.querySelector('.chat-rewind-choice-words')?.textContent
  const key = async (el: HTMLElement, k: string) => {
    const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })
    await act(async () => void list(el)!.dispatchEvent(e))
    return e
  }
  /** main's chat read again, as the stream's event after a rewind has it */
  const reloaded = async () => {
    await act(async () => bus.emit('chat', { chat: 'main' }))
    await act(async () => new Promise((r) => setTimeout(r, 200)))
  }

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
    await reloaded()
    expect(messages(el)).toEqual(['How many runs failed?'])
    expect(el.querySelector('[data-chip="rewind"]')?.textContent).toBe(LINE)
    expect(el.querySelector('.chat-rewind-ask')).toBeNull()
    expect(box(el).value).toBe('Was it the config change?')
  })

  test('/rewind lists your messages in main, newest first, each with its first words and its time; Esc closes it with nothing changed', async () => {
    const el = await mount(<ChatPanel ws="mini" />)
    await settle()
    await rewindCommand(el)
    expect(posted).toEqual([])  // the command goes to no session
    expect(words(el)).toEqual(['Was it the config change?', 'How many runs failed?'])
    expect(times(el)).toEqual([hhmm(T2), hhmm(T)])
    expect(rows(el).map((o) => o.getAttribute('data-event'))).toEqual(['e2', 'e1'])
    // the newest is the one the keys are on, and the list has the focus, so the keys are its
    expect(active(el)).toBe('Was it the config change?')
    expect(document.activeElement).toBe(list(el))
    expect(list(el)!.getAttribute('aria-activedescendant')).toBe(rows(el)[0].id)
    // it asks nothing under a message, and the ↶ on each message stays
    expect(el.querySelector('.chat-rewind-ask')).toBeNull()
    expect(el.querySelectorAll('.chat-user button.chat-rewind')).toHaveLength(2)
    const esc = await key(el, 'Escape')
    expect(esc.defaultPrevented).toBe(true)
    expect(list(el)).toBeNull()
    expect(document.activeElement).toBe(box(el))
    expect(messages(el)).toEqual(['How many runs failed?', 'Was it the config change?'])
    expect(posted).toEqual([])
  })

  test('↑ and ↓ pick how far back to go, round from one end to the other; Enter rewinds main to before that message', async () => {
    back = 'How many runs failed?'
    const el = await mount(<ChatPanel ws="mini" />)
    await settle()
    await rewindCommand(el)
    expect(rows(el).map((o) => o.hasAttribute('data-after'))).toEqual([false, false])
    expect((await key(el, 'ArrowDown')).defaultPrevented).toBe(true)
    expect(active(el)).toBe('How many runs failed?')
    expect(list(el)!.getAttribute('aria-activedescendant')).toBe(rows(el)[1].id)
    // the newer message, which that rewind takes back too, is marked as such
    expect(rows(el).map((o) => o.hasAttribute('data-after'))).toEqual([true, false])
    await key(el, 'ArrowDown')
    expect(active(el)).toBe('Was it the config change?')
    await key(el, 'ArrowUp')
    expect(active(el)).toBe('How many runs failed?')
    await key(el, 'Home')
    expect(active(el)).toBe('Was it the config change?')
    await key(el, 'End')
    expect(active(el)).toBe('How many runs failed?')
    expect(posted).toEqual([])
    expect((await key(el, 'Enter')).defaultPrevented).toBe(true)
    await settle()
    expect(posted).toEqual([{ url: '/api/ws/mini/chats/main/rewind', body: { event: 'e1' } }])
    await reloaded()
    expect(list(el)).toBeNull()
    expect(messages(el)).toEqual([])
    expect(box(el).value).toBe('How many runs failed?')
    expect(document.activeElement).toBe(box(el))
  })

  test('the pointer moves with the keys, and a click picks as Enter does', async () => {
    back = 'How many runs failed?'
    const el = await mount(<ChatPanel ws="mini" />)
    await settle()
    await rewindCommand(el)
    const older = rows(el)[1]
    await act(async () => void older.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' })))
    expect(active(el)).toBe('How many runs failed?')
    // a press in the list keeps the focus in it
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    await act(async () => void older.dispatchEvent(press))
    expect(press.defaultPrevented).toBe(true)
    expect(list(el)).not.toBeNull()
    await act(async () => older.click())
    await settle()
    expect(posted).toEqual([{ url: '/api/ws/mini/chats/main/rewind', body: { event: 'e1' } }])
    await reloaded()
    expect(list(el)).toBeNull()
    expect(box(el).value).toBe('How many runs failed?')
  })

  test('a press outside the list closes it, and so does the focus going elsewhere; nothing is rewound', async () => {
    const el = await mount(<ChatPanel ws="mini" />)
    await settle()
    await rewindCommand(el)
    expect(list(el)).not.toBeNull()
    await act(async () => void el.querySelector('.chat-list')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })))
    expect(list(el)).toBeNull()
    await rewindCommand(el)
    expect(document.activeElement).toBe(list(el))
    await act(async () => box(el).focus())  // as Tab takes it to the composer's text
    expect(list(el)).toBeNull()
    expect(document.activeElement).toBe(box(el))
    expect(posted).toEqual([])
    expect(messages(el)).toEqual(['How many runs failed?', 'Was it the config change?'])
  })

  test('while the rewind runs, its row says so and another pick sends nothing more', async () => {
    let send = () => undefined as void
    reply = new Promise((r) => (send = r))
    const el = await mount(<ChatPanel ws="mini" />)
    await settle()
    await rewindCommand(el)
    await key(el, 'Enter')
    await settle()
    expect(posted).toHaveLength(1)
    expect(list(el)!.getAttribute('aria-busy')).toBe('true')
    expect(rows(el)[0].querySelector('[role="status"]')).not.toBeNull()
    await key(el, 'Enter')
    await act(async () => rows(el)[1].click())
    await settle()
    expect(posted).toEqual([{ url: '/api/ws/mini/chats/main/rewind', body: { event: 'e2' } }])
    await act(async () => send())
    await settle()
    expect(list(el)).toBeNull()
    expect(box(el).value).toBe('Was it the config change?')
  })

  test('a message that waits for main comes back in the box with the rewound one, and shows waiting no more', async () => {
    unread = [{ event: 'e3', text: 'And after noon?' }]
    back = 'Was it the config change?\n\nAnd after noon?'
    const el = await mount(<ChatPanel ws="mini" />)
    await settle()
    expect([...el.querySelectorAll('.chat-pending .chat-message')].map((m) => m.textContent)).toEqual(['And after noon?'])
    await act(async () => el.querySelectorAll<HTMLButtonElement>('.chat-user button.chat-rewind')[1].click())
    const go = [...el.querySelectorAll<HTMLButtonElement>('.chat-rewind-ask button')].find((b) => b.textContent === 'Rewind')!
    await act(async () => go.click())
    await settle()
    await reloaded()
    expect(el.querySelector('.chat-pending')).toBeNull()
    expect(messages(el)).toEqual(['How many runs failed?'])
    expect(box(el).value).toBe('Was it the config change?\n\nAnd after noon?')
  })

  test("only the messages of main's current chat have Rewind or are listed, and /rewind finds none before its chat line", async () => {
    const toasts: string[] = []
    const off = bus.on('toast', (t) => void toasts.push(t.text))
    events = [...TALK, NEW_CHAT, LATER]
    let el = await mount(<ChatPanel ws="mini" />)
    await settle()
    expect(messages(el)).toEqual(['How many runs failed?', 'Was it the config change?', 'Which runs passed?'])
    const ups = [...el.querySelectorAll('.chat-user button.chat-rewind')].map((b) => b.closest('.chat-user')!.getAttribute('data-event'))
    expect(ups).toEqual(['e3'])
    await rewindCommand(el)
    expect(words(el)).toEqual(['Which runs passed?'])
    await key(el, 'Escape')
    unmountAll()
    events = [...TALK, RESUMED]
    el = await mount(<ChatPanel ws="mini" />)
    await settle()
    expect(el.querySelectorAll('.chat-user button.chat-rewind')).toHaveLength(0)
    await rewindCommand(el)
    off()
    expect(list(el)).toBeNull()
    expect(el.querySelector('.chat-rewind-ask')).toBeNull()
    expect(toasts).toEqual([NOTHING_TO_REWIND])
    expect(posted).toEqual([])
  })

  test('a message an earlier rewind took back is not listed', async () => {
    events = [...TALK, REWOUND]
    const el = await mount(<ChatPanel ws="mini" />)
    await settle()
    await rewindCommand(el)
    expect(words(el)).toEqual(['How many runs failed?'])
  })

  test("a page that never got the rewind's reply puts its words back in the box from its line, once", async () => {
    const words = 'Was it the config change?\n\nAnd after noon?'
    events = [...TALK, { ...REWOUND, words }]
    let el = await mount(<ChatPanel ws="mini" />)
    await settle()
    expect(messages(el)).toEqual(['How many runs failed?'])
    expect(box(el).value).toBe(words)
    unmountAll()
    el = await mount(<ChatPanel ws="mini" />)  // the page loaded again: this browser put them back already
    await settle()
    expect(box(el).value).toBe('')
    unmountAll()
    localStorage.clear()
    events = [...TALK, { ...REWOUND, words }, LATER]  // the analyst wrote to main since
    el = await mount(<ChatPanel ws="mini" />)
    await settle()
    expect(box(el).value).toBe('')
  })

  test("the page that asked for the rewind gets its words once, when the line comes before the reply", async () => {
    let send = () => undefined as void
    reply = new Promise((r) => (send = r))
    const el = await mount(<ChatPanel ws="mini" />)
    await settle()
    await act(async () => el.querySelectorAll<HTMLButtonElement>('.chat-user button.chat-rewind')[1].click())
    const go = [...el.querySelectorAll<HTMLButtonElement>('.chat-rewind-ask button')].find((b) => b.textContent === 'Rewind')!
    await act(async () => go.click())
    await settle()
    await reloaded()
    expect(messages(el)).toEqual(['How many runs failed?'])  // the line is in, the reply is not
    expect(box(el).value).toBe('')
    await act(async () => send())
    await settle()
    await act(async () => new Promise((r) => setTimeout(r, 200)))
    expect(box(el).value).toBe('Was it the config change?')
  })
})
