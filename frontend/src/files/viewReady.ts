// A view the analyst asked for opens by itself once it is built: a new `view {status: built, asked}` stream record
// teleports to it, unless the analyst is typing in a field. Then the view waits as ready (a toast, Open on its chip and
// the accent dot in the views bar) until opened. The ready set is kept per workspace in localStorage. A view nobody
// asked for never opens by itself.
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { bus } from '../lib/bus'
import { isReplay } from '../lib/events'
import { teleport } from '../lib/teleport'
import { readStorage, storageKey, writeStorage } from '../lib/workspace'

const EMPTY: readonly string[] = []
const subs = new Set<() => void>()
let cache: { ws: string; slugs: readonly string[] } | null = null

const keyOf = (ws: string) => storageKey(ws, 'viewsReady')

function read(ws: string): readonly string[] {
  if (cache?.ws !== ws) {
    const raw = readStorage<unknown>(keyOf(ws), [])
    cache = { ws, slugs: Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [] }
  }
  return cache.slugs
}

function write(ws: string, slugs: readonly string[]) {
  cache = { ws, slugs }
  writeStorage(keyOf(ws), slugs)
  subs.forEach((fn) => fn())
}

function subscribe(fn: () => void): () => void {
  subs.add(fn)
  return () => {
    subs.delete(fn)
  }
}

/** The views built for the analyst's ask and not opened since. */
export function useReadyViews(ws: string): readonly string[] {
  return useSyncExternalStore(subscribe, () => read(ws), () => EMPTY)
}

export function markReady(ws: string, slug: string): void {
  const cur = read(ws)
  if (!cur.includes(slug)) write(ws, [...cur, slug])
}

/** The view was opened (or is gone): stop waiting for it. */
export function markOpened(ws: string, slug: string): void {
  const cur = read(ws)
  if (cur.includes(slug)) write(ws, cur.filter((s) => s !== slug))
}

/** Whether the element with the focus takes typing, so a switch of the pane would take the analyst's words from it. */
export function typingIn(el: Element | null): boolean {
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable === true || el.closest('[contenteditable="true"], [contenteditable=""]') != null
}

/** What a `view` record asks of the page: open the view, mark it ready, or nothing. Pure, so the rule is tested without
 * a page. */
export function onBuilt(e: { status: string; asked?: boolean }, replay: boolean, typing: boolean): 'open' | 'ready' | null {
  if (e.status !== 'built' || !e.asked || replay) return null
  return typing ? 'ready' : 'open'
}

/** Open each view the analyst asked for once it is built (the module note); FilesTab runs it once per page, with the
 * names of the views it knows for the toast. */
export function useOpenAskedViews(ws: string, names: ReadonlyMap<string, string>): void {
  const known = useRef(names)
  known.current = names
  useEffect(
    () =>
      bus.on('view', (e) => {
        if (e.status === 'deleted') return markOpened(ws, e.slug)
        const act = onBuilt(e, isReplay(), typingIn(document.activeElement))
        if (act === 'open') teleport(`view:${e.slug}`)
        else if (act === 'ready') {
          markReady(ws, e.slug)
          const name = known.current.get(e.slug)
          bus.emit('toast', { text: name ? `The view ${name} is ready.` : 'The view is ready.', ref: `view:${e.slug}` })
        }
      }),
    [ws],
  )
}
