// The workspace the page shows: `?ws=<name>` in the URL, which /thimble prints. A URL without one, or with one this server
// does not hold, is thimble's start page (shell/StartPage), which lists the server's workspaces (GET /workspaces), as
// the top bar's switcher does (shell/WorkspaceList).
import type { WorkspaceRow } from './types'

const NAME_RE = /^[A-Za-z0-9._-]+$/

export function workspaceFromUrl(): string | null {
  return nameFromUrl('ws')
}

/** `?pick=<name>`: the session picker of that workspace's folder (shell/SessionPicker), which thimble-browser opens in
 * a folder that has sessions, and a start page's row of a folder. */
export function pickFromUrl(): string | null {
  return nameFromUrl('pick')
}

function nameFromUrl(key: string): string | null {
  if (typeof window === 'undefined') return null
  const v = new URLSearchParams(window.location.search).get(key)?.trim() ?? ''
  return v && NAME_RE.test(v) ? v : null
}

/** What a row of the start page and the switcher shows: the server's label, else the folder's own name or the
 * workspace's name. Pure. */
export function workspaceLabel(row: Pick<WorkspaceRow, 'name' | 'label' | 'folder'>): string {
  return row.label || row.folder || row.name
}

/** The page at `pathname` with a workspace. It carries no sign-in key: the start page signed this browser in already.
 * Pure. */
export function workspaceHref(row: Pick<WorkspaceRow, 'name'>, pathname = '/'): string {
  return `${pathname}?${new URLSearchParams({ ws: row.name }).toString()}`
}

/** Where a folder's row of the start page goes: its session picker (pickFromUrl). Pure. */
export function pickHref(folder: string, pathname = '/'): string {
  return `${pathname}?${new URLSearchParams({ pick: folder }).toString()}`
}

/** The server's workspaces as folders, in their order: one row per folder (a folder's sessions open at once share
 * its own workspace, `of`), named by its own workspace and labeled with the folder's name, and the workspaces it
 * holds. Pure. */
export function folderRows(rows: readonly WorkspaceRow[]): { row: WorkspaceRow; names: string[] }[] {
  const out: { row: WorkspaceRow; names: string[] }[] = []
  const at = new Map<string, number>()
  for (const r of rows) {
    const folder = r.of || r.name
    const i = at.get(folder)
    if (i == null) {
      at.set(folder, out.length)
      out.push({ row: { ...r, name: folder, label: r.folder || r.label, session: undefined }, names: [r.name] })
    } else out[i].names.push(r.name)
  }
  return out
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
