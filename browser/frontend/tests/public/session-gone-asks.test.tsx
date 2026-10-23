// @vitest-environment jsdom
// With no Claude Code session attached the shell is inert under SessionGone's scrim (src/shell/SessionGone.tsx), yet the
// sessions thimble started go on and ask: their permission card shows on the scrim, where it can be answered. Every
// request is answered by a stand-in fetch.
import { act } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ARM_MS } from '../../src/chat/PermissionCard.tsx'
import type { ChatMeta } from '../../src/lib/types.ts'
import { SessionGone } from '../../src/shell/SessionGone.tsx'
import { mount, settle, unmountAll } from './mount.tsx'

const T = '2026-10-01T00:17:11+00:00'
const CHATS: ChatMeta[] = [
  { id: 'main', kind: 'main', role: 'main', title: '', created_at: T, parent: null, permissions: [] },
  { id: 'd1', kind: 'agent', role: 'dev', title: 'view: Posts', view: 'posts', created_at: T, parent: 'main', status: 'running', permissions: [{ id: 'r1', tool: 'Bash', what: 'Install the view', command: 'npm i d3', since: T, wait_s: 600 }] },
  { id: 'd2', kind: 'agent', role: 'dev', title: 'view: Board', view: 'board', created_at: T, parent: 'main', status: 'running', permissions: [{ id: 'r2', tool: 'Bash', what: 'Count posts', command: 'wc -l board.jsonl', since: T, wait_s: 600 }] },
] as unknown as ChatMeta[]

const posted: [string, unknown][] = []
beforeEach(() => {
  posted.length = 0
  vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') posted.push([String(url), JSON.parse(String(init.body ?? '{}'))])
    const body = String(url).endsWith('/chats') ? CHATS : String(url).includes('/settings') ? {} : { answered: 'x' }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

test("the sessions' permission requests can be answered while no Claude Code session is connected", async () => {
  await mount(<SessionGone gone={{ ended: null, folder: '/corpus' }} ws="mini" />)
  await settle()
  const card = document.querySelector('.shell-gone .chat-perm')
  expect(card?.getAttribute('data-count')).toBe('2')
  expect(card?.closest('[inert]')).toBeNull()
  await act(async () => new Promise((r) => setTimeout(r, ARM_MS + 30)))
  await act(async () => (document.querySelector('.shell-gone .chat-perm-allow') as HTMLButtonElement).click())
  await settle()
  expect(posted).toEqual([['/api/ws/mini/chats/d1/permission', { id: 'r1', allow: true, shown: 0 }]])
  expect(document.querySelector('.shell-gone .chat-perm')?.getAttribute('data-request')).toBe('r2')
})
