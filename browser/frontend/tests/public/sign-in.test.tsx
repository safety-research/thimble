// @vitest-environment jsdom
// Signing in (src/shell/SignIn.tsx, src/lib/api.ts, src/lib/browserKey.ts): every read of the server's data needs a
// signed-in browser (backend hook_auth: 401 {detail, signin: true} without one). The page shows the app only to a
// browser that is signed in (GET /ui/paired, after the claim of the link's code); any other sees one line that sends
// it to the new link in the terminal where thimble-browser runs, and the app never mounts, so nothing reads. A link's
// code is posted with its workspace and leaves the address; the key the server gives for it is the path every request
// of this browser goes under (/b/<key>/api, which its cookie is scoped to). A read refused for want of sign-in brings
// the line back.
import { act, createElement } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { mount, settle, unmountAll } from './mount.tsx'

const LINE = "This browser isn't signed in. Open the new link in the terminal where thimble-browser runs."
const KEY = 'Ab3_-'.repeat(6)

let paired = false
let refuse: RegExp | null = null
/** Each request, as the page asked it. */
let requests: string[] = []
let posts: string[] = []

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  paired = false
  refuse = null
  requests = []
  posts = []
  localStorage.clear()
  window.history.replaceState(null, '', '/?ws=logs')
  vi.resetModules()
  vi.stubGlobal('fetch', async (url: unknown, init: RequestInit = {}) => {
    requests.push(`${init.method ?? 'GET'} ${String(url)}`)
    // the server answers under the browser's path as under /api
    const u = String(url).replace(`/b/${KEY}/`, '/')
    if (u === '/api/ui/key') {
      posts.push(String(init.body))
      paired = true
      return json({ key: KEY })
    }
    if (u === '/api/ui/paired') return json({ paired, id: paired ? 'abc123def456' : '' })
    const read = (init.method ?? 'GET') === 'GET' && u !== '/api/health'
    if (refuse?.test(u) || (read && !paired)) return json({ detail: 'sign in', signin: true }, 401)
    return json({})
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

/** The gate over a stand-in app, from modules loaded fresh for the test (claimKey keeps its claim per page). */
async function gate() {
  const api = await import('../../src/lib/api.ts')
  const { SignInGate } = await import('../../src/shell/SignIn.tsx')
  const el = await mount(createElement(SignInGate, null, createElement('div', { className: 'stand-in-app' }, 'the app')))
  await settle()
  await settle()
  return { el, api }
}

test('a browser that is not signed in sees only the line, and the app never mounts or reads', async () => {
  const { el } = await gate()
  expect(el.textContent).toBe(LINE)
  expect(el.querySelector('.stand-in-app')).toBeNull()
  // /ui/paired says no, and one read the server guards (refused) confirms it
  expect(requests).toEqual(['GET /api/ui/paired', 'GET /api/tour'])
})

test('a link signs the browser in: its code goes with the workspace and leaves the address, and the key the server gives is the path of every request after it', async () => {
  const { el, api } = await gate()
  api.claimOnHashChange() // as main.tsx does, once per page
  expect(el.textContent).toBe(LINE)
  // the link opened in the tab
  window.history.replaceState(null, '', '/?ws=logs#p=c0de')
  await act(async () => {
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  })
  await settle()
  await settle()
  expect(posts).toEqual(['{"code":"c0de","ws":"logs"}'])
  expect(location.hash).toBe('')
  expect(el.querySelector('.stand-in-app')?.textContent).toBe('the app')
  requests = []
  await api.api.corpora()
  expect(requests).toEqual([`GET /b/${KEY}/api/corpora`])
})

test('a read refused for want of sign-in brings the line back, in place of the app', async () => {
  paired = true
  const { el, api } = await gate()
  expect(el.querySelector('.stand-in-app')?.textContent).toBe('the app')
  refuse = /^\/api\/corpora$/
  await act(async () => {
    await expect(api.api.corpora()).rejects.toThrow(/^401 sign in$/)
  })
  expect(el.querySelector('.stand-in-app')).toBeNull()
  expect(el.textContent).toBe(LINE)
})
