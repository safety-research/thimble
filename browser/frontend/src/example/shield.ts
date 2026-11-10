// The example frame's walls, put up before any module of the app runs (./main.tsx imports this first). Its requests to
// thimble's API are answered by the example's server (./server.ts); it fetches nothing else but the app's own files
// (its scripts, styles and fonts). Its storage is its own, in memory, and goes with the frame, so nothing the person
// does in it is kept in the browser or touches the storage of their workspace. It opens no stream and sends no beacon.
//
// The one page it reads from thimble's server is the Timeline mode's: the view kit's own page, which is the same for
// every folder and holds none of the folder's data. It is read under the workspace of the page around the frame, with
// that page's sign-in, as the page itself reads it.
import { createServer } from './server'

const realFetch = window.fetch.bind(window)
const realStorage = (() => {
  try {
    return window.localStorage
  } catch {
    return null
  }
})()

/** A Storage that lives in memory, with `seed` in it at the start. */
class MemoryStorage implements Storage {
  private items = new Map<string, string>()
  constructor(seed: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(seed)) this.items.set(k, v)
  }
  get length(): number {
    return this.items.size
  }
  clear(): void {
    this.items.clear()
  }
  getItem(key: string): string | null {
    return this.items.get(String(key)) ?? null
  }
  key(i: number): string | null {
    return [...this.items.keys()][i] ?? null
  }
  removeItem(key: string): void {
    this.items.delete(String(key))
  }
  setItem(key: string, value: string): void {
    this.items.set(String(key), String(value))
  }
}

/** The page around the frame, when it is the workbench of the same origin; null when the frame is opened alone. */
function host(): Window | null {
  try {
    return window.parent !== window && window.parent.location.origin === window.location.origin ? window.parent : null
  } catch {
    return null
  }
}

/** The Timeline mode's page, read from thimble's server under the workspace the page around the frame shows. */
async function timelinePage(): Promise<string> {
  const page = host()
  const ws = page ? new URLSearchParams(page.location.search).get('ws') : null
  if (!ws || !/^[A-Za-z0-9._-]+$/.test(ws)) throw new Error('the example is not in a workspace page')
  const key = realStorage?.getItem('thimble-browser-key') ?? ''
  const base = /^[A-Za-z0-9_-]{16,128}$/.test(key) ? `/b/${key}/api` : '/api'
  const res = await realFetch(`${base}/corpora/${encodeURIComponent(ws)}/source/timeline`)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.text()
}

export const server = createServer({ timelinePage })

/** A request for one of the app's own files: a GET of this origin outside the API, or a data: or blob: URL. */
function ownFile(input: RequestInfo | URL, init?: RequestInit): boolean {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  try {
    const u = new URL(href, window.location.href)
    if (u.protocol === 'data:' || u.protocol === 'blob:') return true
    return method === 'GET' && u.origin === window.location.origin && !server.answers(u.pathname)
  } catch {
    return false
  }
}

const own = (name: string, value: unknown) => {
  try {
    Object.defineProperty(window, name, { value, configurable: true, writable: true })
  } catch {
    /* the frame keeps the browser's own */
  }
}

window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (server.answers(href)) return server.answer(input, init)
  if (ownFile(input, init)) return realFetch(input, init)
  return Promise.reject(new TypeError('The example panes reach no server.'))
}) as typeof fetch
own('EventSource', undefined)
own('XMLHttpRequest', undefined)
own('WebSocket', undefined)
try {
  Object.defineProperty(navigator, 'sendBeacon', { value: () => true, configurable: true })
} catch {
  /* nothing here sends one */
}

/** What the frame's storage starts with: the theme the page shows, so the panes draw in its paper, accent and figure
 * style. */
function seed(): Record<string, string> {
  const out: Record<string, string> = {}
  const root = host()?.document.documentElement
  for (const [attr, key] of [
    ['data-paper', 'thimble:paper'],
    ['data-accent', 'thimble:accent'],
    ['data-figures', 'thimble:figures'],
  ]) {
    const v = root?.getAttribute(attr)
    if (v) out[key] = v
  }
  return out
}
own('localStorage', new MemoryStorage(seed()))
own('sessionStorage', new MemoryStorage())
