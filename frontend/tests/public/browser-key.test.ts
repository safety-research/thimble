// @vitest-environment jsdom
// The path this browser reaches the API under (src/lib/browserKey.ts). The server scopes a browser's sign-in cookie to
// /b/<key>/api/ and gives the page the key when it trades the link's code (backend hook_auth.claim), so the browser
// never sends the cookie to another server on 127.0.0.1 or localhost. The page keeps the key in localStorage, which a
// new tab of the same browser reads, and every request it makes to the API goes under that path: the claim's answer
// keeps the key, every client call and every address it builds (media, a PDF, a download, an event stream) uses it,
// markup's media routes are asked under it, and no source file names /api for a request any other way. What the page
// logs or reports names the API's own path, never the key.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const KEY = 'Ab3_-'.repeat(6)
const SRC = join(__dirname, '../../src')

beforeEach(() => {
  localStorage.clear()
  vi.resetModules()
})
afterEach(() => vi.unstubAllGlobals())

test('without a key the page asks the API itself; with one, everything goes under /b/<key>/api', async () => {
  const k = await import('../../src/lib/browserKey.ts')
  expect([k.browserKey(), k.apiBase(), k.apiUrl('/api/health')]).toEqual(['', '/api', '/api/health'])
  expect(k.setBrowserKey('short')).toBe(false)
  expect(k.setBrowserKey('../../etc/passwd/xxxxxxxx')).toBe(false)
  expect(k.browserKey()).toBe('')
  expect(k.setBrowserKey(KEY)).toBe(true)
  expect(localStorage.getItem(k.KEY_ITEM)).toBe(KEY)
  expect(k.apiBase()).toBe(`/b/${KEY}/api`)
  expect(k.apiUrl('/api/ws/w/media?path=a.png')).toBe(`/b/${KEY}/api/ws/w/media?path=a.png`)
  expect(k.apiUrl(`${location.origin}/api/ws/w/media?path=a.png`)).toBe(`${location.origin}/b/${KEY}/api/ws/w/media?path=a.png`)
  expect(k.apiUrl('https://example.com/api/x')).toBe('https://example.com/api/x')
  expect(k.apiUrl('/apix')).toBe('/apix')
  expect(k.apiUrl('data:image/png;base64,AA')).toBe('data:image/png;base64,AA')
  expect(k.apiPath(`/b/${KEY}/api/ws/w/canvas`)).toBe('/api/ws/w/canvas')
  expect(k.apiPath('/api/ws/w/canvas')).toBe('/api/ws/w/canvas')
  localStorage.setItem(k.KEY_ITEM, 'not a key at all')
  expect(k.apiBase()).toBe('/api')
})

test("the claim's answer keeps the key, a signed-in browser's claim goes under its path and keeps it, and requests follow", async () => {
  const seen: string[] = []
  let answer: () => Response = () => new Response(JSON.stringify({ key: KEY }), { status: 200, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', async (url: unknown, init: RequestInit = {}) => {
    seen.push(`${init.method ?? 'GET'} ${String(url)}`)
    if (String(url).endsWith('/ui/key')) return answer()
    return new Response(JSON.stringify({ paired: true, id: 'abc123def456' }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  history.replaceState(null, '', '/?ws=logs#p=c0de')
  const { api, claimKey, claimOnHashChange } = await import('../../src/lib/api.ts')
  await claimKey()
  expect(seen[0]).toBe('POST /api/ui/key')
  expect(localStorage.getItem('thimble-browser-key')).toBe(KEY)
  expect(location.hash).toBe('')
  await api.corpora()
  expect(seen.slice(1)).toEqual([`GET /b/${KEY}/api/ui/paired`, `GET /b/${KEY}/api/corpora`])
  // a later link in the same tab: the browser is signed in, so the claim goes under its path and 204 keeps the key
  answer = () => new Response(null, { status: 204 })
  claimOnHashChange()
  history.replaceState(null, '', '/?ws=logs#p=next')
  window.dispatchEvent(new HashChangeEvent('hashchange'))
  await claimKey()
  expect(seen).toContain(`POST /b/${KEY}/api/ui/key`)
  expect(localStorage.getItem('thimble-browser-key')).toBe(KEY)
})

test('the problem log and the telemetry name the API path, never the key', async () => {
  const { requestUrl } = await import('../../src/lib/problemLog.ts')
  const { classifyRequest } = await import('../../src/lib/telemetry.ts')
  expect(requestUrl(`/b/${KEY}/api/ws/w/canvas?x=1`, location.origin)).toBe('/api/ws/w/canvas?x=1')
  expect(requestUrl(`${location.origin}/b/${KEY}/api/corpora`, location.origin)).toBe('/api/corpora')
  const body = JSON.stringify({ kind: 'main', payload: { text: 'hi' } })
  expect(classifyRequest('POST', `/b/${KEY}/api/ws/w/events`, body)).toEqual(classifyRequest('POST', '/api/ws/w/events', body))
  expect(classifyRequest('POST', `/b/${KEY}/api/ws/w/events`, body)).not.toBeNull()
})

/** Every .ts and .tsx file under `dir`. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? sources(p) : /\.tsx?$/.test(name) ? [p] : []
  })
}

test('no source file names an API path for a request but through lib/browserKey', () => {
  // a string or template literal that starts with /api: allowed only as the argument of apiUrl, or as the path a
  // startsWith test compares (render.tsx), never as an address the page asks for
  const literal = /(['"`])\/api(?=[/'"`?])/g
  const found: string[] = []
  for (const file of sources(SRC)) {
    if (file.endsWith('/lib/browserKey.ts')) continue
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, '')
      for (const m of code.matchAll(literal)) {
        const before = code.slice(0, m.index)
        if (/apiUrl\($/.test(before) || /\.startsWith\($/.test(before)) continue
        found.push(`${file.slice(SRC.length + 1)}:${i + 1}: ${line.trim()}`)
      }
    })
  }
  expect(found).toEqual([])
})
