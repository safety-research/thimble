// The workspace's view proposals, read once and shared by every component that shows one. Each proposal is a view the
// dev agent builds in the background (backend views.py); the stream's `view` events move its status (queued, building,
// built, failed) before the list is read again.
import { useSyncExternalStore } from 'react'
import { api } from './api'
import { bus } from './bus'
import type { Proposal } from './types'

const REFETCH_MS = 150

interface Store {
  proposals: Proposal[] | null
  subs: Set<() => void>
  timer: number | null
  off: (() => void) | null
  /** the subscribe function useSyncExternalStore gets, made once per workspace: React subscribes again whenever it is
   * handed a new function, and a lone chip's resubscription dropped the last subscriber and read the list again, whose
   * answer rendered it and handed React a new function, a loop of many reads a second */
  sub: (fn: () => void) => () => void
}

const stores = new Map<string, Store>()

function storeOf(ws: string): Store {
  let s = stores.get(ws)
  if (!s) stores.set(ws, (s = { proposals: null, subs: new Set(), timer: null, off: null, sub: (fn) => subscribe(ws, fn) }))
  return s
}

/** The subscribe function of the workspace's store, the same on every call. */
export const subscriberOf = (ws: string) => storeOf(ws).sub

function publish(s: Store, next: Proposal[]) {
  s.proposals = next
  s.subs.forEach((fn) => fn())
}

/** Read the workspace's proposals now; every subscriber sees the answer. */
export function refreshProposals(ws: string): Promise<void> {
  const s = storeOf(ws)
  return api
    .proposals(ws)
    .then((p) => publish(s, p))
    .catch(() => {
      if (s.proposals == null) publish(s, [])
    })
}

/** A `view` event: the proposal's new status at once (and its build's chat), then the list read again shortly after. */
export function applyViewEvent(ws: string, e: { slug: string; status: string; chat?: string }) {
  const s = storeOf(ws)
  if (s.proposals) {
    const next =
      e.status === 'deleted'
        ? s.proposals.filter((p) => p.slug !== e.slug)
        : s.proposals.map((p) => (p.slug === e.slug ? { ...p, status: e.status as Proposal['status'], ...(e.chat ? { chat: e.chat } : {}) } : p))
    publish(s, next)
  }
  if (s.timer != null) window.clearTimeout(s.timer)
  s.timer = window.setTimeout(() => {
    s.timer = null
    void refreshProposals(ws)
  }, REFETCH_MS)
}

function subscribe(ws: string, fn: () => void): () => void {
  const s = storeOf(ws)
  s.subs.add(fn)
  if (!s.off) {
    s.off = bus.on('view', (e) => applyViewEvent(ws, e))
    void refreshProposals(ws)
  }
  return () => {
    s.subs.delete(fn)
    if (s.subs.size === 0 && s.off) {
      s.off()
      s.off = null
    }
  }
}

/** The workspace's proposals, null until the first read answers. */
export function useProposals(ws: string): Proposal[] | null {
  return useSyncExternalStore(
    subscriberOf(ws),
    () => storeOf(ws).proposals,
    () => null,
  )
}

/** The proposal a chip names: by slug, else the newest of that name. Pure. */
export function findProposal(proposals: readonly Proposal[] | null, slug: string | null | undefined, name?: string | null): Proposal | null {
  if (!proposals) return null
  if (slug) return proposals.find((p) => p.slug === slug) ?? null
  // the server title-cases a proposal's name and compares names case-folded (backend views.propose), while a chip
  // names the view as the agent's propose_view call did ("Event counts" for the proposal "Event Counts")
  const want = (name ?? '').trim().toLowerCase()
  const named = want ? proposals.filter((p) => String(p.name ?? '').trim().toLowerCase() === want) : []
  return named.length ? named.reduce((a, b) => (a.ts >= b.ts ? a : b)) : null
}

/** Whether the proposal a chip names was dropped (an orientation view that could not be built, backend views.drop),
 * so no chip, count or section shows it. Pure. */
export function isDropped(proposals: readonly Proposal[] | null, slug: string | null | undefined, name?: string | null): boolean {
  return findProposal(proposals, slug, name)?.status === 'dropped'
}

/** What a run made, less the views whose proposals were dropped (isDropped). Pure. */
export function withoutDropped<T extends { views: string[]; viewSlugs?: Record<string, string> }>(made: T, proposals: readonly Proposal[] | null): T {
  const views = made.views.filter((v) => !isDropped(proposals, made.viewSlugs?.[v], v))
  return views.length === made.views.length ? made : { ...made, views }
}
