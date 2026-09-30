// The page's claim of the key in thimble's link (src/lib/api.ts claimKey): the key leaves the address only once the
// server has answered, a claim the server never answered is tried again, and a link opened in a tab already on its page
// (a change of the hash alone) is claimed too. Every write waits for the claim (backend hook_auth.LocalWriteGuard).
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

type Answer = number | 'down'
let answers: Answer[] = []
let posts: string[] = []
let listeners: Record<string, () => void> = {}

function stubPage(hash: string) {
  const loc = { hash, pathname: '/mini', search: '', origin: 'http://127.0.0.1:8300' }
  vi.stubGlobal('window', {
    location: loc,
    history: { state: null, replaceState: (_s: unknown, _t: string, url: string) => { loc.hash = url.includes('#') ? url.slice(url.indexOf('#')) : '' } },
    addEventListener: (name: string, fn: () => void) => { listeners[name] = fn },
  })
  vi.stubGlobal('fetch', async (url: unknown, init: RequestInit = {}) => {
    if (String(url) === '/api/ui/key') {
      posts.push(String(init.body))
      const a = answers.shift() ?? 204
      if (a === 'down') throw new TypeError('Failed to fetch')
      return new Response(null, { status: a })
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  })
  return loc
}

beforeEach(() => {
  answers = []
  posts = []
  listeners = {}
  vi.resetModules()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

test('the key leaves the address once the server claimed it, and a write waits for the claim', async () => {
  const loc = stubPage('#k=abc')
  const { claimKey, api } = await import('../../src/lib/api.ts')
  const done = claimKey()
  expect(loc.hash).toBe('#k=abc')
  await done
  expect(posts).toEqual(['{"key":"abc"}'])
  expect(loc.hash).toBe('')
  await api.corpora()
  expect(posts.length).toBe(1)
})

test('a claim the server does not answer is tried again, and the key stays in the address until it is', async () => {
  const loc = stubPage('#k=abc')
  answers = ['down', 502, 'down', 204]
  const { claimKey } = await import('../../src/lib/api.ts')
  const first = claimKey()
  await vi.advanceTimersByTimeAsync(5000)
  await first
  expect(posts.length).toBe(3)
  expect(loc.hash).toBe('#k=abc')
  // the next call (a write) claims it again
  const second = claimKey()
  await vi.advanceTimersByTimeAsync(5000)
  await second
  expect(posts.length).toBe(4)
  expect(loc.hash).toBe('')
})

test('a key the server refuses leaves the address, since another try would be refused too', async () => {
  const loc = stubPage('#k=stale')
  answers = [403]
  const { claimKey } = await import('../../src/lib/api.ts')
  await claimKey()
  expect(posts.length).toBe(1)
  expect(loc.hash).toBe('')
})

test('a link opened in a tab already on its page is claimed when only the hash changes', async () => {
  const loc = stubPage('')
  const { claimKey, claimOnHashChange } = await import('../../src/lib/api.ts')
  await claimKey()
  claimOnHashChange()
  expect(posts.length).toBe(0)
  loc.hash = '#k=fresh'
  listeners.hashchange()
  await claimKey()
  expect(posts).toEqual(['{"key":"fresh"}'])
  expect(loc.hash).toBe('')
})
