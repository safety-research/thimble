// @vitest-environment jsdom
// Notices in a chat (src/chat/Notice.tsx, backend notices.post): a failure with an easy fix, one warning line in the
// chat it belongs to, main's or a thread's, with its button and ×. A later notice with the same key replaces the
// earlier one, so a failure that happens again is one row; × dismisses it in this browser, and a new notice of the
// same failure shows again. Each button runs its fix: Try again checks for a view proposal now, Turn off view
// proposals turns them off, Open Settings opens Settings, Retry builds the failed view again. A fix that failed says
// so in a toast and the notice stays. The stream's `notice` record reaches the bus.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { threadRetry } from '../../src/chat/ChatPanel.tsx'
import { foldRecords, withApiErrors, type Row } from '../../src/chat/model.ts'
import { dismissedNotices } from '../../src/chat/Notice.tsx'
import { PROPOSALS_OFF_LINE } from '../../src/chat/ProposalCard.tsx'
import { ThreadRows } from '../../src/chat/ThreadRows.tsx'
import { bus } from '../../src/lib/bus.ts'
import { dispatch, noticeAction } from '../../src/lib/events.ts'
import type { ChatRecord } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const SIGN_IN = "Couldn't check for a view proposal: Claude Code isn't signed in for thimble's server. Run /login, or if you changed your sign-in (for example exported ANTHROPIC_API_KEY), run `thimble server restart`."
const notice = (id: string, text: string, extra: Record<string, unknown> = {}): ChatRecord => ({ type: 'notice', ts: '2026-10-14T10:00:00Z', id, kind: 'proposer', text, ...extra }) as ChatRecord

describe('the fold', () => {
  test('a notice is a row of its own; a later one with the same key replaces it, at the later place; one with no key always shows', () => {
    const rows = foldRecords([
      notice('n1', "Couldn't check for a view proposal: the request timed out.", { key: 'proposer', action: { label: 'Try again', do: 'proposals-retry' } }),
      { type: 'user', text: 'Which agents merged most?', by: 'browser' },
      notice('d1', "Claude's safeguards switched this reply from Opus 5.5 to Opus 4.8.", { kind: 'downgrade' }),
      notice('n2', SIGN_IN, { key: 'proposer', action: { label: 'Try again', do: 'proposals-retry' } }),
      notice('x', ''),
    ])
    expect(rows.map((r) => r.kind)).toEqual(['user', 'notice', 'notice'])
    const [, down, signIn] = rows
    expect(down).toMatchObject({ kind: 'notice', id: 'd1', noticeKind: 'downgrade', text: "Claude's safeguards switched this reply from Opus 5.5 to Opus 4.8." })
    expect(down).not.toHaveProperty('action')
    expect(signIn).toMatchObject({ kind: 'notice', index: 3, id: 'n2', key: 'proposer', text: SIGN_IN, action: { label: 'Try again', do: 'proposals-retry' } })
  })

  test("an action without a label or a `do` is left out, and a notice with no id takes its record's place", () => {
    const [r] = foldRecords([{ type: 'notice', text: 'The view Posts failed to build: no data.', action: { label: '', do: 'view-retry' } } as ChatRecord])
    expect(r).toMatchObject({ kind: 'notice', id: '#0' })
    expect(r).not.toHaveProperty('action')
  })

  test("a notice after a thread's API error leaves the error its Retry", () => {
    const rows = withApiErrors(foldRecords([
      { type: 'user', text: 'Explain the merges.', by: 'browser' },
      { type: 'text', delta: 'API Error: 500 {"type":"error","error":{"type":"api_error"}}', reply: true },
      notice('d1', "Claude's safeguards switched this reply from Opus 5.5 to Opus 4.8.", { kind: 'downgrade' }),
    ])) as Row[]
    expect(threadRetry(rows, false, async () => undefined)?.index).toBe(1)
  })

  test("the stream's notice record reaches the bus, main's chat when it names none", () => {
    const got: unknown[] = []
    const off = bus.on('notice', (e) => void got.push(e))
    dispatch({ type: 'notice', id: 'n1', key: 'proposer', kind: 'proposer', text: SIGN_IN, action: { label: 'Try again', do: 'proposals-retry', extra: 1 } } as never)
    dispatch({ type: 'notice', chat: 't1', text: '' } as never)
    off()
    expect(got).toEqual([{ chat: 'main', id: 'n1', key: 'proposer', kind: 'proposer', text: SIGN_IN, action: { label: 'Try again', do: 'proposals-retry' } }])
    expect(noticeAction({ label: 'Retry', do: 'view-retry', slug: 'posts' })).toEqual({ label: 'Retry', do: 'view-retry', slug: 'posts' })
    expect(noticeAction({ do: 'view-retry' })).toBeUndefined()
  })
})

describe('the row', () => {
  let sent: string[] = []
  let fail = false
  let toasts: string[] = []
  let off: () => void = () => undefined

  beforeEach(() => {
    sent = []
    fail = false
    toasts = []
    localStorage.clear()
    off = bus.on('toast', (t) => void toasts.push(t.text))
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET'
      if (method !== 'GET') sent.push(`${method} ${url}${init.body ? ` ${String(init.body)}` : ''}`)
      if (fail && method !== 'GET') return new Response(JSON.stringify({ detail: 'the server is busy' }), { status: 409, headers: { 'content-type': 'application/json' } })
      return new Response(String(url).endsWith('/views/proposals') ? '[]' : '{}', { status: 200, headers: { 'content-type': 'application/json' } })
    })
  })
  afterEach(() => {
    off()
    unmountAll()
    vi.unstubAllGlobals()
  })

  /** A thread's rows with `records` in it, as the chat panel shows them. */
  const shown = (ws: string, records: ChatRecord[], chat = 't1') => mount(<ThreadRows rows={foldRecords(records)} edits={new Map()} ws={ws} chat={chat} />)
  const click = (el: Element | null | undefined) => act(async () => (el as HTMLButtonElement).click())

  test('one warning line in its thread: the text with its command in code, the button, and ×', async () => {
    const el = await shown('nt-look', [notice('n1', SIGN_IN, { key: 'proposer', action: { label: 'Try again', do: 'proposals-retry' } })])
    const row = el.querySelector('.chat-notice')!
    expect(row.getAttribute('role')).toBe('status')
    expect(row.querySelector('.chat-notice-text')?.textContent).toBe(SIGN_IN.replace(/`/g, ''))
    expect(row.querySelector('.chat-notice-text code')?.textContent).toBe('thimble server restart')
    expect([...row.querySelectorAll('button')].map((b) => b.textContent || b.getAttribute('aria-label'))).toEqual(['Try again', 'Dismiss'])
  })

  test('× dismisses it in this browser; a new notice of the same failure shows again', async () => {
    let el = await shown('nt-x', [notice('n1', SIGN_IN, { key: 'proposer' })])
    await click(el.querySelector('.chat-notice-x'))
    expect(el.querySelector('.chat-notice')).toBeNull()
    expect(dismissedNotices('nt-x')).toEqual(['t1:n1'])
    unmountAll()
    el = await shown('nt-x', [notice('n1', SIGN_IN, { key: 'proposer' })])
    expect(el.querySelector('.chat-notice')).toBeNull()
    unmountAll()
    el = await shown('nt-x', [notice('n1', SIGN_IN, { key: 'proposer' }), notice('n2', SIGN_IN, { key: 'proposer' })])
    expect(el.querySelectorAll('.chat-notice')).toHaveLength(1)
  })

  test('Try again checks for a view proposal now and the notice goes; Turn off view proposals turns them off; Retry builds the view again', async () => {
    const el = await shown('nt-act', [
      notice('a', "Couldn't check for a view proposal: Claude's safeguards blocked the request.", { key: 'p1', action: { label: 'Try again', do: 'proposals-retry' } }),
      notice('b', "Couldn't check for a view proposal: Claude's safeguards blocked the request.", { key: 'p2', action: { label: 'Turn off view proposals', do: 'proposals-off' } }),
      notice('c', 'The view Posts failed to build: the page did not load.', { key: 'v', action: { label: 'Retry', do: 'view-retry', slug: 'posts' } }),
    ], 'main')
    const button = (label: string) => [...el.querySelectorAll('.chat-notice-act')].find((b) => b.textContent === label)
    await click(button('Try again'))
    await settle()
    await click(button('Turn off view proposals'))
    await settle()
    await click(button('Retry'))
    await settle()
    expect(sent).toEqual(['POST /api/ws/nt-act/views/propose-now', 'PUT /api/ws/nt-act/settings {"propose_views":false}', 'POST /api/ws/nt-act/views/proposals/posts/retry'])
    expect(el.querySelectorAll('.chat-notice')).toHaveLength(0)
    expect(toasts).toEqual([PROPOSALS_OFF_LINE])
  })

  test('Open Settings opens Settings and leaves the notice; an action this page does not know shows no button', async () => {
    const opened: unknown[] = []
    const offSettings = bus.on('openSettings', () => void opened.push(1))
    const el = await shown('nt-settings', [notice('a', 'A notice.', { action: { label: 'Open Settings', do: 'settings' } }), notice('b', 'Another.', { action: { label: 'Fly', do: 'fly' } })])
    await click(el.querySelector('.chat-notice-act'))
    offSettings()
    expect(opened).toHaveLength(1)
    expect(el.querySelectorAll('.chat-notice')).toHaveLength(2)
    expect(el.querySelectorAll('.chat-notice-act')).toHaveLength(1)
  })

  test('a fix that failed says so in a toast, and the notice stays', async () => {
    fail = true
    const el = await shown('nt-fail', [notice('a', "Couldn't check for a view proposal: the request timed out.", { action: { label: 'Try again', do: 'proposals-retry' } })])
    await click(el.querySelector('.chat-notice-act'))
    await settle()
    expect(toasts).toEqual(["Try again didn't work: the server is busy"])
    expect(el.querySelector('.chat-notice')).not.toBeNull()
  })
})
