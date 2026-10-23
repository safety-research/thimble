// @vitest-environment jsdom
// The permission card above the chat's composer (src/chat/PermissionCard.tsx, src/chat/permissions.ts): every request
// that waits for the analyst, from main's session and from every session thimble started, on one card, the one asked
// first first, each answer sent to the session that asked and to no other: a click as the request shown is declined
// does not dismiss it unread, a double click answers only the request clicked, and an older answer that comes last does
// not bring an answered request back. Every request is recorded and answered by a stand-in fetch, which a test may hold
// or fail.
import { act, useState } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ThreadsContext } from '../../src/chat/Notes.tsx'
import { ARM_MS, EXPIRED_TITLE, PermissionCard } from '../../src/chat/PermissionCard.tsx'
import { pendingRequests, type PendingAsk } from '../../src/chat/permissions.ts'
import { bus } from '../../src/lib/bus.ts'
import { newest, STALE } from '../../src/lib/newest.ts'
import type { ChatMeta, PermissionRequest } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const posted: [string, unknown][] = []
// how the stand-in answers a POST: at once with 200, or as the test says
let reply: (url: string, body: { id?: string }) => Promise<Response> = async () => ok()
const ok = () => new Response('{"answered":"x"}', { status: 200, headers: { 'content-type': 'application/json' } })
beforeEach(() => {
  posted.length = 0
  reply = async () => ok()
  vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
    if (init?.method !== 'POST') return ok()
    const body = JSON.parse(String(init.body ?? '{}'))
    posted.push([String(url), body])
    return reply(String(url), body)
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

/** Wait past the time a request that just took the card's place ignores clicks. */
const armed = () => act(async () => new Promise((r) => setTimeout(r, ARM_MS + 30)))

const T = (m: number) => `2026-09-25T10:${String(m).padStart(2, '0')}:00Z`
const chat = (id: string, extra: Partial<ChatMeta> & { permission_mode?: string } = {}): ChatMeta => ({ id, kind: 'agent', role: 'orient', title: 'Orientation', created_at: T(0), parent: 'main', status: 'running', ...extra }) as ChatMeta
const ORIENT = chat('or1', { permission_mode: 'manual' })
const METAS = new Map([[ORIENT.id, ORIENT]])

const req = (id: string, extra: Partial<PermissionRequest> = {}): PermissionRequest => ({ id, tool: 'Bash', what: 'Count the runs', ...extra }) as PermissionRequest

describe('the requests and their words', () => {

  test("every session's requests while it runs, main's among them, the one asked first first", () => {
    const main = { permissions: [req('m1', { since: T(5) })] }
    const metas: ChatMeta[] = [chat('main', { kind: 'main' } as Partial<ChatMeta>), { ...ORIENT, permissions: [req('o1', { since: T(3) }), req('o2', { since: T(7) })] }, chat('w1', { role: 'writer', status: 'done', permissions: [req('w1', { since: T(1) })] })]
    expect(pendingRequests(main, metas).map((a) => `${a.chat}:${a.request.id}`)).toEqual(['or1:o1', 'main:m1', 'or1:o2'])
    expect(pendingRequests(null, [])).toEqual([])
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
  const answerNext = async (b: () => Element | null) => {
    await armed()
    await click(b())
  }

  test("each answer goes to the session that asked, and the next request takes the card's place", async () => {
    const el = await card()
    await answerNext(() => el.querySelector('.chat-perm-always'))
    expect(posted).toEqual([['/api/ws/mini/chats/or1/permission', { id: 'o1', allow: true, always: true, shown: 0 }]])
    expect(el.querySelector('.chat-perm')?.getAttribute('data-request')).toBe('m1')
    expect(el.querySelector('.chat-perm-count')).toBeNull()
    await answerNext(() => el.querySelector('.chat-perm-deny'))
    expect(posted[1]).toEqual(['/api/ws/mini/permission', { id: 'm1', allow: false }])
    expect(el.querySelector('.chat-perm')).toBeNull()
  })
})

describe('several requests at once', () => {
  const dev = (id: string, title: string) => chat(id, { role: 'dev', title: `view: ${title}`, view: title.toLowerCase(), permission_mode: 'manual' })
  const DEVS = [dev('d1', 'Posts'), dev('d2', 'Reviews'), dev('d3', 'Board')]
  const metas = new Map(DEVS.map((m) => [m.id, m]))
  const ask = (chatId: string, id: string, minute: number, extra: Partial<PermissionRequest> = {}): PendingAsk => ({ chat: chatId, request: req(id, { since: T(minute), command: `echo ${id}`, wait_s: 600, ...extra }) })
  // the card as the chat panel renders it, its requests replaced as the chat list is read again
  let setAsks: (a: PendingAsk[]) => void = () => {}
  function Live({ initial }: { initial: PendingAsk[] }) {
    const [asks, set] = useState(initial)
    setAsks = set
    return <PermissionCard ws="mini" asks={asks} metas={metas} labels={new Map()} />
  }
  const shownId = (el: HTMLElement) => el.querySelector('.chat-perm')?.getAttribute('data-request')
  const click = async (b: Element | null) => {
    await act(async () => (b as HTMLButtonElement).click())
    await settle()
  }

  test('a click as the request shown is declined does not dismiss it unread', async () => {
    const a = ask('d1', 'a', 1)
    const el = await mount(<Live initial={[a, ask('d2', 'b', 2)]} />)
    await armed()
    await act(async () => setAsks([ask('d2', 'b', 2), { ...a, request: { ...a.request, expired: T(9) } }]))
    expect(shownId(el)).toBe('a')
    expect(el.querySelector('.chat-perm-title')?.textContent).toBe(EXPIRED_TITLE)
    await click(el.querySelector('.chat-perm-dismiss'))
    expect(posted).toEqual([])
    await armed()
    await click(el.querySelector('.chat-perm-dismiss'))
    expect(posted).toEqual([['/api/ws/mini/chats/d1/permission', { id: 'a', allow: false, shown: 0 }]])
  })

  test('a double click answers only the request clicked, never the one that takes its place', async () => {
    const el = await mount(<Live initial={[ask('d1', 'a', 1), ask('d2', 'b', 2)]} />)
    await armed()
    const allow = () => el.querySelector('.chat-perm-allow') as HTMLButtonElement
    await act(async () => {
      allow().click()
      allow().click()
    })
    await settle()
    await click(allow())
    expect(posted.map(([, b]) => (b as { id: string }).id)).toEqual(['a'])
    expect(shownId(el)).toBe('b')
  })

})

describe('reads of the chat list that overlap', () => {
  test('an older answer that comes last is dropped, so an answered request does not come back', async () => {
    const fresh = newest<string[]>()
    let first: (v: string[]) => void = () => {}
    const slow = fresh(new Promise<string[]>((r) => (first = r)))
    const quick = fresh(Promise.resolve(['after the answer']))
    expect(await quick).toEqual(['after the answer'])
    first(['before the answer'])
    expect(await slow).toBe(STALE)
    expect(await fresh(Promise.resolve(['later']))).toEqual(['later'])
  })
})
