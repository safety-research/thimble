// The workspace's views (GET /ws/{c}/views), read once and shared by every component that lists them: the shell and
// Files both do, and on a large corpus each read of the list costs the server a walk of the claimed files. A `view`
// event on the bus reads it again shortly after; a lookup by slug that misses reads it again at once. A read asked for
// while one is under way follows that one, since the list it brings may predate the change. The views that claim one
// file (viewsForFile) are read once for the callers that ask in the same task.
import { useSyncExternalStore } from 'react'
import { api } from './api'
import { bus } from './bus'
import type { View } from './types'

const REFETCH_MS = 150

interface Store {
  views: View[] | null
  subs: Set<() => void>
  timer: number | null
  off: (() => void) | null
  reading: Promise<View[]> | null
  /** the read that starts once `reading` ends, shared by every caller that asked meanwhile */
  next: Promise<View[]> | null
  /** made once per workspace, so React keeps one subscription (lib/proposals.ts says why) */
  sub: (fn: () => void) => () => void
}

const stores = new Map<string, Store>()

function storeOf(ws: string): Store {
  let s = stores.get(ws)
  if (!s) stores.set(ws, (s = { views: null, subs: new Set(), timer: null, off: null, reading: null, next: null, sub: (fn) => subscribe(ws, fn) }))
  return s
}

/** Read the workspace's views now, or right after the read under way; every subscriber sees the answer. */
export function refreshViews(ws: string): Promise<View[]> {
  const s = storeOf(ws)
  if (!s.reading) return read(ws)
  if (!s.next) {
    const after = () => {
      s.next = null
      return read(ws)
    }
    s.next = s.reading.then(after, after)
  }
  return s.next
}

/** The list as it is now: the read under way, or a new one. */
function current(ws: string): Promise<View[]> {
  return storeOf(ws).reading ?? read(ws)
}

function read(ws: string): Promise<View[]> {
  const s = storeOf(ws)
  const reading = api.views(ws).then(
    (v) => {
      s.views = v
      s.subs.forEach((fn) => fn())
      return v
    },
    (e: unknown) => {
      if (s.views == null) {
        s.views = []
        s.subs.forEach((fn) => fn())
      }
      throw e
    },
  )
  s.reading = reading
  const done = () => {
    if (s.reading === reading) s.reading = null
  }
  reading.then(done, done)
  return reading
}

function later(ws: string) {
  const s = storeOf(ws)
  if (s.timer != null) window.clearTimeout(s.timer)
  s.timer = window.setTimeout(() => {
    s.timer = null
    refreshViews(ws).catch(() => {})
  }, REFETCH_MS)
}

function subscribe(ws: string, fn: () => void): () => void {
  const s = storeOf(ws)
  s.subs.add(fn)
  if (!s.off) {
    s.off = bus.on('view', () => later(ws))
    current(ws).catch(() => {})
  }
  return () => {
    s.subs.delete(fn)
    if (s.subs.size === 0 && s.off) {
      s.off()
      s.off = null
    }
  }
}

/** The workspace's views, null until the first read answers. */
export function useViewList(ws: string): View[] | null {
  return useSyncExternalStore(
    storeOf(ws).sub,
    () => storeOf(ws).views,
    () => null,
  )
}

/** The view `slug` of the workspace: from the shared list, read again when the list lacks it (a view just built). */
export async function findView(ws: string, slug: string): Promise<View | undefined> {
  const s = storeOf(ws)
  const known = (s.views ?? (await current(ws))).find((v) => v.slug === slug)
  return known ?? (await refreshViews(ws)).find((v) => v.slug === slug)
}

const joinable = new Map<string, Promise<View[]>>()

/** The views that claim `path` (GET /views?path=). Callers in the same task share one read: the File browser's modes and
 * Open in ask together when a file opens and on each view event. */
export function viewsForFile(ws: string, path: string): Promise<View[]> {
  const key = `${ws}\n${path}`
  let reading = joinable.get(key)
  if (!reading) {
    reading = api.viewsForFile(ws, path)
    joinable.set(key, reading)
    queueMicrotask(() => joinable.delete(key))
  }
  return reading
}
