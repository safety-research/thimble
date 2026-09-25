// The workspace the page shows: `?ws=<name>` in the URL, which /thimble prints. A URL without one opens the workspace the
// server holds (pickWorkspace); thimble has no page for choosing among corpora.

const NAME_RE = /^[A-Za-z0-9._-]+$/

export function workspaceFromUrl(): string | null {
  if (typeof window === 'undefined') return null
  const v = new URLSearchParams(window.location.search).get('ws')?.trim() ?? ''
  return v && NAME_RE.test(v) ? v : null
}

export function urlForWorkspace(name: string): string {
  const u = new URL(window.location.href)
  u.searchParams.set('ws', name)
  return u.pathname + u.search
}

const LAST_KEY = 'thimble:last-ws'

/** The workspace this browser opened last, if any. */
export function lastWorkspace(): string | null {
  try {
    const v = window.localStorage.getItem(LAST_KEY)
    return v && NAME_RE.test(v) ? v : null
  } catch {
    return null
  }
}

/** Keeps the workspace a page opened, for a later URL that names none. */
export function rememberWorkspace(name: string): void {
  try {
    window.localStorage.setItem(LAST_KEY, name)
  } catch {
    /* storage is a convenience */
  }
}

/** The workspace a URL that names none opens: of the server's (`names`, in the order GET /corpora lists them) the one
 * this browser opened last, else the first; null when the server holds none. Pure. */
export function pickWorkspace(names: readonly string[], last: string | null): string | null {
  if (last && names.includes(last)) return last
  return names[0] ?? null
}

/** A key in browser storage, per workspace. */
export const storageKey = (ws: string, name: string): string => `thimble:${ws}:${name}`

export function readStorage<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    return raw == null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

export function writeStorage(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage is a convenience */
  }
}

/** A value kept for this tab's session (sessionStorage): it outlives a reload and ends with the tab. */
export function readSession<T>(key: string, fallback: T): T {
  try {
    const raw = window.sessionStorage.getItem(key)
    return raw == null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

export function writeSession(key: string, value: unknown): void {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage is a convenience */
  }
}

/** A folder as the top bar prints it: the home folder as ~. Pure. */
export function shortPath(path: string): string {
  const m = /^\/(?:home|Users)\/[^/]+(\/.*)?$/.exec(path)
  return m ? `~${m[1] ?? ''}` : path
}
