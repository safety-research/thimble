// @vitest-environment jsdom
// With no Claude Code session attached the shell is inert under SessionGone's scrim (src/shell/SessionGone.tsx), yet the
// sessions thimble started may still ask: their permission card shows on the scrim, outside the inert part, read-only
// (thimble 0.9.0 answers no permission request from the browser), and says to answer in the terminal. Every request the
// page makes is recorded by a stand-in fetch.
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { TERMINAL_LINE } from '../../src/chat/PermissionCard.tsx'
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
    const body = String(url).endsWith('/chats') ? CHATS : String(url).includes('/settings') ? {} : {}
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

test("the sessions' permission requests show on the scrim, read-only, while no Claude Code session is connected", async () => {
  await mount(<SessionGone gone={{ ended: null, folder: '/corpus' }} ws="mini" />)
  await settle()
  const card = document.querySelector('.shell-gone .chat-perm')
  expect(card?.getAttribute('data-count')).toBe('2')
  expect(card?.closest('[inert]')).toBeNull()
  expect(card?.querySelector('.chat-perm-allow, .chat-perm-deny, .chat-perm-dismiss')).toBeNull()
  expect(card?.querySelector('.chat-perm-answer-there')?.textContent).toBe(TERMINAL_LINE)
  expect(posted).toEqual([])
})
