// @vitest-environment jsdom
// Signing in (src/shell/SignIn.tsx, src/lib/api.ts, src/lib/sse.ts): every read of the server's data needs a signed-in
// browser (backend hook_auth: 401 {detail, signin: true} without one), or a read credential of thimble's own, such as
// the one its screenshot tool sends. The page shows the app only to a browser that is signed in (GET /ui/paired, after
// the claim of the link's code) or whose reads the server answers all the same (GET /tour); any other sees one line
// that says it isn't signed in and names the way in, and the app never mounts, so nothing polls. A code the server
// refused with 410 says so first. A read refused for
// want of sign-in, or a stream closed while the browser is no longer signed in, brings the line back; a new link opened
// in the tab, or the tab shown again, checks once more.
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mount, settle, unmountAll } from './mount.tsx'

// 0.9.0: the way in is the press (/thimble browser, or o in the terminal panel), not a link /thimble shows or `thimble up`
const LINE = "This browser isn't signed in. Type /thimble browser in your Claude Code terminal, or press o in thimble's panel."
const GONE = "This link was used or has expired, so this browser isn't signed in. Type /thimble browser in your Claude Code terminal, or press o in thimble's panel."

let paired: boolean | 'down' = false
// the server answers reads without the sign-in, as it does for the screenshot tool's credential
let reads = false
let keyStatus = 204
let refuse: RegExp | null = null
let requests: string[] = []
let posts: string[] = []

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  paired = false
  reads = false
  keyStatus = 204
  refuse = null
  requests = []
  posts = []
  window.history.replaceState(null, '', '/?ws=logs')
  vi.resetModules()
  vi.stubGlobal('fetch', async (url: unknown, init: RequestInit = {}) => {
    const u = String(url)
    requests.push(`${init.method ?? 'GET'} ${u}`)
    if (u === '/api/ui/key') {
      posts.push(String(init.body))
      return new Response(keyStatus === 410 ? JSON.stringify({ detail: 'gone' }) : null, { status: keyStatus })
    }
    if (u === '/api/ui/paired') {
      if (paired === 'down') throw new TypeError('Failed to fetch')
      return json({ paired, id: paired ? 'abc123def456' : '' })
    }
    const read = (init.method ?? 'GET') === 'GET' && u !== '/api/health'
    if (refuse?.test(u) || (read && paired !== true && !reads)) return json({ detail: 'sign in', signin: true }, 401)
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
  const { bus } = await import('../../src/lib/bus.ts')
  const { SignInGate, SIGN_IN_LINE, CODE_GONE_LINE } = await import('../../src/shell/SignIn.tsx')
  const el = await mount(createElement(SignInGate, null, createElement('div', { className: 'stand-in-app' }, 'the app')))
  await settle()
  await settle()
  return { el, api, bus, SIGN_IN_LINE, CODE_GONE_LINE }
}

describe('the sign-in gate', () => {
  test('the lines are the contract the server and the release test share, and each starts by saying the browser is not signed in', async () => {
    const { SIGN_IN_LINE, CODE_GONE_LINE } = await gate()
    expect(SIGN_IN_LINE).toBe("This browser isn't signed in. Type `/thimble browser` in your Claude Code terminal, or press o in thimble's panel.")
    expect(CODE_GONE_LINE).toBe("This link was used or has expired, so this browser isn't signed in. Type `/thimble browser` in your Claude Code terminal, or press o in thimble's panel.")
  })

  test('a browser that is not signed in sees only the line, and the app never mounts or reads', async () => {
    const { el } = await gate()
    expect(el.textContent).toBe(LINE)
    expect(el.querySelector('code')?.textContent).toBe('/thimble browser')
    expect(el.querySelector('.stand-in-app')).toBeNull()
    // /ui/paired says no, and one read the server guards (refused) confirms it
    expect(requests).toEqual(['GET /api/ui/paired', 'GET /api/tour'])
  })

  test('a link whose code the server refused with 410 says so first', async () => {
    window.history.replaceState(null, '', '/?ws=logs#p=old')
    keyStatus = 410
    const { el } = await gate()
    expect(posts).toEqual(['{"code":"old","ws":"logs"}'])
    expect(el.textContent).toBe(GONE)
    expect(el.querySelector('code')?.textContent).toBe('/thimble browser')
    expect(el.querySelector('.stand-in-app')).toBeNull()
  })
})

describe('the page hears that it is signed out', () => {
  test('from any 401 that says signin, and from no other', async () => {
    const api = await import('../../src/lib/api.ts')
    const { bus } = await import('../../src/lib/bus.ts')
    let heard = 0
    const off = bus.on('signedOut', () => heard++)
    expect(await api.signInNeeded(json({ detail: 'sign in', signin: true }, 401))).toBe(true)
    expect(await api.signInNeeded(json({ detail: 'no' }, 401))).toBe(false)
    expect(await api.signInNeeded(json({ detail: 'sign in', signin: true }, 403))).toBe(false)
    expect(await api.signInNeeded(new Response(null, { status: 401 }))).toBe(false)
    // the answer can still be read after it
    const res = json({ detail: 'sign in', signin: true }, 401)
    await api.signInNeeded(res)
    expect(await res.json()).toEqual({ detail: 'sign in', signin: true })
    off()
    expect(heard).toBe(2)
  })
})
