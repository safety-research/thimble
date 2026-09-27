// @vitest-environment jsdom
// The permission card above the chat's composer (src/chat/PermissionCard.tsx, src/chat/permissions.ts): every request
// that waits for the analyst, from main's session and from every session thimble started, on one card, the one asked
// first first, paged; each names the thread it comes from, says which session or agent asks, what it asks to do, its
// input and why it asks, with Allow, Always allow where Claude Code offers a rule (its scope in the tooltip), and Deny,
// each sent to the session that asked. Every request is recorded and answered by a stand-in fetch.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { askFields, askWhat } from '../../src/chat/Holds.tsx'
import { ThreadsContext } from '../../src/chat/Notes.tsx'
import { PermissionCard } from '../../src/chat/PermissionCard.tsx'
import { askedBy, askingAgent, asksTo, askThread, askWhy, classifierDown, modeChat, pendingRequests, waitWords, type PendingAsk } from '../../src/chat/permissions.ts'
import { pendingAsks, waitingChats } from '../../src/chat/waiting.ts'
import { bus } from '../../src/lib/bus.ts'
import type { ChatMeta, PermissionRequest } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const posted: [string, unknown][] = []
beforeEach(() => {
  posted.length = 0
  vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') posted.push([String(url), JSON.parse(String(init.body ?? '{}'))])
    return new Response('{"answered":"x"}', { status: 200, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

const T = (m: number) => `2026-09-25T10:${String(m).padStart(2, '0')}:00Z`
const chat = (id: string, extra: Partial<ChatMeta> = {}): ChatMeta => ({ id, kind: 'agent', role: 'orient', title: 'Orientation', created_at: T(0), parent: 'main', status: 'running', ...extra }) as ChatMeta
const ORIENT = chat('or1', { permission_mode: 'manual' })
const WRITER = chat('w1', { role: 'writer', title: 'Write report' })
const CHECK = chat('ck1', { role: 'check', title: 'Unverified' })
const CRITIQUE = chat('cr1', { role: 'step', title: 'critique', parent: 'or1' })
const METAS = new Map([ORIENT, WRITER, CHECK, CRITIQUE].map((m) => [m.id, m]))
/** The text of the tooltip a hover on `el` shows. */
async function hoverTip(el: Element): Promise<string | null | undefined> {
  vi.useFakeTimers()
  try {
    await act(async () => void el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' })))
    await act(async () => void el.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false, pointerType: 'mouse' })))
    await act(async () => void vi.advanceTimersByTime(1000))
  } finally {
    vi.useRealTimers()
  }
  return document.querySelector('.tip')?.textContent
}

const req = (id: string, extra: Partial<PermissionRequest> = {}): PermissionRequest => ({ id, tool: 'Bash', what: 'Count the runs', ...extra }) as PermissionRequest

describe('the requests and their words', () => {
  test("every session's requests while it runs, main's among them, the one asked first first", () => {
    const main = { permissions: [req('m1', { since: T(5) })] }
    const metas: ChatMeta[] = [chat('main', { kind: 'main' } as Partial<ChatMeta>), { ...ORIENT, permissions: [req('o1', { since: T(3) }), req('o2', { since: T(7) })] }, chat('w1', { role: 'writer', status: 'done', permissions: [req('w1', { since: T(1) })] })]
    expect(pendingRequests(main, metas).map((a) => `${a.chat}:${a.request.id}`)).toEqual(['or1:o1', 'main:m1', 'or1:o2'])
    expect(pendingRequests(null, [])).toEqual([])
  })

  test('who asks, in words: your session or its thread, the orientation, its critique, the writer, a check', () => {
    const labels = new Map([['t1', 'main/why-the-spike']])
    const ask = (chat: string, extra: Partial<PermissionRequest> = {}): PendingAsk => ({ chat, request: req('x', extra) })
    expect(askedBy(ask('main'), METAS, labels)).toBe('Your Claude Code session')
    expect(askedBy(ask('main', { chat: 't1' }), METAS, labels)).toBe('The thread main/why-the-spike')
    expect(askedBy(ask('or1'), METAS)).toBe('The orientation')
    expect(askedBy(ask('cr1'), METAS)).toBe("The orientation's critique")
    expect(askedBy(ask('w1'), METAS)).toBe('The report writer')
    expect(askedBy(ask('ck1'), METAS)).toBe('The Unverified check')
  })

  test('the thread a request comes from: the session that asked, or the thread of main whose agent asked', () => {
    expect(askThread({ chat: 'or1', request: req('x') })).toBe('or1')
    expect(askThread({ chat: 'cr1', request: req('x') })).toBe('cr1')
    expect(askThread({ chat: 'main', request: req('x') })).toBe('main')
    expect(askThread({ chat: 'main', request: req('x', { chat: 't1' }) })).toBe('t1')
  })

  test('what it asks to do, by the tool; the agent that asked when a subagent did', () => {
    expect(asksTo('Bash')).toBe('run a command')
    expect(asksTo('Write')).toBe('write a file')
    expect(asksTo('WebFetch')).toBe('fetch a web page')
    expect(asksTo('mcp__plugin_thimble_thimble__add_card')).toBe('use add_card')
    expect(askingAgent({ agent_id: 'a1', agent_type: 'general-purpose', agent_title: 'Count runs', agent_chat: 's1' })).toEqual({ title: 'Count runs', type: 'general-purpose', chat: 's1' })
    expect(askingAgent({ agent_id: 'a2', agent_type: 'Explore' })).toEqual({ title: '', type: 'Explore', chat: null })
    expect(askingAgent({})).toBeNull()
  })

  test("why it asks: auto mode's reason, Manual, the analyst's own mode for a writer or a check, the terminal's prompt", () => {
    const ask = (chat: string, extra: Partial<PermissionRequest> = {}): PendingAsk => ({ chat, request: req('x', extra) })
    expect(askWhy(ask('or1', { refused: 'Writes outside the working folder' }), METAS)).toBe('Auto mode did not allow it on its own: Writes outside the working folder.')
    expect(askWhy(ask('or1', { refused: 'Classifier unavailable' }), METAS)).toBe("Auto mode cannot decide in this session (Claude Code's classifier is unavailable), so it asks you about each call.")
    expect(askWhy(ask('or1'), METAS)).toBe('It runs in Manual, which asks before each call.')
    expect(askWhy(ask('cr1'), METAS)).toBe('The orientation runs in Manual, which asks before each call.')
    expect(askWhy(ask('w1'), METAS)).toMatch(/your Claude Code permission mode.*denied after a minute/)
    expect(askWhy(ask('main'), METAS)).toBe('Claude Code asks in your terminal too; the first answer counts.')
  })

  test('the input: a Bash command whole as code, never its JSON; other fields but the description; a command with no description of its own once', () => {
    const command = "cd /data/toy && python3 - <<'EOF'\nprint(1)\nEOF"
    expect(askFields({ command, what: 'Count the runs', input: JSON.stringify({ command }).slice(0, 30) })).toEqual([{ key: 'command', code: true, value: command }])
    expect(askFields({ what: '/data/toy/notes.md', input: '{"file_path": "/data/toy/notes.md", "content": "a\\nb", "description": "x"}' })).toEqual([{ key: 'content', code: false, value: 'a\nb' }])
    expect(askWhat({ command: 'wc -l a  b', what: 'wc -l a b' })).toBe('')
    expect(askWhat({ command: 'wc -l a b', what: 'Count the lines' })).toBe('Count the lines')
  })
})

describe('the card', () => {
  const asks: PendingAsk[] = [
    { chat: 'or1', request: req('o1', { command: 'grep -c refund tickets/*.jsonl', what: 'Count refunds', always: 'Bash(grep *)', agent_id: 'a1', agent_type: 'workflow-subagent', agent_title: 'Audit: batch2', agent_chat: 's1' }) },
    { chat: 'main', request: req('m1', { tool: 'Write', what: 'Save notes', input: '{"file_path": "notes.md", "content": "hi"}' }) },
  ]
  const card = () =>
    mount(
      <ThreadsContext.Provider value={{ labels: new Map([['s1', 'orient/audit: batch2']]) }}>
        <PermissionCard ws="mini" asks={asks} metas={METAS} labels={new Map()} />
      </ThreadsContext.Provider>,
    )
  const click = async (b: Element | null) => {
    await act(async () => (b as HTMLButtonElement).click())
    await settle()
  }

  test('one request at a time, paged: who asks and what, its input as code, why, then Allow, Always allow, Deny', async () => {
    const el = await card()
    const c = el.querySelector('.chat-perm')!
    expect(c.getAttribute('role')).toBe('alertdialog')
    expect(c.querySelector('.chat-perm-title')?.textContent).toBe('Permission needed')
    expect(c.querySelector('.chat-perm-count')?.textContent).toBe('1 of 2')
    expect(c.querySelector('.chat-perm-who')?.textContent).toBe("The orientation's agentAudit: batch2(workflow-subagent)asks to run a command")
    expect(c.querySelector('.chat-perm-who [data-thread="s1"]')).not.toBeNull()
    expect(c.querySelector('.chat-perm-what')?.textContent).toBe('Count refunds')
    expect(c.querySelector('.chat-perm-code[data-field="command"]')?.textContent).toBe('grep -c refund tickets/*.jsonl')
    expect(c.querySelector('.chat-perm-why')?.textContent).toBe('It runs in Manual, which asks before each call.')
    expect([...c.querySelectorAll('.chat-perm-acts button')].map((b) => b.textContent)).toEqual(['Allow', 'Always allow Bash(grep *)', 'Deny'])
    expect(await hoverTip(c.querySelector('.chat-perm-always-tip')!)).toBe("Allow, and don't ask again for Bash(grep *) for the rest of this session")
    await click(c.querySelector('[aria-label="Next request"]'))
    expect(el.querySelector('.chat-perm-count')?.textContent).toBe('2 of 2')
    expect(el.querySelector('.chat-perm-who')?.textContent).toBe('Your Claude Code sessionasks to write a file')
    expect(el.querySelector('.chat-perm-field[data-field="content"]')?.textContent).toBe('contenthi')
    expect([...el.querySelectorAll('.chat-perm-acts button')].map((b) => b.textContent)).toEqual(['Allow', 'Deny'])
  })

  test("each answer goes to the session that asked, and the next request takes the card's place", async () => {
    const el = await card()
    await click(el.querySelector('.chat-perm-always'))
    expect(posted).toEqual([['/api/ws/mini/chats/or1/permission', { id: 'o1', allow: true, always: true }]])
    expect(el.querySelector('.chat-perm')?.getAttribute('data-request')).toBe('m1')
    expect(el.querySelector('.chat-perm-count')).toBeNull()
    await click(el.querySelector('.chat-perm-deny'))
    expect(posted[1]).toEqual(['/api/ws/mini/permission', { id: 'm1', allow: false }])
    expect(el.querySelector('.chat-perm')).toBeNull()
  })

  test('the head names the thread each request comes from as its chip, which opens that thread', async () => {
    const opened: string[] = []
    const off = bus.on('openChat', (e) => void opened.push(e.chatId))
    const el = await mount(
      <ThreadsContext.Provider value={{ labels: new Map([['or1', 'orient'], ['main', 'main'], ['t1', 'main/why-the-spike']]) }}>
        <PermissionCard ws="mini" asks={[...asks, { chat: 'main', request: req('m2', { chat: 't1' }) }]} metas={METAS} labels={new Map()} />
      </ThreadsContext.Provider>,
    )
    const from = () => el.querySelector('.chat-perm-head .chat-perm-from')
    expect(from()?.textContent).toBe('fromorient')
    expect(from()?.querySelector('.chip')?.classList.contains('chip-sans')).toBe(true)
    await click(from()!.querySelector('[data-thread="or1"]'))
    expect(opened).toEqual(['or1'])
    await click(el.querySelector('[aria-label="Next request"]'))
    expect(from()?.textContent).toBe('frommain')
    await click(el.querySelector('[aria-label="Next request"]'))
    expect(from()?.textContent).toBe('frommain/why-the-spike')
    off()
  })

  test('auto mode that cannot decide in the session: the orientation offers Manual and Bypass, a writer only says why', async () => {
    const auto = new Map([...METAS, ['or1', { ...ORIENT, permission_mode: 'auto' } as ChatMeta]])
    const down = (chat: string, id: string): PendingAsk => ({ chat, request: req(id, { command: 'ls runs', refused: 'Classifier unavailable' }) })
    expect(classifierDown({ refused: 'Classifier unavailable' })).toBe(true)
    expect(classifierDown({ refused: 'Writes outside the working folder' })).toBe(false)
    expect(modeChat(down('or1', 'x'), auto)).toBe('or1')
    expect(modeChat(down('w1', 'x'), auto)).toBeNull()
    const el = await mount(<PermissionCard ws="mini" asks={[down('or1', 'o9'), down('w1', 'w9')]} metas={auto} labels={new Map()} />)
    expect(el.querySelector('.chat-perm-why')?.textContent).toMatch(/^Auto mode cannot decide in this session/)
    expect([...el.querySelectorAll('.chat-perm-switch button')].map((b) => b.textContent)).toEqual(['Switch to Manual', 'Switch to Bypass'])
    await act(async () => (el.querySelector('.chat-perm-bypass') as HTMLButtonElement).click())
    await settle()
    expect(posted).toEqual([['/api/ws/mini/chats/or1/permission-mode', { mode: 'bypass' }]])
    expect(el.querySelector('.chat-perm-switch')).toBeNull()
    await act(async () => (el.querySelector('[aria-label="Next request"]') as HTMLButtonElement).click())
    expect(el.querySelector('.chat-perm-why')?.textContent).toMatch(/^Auto mode cannot decide in this session/)
    expect(el.querySelector('.chat-perm-switch')).toBeNull()
  })
})

describe("the dev agent's requests and the web", () => {
  const VIEW = chat('d1', { role: 'dev', title: 'view: Posts', view: 'posts' } as Partial<ChatMeta>)
  const TICKET = chat('d2', { role: 'dev', title: 'ticket #3: Darker header', ticket: 't3' } as Partial<ChatMeta>)
  const DEV = new Map([...METAS, [VIEW.id, VIEW], [TICKET.id, TICKET]])
  const fetch1 = req('f1', { tool: 'WebFetch', what: 'https://vega.github.io/vega-lite/docs/bar.html', keep: 'vega.github.io', mode: 'manual', wait_s: 600, also: ['https://vega.github.io/vega-lite/docs/line.html'] })

  test('the card names the dev agent and its task, its mode and the wait before an unanswered request is denied', () => {
    expect(askedBy({ chat: 'd1', request: fetch1 }, DEV)).toBe('dev · view Posts')
    expect(askedBy({ chat: 'd2', request: fetch1 }, DEV)).toBe('dev · ticket #3')
    expect(askWhy({ chat: 'd1', request: fetch1 }, DEV)).toBe('It runs in Manual, which asks before each call. Unanswered, it is denied after 10 minutes and the work goes on without it.')
    expect(waitWords(60)).toBe('a minute')
    expect(waitWords(30)).toBe('30 seconds')
    expect(waitWords(90)).toBe('90 seconds')
  })

  test("a fetch shows its URL and the site's later fetches, and Always allow keeps the site for the workspace", async () => {
    const el = await mount(<PermissionCard ws="mini" asks={[{ chat: 'd1', request: fetch1 }]} metas={DEV} labels={new Map()} />)
    expect(el.querySelector('.chat-perm-who')?.textContent).toBe('dev · view Postsasks to fetch a web page')
    expect(el.querySelector('.chat-perm-what')?.textContent).toBe('https://vega.github.io/vega-lite/docs/bar.html')
    expect(el.querySelector('.chat-perm-also')?.textContent).toBe('and from this sitehttps://vega.github.io/vega-lite/docs/line.html')
    expect([...el.querySelectorAll('.chat-perm-acts button')].map((b) => b.textContent)).toEqual(['Allow', 'Always allow vega.github.io', 'Deny'])
    expect(await hoverTip(el.querySelector('.chat-perm-always-tip')!)).toBe("Allow, and don't ask again for vega.github.io in this workspace")
    await act(async () => (el.querySelector('.chat-perm-always') as HTMLButtonElement).click())
    await settle()
    expect(posted).toEqual([['/api/ws/mini/chats/d1/permission', { id: 'f1', allow: true, always: true }]])
    const search = req('s1', { tool: 'WebSearch', what: 'vega-lite bar', keep: 'web search' })
    const other = await mount(<PermissionCard ws="mini" asks={[{ chat: 'or1', request: search }]} metas={DEV} labels={new Map()} />)
    expect(other.querySelector('.chat-perm-always')?.textContent).toBe('Always allow web search')
    expect(await hoverTip(other.querySelector('.chat-perm-always-tip')!)).toBe("Allow, and don't ask again for web searches in this workspace")
  })

  test('a request denied unanswered stays on the card after those that wait, saying so, waits on nobody, and Dismiss takes it off', async () => {
    const expired = { ...fetch1, expired: T(9), also: [] }
    const metas: ChatMeta[] = [{ ...VIEW, permissions: [expired] }]
    expect(pendingRequests(null, metas).map((a) => a.request.id)).toEqual(['f1'])
    const later = [{ ...VIEW, permissions: [expired, req('f2', { tool: 'WebFetch', since: T(20) })] }]
    expect(pendingRequests(null, later).map((a) => a.request.id)).toEqual(['f2', 'f1'])
    expect(pendingAsks(metas[0])).toEqual([])
    expect(waitingChats(metas)).toEqual([])
    const el = await mount(<PermissionCard ws="mini" asks={pendingRequests(null, metas)} metas={DEV} labels={new Map()} />)
    expect(el.querySelector('.chat-perm')?.getAttribute('data-expired')).toBe('true')
    expect(el.querySelector('.chat-perm-title')?.textContent).toBe('Denied unanswered')
    expect(el.querySelector('.chat-perm-who')?.textContent).toBe('dev · view Postsasked to fetch a web page')
    expect(el.querySelector('.chat-perm-why')?.textContent).toBe('Nobody answered within 10 minutes, so it was denied and the session went on without it.')
    expect([...el.querySelectorAll('.chat-perm-acts button')].map((b) => b.textContent)).toEqual(['Dismiss'])
    await act(async () => (el.querySelector('.chat-perm-dismiss') as HTMLButtonElement).click())
    await settle()
    expect(posted).toEqual([['/api/ws/mini/chats/d1/permission', { id: 'f1', allow: false }]])
  })
})
