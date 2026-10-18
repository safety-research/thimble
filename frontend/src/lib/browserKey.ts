// The path this browser reaches the API under. The server scopes a browser's sign-in cookie to a path of that browser's
// own, /b/<key>/api/, and gives the page the random <key> when it trades the link's code (backend hook_auth.claim): a
// cookie is bound to a host and a path but not to a port, so a cookie scoped to /api/ would also go to any other server
// on 127.0.0.1 or localhost whose page asks for one of its own /api/ paths. The page keeps the key in localStorage, which
// every tab of this browser on this address shares, and every request it makes to the API (fetch, event streams,
// images and media, downloads, PDFs) goes under that path, which the server takes off again (hook_auth.BrowserPath). No
// other page knows the key, so the browser sends the cookie to no other server. Without a key (never signed in here, or
// its site data cleared) requests go to /api/ itself, where the server reads them as a browser that is not signed in.
// Beside the key the page keeps the port the server that gave it listens on (the claim's `port`), which the stale-tab
// challenge binds its answer to (lib/stale). Pure but for localStorage.

/** Where the key is kept in localStorage. */
export const KEY_ITEM = 'thimble-browser-key'
/** Where the port of the server that gave the key is kept (lib/stale challengePort). */
export const PORT_ITEM = 'thimble-server-port'
/** A key as the server makes it (secrets.token_urlsafe), which BrowserPath takes; anything else is no key. */
const KEY_RE = /^[A-Za-z0-9_-]{16,128}$/
/** A path under some browser's key: its prefix and the API path it stands for. */
const UNDER_KEY = /^\/b\/[A-Za-z0-9_-]{16,128}(\/api(?:\/.*)?)$/

function store(): Storage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null
  } catch {
    return null // storage blocked
  }
}

/** This browser's key, '' when it holds none. Read anew each time, so a sign-in in another tab is used at once. */
export function browserKey(): string {
  try {
    const got = store()?.getItem(KEY_ITEM) ?? ''
    return KEY_RE.test(got) ? got : ''
  } catch {
    return ''
  }
}

/** Keep `key`, which the server gave with this browser's cookie; a value that is no key is not kept. Whether it was. */
export function setBrowserKey(key: unknown): boolean {
  if (typeof key !== 'string' || !KEY_RE.test(key)) return false
  try {
    const s = store()
    if (!s) return false
    s.setItem(KEY_ITEM, key)
    return true
  } catch {
    return false
  }
}

/** Forget the key, once this browser signed itself out (Settings): every tab then asks the API's own path, where the
 * server reads it as a browser that is not signed in, and each tab's sign-in check runs again (shell/SignIn). */
export function clearBrowserKey(): void {
  try {
    store()?.removeItem(KEY_ITEM)
  } catch {
    /* storage blocked: there was no key */
  }
}

/** The port the server that gave this browser its key listens on, 0 when none is kept. */
export function serverPort(): number {
  try {
    const got = Number(store()?.getItem(PORT_ITEM) ?? '')
    return Number.isInteger(got) && got > 0 && got < 65536 ? got : 0
  } catch {
    return 0
  }
}

/** Keep the port the claim answered beside the key; a value that is no port is not kept. */
export function setServerPort(port: unknown): void {
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port >= 65536) return
  try {
    store()?.setItem(PORT_ITEM, String(port))
  } catch {
    /* storage blocked: the challenge uses the page's own port */
  }
}

/** The base of every API path this page asks for: `/b/<key>/api` with a key, else `/api`. */
export function apiBase(): string {
  const key = browserKey()
  return key ? `/b/${key}/api` : '/api'
}

/** The API's own path for `path` (`/api` + path), never under a key: the stale-tab challenge (lib/stale), which must
 * carry no credential to a server that has not proved itself. */
export function plainApiPath(path: string): string {
  return `/api${path}`
}

/** `url`, an address of the API (`/api` or a path under it, or such a path on this page's origin), under this browser's
 * path (apiBase); any other address as it is. */
export function apiUrl(url: string): string {
  if (url === '/api' || url.startsWith('/api/') || url.startsWith('/api?')) return apiBase() + url.slice(4)
  if (typeof location === 'undefined' || !location.origin || location.origin === 'null') return url
  const own = location.origin + '/api'
  if (url === own || url.startsWith(own + '/') || url.startsWith(own + '?')) return location.origin + apiBase() + url.slice(own.length)
  return url
}

/** The API path a path asked under some browser's key stands for (`/b/<key>/api/x` is `/api/x`); any other path as it
 * is. For code that tells API requests apart by their path. */
export function apiPath(pathname: string): string {
  const m = UNDER_KEY.exec(pathname)
  return m ? m[1] : pathname
}
