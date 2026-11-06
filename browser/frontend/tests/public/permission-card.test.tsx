// @vitest-environment jsdom
// The permission card above the chat's composer (src/chat/PermissionCard.tsx): every request that waits for the
// analyst, from main's session and from every session thimble started, on one card, the one asked first first, each
// answer sent to the session that asked and to no other. Every request is recorded and answered by a stand-in fetch.
import { act } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ThreadsContext } from '../../src/chat/Notes.tsx'
import { ARM_MS, PermissionCard } from '../../src/chat/PermissionCard.tsx'
import type { PendingAsk } from '../../src/chat/permissions.ts'
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

const CHECK = { id: 'ck1', kind: 'agent', role: 'check', title: 'Unverified', created_at: '2026-09-25T10:00:00Z', parent: 'main', status: 'running', permission_mode: 'manual' } as unknown as ChatMeta
const req = (id: string, extra: Partial<PermissionRequest> = {}): PermissionRequest => ({ id, tool: 'Bash', what: 'Count the runs', ...extra }) as PermissionRequest

test("each answer goes to the session that asked, and the next request takes the card's place", async () => {
  const asks: PendingAsk[] = [
    { chat: 'ck1', request: req('o1', { command: 'grep -c refund tickets/*.jsonl', what: 'Count refunds', always: 'Bash(grep *)', agent_id: 'a1', agent_type: 'workflow-subagent', agent_title: 'Audit: batch2', agent_chat: 's1' }) },
    { chat: 'main', request: req('m1', { tool: 'Write', what: 'Save notes', input: '{"file_path": "notes.md", "content": "hi"}' }) },
  ]
  const el = await mount(
    <ThreadsContext.Provider value={{ labels: new Map([['s1', 'unverified/audit: batch2']]) }}>
      <PermissionCard ws="mini" asks={asks} metas={new Map([[CHECK.id, CHECK]])} labels={new Map()} />
    </ThreadsContext.Provider>,
  )
  /** A button pressed once the request shown takes clicks (a request that just took the card's place ignores them). */
  const answer = async (sel: string) => {
    await act(async () => new Promise((r) => setTimeout(r, ARM_MS + 30)))
    await act(async () => el.querySelector<HTMLButtonElement>(sel)!.click())
    await settle()
  }
  await answer('.chat-perm-always')
  expect(posted).toEqual([['/api/ws/mini/chats/ck1/permission', { id: 'o1', allow: true, always: true, shown: 0 }]])
  expect(el.querySelector('.chat-perm')?.getAttribute('data-request')).toBe('m1')
  await answer('.chat-perm-deny')
  expect(posted[1]).toEqual(['/api/ws/mini/permission', { id: 'm1', allow: false }])
  expect(el.querySelector('.chat-perm')).toBeNull()
})
