// The tab's problem log (src/lib/problemLog.ts), which Report a problem sends with the logs: the ring keeps the last
// entries and cuts a long one; a console.error call, an uncaught error, an unhandled rejection, a request that answered
// 400 or more (with the start of its answer) and one that got no answer are kept, while a request that succeeded or
// was aborted is not; a request to another server keeps its address without the password; wiring twice wraps nothing
// twice.
import { describe, expect, test } from 'vitest'
import { consoleText, installProblemLog, recentProblems, requestUrl, Ring, TEXT_MAX } from '../../src/lib/problemLog.ts'

describe('the problem log', () => {
  test('the ring keeps the last entries, oldest first, and cuts a long text', () => {
    const r = new Ring(3)
    for (let i = 0; i < 5; i++) r.push({ ts: 't', kind: 'console', text: `e${i}` })
    expect(r.list().map((e) => e.text)).toEqual(['e2', 'e3', 'e4'])
    r.push({ ts: 't', kind: 'console', text: 'x'.repeat(TEXT_MAX + 50) })
    const last = r.list().at(-1)!.text
    expect(last.startsWith('x'.repeat(TEXT_MAX))).toBe(true)
    expect(last.endsWith('[50 more characters]')).toBe(true)
  })

  test('a console call joins strings as they are, an Error by its message and first frame, objects as JSON', () => {
    const line = consoleText(['draw failed', new Error('kaput'), { rows: 0 }, 3])
    expect(line.startsWith('draw failed kaput')).toBe(true)
    expect(line).toContain('{"rows":0} 3')
    const loop: Record<string, unknown> = {}
    loop.self = loop
    expect(consoleText([loop])).toBe('[object Object]')
  })

  test("a request keeps this server's path and query, and another server's address without its password", () => {
    const o = 'http://localhost:5300'
    expect(requestUrl('/api/ws/mini/views?x=1', o)).toBe('/api/ws/mini/views?x=1')
    expect(requestUrl(new URL('http://localhost:5300/api/health'), o)).toBe('/api/health')
    expect(requestUrl('https://tester:hunter2@example.com/data.json', o)).toBe('https://example.com/data.json')
    expect(requestUrl(`/api/${'a'.repeat(400)}`, o).length).toBeLessThan(400)
  })

  test('the wired window records console errors, uncaught errors, rejections and failed requests, once', async () => {
    const listeners: Record<string, (e: unknown) => void> = {}
    const printed: unknown[][] = []
    const answers: Record<string, () => Promise<Response> | Response> = {
      '/ok': () => new Response('{}', { status: 200 }),
      '/missing': () => new Response('{"detail": "no such view"}', { status: 404, statusText: 'Not Found' }),
      '/down': () => Promise.reject(new TypeError('Failed to fetch')),
      '/aborted': () => Promise.reject(new DOMException('aborted', 'AbortError')),
    }
    const win = {
      location: { origin: 'http://localhost:5300' },
      console: { error: (...a: unknown[]) => void printed.push(a) },
      addEventListener: (type: string, fn: (e: unknown) => void) => void (listeners[type] = fn),
      fetch: async (input: RequestInfo | URL, _init?: RequestInit) => answers[new URL(String(input), 'http://localhost:5300').pathname](),
    }
    type Win = Parameters<typeof installProblemLog>[0]
    expect(installProblemLog(win as unknown as Win)).toBe(true)
    expect(installProblemLog(win as unknown as Win)).toBe(false)
    win.console.error('the chart failed', new Error('kaput'))
    expect(printed).toHaveLength(1)
    listeners.error({ message: 'boom', error: new Error('boom') })
    listeners.unhandledrejection({ reason: new Error('lost promise') })
    expect((await win.fetch('/ok')).status).toBe(200)
    expect((await win.fetch('/missing', { method: 'post' })).status).toBe(404)
    await expect(win.fetch('/down')).rejects.toThrow()
    await expect(win.fetch('/aborted')).rejects.toThrow()
    await new Promise((r) => setTimeout(r, 20))
    // a failed answer's entry is kept once its body is read, so the entries are compared in the order of their times
    const got = recentProblems()
      .sort((a, b) => a.ts.localeCompare(b.ts))
      .map((e) => [e.kind, e.method ?? null, e.url ?? null, e.status ?? null, e.text.split(' | ')[0]])
    expect(got).toEqual([
      ['console', null, null, null, 'the chart failed kaput'],
      ['error', null, null, null, 'boom'],
      ['rejection', null, null, null, 'lost promise'],
      ['request', 'POST', '/missing', 404, '404 Not Found: {"detail": "no such view"}'],
      ['request', 'GET', '/down', null, 'no answer: Failed to fetch'],
    ])
    expect(recentProblems().every((e) => typeof e.ts === 'string' && e.ts.endsWith('Z'))).toBe(true)
  })
})
