// @vitest-environment jsdom
// The chat as the analyst uses it (src/chat/ChatPanel.tsx, useChat.ts, Rows.tsx), over a stand-in server that answers
// the routes the panel calls as the server does: a question goes to main, and the answer shows with the card it made
// and its citation as the check found it, a failed citation saying so only in itself; while main works, a message
// waits for main and Stop ends the turn; a model
// picked under the composer shows there at once; a view's thread shows the fast mode of its build's row in Settings,
// which is main's until the row's own is set; a rewind takes a message back; a side thread says it is starting, then
// that it works, and ends on its answer; a fix shows in main as a side thread does.
import { act } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ChatPanel } from '../../src/chat/ChatPanel.tsx'
import { chooseMain } from '../../src/chat/mainChoice.ts'
import { bus } from '../../src/lib/bus.ts'
import { invalidateSettings } from '../../src/lib/models.ts'
import type { FixRow } from '../../src/chat/fix.ts'
import type { ChatMeta, ChatRecord } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const T = '2026-10-15T10:00:00+00:00'
const ATTACHED = { session: 's1', cwd: '/corpus', at: T, model: 'claude-opus-5-5' }
const P = 'mcp__plugin_thimble_thimble__'
const REWOUND = 'Rewound to before your message. Claude no longer sees it or anything after it; files and cards it changed stay as they are.'

/** What the stand-in server holds: each chat's meta and log. */
let chats: Record<string, { meta: ChatMeta; events: ChatRecord[] }>
/** What the page sent the server, each request that changes state. */
let posted: { url: string; body: unknown }[]
/** The fixes GET /fixes lists (backend fixes.status). */
let fixes: FixRow[]
/** The Models rows GET /settings gives, by role (settings.models). */
let models: Record<string, object>

const main = (extra: Record<string, unknown> = {}) =>
  ({ id: 'main', kind: 'main', role: 'main', title: 'main', created_at: T, parent: null, running: false, attached: ATTACHED, unread: [], ...extra }) as unknown as ChatMeta

/** What the server answers, and does, for a request. */
function answer(u: string, init?: RequestInit): unknown {
  const body = init?.body ? JSON.parse(String(init.body)) : null
  const chat = Object.keys(chats).find((id) => u.endsWith(`/chats/${id}`))
  if (chat) return chats[chat]
  if (u.endsWith('/events') && init?.method === 'POST') {
    // idle, main takes the message as its next turn, and its log holds it
    if (!chats.main.meta.running) chats.main.events.push({ type: 'user', ts: T, text: body.payload.text, by: 'browser' })
    return { id: 'e2', kind: 'main', delivered: 1 }
  }
  if (u.endsWith('/session/model')) {
    // main's meta holds the pick at once (events._choose), with the effort main runs at on it by Claude Code's
    // defaults (high on Opus 4.8, medium on Opus 5.5 and Sonnet 5.5); a model without fast mode turns fast mode off
    const held = chats.main.meta.attached!
    const fast = body.model.includes('opus') ? {} : { fast_choice: false }
    chats.main.meta = { ...chats.main.meta, attached: { ...held, model_choice: body.model, settings_effort: body.model.endsWith('4-8') ? 'high' : 'medium', ...fast } }
    return { model: body.model }
  }
  if (u.endsWith('/session/fast')) {
    // main's meta holds the choice at once, and a row that follows main's fast mode shows it (config.models_for)
    chats.main.meta = { ...chats.main.meta, attached: { ...chats.main.meta.attached!, fast_choice: body.fast } }
    for (const [role, row] of Object.entries(models)) if ((row as { fast_follows?: string }).fast_follows === 'main') models[role] = { ...row, fast: body.fast }
    return { fast: body.fast }
  }
  if (u.endsWith('/interrupt')) return { stopped: true }
  if (u.endsWith('/chats/main/rewind')) {
    // the rewind's line in main's log, and the words it gives back
    const words = (chats.main.events.find((r) => (r as { event?: string }).event === body.event) as { text: string }).text
    chats.main.events.push({ type: 'chip', kind: 'rewind', text: REWOUND, event: body.event, words } as unknown as ChatRecord)
    return { text: words, event: body.event }
  }
  if (/\/chats(\?|$)/.test(u)) return Object.values(chats).map((c) => c.meta)
  if (/\/fixes(\?|$)/.test(u)) return { problem: '', fixes }
  if (u.endsWith('/settings')) {
    // a pick is merged into what its row holds
    for (const [role, patch] of Object.entries((body?.models ?? {}) as Record<string, object>)) models[role] = { ...models[role], ...patch }
    return { models }
  }
  if (/\/(proposals|notices|views)(\?|$)/.test(u)) return []
  return {}
}

beforeEach(() => {
  chats = { main: { meta: main(), events: [] } }
  posted = []
  fixes = []
  models = {}
  invalidateSettings('mini')
  localStorage.clear()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  Element.prototype.scrollIntoView = () => undefined // jsdom lays nothing out
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const u = String(url)
    if (init?.method && init.method !== 'GET' && !u.includes('/telemetry')) posted.push({ url: u, body: init.body ? JSON.parse(String(init.body)) : null })
    return new Response(JSON.stringify(answer(u, init)), { status: 200, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
  delete (Element.prototype as Partial<Element>).scrollIntoView
})

/** A chat read again, as on the stream's `chat` record. */
async function reread(chat = 'main') {
  await act(async () => bus.emit('chat', { chat }))
  await act(async () => new Promise((r) => setTimeout(r, 200)))
}
const box = (el: HTMLElement) => el.querySelector<HTMLTextAreaElement>('.chat-composer textarea')!
async function type(el: HTMLElement, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box(el), text)
    box(el).dispatchEvent(new Event('input', { bubbles: true }))
  })
}
/** The square buttons at the composer's end, by name: Send, Stop main, Stop the thread. */
const squares = (el: HTMLElement) => [...el.querySelectorAll<HTMLButtonElement>('.chat-composer button.composer-send')]
const square = (el: HTMLElement, name: string) => squares(el).find((b) => b.getAttribute('aria-label') === name)!
const click = (b: HTMLElement) => act(async () => b.click())
/** The analyst's messages main's log holds, as the chat draws them. */
const messages = (el: HTMLElement) => [...el.querySelectorAll('.chat-user:not(.chat-pending) .chat-message')].map((m) => m.textContent)
/** The line behind the composer that says the chat works. */
const strip = (el: HTMLElement) => el.querySelector('.chat-strip-title')?.textContent ?? null

test('a question goes to main, and the answer shows with the card it made and its citation as the check found it', async () => {
  const el = await mount(<ChatPanel ws="mini" />)
  await settle()
  await type(el, 'How many runs failed?')
  await click(square(el, 'Send'))
  await settle()
  expect(posted).toEqual([{ url: '/api/ws/mini/events', body: { kind: 'main', payload: { text: 'How many runs failed?' } } }])
  expect(messages(el)).toEqual(['How many runs failed?'])

  chats.main.events.push(
    ...([
      { type: 'tool_use', id: 't1', name: `${P}add_card`, input: { kind: 'table', question: 'Runs by outcome', code: 'df' } },
      { type: 'tool_result', id: 't1', summary: 'card:abcd1234\n2 rows', cell_id: 'abcd1234' },
      { type: 'text', delta: '[12 of the 40](#) runs failed.' },
      { type: 'done', turn: 'aaaa1111' },
      { type: 'marks', turn: 'aaaa1111', items: [{ n: 1, piece: 0, k: 0, words: '12 of the 40', sentence: '', status: 'verified', shown: '12 of the 40' }] },
    ] as unknown as ChatRecord[]),
  )
  await reread()
  expect(el.querySelector('.refchip[data-ref="card:abcd1234"]')).not.toBeNull()
  const mark = el.querySelector('.chat-text .mark')
  expect([mark?.getAttribute('data-mark-look'), mark?.textContent]).toEqual(['verified', '12 of the 40'])
})

test('an answer whose citations failed says so in each citation alone, with no line under the answer', async () => {
  chats.main.events.push(
    ...([
      { type: 'user', ts: T, text: 'How many runs failed?', by: 'browser' },
      { type: 'text', delta: '[12 of the 40](#) runs failed, [3](#) of them twice.' },
      { type: 'done', turn: 'aaaa1111' },
      {
        type: 'marks',
        turn: 'aaaa1111',
        items: [
          { n: 1, piece: 0, k: 0, words: '12 of the 40', sentence: '', status: 'failed', failedBy: 'evidence', shown: '12 of the 40', reason: 'No line shows 12.' },
          { n: 2, piece: 0, k: 1, words: '3', sentence: '', status: 'failed', failedBy: 'check', shown: '3', reason: 'Two runs failed twice.' },
        ],
      },
    ] as unknown as ChatRecord[]),
  )
  const el = await mount(<ChatPanel ws="mini" />)
  await settle()
  expect([...el.querySelectorAll('.chat-text .mark')].map((m) => [m.getAttribute('data-mark-look'), m.textContent])).toEqual([
    ['failed', '12 of the 40×'],
    ['failed', '3×'],
  ])
  const answer = el.querySelector('.chat-text')!.closest('.chat-assistant')!
  expect(answer.textContent).toBe('12 of the 40× runs failed, 3× of them twice.')
})

test('while main works, a message sent waits until main reads it, and Stop main ends the turn', async () => {
  chats.main = { meta: main({ running: true }), events: [{ type: 'user', text: 'Count the runs per agent.', by: 'browser' }, { type: 'tool_use', id: 't1', name: `${P}list_cards`, input: { group: 'all' } }] }
  const el = await mount(<ChatPanel ws="mini" />)
  await settle()
  expect(strip(el)).toBe('Working')
  expect(squares(el).map((b) => b.getAttribute('aria-label'))).toEqual(['Stop main'])
  // the server keeps the message for main's next step
  await type(el, 'And how many files are there?')
  chats.main.meta = main({ running: true, unread: [{ event: 'e2', text: 'And how many files are there?' }] })
  await click(square(el, 'Send'))
  await settle()
  expect(posted.map((p) => p.url)).toEqual(['/api/ws/mini/events'])
  const tail = el.querySelector('.chat-flow')!.lastElementChild!
  expect(tail.matches('.chat-pending')).toBe(true)
  expect(tail.textContent).toContain('And how many files are there?')
  expect(messages(el)).toEqual(['Count the runs per agent.'])

  await click(square(el, 'Stop main'))
  await settle()
  expect(posted.map((p) => p.url)).toEqual(['/api/ws/mini/events', '/api/ws/mini/chats/main/interrupt'])
  // the turn ended, and main read the message as its next: the log holds it, and the square is Send again
  chats.main = {
    meta: main(),
    events: [...chats.main.events, { type: 'done' }, { type: 'user', text: 'And how many files are there?', by: 'browser', event: 'e2' }, { type: 'text', delta: 'There are 12 files.' }, { type: 'done' }] as ChatRecord[],
  }
  await reread()
  expect(strip(el)).toBeNull()
  expect(el.querySelector('.chat-pending')).toBeNull()
  expect(messages(el)).toEqual(['Count the runs per agent.', 'And how many files are there?'])
  expect(squares(el).map((b) => b.getAttribute('aria-label'))).toEqual(['Send'])
})

test('a model picked in the line under the composer shows there at once, with the effort and fast mode main runs it at', async () => {
  // main's replies came from Opus 5.5 at medium, with fast mode on
  chats.main.meta = main({ attached: { ...ATTACHED, effort: 'medium', settings_effort: 'medium', fast_choice: true } })
  const el = await mount(<ChatPanel ws="mini" />)
  await settle()
  const line = () => el.querySelector<HTMLElement>('.chat-composer .model-line')!
  const bolt = () => line().querySelector<HTMLElement>('.fast-bolt')!
  /** The line's model and effort, its menu's checked model, and its bolt: pressed, locked. */
  const shown = async () => {
    await click(line().querySelector<HTMLElement>('[aria-label="Model for main and its threads"]')!)
    const checked = document.querySelector('.menu-item.checked')?.getAttribute('data-item')
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    return [line().querySelector('.model-line-part')?.textContent, line().querySelector('.model-line-effort')?.textContent, checked, bolt().getAttribute('aria-pressed'), bolt().getAttribute('aria-disabled')]
  }
  const pick = async (model: string) => {
    await click(line().querySelector<HTMLElement>('[aria-label="Model for main and its threads"]')!)
    await click(document.querySelector<HTMLElement>(`.menu-item[data-item="model:${model}"]`)!)
    await settle()
    await settle()
  }
  expect(await shown()).toEqual(['Opus 5.5', 'medium', 'model:claude-opus-5-5', 'true', null])
  await pick('claude-sonnet-5-5')
  expect(posted).toEqual([{ url: '/api/ws/mini/session/model', body: { model: 'claude-sonnet-5-5' } }])
  // before main replies on it: the line and its menu name Sonnet 5.5, whose bolt is off and locked, since it has no
  // fast mode
  expect(await shown()).toEqual(['Sonnet 5.5', 'medium', 'model:claude-sonnet-5-5', 'false', 'true'])
  await pick('claude-opus-4-8')
  // Opus 4.8 at the effort main runs it at, with fast mode off until the bolt turns it on
  expect(await shown()).toEqual(['Opus 4.8', 'high', 'model:claude-opus-4-8', 'false', null])
})

test("a view's thread shows the fast mode of its build's row in Settings under the composer, and the bolt switches it as the row's does", async () => {
  // the row "View builds": Opus 5.5 at high effort, with its own fast mode on
  models = { dev: { model: 'claude-opus-5-5', effort: 'high', fast: true } }
  chats.dv1 = { meta: { id: 'dv1', kind: 'agent', role: 'dev', title: 'view: Decisions', created_at: T, parent: 'main', status: 'done', view: 'decisions', asked: true } as unknown as ChatMeta, events: [] }
  localStorage.setItem('thimble:mini:thread-current', JSON.stringify('dv1'))
  const el = await mount(<ChatPanel ws="mini" />)
  await settle()
  await settle()
  const line = () => el.querySelector<HTMLElement>('.chat-composer .role-line[data-role="dev"] .model-line')!
  const bolt = () => line().querySelector<HTMLElement>('.fast-bolt')
  /** The line's model and effort, and its bolt: its name, pressed, locked. */
  const shown = () => [
    line().querySelector('.model-line-part')?.textContent,
    line().querySelector('.model-line-effort')?.textContent,
    ...['aria-label', 'aria-pressed', 'aria-disabled'].map((a) => bolt()?.getAttribute(a)),
  ]
  expect(shown()).toEqual(['Opus 5.5', 'high', 'Fast mode for the view build', 'true', null])
  // the request the row's switch in Settings sends (settings.test.tsx)
  await click(bolt()!)
  await settle()
  await settle()
  expect(posted).toEqual([{ url: '/api/ws/mini/settings', body: { models: { dev: { fast: false } } } }])
  expect(shown().slice(3)).toEqual(['false', null])
  // a model without fast mode has no bolt, as its row in Settings has none
  await click(line().querySelector<HTMLElement>('[aria-label="Model for the view build"]')!)
  await click(document.querySelector<HTMLElement>('.menu-item[data-item="model:claude-sonnet-5-5"]')!)
  await settle()
  await settle()
  expect([line().querySelector('.model-line-part')?.textContent, bolt()]).toEqual(['Sonnet 5.5', null])
})

test("a view's thread shows main's fast mode while its row sets none, as soon as main's bolt switches it", async () => {
  // the row "View builds" with no fast mode of its own: it shows main's, which is off
  models = { dev: { model: 'claude-opus-5-5', effort: 'high', fast: false, fast_follows: 'main' } }
  chats.dv1 = { meta: { id: 'dv1', kind: 'agent', role: 'dev', title: 'view: Decisions', created_at: T, parent: 'main', status: 'done', view: 'decisions', asked: true } as unknown as ChatMeta, events: [] }
  localStorage.setItem('thimble:mini:thread-current', JSON.stringify('dv1'))
  const el = await mount(<ChatPanel ws="mini" />)
  await settle()
  await settle()
  const pressed = () => el.querySelector('.chat-composer .role-line[data-role="dev"] .fast-bolt')?.getAttribute('aria-pressed')
  expect(pressed()).toBe('false')
  // main's bolt, in the line under main's chat or in Settings' row for main
  await act(async () => void (await chooseMain('mini', { fast: true })))
  await settle()
  await settle()
  expect(posted).toEqual([{ url: '/api/ws/mini/session/fast', body: { fast: true } }])
  expect(pressed()).toBe('true')
})

test('Rewind asks under the message first, then takes it and what came after back, its words in the box again', async () => {
  chats.main.events = [
    { type: 'user', ts: T, text: 'How many runs failed?', by: 'browser', event: 'e1' },
    { type: 'text', delta: 'Twelve of the forty.' },
    { type: 'done' },
    { type: 'user', ts: T, text: 'Was it the config change?', by: 'browser', event: 'e2' },
    { type: 'text', delta: 'Yes, every failure came after it.' },
    { type: 'done' },
  ] as ChatRecord[]
  const el = await mount(<ChatPanel ws="mini" />)
  await settle()
  await click(el.querySelectorAll<HTMLButtonElement>('.chat-user button.chat-rewind')[1])
  const ask = el.querySelector('.chat-user[data-event="e2"] .chat-rewind-ask')!
  expect(posted).toEqual([])
  await click([...ask.querySelectorAll('button')].find((b) => b.textContent === 'Rewind')!)
  await settle()
  expect(posted).toEqual([{ url: '/api/ws/mini/chats/main/rewind', body: { event: 'e2' } }])
  await reread()
  expect(messages(el)).toEqual(['How many runs failed?'])
  expect(el.querySelector('[data-chip="rewind"]')?.textContent).toBe(REWOUND)
  expect(box(el).value).toBe('Was it the config change?')
})

test('a side thread says it is starting while its question waits for its fork, then that it works, and ends on its answer', async () => {
  const question: ChatRecord = { type: 'user', ts: T, text: 'Why did agent-05 push three times?', by: 'browser' }
  const thread = (extra: Record<string, unknown>) =>
    ({ id: 'th1', kind: 'thread', role: 'thread', title: 'push-retries', created_at: T, parent: 'main', anchor: 'agents/agent-05.jsonl#L12', anchor_text: 'git push', running: true, ...extra }) as unknown as ChatMeta
  // main's short turn takes the question to the thread's fork; the thread names main nowhere
  chats.main = { meta: main({ running: true }), events: [{ type: 'done', ts: '2026-10-15T09:59:00+00:00' }] as ChatRecord[] }
  chats.th1 = { meta: thread({}), events: [question] }
  localStorage.setItem('thimble:mini:thread-current', JSON.stringify('th1'))
  const el = await mount(<ChatPanel ws="mini" />)
  await settle()
  await settle()
  expect(el.querySelector('.chat')?.getAttribute('data-thread-kind')).toBe('thread')
  expect(strip(el)).toBe('Starting this thread…')

  chats.main.meta = main()
  chats.th1.meta = thread({ fork: { agent_id: 'afork1' } })
  await reread('th1')
  expect(strip(el)).toBe('Working')

  chats.th1 = {
    meta: thread({ fork: { agent_id: 'afork1' }, running: false }),
    events: [question, { type: 'text', delta: 'It retried after two timeouts of the remote.', reply: true, by: 'terminal' }, { type: 'done', result: null }] as ChatRecord[],
  }
  await reread('th1')
  expect(strip(el)).toBeNull()
  expect(el.querySelector('.chat-flow')?.textContent).toContain('It retried after two timeouts of the remote.')
  // nothing under the answer sends it to main
  expect(el.querySelector('.chat-hand-back')).toBeNull()
  expect(posted).toEqual([])
})

test('a fix shows in main as a side thread does: one line per fixer with its thread, which spins until the fix ends', async () => {
  const name = "fixing make the composer's placeholder say Ask…"
  const fixer = (extra: Record<string, unknown>) =>
    ({ id: 'f1', kind: 'agent', role: 'fixer', title: name, created_at: T, parent: 'main', status: 'running', running: false, fix: 1, ...extra }) as unknown as ChatMeta
  const started = (title: string) => ({ type: 'agent', ts: T, chat: 'f1', role: 'fixer', title }) as ChatRecord
  chats.main.events = [
    { type: 'user', ts: T, text: "/thimble-fix make the composer's placeholder say Ask thimble…", by: 'browser' },
    started(name),
    { type: 'text', delta: 'I started a fix that changes the placeholder.' },
    { type: 'done' },
  ] as ChatRecord[]
  chats.f1 = { meta: fixer({}), events: [] }
  const working: FixRow = { id: 1, title: '', state: 'working', phase: 'fixing', kind: null, said: null, words: "make the composer's placeholder say Ask thimble…", tests: null, error: null, at: 1 }
  fixes = [working]
  const el = await mount(<ChatPanel ws="mini" />)
  await settle()
  await settle()
  /** The fixer's lines in main: the words, the thread chip's name, and whether the line spins. */
  const lines = () => [...el.querySelectorAll('.chat-agent-note[data-chat="f1"]')].map((l) => [l.querySelector('.chat-note-text')?.textContent, l.querySelector('.chat-thread-chip')?.textContent, !!l.querySelector('.spinner')])
  /** The chats the folded thread tree counts as running. */
  const running = () => el.querySelector('.tt-active')?.getAttribute('data-active') ?? null
  /** The page read again on the stream's `chat` record: the chat's log, and the list of chats. */
  const reread = async (chat: string) => {
    await act(async () => bus.emit('chat', { chat }))
    await act(async () => new Promise((r) => setTimeout(r, 400)))
  }
  expect(lines()).toEqual([['Fix started in', `main/${name}`, true]])
  expect(running()).toBe('1')
  // nothing else stands for it: no subagent's card, and no row above the composer
  expect(el.querySelector('.chat-agent')).toBeNull()
  expect(el.querySelector('.chat-foot .chat-fix')).toBeNull()

  // the fixer ended and the kernel checks its change: its chat still runs
  chats.f1.meta = fixer({ status: 'done', running: true })
  fixes = [{ ...working, phase: 'testing' }]
  await reread('f1')
  expect(lines()).toEqual([['Fix started in', `main/${name}`, true]])
  expect(running()).toBe('1')
  expect(el.querySelector('.chat-foot .chat-fix')).toBeNull()

  // a round of the fix, by a new fixer in the same thread: its own line spins, and the first one stops
  const round = 'changing Main chat box now says "Ask thimble…"'
  chats.f1.meta = fixer({ title: round })
  chats.main.events.push({ type: 'user', ts: T, text: '/thimble-fix the box still says Reply in main', by: 'browser' } as ChatRecord, started(round))
  await reread('main')
  expect(lines()).toEqual([
    ['Fix started in', `main/${round}`, false],
    ['Fix started in', `main/${round}`, true],
  ])

  // the fix ended: no line spins, and the tree counts nothing running
  chats.f1.meta = fixer({ title: round, status: 'done' })
  fixes = []
  await reread('f1')
  expect(lines().map((l) => l[2])).toEqual([false, false])
  expect(running()).toBeNull()
})
