// @vitest-environment jsdom
// The permission card above the chat's composer (src/chat/PermissionCard.tsx, src/chat/permissions.ts): every request
// that waits for the analyst, from main's session and from every session thimble started, on one card, the one asked
// first first, read-only: thimble 0.9.0 answers no permission request from the browser (the terminal is always there),
// so the card has no Allow, Always allow, Deny or Dismiss, posts nothing, and says to answer in the terminal. Several
// requests at once: the card keeps the request it shows while others come and go. Every request the page makes is
// recorded by a stand-in fetch.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ThreadsContext } from '../../src/chat/Notes.tsx'
import { PermissionCard, TERMINAL_LINE } from '../../src/chat/PermissionCard.tsx'
import { autoModeRefusal, pendingRequests, type PendingAsk } from '../../src/chat/permissions.ts'
import type { ChatMeta, PermissionRequest } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const posted: [string, unknown][] = []
const ok = () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
beforeEach(() => {
  posted.length = 0
  vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') posted.push([String(url), JSON.parse(String(init.body ?? '{}'))])
    return ok()
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

/** The card's buttons, its pager's and its thread chips aside. */
const answerButtons = (el: Element) => [...el.querySelectorAll('.chat-perm button:not(.chat-perm-page):not(.chat-thread-chip)')]

const T = (m: number) => `2026-09-25T10:${String(m).padStart(2, '0')}:00Z`
const chat = (id: string, extra: Partial<ChatMeta> & { permission_mode?: string } = {}): ChatMeta => ({ id, kind: 'agent', role: 'orient', title: 'Orientation', created_at: T(0), parent: 'main', status: 'running', ...extra }) as ChatMeta
const ORIENT = chat('or1', { permission_mode: 'manual' })
const METAS = new Map([[ORIENT.id, ORIENT]])

const req = (id: string, extra: Partial<PermissionRequest> = {}): PermissionRequest => ({ id, tool: 'Bash', what: 'Count the runs', ...extra }) as PermissionRequest

describe('the requests and their words', () => {
  test("a call auto mode refused reads as the plan's step: the reason as given and where to approve it", () => {
    // live check L3: the orientation's own probing call was refused, and its thread showed Claude Code's whole tool
    // result, with no word of /permissions
    const result = 'Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Credential Exploration]. If you have other tasks that don\'t depend on this action, continue working on those.'
    expect(autoModeRefusal(result)).toBe('Auto mode refused: [Credential Exploration]. To approve it, open /permissions → Recently denied in your terminal.')
    expect(autoModeRefusal('Exit code 1\ntouch: cannot touch: Read-only file system')).toBeNull()
    expect(autoModeRefusal(undefined)).toBeNull()
  })

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

  test('no request is answered from the browser: no Allow, Always allow or Deny, nothing posted, and the line says where to answer', async () => {
    // 0.9.0 (SPEC D47): the card points to the terminal; the answer routes are the terminal's
    const el = await card()
    expect(answerButtons(el)).toEqual([])
    expect(el.querySelector('.chat-perm')?.getAttribute('data-terminal')).toBe('true')
    expect(el.querySelector('.chat-perm-answer-there')?.textContent).toBe(TERMINAL_LINE)
    expect(TERMINAL_LINE).toBe('Answer it in your Claude Code terminal.')
    await click(el.querySelectorAll('.chat-perm-page')[1])
    expect(el.querySelector('.chat-perm')?.getAttribute('data-request')).toBe('m1')
    expect(el.querySelector('.chat-perm-why')?.textContent).toBe('Answer it in your Claude Code terminal.')
    expect(el.querySelector('.chat-perm-answer-there')).toBeNull()
    await act(async () => void el.querySelector<HTMLElement>('.chat-perm')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(posted).toEqual([])
  })
})
