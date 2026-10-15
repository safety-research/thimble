// The path this browser reaches the API under. The server scopes a browser's sign-in cookie to a path of that browser's
// own, /b/<key>/api/, and gives the page the random <key> when it trades the link's code (backend hook_auth.claim): a
// cookie is bound to a host and a path but not to a port, so a cookie scoped to /api/ would also go to any other server
// on 127.0.0.1 or localhost whose page asks for one of its own /api/ paths. The page keeps the key in localStorage, which
// every tab of this browser on this address shares, and every request it makes to the API (fetch, event streams,
// images and media, downloads, PDFs) goes under that path, which the server takes off again (hook_auth.BrowserPath). No
// other page knows the key, so the browser sends the cookie to no other server. Without a key (never signed in here, or
// its site data cleared) requests go to /api/ itself, where the server reads them as a browser that is not signed in.
// Pure but for localStorage.

/** Where the key is kept in localStorage. */
export const KEY_ITEM = 'thimble-browser-key'
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

/** The base of every API path this page asks for: `/b/<key>/api` with a key, else `/api`. */
export function apiBase(): string {
  const key = browserKey()
  return key ? `/b/${key}/api` : '/api'
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
