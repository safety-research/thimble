// @vitest-environment jsdom
// Notices (src/chat/Notice.tsx, src/lib/notices.ts, backend notices.py): a failure of main or of any of thimble's
// agents, with an easy fix. Every open notice shows in the foreground, in the strip above the composer of whichever
// chat is open, read from GET /notices when the page opens and kept up to date by the stream: one with the key of a
// notice shown replaces it in place, a fix that worked clears it, × dismisses it on the server. Each names its agent,
// says what failed, offers its fix as buttons and Open for the agent's thread. In the agent's own chat it is also a row,
// which stays as a quiet line once the notice is closed.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { threadRetry } from '../../src/chat/ChatPanel.tsx'
import { foldRecords, withApiErrors, type NoticeRow as NoticeRowT, type Row } from '../../src/chat/model.ts'
import { NoticeStrip } from '../../src/chat/Notice.tsx'
import { Rows } from '../../src/chat/Rows.tsx'
import { bus } from '../../src/lib/bus.ts'
import { dispatch } from '../../src/lib/events.ts'
import { CODE_GONE_TEXT, noticeActions, parseNotice, setBrowserId, showCodeGone, withNotice, withoutNotice } from '../../src/lib/notices.ts'
import type { ChatRecord, Notice } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const SIGN_IN = "Couldn't check for a view proposal: Claude Code isn't signed in for thimble's server. In your terminal: run /login (or `claude auth login` in a shell), or if you changed your sign-in (for example exported ANTHROPIC_API_KEY), run `thimble server restart`. Then Try again."
const BLOCKED = "Couldn't check for a view proposal: Claude's safeguards blocked the request."
const DOWNGRADE = "Claude's safeguards switched this reply from Opus 5.5 to Opus 4.8."
const BUILD = 'The view Agent Network failed to build: the page did not load.'
const MANUAL = 'Manual mode: Claude Code asks before most commands. In your terminal, press shift+tab for auto mode, or start with `thimble --permission-mode auto`.'
const TRY = { label: 'Retry', do: 'view-retry', slug: 'agent-network' }
const OFF = { label: 'Open Settings', do: 'settings' }
const record = (id: string, text: string, extra: Record<string, unknown> = {}): ChatRecord => ({ type: 'notice', ts: '2026-10-14T10:00:00Z', id, kind: 'proposals', text, ...extra }) as ChatRecord

describe('a notice as the server sends it', () => {
  test('its fields, one action or several, those without a label or a `do` left out; none without text', () => {
    expect(parseNotice({ id: 'n1', key: 'proposals', kind: 'proposals', text: BLOCKED, agent: 'View proposals', action: [TRY, OFF, { label: '', do: 'x' }], foreground: true })).toEqual({ id: 'n1', key: 'proposals', kind: 'proposals', text: BLOCKED, agent: 'View proposals', action: [TRY, OFF] })
    expect(parseNotice({ id: 'n2', text: BUILD, chat: 'dev-1', action: { label: 'Retry', do: 'view-retry', slug: 'agent-network' } })).toEqual({ id: 'n2', text: BUILD, chat: 'dev-1', action: { label: 'Retry', do: 'view-retry', slug: 'agent-network' } })
    expect(parseNotice({ id: 'n3', text: ' ' })).toBeNull()
    expect(noticeActions(null)).toEqual([])
  })

  test('one with the key of a notice shown replaces it in place; any other goes at the end; an end takes one by id, else by key', () => {
    const a: Notice = { id: 'a', key: 'proposals', text: BLOCKED }
    const b: Notice = { id: 'b', key: 'build:agent-network', text: BUILD }
    const a2: Notice = { id: 'a2', key: 'proposals', text: SIGN_IN }
    expect(withNotice([a, b], a2).map((n) => n.id)).toEqual(['a2', 'b'])
    expect(withNotice([a], b).map((n) => n.id)).toEqual(['a', 'b'])
    expect(withoutNotice([a, b], { id: 'b' }).map((n) => n.id)).toEqual(['a'])
    expect(withoutNotice([a, b], { id: 'gone', key: 'proposals' }).map((n) => n.id)).toEqual(['b'])
  })

  test("the stream's notice record reaches the bus with its chat; a cleared or dismissed one as its end; a replayed one marked", () => {
    const got: unknown[] = []
    const off = bus.on('notice', (e) => void got.push(e))
    dispatch({ type: 'notice', id: 'n1', key: 'proposals', kind: 'proposals', text: SIGN_IN, agent: 'View proposals', chat: null, action: TRY, foreground: true } as never)
    dispatch({ type: 'notice', id: 'n1', key: 'proposals', cleared: true } as never)
    dispatch({ type: 'notice', chat: 'main', dismissed: true, key: 'safeguards-fallback' } as never)
    dispatch({ type: 'notice', id: 'n2', chat: 'orient-1', text: DOWNGRADE } as never, true)
    dispatch({ type: 'notice', chat: 't1', text: '' } as never)
    off()
    expect(got).toEqual([
      { chat: null, notice: { id: 'n1', key: 'proposals', kind: 'proposals', text: SIGN_IN, agent: 'View proposals', action: TRY }, gone: null, foreground: true, replay: false },
      { chat: null, notice: null, gone: { id: 'n1', key: 'proposals' }, foreground: false, replay: false },
      { chat: 'main', notice: null, gone: { key: 'safeguards-fallback' }, foreground: false, replay: false },
      { chat: 'orient-1', notice: { id: 'n2', chat: 'orient-1', text: DOWNGRADE }, gone: null, foreground: true, replay: true },
    ])
  })
})

describe('the row in a chat', () => {
  test('a notice is a row; one under the key of a row still open replaces it in place; its end closes the row, and a later failure is a row of its own', () => {
    const rows = foldRecords([
      record('n1', "Couldn't check for a view proposal: the request timed out.", { key: 'proposals', action: TRY }),
      { type: 'user', text: 'Which agents merged most?', by: 'browser' },
      record('d1', DOWNGRADE, { kind: 'safeguards', agent: 'Orientation' }),
      record('n2', SIGN_IN, { key: 'proposals', action: TRY }),
      record('x', ''),
      { type: 'notice', dismissed: true, key: 'proposals' } as ChatRecord,
      record('n3', BLOCKED, { key: 'proposals' }),
    ])
    expect(rows.map((r) => r.kind)).toEqual(['notice', 'user', 'notice', 'notice'])
    const [first, , down, again] = rows as NoticeRowT[]
    expect(first).toMatchObject({ index: 0, id: 'n2', key: 'proposals', text: SIGN_IN, closed: true })
    expect(down).toMatchObject({ id: 'd1', noticeKind: 'safeguards', agent: 'Orientation', text: DOWNGRADE, closed: false })
    expect(again).toMatchObject({ index: 6, id: 'n3', text: BLOCKED, closed: false })
  })

  test("a notice after a thread's API error leaves the error its Retry", () => {
    const rows = withApiErrors(foldRecords([
      { type: 'user', text: 'Explain the merges.', by: 'browser' },
      { type: 'text', delta: 'API Error: 500 {"type":"error","error":{"type":"api_error"}}', reply: true },
      record('d1', DOWNGRADE, { kind: 'safeguards' }),
    ])) as Row[]
    expect(threadRetry(rows, false, async () => undefined)?.index).toBe(1)
  })
})

describe('the strip above the composer, and the rows', () => {
  let open: unknown[] = []
  let sent: string[] = []
  let fail = false
  let toasts: string[] = []
  let off: () => void = () => undefined

  beforeEach(() => {
    open = []
    sent = []
    fail = false
    toasts = []
    off = bus.on('toast', (t) => void toasts.push(t.text))
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET'
      const u = String(url)
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })
      if (method !== 'GET') sent.push(`${method} ${u}${init.body ? ` ${String(init.body)}` : ''}`)
      if (fail && method !== 'GET' && !u.endsWith('/dismiss')) return json({ detail: 'the server is busy' }, 409)
      if (u.endsWith('/notices')) return json(open)
      if (u.endsWith('/views/proposals')) return json([])
      if (u.endsWith('/dismiss')) return json({ dismissed: true })
      return json({})
    })
  })
  afterEach(() => {
    off()
    unmountAll()
    vi.unstubAllGlobals()
  })

  const labels = new Map([['orient-1', 'orient'], ['dev-1', 'dev · view Agent Network']])
  /** The strip of workspace `ws` (one per test: the open notices are kept per workspace) in the chat `current`. */
  async function strip(ws: string, current = 'main', onOpen: (chat: string) => void = () => undefined) {
    const el = await mount(<NoticeStrip ws={ws} current={current} labels={labels} onOpen={onOpen} />)
    await settle()
    return el
  }
  const live = (ev: Record<string, unknown>) => act(async () => dispatch({ type: 'notice', ...ev } as never))
  const click = (el: Element | null | undefined) => act(async () => (el as HTMLButtonElement).click())
  /** Each notice's words, without its Open link. */
  const lines = (el: HTMLElement) => [...el.querySelectorAll('.chat-notice')].map((n) => n.querySelector('.chat-notice-text')?.textContent?.replace(/ Open$/, ''))

  test('the open notices are read when the page opens: the agent in bold, the failure, the fixes, Open and ×', async () => {
    open = [{ id: 'n1', key: 'proposals', kind: 'proposals', agent: 'View proposals', text: BLOCKED, action: [TRY, OFF], foreground: true }, { id: 'n2', key: 'build:agent-network', kind: 'view', agent: 'View build: Agent Network', chat: 'dev-1', text: BUILD, action: { label: 'Retry', do: 'view-retry', slug: 'agent-network' } }]
    const el = await strip('nt-read')
    expect(el.querySelector('.chat-notices')?.getAttribute('role')).toBe('region')
    const [proposals, build] = el.querySelectorAll('.chat-notice')
    expect(proposals.querySelector('.chat-notice-agent')?.textContent).toBe('View proposals')
    expect(proposals.querySelector('.chat-notice-text')?.textContent).toBe(`View proposals ${BLOCKED}`)
    expect([...proposals.querySelectorAll('button')].map((b) => b.textContent || b.getAttribute('aria-label'))).toEqual(['Retry', 'Open Settings', 'Dismiss'])
    expect(build.querySelector('.chat-notice-agent')?.textContent).toBe('View build: Agent Network')
    // Open is a link after the words, the fix a button under them
    expect([...build.querySelectorAll('button')].map((b) => b.textContent || b.getAttribute('aria-label'))).toEqual(['Open', 'Retry', 'Dismiss'])
    expect(build.querySelector('.chat-notice-text .chat-notice-open')).not.toBeNull()
  })

  test('a command in the text is code; with no agent named, the thread it happened in names it', async () => {
    open = [{ id: 'n1', text: SIGN_IN, action: TRY }, { id: 'n2', chat: 'orient-1', text: DOWNGRADE }]
    const el = await strip('nt-code')
    expect([...el.querySelectorAll('.chat-notice-text code')].map((c) => c.textContent)).toEqual(['claude auth login', 'thimble server restart'])
    expect(el.querySelectorAll('.chat-notice-agent')[0]?.textContent).toBe('orient')
  })

  test("the stream's notices come in live: one under a key shown replaces it in place, a cleared one goes, a replayed one is left to the read", async () => {
    open = [{ id: 'n1', key: 'proposals', text: BLOCKED, action: TRY }]
    const el = await strip('nt-live')
    await live({ id: 'd1', key: 'safeguards-fallback', chat: 'orient-1', agent: 'Orientation', text: DOWNGRADE, foreground: true })
    expect(lines(el)).toEqual([BLOCKED, `Orientation ${DOWNGRADE}`])
    await live({ id: 'n2', key: 'proposals', text: SIGN_IN, action: TRY, foreground: true })
    expect(lines(el)).toEqual([SIGN_IN.replace(/`/g, ''), `Orientation ${DOWNGRADE}`])
    await live({ id: 'n2', key: 'proposals', cleared: true })
    expect(lines(el)).toEqual([`Orientation ${DOWNGRADE}`])
    await act(async () => dispatch({ type: 'notice', id: 'old', text: BUILD } as never, true))
    expect(lines(el)).toEqual([`Orientation ${DOWNGRADE}`])
  })

  test('a notice the stream sends while the read is under way is kept over its answer', async () => {
    open = [{ id: 'n1', text: BLOCKED }]
    const el = await mount(<NoticeStrip ws="nt-race" current="main" onOpen={() => undefined} />)
    await live({ id: 'd1', text: DOWNGRADE })
    await settle()
    expect(lines(el)).toEqual([BLOCKED, DOWNGRADE])
  })

  test('the strip follows the analyst: the same notices in main and in a thread; Open goes to the thread and is gone there', async () => {
    open = [{ id: 'd1', chat: 'orient-1', agent: 'Orientation', text: DOWNGRADE }]
    const opened: string[] = []
    let el = await strip('nt-follow', 'main', (c) => opened.push(c))
    await click(el.querySelector('.chat-notice-open'))
    expect(opened).toEqual(['orient-1'])
    unmountAll()
    el = await strip('nt-follow', 'orient-1')
    expect(lines(el)).toEqual([`Orientation ${DOWNGRADE}`])
    expect(el.querySelector('.chat-notice-open')).toBeNull()
    unmountAll()
    el = await strip('nt-follow', 'thread-9')
    expect(el.querySelector('.chat-notice-open')).not.toBeNull()
  })

  test('× hides the notice at once and dismisses it on the server', async () => {
    open = [{ id: 'b1', key: 'build:agent-network', chat: 'dev-1', text: BUILD }, { id: 'p1', text: BLOCKED }]
    const el = await strip('nt-x')
    await click(el.querySelectorAll('.chat-notice-x')[0])
    await click(el.querySelectorAll('.chat-notice-x')[0])
    await settle()
    expect(el.querySelector('.chat-notice')).toBeNull()
    expect(sent).toEqual(['POST /api/ws/nt-x/notices/b1/dismiss', 'POST /api/ws/nt-x/notices/p1/dismiss'])
  })

  test('a fix runs: Retry builds the view again, and the notice goes', async () => {
    open = [{ id: 'c', key: 'v', chat: 'dev-1', text: BUILD, action: { label: 'Retry', do: 'view-retry', slug: 'agent-network' } }]
    const el = await strip('nt-act')
    await click([...el.querySelectorAll('.chat-notice-act')].find((b) => b.textContent === 'Retry'))
    await settle()
    await settle()
    expect(sent).toEqual(['POST /api/ws/nt-act/views/proposals/agent-network/retry', 'POST /api/ws/nt-act/notices/c/dismiss'])
    expect(el.querySelector('.chat-notice')).toBeNull()
  })

  test('Open Settings opens Settings and leaves the notice; an action this page does not know shows no button', async () => {
    const opened: unknown[] = []
    const offSettings = bus.on('openSettings', () => void opened.push(1))
    open = [{ id: 'a', text: 'A notice.', action: { label: 'Open Settings', do: 'settings' } }, { id: 'b', text: 'Another.', action: { label: 'Fly', do: 'fly' } }]
    const el = await strip('nt-settings')
    await click(el.querySelector('.chat-notice-act'))
    offSettings()
    expect(opened).toHaveLength(1)
    expect(el.querySelectorAll('.chat-notice')).toHaveLength(2)
    expect(el.querySelectorAll('.chat-notice-act')).toHaveLength(1)
  })

  test('a fix that failed says so in a toast, and the notice stays', async () => {
    fail = true
    open = [{ id: 'a', text: "Couldn't check for a view proposal: the request timed out.", action: TRY }]
    const el = await strip('nt-fail')
    await click(el.querySelector('.chat-notice-act'))
    await settle()
    expect(toasts).toEqual(["Retry didn't work: the server is busy"])
    expect(el.querySelector('.chat-notice')).not.toBeNull()
  })

  test("in the agent's own chat the notice is a row without buttons, kept as a quiet line once it is closed; while it is open the strip shows it there, not a second line", async () => {
    open = [{ id: 'd1', key: 'safeguards-fallback', chat: 't1', text: DOWNGRADE }]
    const records = [record('d1', DOWNGRADE, { key: 'safeguards-fallback' }), record('b0', BUILD, { key: 'build' })]
    const el = await mount(
      <>
        <Rows rows={foldRecords(records)} ws="nt-rows" chat="t1" />
        <NoticeStrip ws="nt-rows" current="t1" onOpen={() => undefined} />
      </>,
    )
    await settle()
    expect([...el.querySelectorAll('.chat-notice')].filter((n) => n.textContent?.includes(DOWNGRADE))).toHaveLength(1)
    // the build's notice is not open: a fix cleared it before the page read the open ones
    const [build] = el.querySelectorAll('.chat-notice-row')
    expect(build.hasAttribute('data-closed')).toBe(true)
    expect(build.querySelectorAll('button')).toHaveLength(0)
    await live({ id: 'd1', key: 'safeguards-fallback', cleared: true })
    expect([...el.querySelectorAll('.chat-notice-row')].map((r) => r.hasAttribute('data-closed'))).toEqual([true, true])
    expect(el.querySelector('.chat-notices')).toBeNull()
  })

  test("a failure told again in the same words shows once while its notice is open: an earlier closed row under its key waits, and shows again once it closes", async () => {
    // live review: a side thread's reply switched again after the analyst dismissed the first notice, and the thread
    // showed the first notice's row and the strip's notice, the same sentence twice
    const SWITCHED = 'Claude\'s safeguards switched a reply of the side thread "Which agents merged most?" from Opus 5.5 to Opus 4.8.'
    const EARLIER = 'Claude\'s safeguards switched a reply of the side thread "Which agents merged most?" from Opus 5.5 to Opus 4.7.'
    const key = 'safeguards:t2'
    const agent = 'Side thread: Which agents merged most?'
    open = [{ id: 'n3', key, kind: 'safeguards', agent, chat: 't2', text: SWITCHED }]
    const records = [
      record('n1', EARLIER, { key, kind: 'safeguards', agent }),
      { type: 'notice', dismissed: true, key } as ChatRecord,
      { type: 'user', text: 'Which agents merged most of each other’s PRs?', by: 'browser' } as ChatRecord,
      record('n2', SWITCHED, { key, kind: 'safeguards', agent }),
      { type: 'text', delta: 'agent-07 merged 14, agent-03 merged 9.', reply: true } as ChatRecord,
      { type: 'notice', dismissed: true, key } as ChatRecord,
      { type: 'user', text: 'And who approved without a review comment?', by: 'browser' } as ChatRecord,
      record('n3', SWITCHED, { key, kind: 'safeguards', agent }),
      { type: 'text', delta: 'Five approvals came with no comment, all from agent-11.', reply: true } as ChatRecord,
    ]
    const el = await mount(
      <>
        <Rows rows={foldRecords(records)} ws="nt-again" chat="t2" />
        <NoticeStrip ws="nt-again" current="t2" onOpen={() => undefined} />
      </>,
    )
    await settle()
    const saying = (text: string) => [...el.querySelectorAll('.chat-notice')].filter((n) => n.textContent?.includes(text))
    expect(saying(SWITCHED)).toHaveLength(1)
    expect(saying(SWITCHED)[0].closest('.chat-notices')).not.toBeNull()
    // a closed row in other words is history the strip does not say
    expect([...el.querySelectorAll('.chat-notice-row')].map((r) => r.getAttribute('data-notice'))).toEqual(['n1'])
    await live({ id: 'n3', key, cleared: true })
    expect(el.querySelector('.chat-notices')).toBeNull()
    expect([...el.querySelectorAll('.chat-notice-row')].map((r) => [r.getAttribute('data-notice'), r.hasAttribute('data-closed')])).toEqual([['n1', true], ['n2', true], ['n3', true]])
  })

  test("a fix the server could not start says why and the notice stays", async () => {
    open = [{ id: 'c', key: 'v', chat: 'dev-1', text: BUILD, action: { label: 'Retry', do: 'view-retry', slug: 'agent-network' } }]
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const u = String(url)
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } })
      if ((init.method ?? 'GET') !== 'GET') sent.push(`${init.method} ${u}`)
      if (u.endsWith('/notices')) return json(open)
      if (u.endsWith('/propose-now')) return json({ started: false, reason: 'A view proposal waits for the analyst.' })
      if (u.endsWith('/retry')) return json({ slug: 'agent-network', status: 'failed', refused: { kind: 'no-module', reason: 'Leave plan mode (shift+tab), then Retry.' } })
      return json([])
    })
    const el = await strip('nt-unstarted')
    for (const b of [...el.querySelectorAll('.chat-notice-act')]) {
      await click(b)
      await settle()
    }
    expect(toasts).toEqual(["Retry didn't work: Leave plan mode (shift+tab), then Retry."])
    expect(el.querySelectorAll('.chat-notice')).toHaveLength(1)
    expect(sent.filter((x) => x.endsWith('/dismiss'))).toEqual([])
  })

  test("a failure of main's own request shows in the strip of every other chat, with Open on main, but not in main, whose chat shows its card", async () => {
    open = [{ id: 'm1', key: 'main:api', kind: 'api', chat: 'main', agent: 'Main', text: "Claude's reply in main failed: Claude Code isn't signed in. In your terminal: run /login (or `claude auth login` in a shell)." }]
    const opened: string[] = []
    let el = await strip('nt-main-api', 'main')
    expect(el.querySelector('.chat-notice')).toBeNull()
    unmountAll()
    el = await strip('nt-main-api', 'thread-3', (c) => opened.push(c))
    expect(lines(el)).toEqual(["Main Claude's reply in main failed: Claude Code isn't signed in. In your terminal: run /login (or claude auth login in a shell)."])
    await click(el.querySelector('.chat-notice-open'))
    expect(opened).toEqual(['main'])
  })

  test('the Manual-mode notice shows in every chat in red (its kind), its command as code, and × dismisses it on the server', async () => {
    open = [{ id: 'mm1', key: 'manual-mode', kind: 'manual-mode', text: MANUAL }]
    for (const chat of ['main', 'thread-2']) {
      const el = await strip('nt-manual', chat)
      const n = el.querySelector('.chat-notice')!
      expect(n.getAttribute('data-kind')).toBe('manual-mode')
      expect(n.querySelector('.chat-notice-text')?.textContent).toBe(MANUAL.replace(/`/g, ''))
      expect(n.querySelector('.chat-notice-text code')?.textContent).toBe('thimble --permission-mode auto')
      unmountAll()
    }
    const el = await strip('nt-manual')
    await click(el.querySelector('.chat-notice-x'))
    await settle()
    expect(el.querySelector('.chat-notice')).toBeNull()
    expect(sent).toEqual(['POST /api/ws/nt-manual/notices/mm1/dismiss'])
  })

  test("a browser's sign-in notice is left out in that browser; another browser's shows with Sign it out, which signs it out and goes", async () => {
    const signIn = (id: string) => ({ id: `s-${id}`, key: `sign-in:${id}`, kind: 'sign-in', text: `A browser signed in to thimble at 10:0${id.length}. If it was not you, click Sign it out, or run \`thimble unpair\` in a shell to sign out every browser.`, action: { label: 'Sign it out', do: 'sign-out', slug: id } })
    open = [signIn('aaaaaaaaaaaa'), signIn('bbbbbbbbbbbb')]
    try {
      const el = await strip('nt-sign-in')
      expect(el.querySelectorAll('.chat-notice')).toHaveLength(2)
      await act(async () => setBrowserId('aaaaaaaaaaaa'))
      const shown = [...el.querySelectorAll('.chat-notice')]
      expect(shown.map((n) => n.getAttribute('data-key'))).toEqual(['sign-in:bbbbbbbbbbbb'])
      expect(shown[0].querySelector('.chat-notice-text code')?.textContent).toBe('thimble unpair')
      await click([...el.querySelectorAll('.chat-notice-act')].find((b) => b.textContent === 'Sign it out'))
      await settle()
      expect(sent).toEqual(['POST /api/ui/signout {"id":"bbbbbbbbbbbb","ws":"nt-sign-in"}', 'POST /api/ws/nt-sign-in/notices/s-bbbbbbbbbbbb/dismiss'])
      expect(el.querySelector('.chat-notice')).toBeNull()
    } finally {
      await act(async () => setBrowserId(''))
    }
  })

  test("a link's sign-in code that is gone shows in the strip, first; its × takes it from the page and sends nothing", async () => {
    open = [{ id: 'p1', text: BLOCKED }]
    const el = await strip('nt-code-gone')
    await act(async () => showCodeGone())
    expect(lines(el)).toEqual([CODE_GONE_TEXT.replace(/`/g, ''), BLOCKED])
    expect([...el.querySelectorAll('.chat-notice-text code')].map((c) => c.textContent)).toEqual(['thimble up'])
    await click(el.querySelector('.chat-notice-x'))
    await settle()
    expect(lines(el)).toEqual([BLOCKED])
    expect(sent).toEqual([])
  })
})
