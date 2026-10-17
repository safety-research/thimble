// @vitest-environment jsdom
// Notices (src/chat/Notice.tsx, src/lib/notices.ts, backend notices.py): a failure of main or of any of thimble's
// agents, with an easy fix. Every open notice shows in the foreground, in the strip above the composer of whichever
// chat is open, read from GET /notices when the page opens and kept up to date by the stream: one with the key of a
// notice shown replaces it in place, a fix that worked clears it, × dismisses it on the server. Each names its agent,
// says what failed, offers its fix as buttons and Open for the agent's thread. In the agent's own chat it is also a row,
// which stays as a quiet line once the notice is closed.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { Composer } from '../../src/chat/Composer.tsx'
import { NoticeStrip, sameNotices } from '../../src/chat/Notice.tsx'
import { bus } from '../../src/lib/bus.ts'
import { noticeActions, parseNotice, setBrowserId } from '../../src/lib/notices.ts'
import type { Notice } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'
const BLOCKED = "Couldn't check for a view proposal: Claude's safeguards blocked the request."
const BUILD = 'The view Agent Network failed to build: the page did not load.'
const TRY = { label: 'Try again', do: 'proposals-retry' }
const OFF = { label: 'Turn off view proposals', do: 'proposals-off' }

describe('a notice as the server sends it', () => {
  test('its fields, one action or several, those without a label or a `do` left out; none without text', () => {
    expect(parseNotice({ id: 'n1', key: 'proposals', kind: 'proposals', text: BLOCKED, agent: 'View proposals', action: [TRY, OFF, { label: '', do: 'x' }], foreground: true })).toEqual({ id: 'n1', key: 'proposals', kind: 'proposals', text: BLOCKED, agent: 'View proposals', action: [TRY, OFF] })
    expect(parseNotice({ id: 'n2', text: BUILD, chat: 'dev-1', action: { label: 'Retry', do: 'view-retry', slug: 'agent-network' } })).toEqual({ id: 'n2', text: BUILD, chat: 'dev-1', action: { label: 'Retry', do: 'view-retry', slug: 'agent-network' } })
    expect(parseNotice({ id: 'n3', text: ' ' })).toBeNull()
    expect(noticeActions(null)).toEqual([])
  })
})

describe('notices in the same words', () => {
  test('are one card with all of them, oldest first, at the first one’s place; another agent, words or fix, or a Try again of its own, keeps one apart', () => {
    const SWITCHED = "Claude's safeguards switched a reply of a helper of the orientation from Opus 5.5 to Opus 4.8."
    const h = (i: number, extra: object = {}) => ({ id: `h${i}`, key: `safeguards:orient-h${i}`, kind: 'safeguards', agent: 'Orientation helper', text: SWITCHED, ...extra })
    const open = [h(1), { id: 'p1', key: 'proposals:a', text: BLOCKED, action: TRY }, h(2), h(3, { agent: 'Writer' }), h(4), { id: 'p2', key: 'proposals:b', text: BLOCKED, action: TRY }, h(5, { action: OFF })]
    const cards = sameNotices<Notice>(open, (n) => n.agent ?? '')
    expect(cards.map((c) => [c.agent, c.all.map((n) => n.id)])).toEqual([
      ['Orientation helper', ['h1', 'h2', 'h4']],
      ['', ['p1']],
      ['Writer', ['h3']],
      ['', ['p2']],
      ['Orientation helper', ['h5']],
    ])
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
  const click = (el: Element | null | undefined) => act(async () => (el as HTMLButtonElement).click())

  test('× hides the notice at once and dismisses it on the server', async () => {
    open = [{ id: 'b1', key: 'build:agent-network', chat: 'dev-1', text: BUILD }, { id: 'p1', text: BLOCKED }]
    const el = await strip('nt-x')
    await click(el.querySelectorAll('.chat-notice-x')[0])
    await click(el.querySelectorAll('.chat-notice-x')[0])
    await settle()
    expect(el.querySelector('.chat-notice')).toBeNull()
    expect(sent).toEqual(['POST /api/ws/nt-x/notices/p1/dismiss', 'POST /api/ws/nt-x/notices/b1/dismiss'])
  })

  test('bug hunt C21: the newest notice shows in full and the others behind one row, which shows them in place with their fixes and Dismiss all', async () => {
    const at = (m: number) => `2026-10-17T04:${String(m).padStart(2, '0')}:00.000+00:00`
    const SWITCHED = "Claude's safeguards switched a reply of the report check Key facts from Opus 5.5 to Opus 4.8."
    open = [
      { id: 'c1', key: 'safeguards:check-1', kind: 'safeguards', agent: 'Report check: Key facts', chat: 'check-1', text: SWITCHED, ts: at(30) },
      { id: 'o1', key: 'agent:orient', kind: 'agent', agent: 'Orientation', chat: 'orient-1', text: "The orientation failed: Claude's safeguards stopped its request; rephrase or narrow the request and try again.", action: { label: 'Run again', do: 'orient-again' }, ts: at(36) },
      { id: 'c2', key: 'safeguards:check-2', kind: 'safeguards', agent: 'Report check: Key facts', chat: 'check-2', text: SWITCHED, ts: at(41) },
      { id: 'l1', key: 'label:k1', kind: 'label', agent: 'Label: probing', text: "The label probing couldn't label 184 of 2,064 records: Claude's safeguards stopped its request.", action: [{ label: 'Run again on these 184', do: 'label-again', slug: 'k1' }, { label: 'See the label', do: 'label-open', slug: 'k1' }], ts: at(45) },
      { id: 'p1', key: 'proposals', kind: 'proposals', agent: 'View proposals', text: BLOCKED, action: TRY, ts: at(47) },
      { id: 'b1', key: 'build:agent-network', kind: 'agent', agent: 'View build: Agent Network', chat: 'dev-1', text: BUILD, ts: at(50) },
    ]
    const el = await strip('nt-more')
    const shown = () => [...el.querySelectorAll('.chat-notice')].map((n) => n.getAttribute('data-notice'))
    const toggle = () => el.querySelector('.chat-notices-toggle') as HTMLButtonElement
    // the newest in full, the four other cards behind one row (the two notices in the same words are one card)
    expect(shown()).toEqual(['b1'])
    expect(toggle().textContent).toBe('4 more notices ›')
    expect(el.querySelector('.chat-notices-all')).toBeNull()
    await click(toggle())
    expect(shown()).toEqual(['b1', 'p1', 'l1', 'c2', 'o1'])
    expect(toggle().textContent).toBe('Show fewer')
    // a fix runs from the opened list
    await click([...el.querySelectorAll('.chat-notice-act')].find((b) => b.textContent === 'Run again on these 184'))
    await settle()
    expect(sent).toEqual(['POST /api/ws/nt-more/concepts/k1/apply/again', 'POST /api/ws/nt-more/notices/l1/dismiss'])
    expect(shown()).toEqual(['b1', 'p1', 'c2', 'o1'])
    // Dismiss all dismisses every open notice, the two in the same words too
    sent = []
    await click(el.querySelector('.chat-notices-all'))
    await settle()
    expect(sent.sort()).toEqual(['b1', 'c1', 'c2', 'o1', 'p1'].map((id) => `POST /api/ws/nt-more/notices/${id}/dismiss`))
    expect(el.querySelector('.chat-notice')).toBeNull()
  })

  test('a fix that failed says so in a toast, and the notice stays', async () => {
    fail = true
    open = [{ id: 'a', text: "Couldn't check for a view proposal: the request timed out.", action: TRY }]
    const el = await strip('nt-fail')
    await click(el.querySelector('.chat-notice-act'))
    await settle()
    expect(toasts).toEqual(["Try again didn't work: the server is busy"])
    expect(el.querySelector('.chat-notice')).not.toBeNull()
  })

  test("a browser's sign-in notice is left out in that browser; another browser's shows with Sign it out, which signs it out and goes", async () => {
    const signIn = (id: string) => ({ id: `s-${id}`, key: `sign-in:${id}`, kind: 'sign-in', text: `A browser signed in to thimble at 10:0${id.length}. If it was not you, click Sign it out, or run \`thimble unpair\` in a shell to sign out every browser.`, action: { label: 'Sign it out', do: 'sign-out', slug: id } })
    open = [signIn('aaaaaaaaaaaa'), signIn('bbbbbbbbbbbb')]
    try {
      const el = await strip('nt-sign-in')
      expect(el.querySelectorAll('.chat-notice')).toHaveLength(1)
      expect(el.querySelector('.chat-notices-toggle')?.textContent).toBe('1 more notice ›')
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
  test("a label whose records Claude's safeguards refused runs again on them from its notice, and links the label (bug hunt C17)", async () => {
    open = [{ id: 'l1', key: 'label:k1', kind: 'label', agent: 'Label: confused', text: "The label confused couldn't label 184 of 2,064 records: Claude's safeguards refused them.", action: [{ label: 'Run again on these 184', do: 'label-again', slug: 'k1' }, { label: 'See the label', do: 'label-open', slug: 'k1' }] }]
    const el = await strip('nt-label-again')
    const acts = () => [...el.querySelectorAll('.chat-notice-act')]
    expect(acts().map((b) => b.textContent)).toEqual(['Run again on these 184', 'See the label'])
    await click(acts().find((b) => b.textContent === 'Run again on these 184'))
    await settle()
    expect(sent).toEqual(['POST /api/ws/nt-label-again/concepts/k1/apply/again', 'POST /api/ws/nt-label-again/notices/l1/dismiss'])
    expect(el.querySelector('.chat-notice')).toBeNull()
  })
  test("main's reply Claude's safeguards stopped: its notice makes the lost card again, or puts the analyst's question back in main's composer (bug hunt C23)", async () => {
    const opened: unknown[] = []
    const offOpen = bus.on('openChat', (e) => void opened.push(e))
    try {
      const again = { label: 'Make the card again', do: 'card-again', text: 'Claude\'s safeguards stopped your reply while you were adding the card "Which runs failed?", and the card was not added. Make that card again.' }
      const ask = { label: 'Ask again', do: 'ask-again', text: 'Which runs failed, and why?' }
      const stopped = { key: 'stopped:main', kind: 'stopped', chat: 'main', text: "Claude's safeguards stopped main's reply partway, so the card it was making wasn't added: \"Which runs failed?\". Make the card again, or ask again in other words.", action: [again, ask] }
      open = [{ id: 's1', ...stopped }]
      let el = await strip('nt-stopped-ask')
      const acts = () => [...el.querySelectorAll('.chat-notice-act')]
      expect(acts().map((b) => b.textContent)).toEqual(['Make the card again', 'Ask again'])
      await click(acts().find((b) => b.textContent === 'Ask again'))
      await settle()
      expect(opened).toEqual([{ chatId: 'main', draft: ask.text }])
      expect(sent).toEqual(['POST /api/ws/nt-stopped-ask/notices/s1/dismiss'])
      // main's composer takes the question as its draft, to change and send
      const box = await mount(<Composer onSend={() => undefined} sending={false} thread="main" fill={{ thread: 'main', text: ask.text, n: 1 }} />)
      await settle()
      expect(box.querySelector('textarea')?.value).toBe(ask.text)
      // Make the card again sends main its words
      open = [{ id: 's2', ...stopped }]
      el = await strip('nt-stopped-card')
      await click(acts().find((b) => b.textContent === 'Make the card again'))
      await settle()
      expect(opened.at(-1)).toEqual({ chatId: 'main', send: again.text })
      expect(sent.at(-1)).toBe('POST /api/ws/nt-stopped-card/notices/s2/dismiss')
    } finally {
      offOpen()
    }
  })
  test('a failed orientation runs again from its notice, with the request its last run had (bug hunt C18)', async () => {
    open = [{ id: 'o1', key: 'agent:orient', kind: 'agent', agent: 'Orientation', chat: 'orient-1', text: "The orientation failed: Claude's safeguards stopped its request; rephrase or narrow the request and try again.", action: { label: 'Run again', do: 'orient-again' } }]
    const el = await strip('nt-orient-again')
    await click(el.querySelector('.chat-notice-act'))
    await settle()
    expect(sent).toEqual(['POST /api/ws/nt-orient-again/orientation/again {"text":""}', 'POST /api/ws/nt-orient-again/notices/o1/dismiss'])
    expect(el.querySelector('.chat-notice')).toBeNull()
  })
})
