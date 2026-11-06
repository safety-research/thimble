// The browser's client for the backend's routes (src/lib/api.ts, src/report/commentsApi.ts). The backend answers only
// its own origin and refuses a state-changing request whose body is not JSON (backend/app/http_guard.py), and the
// browser's sign-in cookie is scoped to /b/<key>/api/ (src/lib/browserKey.ts), so every call goes to a relative /api
// path, under the browser's own /b/<key> once it holds its key, every call that changes state sends JSON as JSON, and a
// workspace name is percent-encoded into its path segment. Every method of every client is called here with fetch
// stubbed, so a new route is held to the same rules without a line of its own. What the page logs or reports names the
// API's own path, never the key.
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import * as client from '../../src/lib/api.ts'
import { requestUrl } from '../../src/lib/problemLog.ts'
import { classifyRequest } from '../../src/lib/telemetry.ts'
import { commentsApi } from '../../src/report/commentsApi.ts'

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown }
let calls: Call[] = []
const KEY = 'Ab3_-'.repeat(6)

beforeEach(() => {
  calls = []
  vi.stubGlobal('location', { origin: 'http://127.0.0.1:8300' })
  vi.stubGlobal('fetch', async (url: unknown, init: RequestInit = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', headers: (init.headers ?? {}) as Record<string, string>, body: init.body })
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => vi.unstubAllGlobals())

// a workspace name that would change the path if it were not encoded
const WS = 'my ws/../x?y#z'
const CLIENTS: Record<string, Record<string, unknown>> = {
  api: client.api,
  canvasApi: client.canvasApi,
  reportApi: client.reportApi,
  feedbackApi: client.feedbackApi,
  labelApi: client.labelApi,
  docsApi: client.docsApi,
  scaleApi: client.scaleApi,
  undoApi: client.undoApi,
  checksApi: client.checksApi,
  commentsApi,
}

/** Every method called with the probe workspace first and plain values after it; each request it made, or the
 * address it built. */
async function callEverything(): Promise<[string, Call[] | string][]> {
  const out: [string, Call[] | string][] = []
  for (const [clientName, methods] of Object.entries(CLIENTS)) {
    for (const [name, fn] of Object.entries(methods)) {
      if (typeof fn !== 'function') continue
      calls = []
      const result = (fn as (...a: unknown[]) => unknown)(WS, 'id-1', 1, 2, 3, 4)
      if (typeof result === 'string') {
        out.push([`${clientName}.${name}`, result])
        continue
      }
      await Promise.resolve(result).catch(() => undefined)
      out.push([`${clientName}.${name}`, calls])
    }
  }
  return out
}

/** Check every call: one request each, to `base` with the workspace encoded, and JSON when it changes state. */
async function everyCallGoesTo(base: string) {
  const all = await callEverything()
  expect(all.length).toBeGreaterThan(80)
  for (const [name, made] of all) {
    const urls = typeof made === 'string' ? [made] : made.map((c) => c.url)
    if (typeof made !== 'string') expect(made.length, `${name} makes one request`).toBe(1)
    for (const url of urls) {
      expect(url.startsWith(`${base}/`), `${name}: ${url}`).toBe(true)
      expect(url, name).not.toContain(WS)
      expect(url, name).not.toMatch(/\/\.\.\//)
    }
    if (typeof made === 'string') continue
    for (const c of made) {
      if (c.method === 'GET') continue
      expect(c.headers['content-type'], name).toBe('application/json')
      if (c.body != null) expect(() => JSON.parse(String(c.body)), name).not.toThrow()
    }
  }
}

test("every request goes to a relative /api path, under the browser's own path once it holds its key, with the workspace encoded and JSON for a change", async () => {
  await everyCallGoesTo('/api')
  // lib/browserKey: the server scopes the cookie to /b/<key>/api/, so a request to /api/ itself would go unsigned
  const held = new Map([['thimble-browser-key', KEY]])
  vi.stubGlobal('window', {
    localStorage: { getItem: (k: string) => held.get(k) ?? null, setItem: (k: string, v: string) => void held.set(k, v) },
    location: { hash: '', search: '', pathname: '/', origin: 'http://127.0.0.1:8300' },
    history: { state: null, replaceState: () => undefined },
    addEventListener: () => undefined,
  })
  await everyCallGoesTo(`/b/${KEY}/api`)
})

test('the problem log and the telemetry name the API path, never the key', () => {
  expect(requestUrl(`/b/${KEY}/api/ws/w/canvas?x=1`, 'http://127.0.0.1:8300')).toBe('/api/ws/w/canvas?x=1')
  expect(requestUrl(`http://127.0.0.1:8300/b/${KEY}/api/corpora`, 'http://127.0.0.1:8300')).toBe('/api/corpora')
  const body = JSON.stringify({ kind: 'main', payload: { text: 'hi' } })
  expect(classifyRequest('POST', `/b/${KEY}/api/ws/w/events`, body)).toEqual(classifyRequest('POST', '/api/ws/w/events', body))
  expect(classifyRequest('POST', `/b/${KEY}/api/ws/w/events`, body)).not.toBeNull()
})
