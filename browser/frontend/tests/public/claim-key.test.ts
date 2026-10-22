// The page's sign-in with the one-time code in thimble's link (src/lib/api.ts claimKey): `#p=` is posted with the
// workspace of `?ws=`, and leaves the address once the server has answered; a code that is gone (410) shows the
// page's own notice, whose × sends nothing, until a later link signs the browser in; a claim the server never answered is tried again; a link opened in a tab
// already on its page (a change of the hash alone) is claimed too; an earlier version's `#k=` leaves the address and is
// never sent. After the claim the page asks which browser it is (GET /ui/paired). Every write waits for the claim
// (backend hook_auth.LocalWriteGuard).
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Notice } from '../../src/lib/types.ts'

type Answer = number | 'down'
let answers: Answer[] = []
let posts: string[] = []
let requests: string[] = []
let listeners: Record<string, () => void> = {}

function stubPage(hash: string, search = '') {
  const loc = { hash, pathname: '/mini', search, origin: 'http://127.0.0.1:8300' }
  vi.stubGlobal('window', {
    location: loc,
    history: { state: null, replaceState: (_s: unknown, _t: string, url: string) => { loc.hash = url.includes('#') ? url.slice(url.indexOf('#')) : '' } },
    addEventListener: (name: string, fn: () => void) => { listeners[name] = fn },
  })
  vi.stubGlobal('fetch', async (url: unknown, init: RequestInit = {}) => {
    requests.push(`${init.method ?? 'GET'} ${String(url)}`)
    if (String(url) === '/api/ui/key') {
      posts.push(String(init.body))
      const a = answers.shift() ?? 204
      if (a === 'down') throw new TypeError('Failed to fetch')
      return new Response(a === 410 ? JSON.stringify({ detail: 'gone' }) : null, { status: a })
    }
    if (String(url) === '/api/ui/paired') return new Response(JSON.stringify({ paired: true, id: 'abc123def456' }), { status: 200, headers: { 'content-type': 'application/json' } })
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  })
  return loc
}

/** The notices this page made, as the start page's strip reads them (lib/notices usePageNotices). */
function pageNotices(notices: typeof import('../../src/lib/notices.ts')): Notice[] {
  const got: Notice[] = []
  function Read() {
    got.push(...notices.usePageNotices())
    return null
  }
  renderToStaticMarkup(createElement(Read))
  return got
}

beforeEach(() => {
  answers = []
  posts = []
  requests = []
  listeners = {}
  vi.resetModules()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

test('the code is posted with the workspace, leaves the address once the server claimed it, and a write waits for the claim', async () => {
  const loc = stubPage('#p=abc', '?ws=logs')
  const { claimKey, api } = await import('../../src/lib/api.ts')
  const done = claimKey()
  expect(loc.hash).toBe('#p=abc')
  await done
  expect(posts).toEqual(['{"code":"abc","ws":"logs"}'])
  expect(loc.hash).toBe('')
  await api.corpora()
  expect(posts.length).toBe(1)
  // then the page asks once which browser it is
  await vi.advanceTimersByTimeAsync(0)
  expect(requests.filter((r) => r === 'GET /api/ui/paired')).toHaveLength(1)
})

test('on the start page the code goes alone', async () => {
  stubPage('#p=abc')
  const { claimKey } = await import('../../src/lib/api.ts')
  await claimKey()
  expect(posts).toEqual(['{"code":"abc"}'])
})

test('a code that is gone leaves the address and shows the page its own notice, whose × sends nothing', async () => {
  const loc = stubPage('#p=old', '?ws=logs')
  answers = [410]
  const { claimKey } = await import('../../src/lib/api.ts')
  const notices = await import('../../src/lib/notices.ts')
  await claimKey()
  expect(posts.length).toBe(1)
  expect(loc.hash).toBe('')
  const [gone, ...more] = pageNotices(notices)
  expect(more).toEqual([])
  expect(gone).toMatchObject({ kind: 'sign-in', text: notices.CODE_GONE_TEXT })
  expect(gone.id.startsWith(notices.PAGE_NOTICE)).toBe(true)
  await vi.advanceTimersByTimeAsync(0)
  const before = requests.length
  notices.dismissNotice(gone)
  expect(pageNotices(notices)).toEqual([])
  expect(requests.slice(before)).toEqual([])
})

test('a later link whose code signs the browser in takes the notice away, and a refusal other than 410 is no gone code', async () => {
  const loc = stubPage('#p=old', '?ws=logs')
  answers = [410, 204, 403]
  const { claimKey, claimOnHashChange, claimRefused } = await import('../../src/lib/api.ts')
  const notices = await import('../../src/lib/notices.ts')
  await claimKey()
  expect(claimRefused()).toBe(true)
  expect(pageNotices(notices)).toHaveLength(1)
  claimOnHashChange()
  loc.hash = '#p=fresh'
  listeners.hashchange()
  await claimKey()
  expect(claimRefused()).toBe(false)
  expect(pageNotices(notices)).toEqual([])
  loc.hash = '#p=other'
  listeners.hashchange()
  await claimKey()
  expect(claimRefused()).toBe(false)
  expect(posts).toEqual(['{"code":"old","ws":"logs"}', '{"code":"fresh","ws":"logs"}', '{"code":"other","ws":"logs"}'])
})

test('a claim the server does not answer is tried again, and the code stays in the address until it is', async () => {
  const loc = stubPage('#p=abc')
  answers = ['down', 502, 'down', 204]
  const { claimKey } = await import('../../src/lib/api.ts')
  const first = claimKey()
  await vi.advanceTimersByTimeAsync(5000)
  await first
  expect(posts.length).toBe(3)
  expect(loc.hash).toBe('#p=abc')
  expect(requests).not.toContain('GET /api/ui/paired')
  // the next call (a write) claims it again
  const second = claimKey()
  await vi.advanceTimersByTimeAsync(5000)
  await second
  expect(posts.length).toBe(4)
  expect(loc.hash).toBe('')
})

test('a link opened in a tab already on its page is claimed when only the hash changes', async () => {
  const loc = stubPage('')
  const { claimKey, claimOnHashChange } = await import('../../src/lib/api.ts')
  await claimKey()
  claimOnHashChange()
  expect(posts.length).toBe(0)
  loc.hash = '#p=fresh'
  listeners.hashchange()
  await claimKey()
  expect(posts).toEqual(['{"code":"fresh"}'])
  expect(loc.hash).toBe('')
})

test("an earlier version's key leaves the address and is never sent", async () => {
  const loc = stubPage('#k=secret', '?ws=logs')
  const { claimKey, claimOnHashChange } = await import('../../src/lib/api.ts')
  await claimKey()
  expect(loc.hash).toBe('')
  expect(posts).toEqual([])
  // in a tab already on its page too
  claimOnHashChange()
  loc.hash = '#k=again'
  listeners.hashchange()
  await claimKey()
  expect(loc.hash).toBe('')
  expect(posts).toEqual([])
  await vi.advanceTimersByTimeAsync(0)
  expect(requests.join('\n')).not.toMatch(/secret|again/)
})
