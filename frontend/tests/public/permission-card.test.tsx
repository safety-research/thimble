// @vitest-environment jsdom
// The permission card above the chat's composer (src/chat/PermissionCard.tsx, src/chat/permissions.ts): every request
// that waits for the analyst, from main's session and from every session thimble started, on one card, the one asked
// first first, each answer sent to the session that asked. Every request is recorded and answered by a stand-in fetch.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ThreadsContext } from '../../src/chat/Notes.tsx'
import { PermissionCard } from '../../src/chat/PermissionCard.tsx'
import { pendingRequests, type PendingAsk } from '../../src/chat/permissions.ts'
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

  test('a request the card shows only the start of says how much shows and offers no Always allow', async () => {
    const long = 'x'.repeat(50_000)
    const cut = req('c1', { command: long, what: 'Run a long script', always: 'Bash(python3 *)', cut: 61_234 })
    const el = await mount(<PermissionCard ws="mini" asks={[{ chat: 'or1', request: cut }]} metas={METAS} labels={new Map()} />)
    expect(el.querySelector('.chat-perm-cut')?.textContent).toMatch(/50,000 .*61,234/)
    expect(el.querySelector('.chat-perm-code[data-field="command"]')?.textContent).toBe(long)
    expect([...el.querySelectorAll('.chat-perm-acts button')].map((b) => b.textContent)).toEqual(['Allow', 'Deny'])
    const whole = await mount(<PermissionCard ws="mini" asks={[{ chat: 'or1', request: { ...cut, cut: undefined } }]} metas={METAS} labels={new Map()} />)
    expect(whole.querySelector('.chat-perm-cut')).toBeNull()
    expect(whole.querySelector('.chat-perm-always')).not.toBeNull()
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
})
