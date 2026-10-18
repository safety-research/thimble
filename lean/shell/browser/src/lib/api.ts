// api.ts: the page server's routes (shell/node/serve.mjs), in place of 0.9's API client. Every path starts with the
// token, the first part of the page's own path. What the person does goes back to the terminal session as one line
// (POST api/back): {ask, scope}, {verb, row}, {squeeze: {...}}.

export const BASE = location.pathname.split('/').slice(0, 2).join('/')

const etags = new Map<string, string>()
const cache = new Map<string, unknown>()

/** GET a JSON route; a route that answers with an ETag is asked with it again, and a 304 gives the cached body. */
export async function api<T = any>(path: string): Promise<T & { error?: string }> {
  const url = `${BASE}/api/${path}`
  const headers: Record<string, string> = {}
  const tag = etags.get(url)
  if (tag) headers['if-none-match'] = tag
  let r: Response
  try {
    r = await fetch(url, { headers, cache: 'no-store' })
  } catch {
    return { error: 'the page server is not answering (the terminal session ended, or browser mode was turned off)' } as T & { error?: string }
  }
  if (r.status === 304 && cache.has(url)) return cache.get(url) as T & { error?: string }
  const body = await r.json().catch(() => ({ error: `the server said ${r.status}` }))
  const t = r.headers.get('etag')
  if (t && r.ok) {
    etags.set(url, t)
    cache.set(url, body)
  }
  if (!r.ok && !body.error) body.error = `the server said ${r.status}`
  return body
}

export type BackLine =
  | { ask: string; scope?: Scope }
  | { verb: string; row: string; proposal?: string }
  | { squeeze: { row: string; chip?: string; level?: number; custom?: string; reset?: boolean } }

export interface Scope {
  row?: string
  object?: string
  v?: number
  region?: string
  label?: string
  thread?: string
  mark?: { kind: string; ref?: string; gloss?: string; label?: string; term?: string }
}

/** Send what the person did to the terminal session. Resolves {ok} or {error}. */
export async function back(line: BackLine): Promise<{ ok?: boolean; error?: string }> {
  try {
    const r = await fetch(`${BASE}/api/back`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(line) })
    const j = await r.json().catch(() => ({}))
    return r.ok ? { ok: true, ...j } : { error: j.error || `the server said ${r.status}` }
  } catch {
    return { error: 'the terminal session is not listening (it ended, or browser mode was turned off)' }
  }
}

/** Follow the server's change events. The open stream is how the server knows a page is open. */
export function follow(onChange: () => void, onState: (open: boolean) => void): () => void {
  const es = new EventSource(`${BASE}/api/events`)
  es.addEventListener('hello', () => {
    onState(true)
    onChange()
  })
  es.addEventListener('change', () => onChange())
  es.onerror = () => onState(false)
  return () => es.close()
}

// ---------------------------------------------------------------- objects and refs, cached

const objects = new Map<string, Promise<any>>()
/** An object and its versions; a version never changes once saved, so a versioned read is cached. */
export function objectOf(id: string, v?: number | null): Promise<any> {
  const key = `${id}@${v ?? ''}`
  if (v != null && objects.has(key)) return objects.get(key)!
  const p = api(`object/${encodeURIComponent(id)}${v != null ? `?v=${v}` : ''}`)
  if (v != null) objects.set(key, p.then((r) => (r.error ? (objects.delete(key), r) : r)))
  return p
}

const resolved = new Map<string, Promise<any>>()
/** `lean resolve <ref>` through the server: where a value came from, down to its rows. */
export function resolveRef(ref: string, n = 8): Promise<any> {
  const key = `${ref}|${n}`
  if (!resolved.has(key)) resolved.set(key, api(`resolve?ref=${encodeURIComponent(ref)}&n=${n}`))
  return resolved.get(key)!
}

/** A module the server serves beside the pages (the drawing contract, shell/object.js). */
export function serverModule<T = any>(path: string): Promise<T> {
  return import(/* @vite-ignore */ `${BASE}/${path}`) as Promise<T>
}

export const fmt = (n: unknown): string => (typeof n === 'number' && isFinite(n) ? n.toLocaleString('en-US') : String(n ?? ''))

export function ago(at?: string | null): string {
  if (!at) return ''
  const s = (Date.now() - Date.parse(at)) / 1000
  return !isFinite(s) ? '' : s < 90 ? 'now' : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`
}

export function hhmm(at?: string | null): string {
  if (!at) return ''
  const d = new Date(at)
  return isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
