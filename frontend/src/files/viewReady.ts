// A view the analyst asked for opens by itself once it is built: a new `view {status: built, asked}` stream record
// teleports to it, unless the analyst is typing in a field. Then the view waits as ready (a toast, Open on its chip and
// the accent dot in the views bar) until opened. A view nobody asked for never opens by itself: a new version of it
// that no pane shows, a first build included, waits as updated, with the same dot and no toast, until opened, while a
// pane that shows it keeps its version and offers Reload (ViewPane). Both sets are kept per workspace in localStorage.
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { bus } from '../lib/bus'
import { isReplay } from '../lib/events'
import { teleport } from '../lib/teleport'
import { readStorage, storageKey, writeStorage } from '../lib/workspace'

const EMPTY: readonly string[] = []
const subs = new Set<() => void>()
type Kind = 'viewsReady' | 'viewsUpdated'
const cache = new Map<Kind, { ws: string; slugs: readonly string[] }>()

function read(ws: string, kind: Kind): readonly string[] {
  let hit = cache.get(kind)
  if (hit?.ws !== ws) {
    const raw = readStorage<unknown>(storageKey(ws, kind), [])
    hit = { ws, slugs: Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [] }
    cache.set(kind, hit)
  }
  return hit.slugs
}

function write(ws: string, kind: Kind, slugs: readonly string[]) {
  cache.set(kind, { ws, slugs })
  writeStorage(storageKey(ws, kind), slugs)
  subs.forEach((fn) => fn())
}

function subscribe(fn: () => void): () => void {
  subs.add(fn)
  return () => {
    subs.delete(fn)
  }
}

const add = (ws: string, kind: Kind, slug: string) => {
  const cur = read(ws, kind)
  if (!cur.includes(slug)) write(ws, kind, [...cur, slug])
}

/** The views built for the analyst's ask and not opened since. */
export function useReadyViews(ws: string): readonly string[] {
  return useSyncExternalStore(subscribe, () => read(ws, 'viewsReady'), () => EMPTY)
}

/** The views with a version no pane has shown yet. */
export function useUpdatedViews(ws: string): readonly string[] {
  return useSyncExternalStore(subscribe, () => read(ws, 'viewsUpdated'), () => EMPTY)
}

export const markReady = (ws: string, slug: string): void => add(ws, 'viewsReady', slug)
export const markUpdated = (ws: string, slug: string): void => add(ws, 'viewsUpdated', slug)

/** The view was opened (or is gone): stop waiting for it. */
export function markOpened(ws: string, slug: string): void {
  for (const kind of ['viewsReady', 'viewsUpdated'] as const) {
    const cur = read(ws, kind)
    if (cur.includes(slug)) write(ws, kind, cur.filter((s) => s !== slug))
  }
}

/** The views a pane shows now, each with how many panes show it (ViewPane holds its view while mounted). */
const shown = new Map<string, number>()
const shownKey = (ws: string, slug: string) => `${ws}\n${slug}`

/** Hold the view as shown while a pane shows it; the returned function lets go. */
export function holdShown(ws: string, slug: string): () => void {
  const k = shownKey(ws, slug)
  shown.set(k, (shown.get(k) ?? 0) + 1)
  return () => {
    const n = (shown.get(k) ?? 1) - 1
    if (n > 0) shown.set(k, n)
    else shown.delete(k)
  }
}

export const isShown = (ws: string, slug: string): boolean => shown.has(shownKey(ws, slug))

/** Whether the element with the focus takes typing, so a switch of the pane would take the analyst's words from it. */
export function typingIn(el: Element | null): boolean {
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable === true || el.closest('[contenteditable="true"], [contenteditable=""]') != null
}

/** What a `view` record asks of the page: open the view, mark it ready, mark a new version of it updated, or nothing.
 * Pure, so the rule is tested without a page. */
export function onBuilt(e: { status: string; asked?: boolean; version?: string }, replay: boolean, typing: boolean, shownNow = false): 'open' | 'ready' | 'updated' | null {
  if (e.status !== 'built' || replay) return null
  if (e.asked) return typing ? 'ready' : 'open'
  return e.version && !shownNow ? 'updated' : null
}

/** Open each view the analyst asked for once it is built (the module note); FilesTab runs it once per page, with the
 * names of the views it knows for the toast. */
export function useOpenAskedViews(ws: string, names: ReadonlyMap<string, string>): void {
  const known = useRef(names)
  known.current = names
  useEffect(
    () =>
      bus.on('view', (e) => {
        if (e.held) return // a proposal of the orientation's still waiting for its first passing build
        if (e.status === 'deleted') return markOpened(ws, e.slug)
        const act = onBuilt(e, isReplay(), typingIn(document.activeElement), isShown(ws, e.slug))
        if (act === 'open') teleport(`view:${e.slug}`)
        else if (act === 'updated') markUpdated(ws, e.slug)
        else if (act === 'ready') {
          markReady(ws, e.slug)
          const name = known.current.get(e.slug)
          bus.emit('toast', { text: name ? `The view ${name} is ready.` : 'The view is ready.', ref: `view:${e.slug}` })
        }
      }),
    [ws],
  )
}
