// @vitest-environment jsdom
// Notices (src/chat/Notice.tsx, src/lib/notices.ts, backend notices.py): a failure of main or of any of thimble's
// agents, with an easy fix. Every open notice shows in the strip above the composer of whichever chat is open, read
// from GET /notices when the page opens: each names its agent, says what failed, offers its fix as buttons and Open
// for the agent's thread, and × dismisses it on the server. A view that failed to build offers Retry, which builds it
// again, and its notice goes; one whose builder stopped without passing its checks offers Send, which puts
// `/thimble-fix` and the failure in main's composer, and Discard. A notice the server shortened shows Show more.
import { act } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { withOffers } from '../../src/chat/Composer.tsx'
import { fixWords } from '../../src/chat/fix.ts'
import { NoticeStrip } from '../../src/chat/Notice.tsx'
import { takeDrafts } from '../../src/chat/pending.ts'
import { bus } from '../../src/lib/bus.ts'
import { parseNotice } from '../../src/lib/notices.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const BLOCKED = "Couldn't check for a view proposal: Claude's safeguards blocked the request."
const BUILD = 'The view Agent Network failed to build: the page did not load.'
const RETRY = { label: 'Retry', do: 'view-retry', slug: 'agent-network' }

/** What GET /notices answers, and each request that changes state. */
let open: unknown[] = []
let sent: string[] = []

beforeEach(() => {
  open = []
  sent = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET'
    const u = String(url)
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } })
    if (method !== 'GET') sent.push(`${method} ${u}`)
    if (u.endsWith('/notices')) return json(open)
    if (u.endsWith('/views/proposals')) return json([])
    if (u.endsWith('/dismiss')) return json({ dismissed: true })
    return json({})
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

/** The strip of workspace `ws` (one per test: the open notices are kept per workspace) in main's chat. */
async function strip(ws: string) {
  const el = await mount(<NoticeStrip ws={ws} current="main" labels={new Map([['dev-1', 'dev · view Agent Network']])} onOpen={() => undefined} />)
  await settle()
  return el
}
const click = (el: Element | null | undefined) => act(async () => (el as HTMLButtonElement).click())
const buttons = (n: Element) => [...n.querySelectorAll('button')].map((b) => b.textContent || b.getAttribute('aria-label'))
/** Each notice's words, without its Open link. */
const lines = (el: HTMLElement) => [...el.querySelectorAll('.chat-notice')].map((n) => n.querySelector('.chat-notice-text')?.textContent?.replace(/ Open$/, ''))

test('the open notices show when the page opens, each with its agent, what failed and its fixes; × dismisses one on the server', async () => {
  open = [
    { id: 'n1', key: 'proposals', kind: 'proposals', agent: 'View proposals', text: BLOCKED, action: [{ label: 'Try again', do: 'proposals-retry' }, { label: 'Turn off view proposals', do: 'proposals-off' }] },
    { id: 'n2', key: 'build:agent-network', kind: 'view', agent: 'View build: Agent Network', chat: 'dev-1', text: BUILD, action: RETRY },
  ]
  const el = await strip('nt-read')
  const [proposals, build] = el.querySelectorAll('.chat-notice')
  expect(proposals.querySelector('.chat-notice-text')?.textContent).toBe(`View proposals ${BLOCKED}`)
  expect(buttons(proposals)).toEqual(['Try again', 'Turn off view proposals', 'Dismiss'])
  expect(build.querySelector('.chat-notice-agent')?.textContent).toBe('View build: Agent Network')
  expect(buttons(build)).toEqual(['Open', 'Retry', 'Dismiss'])
  await click(proposals.querySelector('.chat-notice-x'))
  await settle()
  expect(el.querySelectorAll('.chat-notice')).toHaveLength(1)
  expect(sent).toEqual(['POST /api/ws/nt-read/notices/n1/dismiss'])
})

test("a view that failed to build is built again by its notice's Retry, and the notice goes", async () => {
  open = [{ id: 'c', key: 'build:agent-network', chat: 'dev-1', text: BUILD, action: RETRY }]
  const el = await strip('nt-retry')
  await click([...el.querySelectorAll('.chat-notice-act')].find((b) => b.textContent === 'Retry'))
  await settle()
  await settle()
  expect(sent).toEqual(['POST /api/ws/nt-retry/views/proposals/agent-network/retry', 'POST /api/ws/nt-retry/notices/c/dismiss'])
  expect(el.querySelector('.chat-notice')).toBeNull()
})

test('a notice the server shortened shows Show more, which shows its whole words in place, and Show less goes back', async () => {
  const cut = "The label suspect answer couldn't label 5 of 1,383 records: 1 record has no readable text (e.g. Runs/a/board.jsonl#L3), so it was not labeled; board.jsonl: ValueError: the record…."
  const whole = `${cut.slice(0, -2)} at line 9 is a list of values, not an object, so skip it.`
  open = [{ id: 'n1', key: 'label:k1', kind: 'label', agent: 'Label: suspect answer', text: cut, details: whole }, { id: 'n2', key: 'proposals', text: BLOCKED, details: BLOCKED }]
  const el = await strip('nt-more')
  const [label, plain] = el.querySelectorAll('.chat-notice')
  const more = label.querySelector<HTMLButtonElement>('.chat-notice-text .chat-notice-more')
  expect(lines(el)).toEqual([`Label: suspect answer ${cut} Show more`, `${BLOCKED}`])
  expect(more?.getAttribute('aria-expanded')).toBe('false')
  expect(plain.querySelector('.chat-notice-more')).toBeNull()
  await click(more)
  expect(lines(el)[0]).toBe(`Label: suspect answer ${whole} Show less`)
  expect(more?.getAttribute('aria-expanded')).toBe('true')
  await click(more)
  expect(lines(el)[0]).toBe(`Label: suspect answer ${cut} Show more`)
  expect(parseNotice({ id: 'n3', text: 'Same.', details: ' Same. ' })).toEqual({ id: 'n3', text: 'Same.' })
})

test('a view whose builder stopped without passing its checks: Send opens main with /thimble-fix and the failure in its composer, for one send, and the notice goes; Discard drops the view or the change', async () => {
  const WORDS = 'The view Agent Network failed after retry: its page showed an error (“page: overview: test”). Make it build.'
  const send = (text: string) => ({ label: 'Send', do: 'thimble-fix', text })
  open = [
    { id: 'v1', key: 'agent:view:agent-network', kind: 'view', agent: 'View build: Agent Network', chat: 'dev-1', text: 'Agent Network failed after retry: its page showed an error. Send to thimble-fix?', action: [send(WORDS), { label: 'Discard the view', do: 'view-discard', slug: 'agent-network' }] },
    { id: 'v2', key: 'agent:view:b', kind: 'view', agent: 'View build: B', chat: 'dev-2', text: 'The change to B failed after retry: its page showed an error. Send to thimble-fix?', action: [send('The change to the view B failed after retry.'), { label: 'Discard the change', do: 'view-discard', slug: 'b' }] },
  ]
  const opened: unknown[] = []
  const offOpen = bus.on('openChat', (e) => void opened.push(e))
  takeDrafts()
  const el = await strip('nt-fix')
  const first = el.querySelector('.chat-notice')!
  expect(buttons(first)).toEqual(['Open', 'Send', 'Discard the view', 'Dismiss'])
  await click(first.querySelector('.chat-notice-act'))
  await settle()
  offOpen()
  expect(opened).toEqual([{ chatId: 'main' }])
  const [draft] = takeDrafts()
  expect(draft).toEqual({ thread: 'main', text: `/thimble-fix ${WORDS}` })
  expect(fixWords(draft.text)).toBe(WORDS)
  expect(sent).toEqual(['POST /api/ws/nt-fix/notices/v1/dismiss'])
  expect(el.querySelectorAll('.chat-notice')).toHaveLength(1)
  // offered again, the composer holds the words once
  expect(withOffers({ main: draft.text }, [draft])).toEqual({ main: draft.text })
  expect(withOffers({ main: 'Also a legend.' }, [draft])).toEqual({ main: `Also a legend.\n${draft.text}` })
  await click([...el.querySelectorAll('.chat-notice-act')].find((b) => b.textContent === 'Discard the change'))
  await settle()
  await settle()
  expect(sent.slice(1)).toEqual(['POST /api/ws/nt-fix/views/proposals/b/discard', 'POST /api/ws/nt-fix/notices/v2/dismiss'])
  expect(el.querySelector('.chat-notice')).toBeNull()
})
