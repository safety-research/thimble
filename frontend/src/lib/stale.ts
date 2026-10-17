// The stale-tab guard. thimble's page outlives its server: the server stops with the Claude Code session, and another
// program may later hold its port. A tab must then send nothing that carries this browser's credentials (its cookie and
// its key, both bound to the path /b/<key>/api/: lib/browserKey) to whatever answers there.
//
// The page stops (stopPage) on the server's `stopping` event (it stops for good: backend main.CompleteStreams), on
// `session-ended` for its workspace (backend main.session_ended), after MAX_FAILURES failed reconnects in a row
// (lib/sse), and when the challenge below fails. A stopped page closes its streams, sends no request under its key
// (guardFetch), and shows the stopped line in place of the app (shell/ServerDown StoppedPage). The stopped line asks
// now and then, with no credentials, whether the server answers again as itself (serverBack, the challenge below), and
// reloads the page once it does (bug hunt H6: after `claude -c` and `/thimble browser` the old tab stayed stopped).
//
// A stream that fails makes the page suspect (markSuspect). Before the next request under its key (a stream's reopen,
// any fetch) the page asks the plain path /api/hello with no credentials, naming its key by an id that tells nothing of
// it, for an HMAC of a fresh nonce under the sha256 of its key, bound to the port the server listens on (backend
// hook_auth.hello; the port is the one the claim answered, else the page's own). A program that is not this server
// cannot answer, and a relay to a thimble server on another port answers for that port: the page stops. A server that
// does not answer at all leaves the page suspect, and lib/sse counts a failed reconnect. A browser the server signed
// out (`thimble unpair`, Sign it out, Settings' Sign out this browser) gets an answer of its own under the same key
// (backend hook_auth.hello_out_mac): the page does not stop but forgets the spent key, shows the sign-in line (bus
// `signedOut`), and goes on once a sign-in here or in another tab gives the browser a new key (bug hunt G4: a
// signed-out tab showed that thimble stopped, for good).
import { browserKey, clearBrowserKey, plainApiPath, serverPort } from './browserKey'
import { bus } from './bus'

export type StopReason = 'stopping' | 'session-ended' | 'failures' | 'challenge'

/** Failed reconnects in a row after which the page stops. */
export const MAX_FAILURES = 6
/** The challenge's route on the API's own path (backend hook_auth.HELLO_PATH). */
export const HELLO_PATH = plainApiPath('/hello')

let stopped: StopReason | null = null
let suspect = false
// the challenge under way, with the key it was asked for
let checking: Promise<{ v: Verdict; key: string }> | null = null

/** Why the page stopped, null while it runs. */
export const pageStopped = (): StopReason | null => stopped

/** Stop the page (module note): once; bus `pageStopped`. */
export function stopPage(reason: StopReason): void {
  if (stopped) return
  stopped = reason
  bus.emit('pageStopped', { reason })
}

/** A stream failed: the next request under the key waits for the challenge. */
export function markSuspect(): void {
  if (!stopped) suspect = true
}

/** Whether the page waits for the challenge before its next request under the key. */
export const isSuspect = (): boolean => suspect

/** For tests: the page runs again, not suspect. */
export function resetStale(): void {
  stopped = null
  suspect = false
  checking = null
}

/** The challenge's outcome: `ok` the server proved itself, `out` it proved itself and signed this browser out,
 * `down` nothing answered, `refused` an answer that is not the server's (or the server does not know the key). */
export type Verdict = 'ok' | 'out' | 'down' | 'refused'

const enc = new TextEncoder()
const hex = (buf: ArrayBuffer): string => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')

async function sha256(text: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(text)))
}

/** HMAC-SHA256 of `message` under the UTF-8 bytes of `secret`, as hex. */
export async function hmac(secret: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(message)))
}

/** The key's id in the challenge: the first 16 hex digits of sha256(sha256(key)) (backend hook_auth.key_id). */
export async function keyId(key: string): Promise<string> {
  return (await sha256(await sha256(key))).slice(0, 16)
}

/** The answer this page expects for `nonce` (backend hook_auth.hello_mac). */
export async function expectedAnswer(key: string, port: number, nonce: string): Promise<string> {
  return hmac(await sha256(key), `hello:${port}:${nonce}`)
}

/** The answer this page expects for `nonce` once the server signed this browser out (backend hook_auth.hello_out_mac). */
export async function expectedOutAnswer(key: string, port: number, nonce: string): Promise<string> {
  return hmac(await sha256(key), `signed-out:${port}:${nonce}`)
}

/** The port the server this page signed in with listens on: the claim's answer, else the page's own. */
export function challengePort(): number {
  const kept = serverPort()
  if (kept) return kept
  if (typeof location === 'undefined') return 80
  return Number(location.port) || (location.protocol === 'https:' ? 443 : 80)
}

let plainFetch: typeof fetch | null = null

/** Ask the challenge once with no credentials, through the fetch guardFetch wrapped (the plain path carries none). */
export async function hello(key: string = browserKey()): Promise<Verdict> {
  if (!key) return 'ok'
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)).buffer as ArrayBuffer)
  let res: Response
  try {
    res = await (plainFetch ?? fetch)(`${HELLO_PATH}?n=${nonce}&k=${await keyId(key)}`, { credentials: 'omit', cache: 'no-store' })
  } catch {
    return 'down'
  }
  if (res.status !== 200) return 'refused'
  try {
    const body = (await res.json()) as { mac?: unknown; out?: unknown } | null
    if (typeof body?.mac === 'string' && body.mac === (await expectedAnswer(key, challengePort(), nonce))) return 'ok'
    if (typeof body?.out === 'string' && body.out === (await expectedOutAnswer(key, challengePort(), nonce))) return 'out'
    return 'refused'
  } catch {
    return 'refused'
  }
}

/** Before a request under the key: `ok` when the page is not suspect or the challenge passed (then it is not suspect
 * any more), `down` when nothing answered (it stays suspect), `out` when the server signed this browser out (it stays
 * suspect, and the page shows the sign-in line: bus `signedOut`), `stopped` when the page stopped or the challenge
 * failed (which stops it). One challenge at a time. */
export async function verified(): Promise<'ok' | 'out' | 'down' | 'stopped'> {
  if (stopped) return 'stopped'
  if (!suspect) return 'ok'
  checking ??= (async () => {
    const key = browserKey()
    return { v: await hello(key), key }
  })().finally(() => {
    checking = null
  })
  const { v, key } = await checking
  if (stopped) return 'stopped'
  if (v === 'ok') {
    suspect = false
    return 'ok'
  }
  if (v === 'refused') {
    stopPage('challenge')
    return 'stopped'
  }
  if (v === 'out') {
    // the key is spent: forget it, unless a sign-in meanwhile gave a new one, so the next sign-in's claim goes out and
    // every tab asks again whether it is signed in (shell/SignIn)
    if (browserKey() === key) clearBrowserKey()
    bus.emit('signedOut', {})
    return 'out'
  }
  return 'down'
}

/** After the page stopped: whether thimble's server answers again as itself (the challenge, asked with no credentials:
 * `ok`, or `out` for a browser it signed out since, which a reload shows the sign-in line), so a reload brings the page
 * back. A page that holds no key asks the plain path and takes any answer. Never sends the key or the cookie. */
export async function serverBack(): Promise<boolean> {
  const key = browserKey()
  if (!key) {
    try {
      await (plainFetch ?? fetch)(HELLO_PATH, { credentials: 'omit', cache: 'no-store' })
      return true
    } catch {
      return false
    }
  }
  const v = await hello(key)
  return v === 'ok' || v === 'out'
}

/** Whether `url` is a request under some browser's key on this page's own origin (one that carries credentials). */
export function underKey(url: string): boolean {
  try {
    const u = new URL(url, typeof location !== 'undefined' ? location.href : 'http://127.0.0.1/')
    return (typeof location === 'undefined' || u.origin === location.origin) && u.pathname.startsWith('/b/')
  } catch {
    return false
  }
}

/** Wrap the page's fetch once (main.tsx): a request under the key goes out only while the page runs and, after a
 * stream failed, once the challenge passed; otherwise it fails as a network error would, and sends nothing. */
export function guardFetch(): void {
  if (typeof window === 'undefined' || plainFetch) return
  const original = window.fetch.bind(window)
  plainFetch = original
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (underKey(url)) {
      if (stopped) throw new TypeError("thimble's page stopped")
      if (suspect) {
        const v = await verified()
        if (v === 'out') throw new TypeError("this browser isn't signed in")
        if (v !== 'ok') throw new TypeError("thimble's server is not answering")
      }
    }
    return original(input, init)
  }
}
