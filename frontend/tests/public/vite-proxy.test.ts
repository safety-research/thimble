// The dev server's /api proxy (vite.config.ts). The backend refuses a state-changing request whose Origin is not its
// own (backend/app/http_guard.py), so the proxy renames the Origin of a request its own page sent to the backend's, and
// leaves every other Origin as it came, to be refused there.
import { describe, expect, test } from 'vitest'
import config, { ownOriginToTarget } from '../../vite.config.ts'

const TARGET = 'http://127.0.0.1:8300'

/** The Origin the proxied request leaves with, or null when the proxy left it alone. */
function renamed(headers: Record<string, string | undefined>): string | null {
  const set: Record<string, string> = {}
  ownOriginToTarget({ getHeader: () => undefined, setHeader: (k, v) => (set[k] = v) }, { headers }, TARGET)
  return set.origin ?? null
}

describe('vite proxy', () => {
  test("renames its own page's Origin to the backend's", () => {
    expect(renamed({ origin: 'http://localhost:5300', host: 'localhost:5300' })).toBe(TARGET)
    expect(renamed({ origin: 'http://127.0.0.1:5412', host: '127.0.0.1:5412' })).toBe(TARGET)
  })

  test('leaves a foreign, opaque or missing Origin as it came', () => {
    expect(renamed({ origin: 'https://evil.example', host: 'localhost:5300' })).toBeNull()
    expect(renamed({ origin: 'http://localhost:5301', host: 'localhost:5300' })).toBeNull()
    expect(renamed({ origin: 'null', host: 'localhost:5300' })).toBeNull()
    expect(renamed({ origin: 'file:///tmp/a.html', host: 'localhost:5300' })).toBeNull()
    expect(renamed({ host: 'localhost:5300' })).toBeNull()
  })

  test('the /api proxy runs the rename on every request', () => {
    const resolved = typeof config === 'function' ? null : config
    const api = resolved?.server?.proxy?.['/api']
    if (!api || typeof api === 'string') throw new Error('vite.config.ts proxies /api')
    expect(api.target).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const handlers: Record<string, (...args: any[]) => void> = {}
    api.configure?.({ on: (event: string, fn: (...args: any[]) => void) => (handlers[event] = fn) } as any, api)
    const set: Record<string, string> = {}
    handlers.proxyReq({ getHeader: () => undefined, setHeader: (k: string, v: string) => (set[k] = v) }, { headers: { origin: 'http://localhost:5300', host: 'localhost:5300' } })
    expect(set.origin).toBe(api.target)
  })
})
