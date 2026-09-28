// The browser's client for the backend's routes (src/lib/api.ts, src/report/commentsApi.ts). The backend answers only
// its own origin and refuses a state-changing request whose body is not JSON (backend/app/http_guard.py), so every
// call goes to a relative /api path, every call that changes state sends JSON as JSON, and a workspace name or an id
// is percent-encoded into its path segment. Every method of every client is called here with fetch stubbed, so a new
// route is held to the same rules without a line of its own.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import * as client from '../../src/lib/api.ts'
import { commentsApi } from '../../src/report/commentsApi.ts'

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown }
let calls: Call[] = []

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

/** Every method called with the probe workspace first and plain values after it; each request it made. */
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

describe('the API client', () => {
  test('every request goes to a relative /api path, and every workspace name in a path is encoded', async () => {
    const all = await callEverything()
    expect(all.length).toBeGreaterThan(80)
    for (const [name, made] of all) {
      const urls = typeof made === 'string' ? [made] : made.map((c) => c.url)
      if (typeof made !== 'string') expect(made.length, `${name} makes one request`).toBe(1)
      for (const url of urls) {
        expect(url, name).toMatch(/^\/api\//)
        expect(url, name).not.toContain(WS)
        expect(url, name).not.toMatch(/\/\.\.\//)
      }
    }
  })

  test('every request that changes state sends JSON, named as JSON', async () => {
    for (const [name, made] of await callEverything()) {
      if (typeof made === 'string') continue
      for (const c of made) {
        if (c.method === 'GET') continue
        expect(c.headers['content-type'], name).toBe('application/json')
        if (c.body != null) expect(() => JSON.parse(String(c.body)), name).not.toThrow()
      }
    }
  })

  test("a message, the Report tab's Write and the Start panel reach the session as events of the one events route", async () => {
    await client.api.postEvent('w', 'main', { text: 'How many reviews?' })
    await client.api.write('w', 'report', { text: 'Add the review load.', after: 'report:report#p1' })
    await client.api.start('w', { effort: 'high' } as never)
    expect(calls.map((c) => [c.method, c.url, JSON.parse(String(c.body))])).toEqual([
      ['POST', '/api/ws/w/events', { kind: 'main', payload: { text: 'How many reviews?' } }],
      ['POST', '/api/ws/w/events', { kind: 'write', payload: { doc: 'report', text: 'Add the review load.', after: 'report:report#p1' } }],
      ['POST', '/api/ws/w/events', { kind: 'start', payload: { effort: 'high' } }],
    ])
  })
})
