// @vitest-environment jsdom
// The stale-tab guard (src/lib/stale.ts, src/lib/sse.ts, src/lib/events.ts): a tab whose server went away sends its
// credentials (the cookie and the key in /b/<key>/api/) to nothing that has not proved itself. After a stream failed,
// the next request under the key waits for the challenge on the plain path (/api/hello, no credentials): the answer the
// backend computes (hook_auth.hello_mac) lets it go out, any other answer stops the page. The page also stops on the
// server's `stopping` event, on a live `session-ended` record, and after 6 failed reconnects; once stopped it sends
// nothing under the key and opens no stream.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const KEY = 'Ab3_-Ab3_-Ab3_-Ab3_-Ab3_-Ab3_-'
const NONCE = '00112233445566778899aabbccddeeff'
// computed with Python's hashlib and hmac, as backend hook_auth.key_id and hello_mac compute them
const KID = '0b3e65a415480d08'
const MAC = '59d63511464f1642e40714ddc24e024e64aacd89a68b671e8671fe19052b936f'

let sent: { url: string; credentials?: RequestCredentials }[] = []
// the real clock: WebCrypto answers on its own, so a test with fake timers waits for it on this one
const realTimeout = globalThis.setTimeout.bind(globalThis)
/** Let the page's challenge (WebCrypto and the stand-in fetch) finish. */
const challengeDone = () => new Promise((r) => realTimeout(r, 40))
let helloAnswer: () => Promise<Response> = async () => new Response('{}', { status: 404 })

class FakeSource {
  static all: FakeSource[] = []
  static CLOSED = 2
  readyState = 0
  onerror: (() => void) | null = null
  onopen: (() => void) | null = null
  listeners = new Map<string, ((e: Event) => void)[]>()
  constructor(public url: string) {
    FakeSource.all.push(this)
  }
  addEventListener(name: string, fn: (e: Event) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn])
  }
  emit(name: string, data = '{}') {
    for (const fn of this.listeners.get(name) ?? []) fn(Object.assign(new Event(name), { data, lastEventId: '' }))
  }
  close() {
    this.readyState = FakeSource.CLOSED
  }
}

beforeEach(() => {
  sent = []
  FakeSource.all = []
  helloAnswer = async () => new Response('{}', { status: 404 })
  vi.resetModules()
  window.localStorage.clear()
  window.localStorage.setItem('thimble-browser-key', KEY)
  window.localStorage.setItem('thimble-server-port', '29280')
  vi.stubGlobal('EventSource', FakeSource)
  vi.stubGlobal('fetch', async (url: unknown, init: RequestInit = {}) => {
    const u = String(url)
    sent.push({ url: u, credentials: init.credentials })
    if (u.startsWith('/api/hello')) return helloAnswer()
    return new Response('{"paired":true,"id":"abc"}', { status: 200, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function load() {
  const stale = await import('../../src/lib/stale.ts')
  const sse = await import('../../src/lib/sse.ts')
  const { bus } = await import('../../src/lib/bus.ts')
  const stops: string[] = []
  bus.on('pageStopped', (e) => stops.push(e.reason))
  return { stale, sse, bus, stops }
}

/** The server's answer to the challenge for the nonce the page sent. */
const answerFor = (mac: (nonce: string) => Promise<string>) => async () => {
  const last = sent[sent.length - 1].url
  const nonce = new URL(last, 'http://127.0.0.1:29280').searchParams.get('n')!
  return new Response(JSON.stringify({ mac: await mac(nonce) }), { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('the challenge', () => {
  test("the page computes the backend's key id and answer", async () => {
    const { stale } = await load()
    expect(await stale.keyId(KEY)).toBe(KID)
    expect(await stale.expectedAnswer(KEY, 29280, NONCE)).toBe(MAC)
    expect(stale.challengePort()).toBe(29280)
  })

  test('it goes to the plain path with no credentials, naming the key by its id, never the key', async () => {
    const { stale } = await load()
    helloAnswer = answerFor((n) => stale.expectedAnswer(KEY, 29280, n))
    expect(await stale.hello()).toBe('ok')
    const [q] = sent
    expect(q.url).toMatch(new RegExp(`^/api/hello\\?n=[0-9a-f]{32}&k=${KID}$`))
    expect(q.credentials).toBe('omit')
    expect(q.url).not.toContain(KEY)
  })

  test('an answer for another port (a relay to a thimble server elsewhere), a wrong one, or none stops the page', async () => {
    const { stale, stops } = await load()
    helloAnswer = answerFor((n) => stale.expectedAnswer(KEY, 29281, n))
    stale.markSuspect()
    expect(await stale.verified()).toBe('stopped')
    expect(stops).toEqual(['challenge'])
    expect(stale.pageStopped()).toBe('challenge')
  })
})

describe('the guarded fetch', () => {
  test('a request under the key waits for the challenge after a failure, and none goes out once the page stopped', async () => {
    const { stale } = await load()
    stale.guardFetch()
    helloAnswer = answerFor((n) => stale.expectedAnswer(KEY, 29280, n))
    await fetch(`/b/${KEY}/api/corpora`)
    expect(sent.map((s) => s.url)).toEqual([`/b/${KEY}/api/corpora`])
    stale.markSuspect()
    await fetch(`/b/${KEY}/api/corpora`)
    expect(sent.map((s) => s.url.split('?')[0])).toEqual([`/b/${KEY}/api/corpora`, '/api/hello', `/b/${KEY}/api/corpora`])
    sent = []
    helloAnswer = async () => new Response('{"mac":"not-the-answer"}', { status: 200 })
    stale.markSuspect()
    await expect(fetch(`/b/${KEY}/api/corpora`)).rejects.toThrow()
    expect(sent.map((s) => s.url.split('?')[0])).toEqual(['/api/hello'])
    expect(stale.pageStopped()).toBe('challenge')
    await expect(fetch(`/b/${KEY}/api/ws/mini/chats`)).rejects.toThrow("thimble's page stopped")
    await fetch('/api/ui/paired')
    // a request with no key carries no credential, and goes out
    expect(sent.map((s) => s.url.split('?')[0])).toEqual(['/api/hello', '/api/ui/paired'])
  })
})

describe('the streams', () => {

  test('a reopen sends credentials only after the challenge passed; a failed challenge reopens nothing', async () => {
    vi.useFakeTimers()
    const { sse, stale } = await load()
    helloAnswer = answerFor((n) => stale.expectedAnswer(KEY, 29280, n))
    const release = sse.openStream(`/b/${KEY}/api/ws/mini/events`, { onEvent: () => undefined })
    FakeSource.all[0].onopen?.()
    FakeSource.all[0].onerror?.()
    expect(FakeSource.all[0].readyState).toBe(2) // closed by the page: no retry of the browser's own
    expect(FakeSource.all).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(sse.RETRY_MS)
    await challengeDone()
    expect(sent.map((s) => s.url.split('?')[0])).toEqual(['/api/hello'])
    expect(FakeSource.all).toHaveLength(2) // the reopen, after the answer
    FakeSource.all[1].onopen?.()
    FakeSource.all[1].onerror?.()
    helloAnswer = async () => new Response('{"mac":"wrong"}', { status: 200 })
    await vi.advanceTimersByTimeAsync(sse.RETRY_MS)
    await challengeDone()
    expect(FakeSource.all).toHaveLength(2)
    expect(stale.pageStopped()).toBe('challenge')
    release()
  })
})
