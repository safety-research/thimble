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

// ---- the workspace instance ----
// Browser storage is keyed by the workspace's name alone, so a workspace deleted on the server (an uninstall, a replaced
// folder) and made again under the same name would reopen on the old one's layout and state. Each workspace instance
// has a birth stamp, its main chat's `created_at` (chats/main.meta.json), kept at storageKey(ws, 'instance'); App checks
// it before it mounts the shell, and a stamp that differs clears that workspace's keys first.

/** The instance key's value while the workspace's main chat has no meta yet. */
export const PENDING_INSTANCE = 'pending'

/** Of `keys`, those that belong to workspace `ws`: the trailing ':' keeps `logs` from taking `logs-2`'s. Pure. */
export function workspaceKeys(ws: string, keys: readonly string[]): string[] {
  const prefix = storageKey(ws, '')
  return keys.filter((k) => k.startsWith(prefix))
}

/** What the instance check does, from the stamp kept (`stored`, null when none) and the workspace's (`stamp`, main's
 * `created_at`, null while main has no meta): whether to clear the workspace's keys, and the stamp to keep after (null:
 * leave it). A stamp kept while main had none is adopted without clearing, so a layout made meanwhile survives. Pure. */
export function instanceAction(stored: string | null, stamp: string | null): { clear: boolean; write: string | null } {
  if (stamp == null) return stored === PENDING_INSTANCE ? { clear: false, write: null } : { clear: true, write: PENDING_INSTANCE }
  if (stored === stamp) return { clear: false, write: null }
  if (stored === PENDING_INSTANCE) return { clear: false, write: stamp }
  return { clear: true, write: stamp }
}

function storageKeys(store: Storage): string[] {
  const out: string[] = []
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i)
    if (k != null) out.push(k)
  }
  return out
}

/** Applies instanceAction to this browser's storage, to localStorage and to this tab's sessionStorage apart, each
 * with its own stamp (a tab kept open across a reinstall holds session state another tab's load never cleared): clears
 * workspace `ws`'s keys in a store whose stamp is not the instance's, then keeps the new stamp there. Called only with
 * the server's answer, never on a failure. Returns whether it cleared any key. */
export function syncInstance(ws: string, stamp: string | null): boolean {
  const key = storageKey(ws, 'instance')
  let cleared = false
  for (const get of [() => window.localStorage, () => window.sessionStorage]) {
    try {
      const store = get()
      const raw = store.getItem(key)
      let stored: string | null = null
      try {
        stored = raw == null ? null : (JSON.parse(raw) as string)
      } catch {
        /* an unreadable stamp is none */
      }
      const { clear, write } = instanceAction(stored, stamp)
      if (clear) {
        const gone = workspaceKeys(ws, storageKeys(store)).filter((k) => k !== key)
        for (const k of gone) store.removeItem(k)
        cleared ||= gone.length > 0
      }
      if (write != null) store.setItem(key, JSON.stringify(write))
    } catch {
      /* storage is a convenience */
    }
  }
  return cleared
}

/** A folder as the top bar prints it: the home folder as ~. Pure. */
export function shortPath(path: string): string {
  const m = /^\/(?:home|Users)\/[^/]+(\/.*)?$/.exec(path)
  return m ? `~${m[1] ?? ''}` : path
}
