// @vitest-environment jsdom
// The permission card above the chat's composer (src/chat/PermissionCard.tsx, src/chat/permissions.ts): every request
// that waits for the analyst, from main's session and from every session thimble started, on one card, the one asked
// first first, each answer sent to the session that asked. Several requests at once: the card keeps the request it
// shows while others come and go, an answer frees the card at once, and a request that ended leaves it. Every request
// is recorded and answered by a stand-in fetch, which a test may hold or fail.
import { act, useState } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ThreadsContext } from '../../src/chat/Notes.tsx'
import { ARM_MS, EXPIRED_TITLE, PermissionCard } from '../../src/chat/PermissionCard.tsx'
import { askWhy, autoModeRefusal, pendingRequests, pluginSteered, type PendingAsk } from '../../src/chat/permissions.ts'
import { bus } from '../../src/lib/bus.ts'
import { newest, STALE } from '../../src/lib/newest.ts'
import type { ChatMeta, PermissionRequest } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const posted: [string, unknown][] = []
// how the stand-in answers a POST: at once with 200, or as the test says
let reply: (url: string, body: { id?: string }) => Promise<Response> = async () => ok()
const ok = () => new Response('{"answered":"x"}', { status: 200, headers: { 'content-type': 'application/json' } })
const missing = () => new Response('{"detail":"no such permission request is waiting"}', { status: 404, headers: { 'content-type': 'application/json' } })
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

  test("main's request and a session's asked in the same second are in the order they were asked", () => {
    const main = { permissions: [req('m1', { since: '2026-10-01T00:17:11.900+00:00' })] }
    const metas = [{ ...ORIENT, permissions: [req('o1', { since: '2026-10-01T00:17:11.500+00:00' }), req('o2', { since: '2026-10-01T00:17:12+00:00' })] }]
    expect(pendingRequests(main, metas).map((a) => a.request.id)).toEqual(['o1', 'm1', 'o2'])
  })

  test('a request nobody answered in time says so, and only a session that asked for a call went on without it', () => {
    const late = (extra: Partial<PermissionRequest>) => askWhy({ chat: 'or1', request: req('e1', { expired: T(9), wait_s: 600, ...extra }) }, METAS)
    expect(late({})).toBe('Nobody answered within 10 minutes, so thimble declined it and the agent went on without it.')
    expect(late({ why: "This edits thimble's own code." })).toBe('Nobody answered within 10 minutes, so thimble declined it.')
    expect(late({ wait_s: 180 })).toContain('within 3 minutes')
    expect(late({ wait_s: 19.98 })).toContain('within 19.98 seconds')
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

  test("a corpus edit thimble's config asks about names the config, not Auto mode, and a writer's still says when it is denied", async () => {
    const auto = chat('or2', { permission_mode: 'auto' })
    const writer = chat('w2', { role: 'writer', title: 'Report', permission_mode: 'auto' })
    const edit = req('e1', { tool: 'Write', what: '/corpus/NOTES.md', asked_by: 'data' })
    const el = await mount(<PermissionCard ws="mini" asks={[{ chat: 'or2', request: edit }]} metas={new Map([['or2', auto]])} labels={new Map()} />)
    const why = el.querySelector('.chat-perm-why')?.textContent ?? ''
    expect(why).toMatch(/every permission mode/)
    expect(why).not.toMatch(/Auto mode/)
    const w = await mount(<PermissionCard ws="mini" asks={[{ chat: 'w2', request: { ...edit, id: 'e2', wait_s: 60 } }]} metas={new Map([['w2', writer]])} labels={new Map()} />)
    expect(w.querySelector('.chat-perm-why')?.textContent).toMatch(/every permission mode\. If nobody answers within a minute, it is declined\.$/)
  })

  test("an edit of thimble's config names the config as the reason, in Bypass too", async () => {
    const bypass = chat('or3', { permission_mode: 'bypass' })
    const edit = req('c1', { tool: 'Edit', what: '/home/u/.thimble/config.json', asked_by: 'config', wait_s: 600 })
    const el = await mount(<PermissionCard ws="mini" asks={[{ chat: 'or3', request: edit }]} metas={new Map([['or3', bypass]])} labels={new Map()} />)
    expect(el.querySelector('.chat-perm-why')?.textContent).toBe(
      "thimble asks before an agent changes thimble's config, in every permission mode. If nobody answers within 10 minutes, it is declined.")
  })

  test("a code ticket's question says what it asks and why thimble asks, in Bypass too, with Allow and Deny", async () => {
    const dev = chat('d1', { role: 'dev', title: 'ticket #3: Fix the chart', permission_mode: 'bypass' })
    const what = "Apply this change to thimble's own code?"
    const q = req('q1', { tool: 'ThimbleCode', what, input: JSON.stringify({ description: what, files: ['frontend/src/App.css'] }), why: 'It changes frontend/src/App.css. thimble asks this before any change reaches its own code, in every permission mode.' })
    const el = await mount(<PermissionCard ws="mini" asks={[{ chat: 'd1', request: q }]} metas={new Map([['d1', dev]])} labels={new Map()} />)
    expect(el.querySelector('.chat-perm-who')?.textContent).toBe("dev · ticket #3asks to change thimble's own code")
    expect(el.querySelector('.chat-perm-what')?.textContent).toBe(what)
    expect(el.querySelector('.chat-perm-why')?.textContent).toBe(q.why)
    expect([...el.querySelectorAll('.chat-perm-acts button')].map((b) => b.textContent)).toEqual(['Allow', 'Deny'])
  })

  test('the count is of the requests that still wait, and on one denied unanswered of those denied unanswered', async () => {
    const live = [req('l1', { since: T(1) }), req('l2', { since: T(2) })]
    const gone = [1, 2, 3].map((n) => req(`x${n}`, { since: T(0), expired: T(9) }))
    const el = await mount(<PermissionCard ws="mini" asks={pendingRequests(null, [{ ...ORIENT, permissions: [...gone, ...live] }])} metas={METAS} labels={new Map()} />)
    expect(el.querySelector('.chat-perm-count')?.textContent).toBe('1 of 2')
    await click(el.querySelectorAll('.chat-perm-page')[1])
    await click(el.querySelectorAll('.chat-perm-page')[1])
    expect(el.querySelector('.chat-perm-title')?.textContent).toBe(EXPIRED_TITLE)
    expect(el.querySelector('.chat-perm-count')?.textContent).toBe('1 of 3')
  })

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

describe("main's requests and those of thimble's agents, its subagents", () => {
  const orient = chat('o9', { route: 'subagent', agent_id: 'ag1', started_by: 'click' })
  const typed = chat('o8', { route: 'subagent', agent_id: 'ag2', started_by: 'typed' })
  const metas = new Map([[orient.id, orient], [typed.id, typed]])

  test("main's own request is answered here or in the terminal, and says nothing of a decline", () => {
    expect(askWhy({ chat: 'main', request: req('m1') }, metas)).toBe('Answer here or in your terminal.')
    expect(askWhy({ chat: 'main', request: req('m2', { asked_by: 'web', tool: 'WebFetch' }) }, metas)).toBe('Your settings ask before any agent fetches a web page or searches the web. Answer here or in your terminal.')
  })

  test('a subagent asks in the terminal; one a click started is shown by Claude Code as from the thimble plugin', () => {
    expect(askWhy({ chat: 'main', request: req('t1', { terminal: true, chat: 'o8' }) }, metas)).toBe('The orientation asks in your terminal. Answer it there (↓ to the orientation in the agent tray if it is not shown).')
    expect(askWhy({ chat: 'main', request: req('t2', { terminal: true, chat: 'o9', asked_by: 'data' }) }, metas)).toBe(
      'thimble asks before an agent changes your files, in every permission mode. The orientation asks in your terminal. Answer it there (↓ to the orientation in the agent tray if it is not shown). Claude Code shows it as from the thimble plugin.',
    )
  })

  test("the critic of a click-started orientation is shown as from the thimble plugin too (live check L13)", () => {
    const critic = chat('k9', { role: 'step', title: 'critique', parent: 'o9', route: 'subagent', agent_id: 'ag3', started_by: 'typed' })
    const typedCritic = chat('k8', { role: 'step', title: 'critique', parent: 'o8', route: 'subagent', agent_id: 'ag4', started_by: 'typed' })
    const all = new Map([...metas, [critic.id, critic], [typedCritic.id, typedCritic]])
    expect(pluginSteered('k9', all)).toBe(true)
    expect(pluginSteered('k8', all)).toBe(false)
    expect(askWhy({ chat: 'main', request: req('t4', { terminal: true, chat: 'k9' }) }, all)).toMatch(/Claude Code shows it as from the thimble plugin\.$/)
  })

  test('the card shows a subagent\'s request with no buttons, and names the agent', async () => {
    const el = await mount(<PermissionCard ws="mini" asks={[{ chat: 'main', request: req('t3', { terminal: true, chat: 'o9', command: 'rm -rf work' }) }]} metas={metas} labels={new Map()} />)
    expect(el.querySelector('.chat-perm')?.getAttribute('data-terminal')).toBe('true')
    expect(el.querySelector('.chat-perm-acts')).toBeNull()
    expect(el.querySelectorAll('button.chat-perm-allow, button.chat-perm-deny')).toHaveLength(0)
    expect(el.querySelector('.chat-perm-who')?.textContent).toMatch(/^The orientationasks to run a command/)
    const main = await mount(<PermissionCard ws="mini" asks={[{ chat: 'main', request: req('m3') }]} metas={metas} labels={new Map()} />)
    expect([...main.querySelectorAll('.chat-perm-acts button')].map((b) => b.textContent)).toEqual(['Allow', 'Deny'])
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

  test('the card keeps the request it shows when one before it times out', async () => {
    const a = ask('d1', 'a', 1)
    const b = ask('d2', 'b', 2)
    const c = ask('d3', 'c', 3)
    const el = await mount(<Live initial={[a, b, c]} />)
    await click(el.querySelectorAll('.chat-perm-page')[1])
    expect(shownId(el)).toBe('b')
    // a's wait passes: it goes last, declined unanswered
    await act(async () => setAsks(pendingRequests(null, DEVS.map((m, k) => ({ ...m, permissions: [[{ ...a.request, expired: T(9) }], [b.request], [c.request]][k] })))))
    expect(shownId(el)).toBe('b')
    await armed()
    await click(el.querySelector('.chat-perm-allow'))
    expect(posted).toEqual([['/api/ws/mini/chats/d2/permission', { id: 'b', allow: true, shown: 0 }]])
  })

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

  test('an answer takes its request off at once, and the next can be answered while the first is still on its way', async () => {
    const held: (() => void)[] = []
    reply = (_url, body) => (body.id === 'a' ? new Promise((r) => held.push(() => r(ok()))) : Promise.resolve(ok()))
    const el = await mount(<Live initial={[ask('d1', 'a', 1), ask('d2', 'b', 2), ask('d3', 'c', 3)]} />)
    await armed()
    await click(el.querySelector('.chat-perm-allow'))
    expect(shownId(el)).toBe('b')
    await armed()
    const deny = el.querySelector('.chat-perm-deny') as HTMLButtonElement
    expect(deny.disabled).toBe(false)
    await click(deny)
    expect(posted.map(([u, b]) => [u, (b as { id: string }).id])).toEqual([['/api/ws/mini/chats/d1/permission', 'a'], ['/api/ws/mini/chats/d2/permission', 'b']])
    expect(shownId(el)).toBe('c')
    await act(async () => held.forEach((r) => r()))
    await settle()
    expect(shownId(el)).toBe('c')
  })

  test('an answer that could not be sent puts its request back, and one whose request had ended leaves it off', async () => {
    const toasts: string[] = []
    const off = bus.on('toast', (t) => toasts.push(t.text))
    reply = async (_url, body) => (body.id === 'a' ? new Response('{"detail":"boom"}', { status: 500 }) : missing())
    const el = await mount(<Live initial={[ask('d1', 'a', 1), ask('d2', 'b', 2)]} />)
    await armed()
    await click(el.querySelector('.chat-perm-allow'))
    expect(shownId(el)).toBe('a')
    expect(toasts.at(-1)).toMatch(/^Could not answer: 500/)
    await click(el.querySelectorAll('.chat-perm-page')[1])
    await armed()
    await click(el.querySelector('.chat-perm-deny'))
    expect(shownId(el)).toBe('a')
    expect(el.querySelector('.chat-perm')?.getAttribute('data-count')).toBe('1')
    expect(toasts.at(-1)).toBe('That request had already ended.')
    off()
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

  test('focus on the card stays there while a request is left, then goes to the composer below it', async () => {
    const el = await mount(
      <div className="chat-foot">
        <Live initial={[ask('d1', 'a', 1), ask('d2', 'b', 2)]} />
        <textarea />
      </div>,
    )
    const allow = () => el.querySelector('.chat-perm-allow') as HTMLButtonElement
    await armed()
    allow().focus()
    await click(allow())
    expect(document.activeElement).toBe(el.querySelector('.chat-perm'))
    await armed()
    allow().focus()
    await click(allow())
    expect(el.querySelector('.chat-perm')).toBeNull()
    expect(document.activeElement).toBe(el.querySelector('textarea'))
  })

  test('several requests declined unanswered are dismissed at once, and the card says why they were declined', async () => {
    const gone = [ask('d1', 'x1', 1, { expired: T(11) }), ask('d2', 'x2', 2, { expired: T(12) }), ask('d3', 'x3', 3, { expired: T(13) })]
    const el = await mount(<Live initial={gone} />)
    expect(el.querySelector('.chat-perm-title')?.textContent).toBe(EXPIRED_TITLE)
    expect(el.querySelector('.chat-perm-why')?.textContent).toBe('Nobody answered within 10 minutes, so thimble declined it and the agent went on without it.')
    await armed()
    await click(el.querySelector('.chat-perm-dismiss-all'))
    expect(posted.map(([u, b]) => [u, (b as { id: string }).id])).toEqual([
      ['/api/ws/mini/chats/d1/permission', 'x1'],
      ['/api/ws/mini/chats/d2/permission', 'x2'],
      ['/api/ws/mini/chats/d3/permission', 'x3'],
    ])
    expect(el.querySelector('.chat-perm')).toBeNull()
  })

  test('a live request says when it is declined if nobody answers', async () => {
    const el = await mount(<Live initial={[ask('d1', 'a', 1)]} />)
    expect(el.querySelector('.chat-perm-why')?.textContent).toBe('It runs in Manual, which asks before each call. If nobody answers within 10 minutes, it is declined.')
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
