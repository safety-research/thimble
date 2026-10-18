// base.js: what every page of the session's browser mode shares: the server's base path (the token is the first part
// of every path), its JSON routes, its change events, and the line a page sends back to the terminal.
//
// A page is a folder of shell/browser/ (mirror/, card/, atlas/ ...). It imports this file as ../common/base.js, the
// drawing modules as ../draw/<file>, and shell/object.js as ../lib/object.js. serve.mjs serves them all behind the
// token, so a new page needs no change to the server.

export const BASE = location.pathname.split('/').slice(0, 2).join('/')
export const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
export const fmt = n => (typeof n === 'number' && isFinite(n) ? n.toLocaleString('en-US') : String(n ?? ''))
export const $ = (s, r) => (r || document).querySelector(s)
export const $$ = (s, r) => Array.from((r || document).querySelectorAll(s))
export const wait = ms => new Promise(r => setTimeout(r, ms))

const etags = new Map()
const cache = new Map()

/** GET a JSON route (`messages`, `object/<id>?v=2`, ...); a route that answers with an ETag is asked with it again. */
export async function api(path) {
  const url = `${BASE}/api/${path}`
  const headers = {}
  if (etags.has(url)) headers['if-none-match'] = etags.get(url)
  const r = await fetch(url, { headers, cache: 'no-store' })
  if (r.status === 304 && cache.has(url)) return cache.get(url)
  const body = await r.json().catch(() => ({ error: `the server said ${r.status}` }))
  const tag = r.headers.get('etag')
  if (tag && r.ok) { etags.set(url, tag); cache.set(url, body) }
  if (!r.ok && !body.error) body.error = `the server said ${r.status}`
  return body
}

/** Send what the person did to the terminal (CONTRACT 5): {ask, scope} or {verb, row}. Resolves {ok} or {error}. */
export async function back(line) {
  try {
    const r = await fetch(`${BASE}/api/back`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(line) })
    const j = await r.json().catch(() => ({}))
    return r.ok ? { ok: true, ...j } : { error: j.error || `the server said ${r.status}` }
  } catch {
    return { error: 'the terminal session is not listening (it ended, or browser mode was turned off)' }
  }
}

/**
 * Follow the server's change events: `fn()` runs on each change. The open stream is also how the server knows a page
 * is open; it stops some seconds after the last page closes. `onState(open)` says when the stream drops and returns.
 */
export function follow(fn, onState = () => {}) {
  let es = null
  const open = () => {
    es = new EventSource(`${BASE}/api/events`)
    es.addEventListener('hello', () => { onState(true); fn() })
    es.addEventListener('change', () => fn())
    es.onerror = () => onState(false)
  }
  open()
  return () => es && es.close()
}

/** The page of another folder, with a query and a hash: page('card', {o: 'id', v: 2}, {r: 'day-1'}). */
export function pageUrl(name, query = {}, hash = {}) {
  const q = new URLSearchParams(Object.entries(query).filter(([, v]) => v != null && v !== ''))
  const h = new URLSearchParams(Object.entries(hash).filter(([, v]) => v != null && v !== ''))
  return `${BASE}/${name}/${q.toString() ? '?' + q : ''}${h.toString() ? '#' + h : ''}`
}

/** An object and its versions, cached by id and version (a version never changes once saved). */
const objects = new Map()
export async function objectOf(id, v) {
  const key = `${id}@${v ?? ''}`
  if (v != null && objects.has(key)) return objects.get(key)
  const r = await api(`object/${encodeURIComponent(id)}${v != null ? `?v=${v}` : ''}`)
  if (!r.error && r.object && v != null) objects.set(key, r)
  return r
}

/** `id` or `id@v` as an object ref. */
export function parseObj(s) {
  const m = /^([^@\s]+)(?:@(\d+))?$/.exec(String(s || ''))
  return m ? { id: m[1], v: m[2] ? Number(m[2]) : null } : null
}
