// The workspace the page shows: `?ws=<name>` in the URL, which /thimble prints. A URL without one, or with one this server
// does not hold, is thimble's start page (shell/StartPage), which lists the server's workspaces (GET /workspaces) in
// groups, as the top bar's switcher does (shell/WorkspaceList).
import type { WorkspaceRow } from './types'

const NAME_RE = /^[A-Za-z0-9._-]+$/

export function workspaceFromUrl(): string | null {
  if (typeof window === 'undefined') return null
  const v = new URLSearchParams(window.location.search).get('ws')?.trim() ?? ''
  return v && NAME_RE.test(v) ? v : null
}

export type WorkspaceKind = WorkspaceRow['kind']

/** The start page's groups in order, with their titles. */
export const WORKSPACE_GROUPS: readonly { kind: WorkspaceKind; title: string }[] = [
  { kind: 'demo', title: 'Demo' },
  { kind: 'example', title: 'Examples' },
  { kind: 'folder', title: 'Your folders' },
]

/** `rows` in the start page's groups, in the order the server gave them; a group with no row is left out. Pure. */
export function groupWorkspaces(rows: readonly WorkspaceRow[]): { kind: WorkspaceKind; title: string; rows: WorkspaceRow[] }[] {
  return WORKSPACE_GROUPS.map((g) => ({ ...g, rows: rows.filter((r) => r.kind === g.kind) })).filter((g) => g.rows.length > 0)
}

/** Where a row of the start page goes: the page at `pathname` with its workspace, an example opened at its view, and the
 * page key when the address still holds one (`hash`: a claim the server has not answered yet). Pure. */
export function workspaceHref(row: Pick<WorkspaceRow, 'name' | 'kind' | 'view'>, pathname = '/', hash = ''): string {
  const q = new URLSearchParams({ ws: row.name })
  if (row.kind === 'example' && row.view?.slug) q.set('ref', `view:${row.view.slug}`)
  const key = new URLSearchParams(hash.replace(/^#/, '')).get('k')
  return `${pathname}?${q.toString()}${key ? `#k=${encodeURIComponent(key)}` : ''}`
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

/** The folder a corpus shows as: the path the analyst opened it by (`shown`, through a symlink), else its folder. */
export function shownPath(c: { path?: string; shown?: string } | null | undefined): string | null {
  return c?.shown || c?.path || null
}

/** A folder as the top bar prints it: the home folder as ~. Pure. */
export function shortPath(path: string): string {
  const m = /^\/(?:home|Users)\/[^/]+(\/.*)?$/.exec(path)
  return m ? `~${m[1] ?? ''}` : path
}
