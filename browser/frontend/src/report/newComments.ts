// New comments: a check that is on ended a run that left comments the analyst has not looked at. The Comments control
// of the surface they are on carries the accent dot, named "New comments" (Checks.tsx NewCommentsDot): for the cards
// the canvas's Comments button (canvas/Controls.tsx CommentsButton), for the documents the top bar's Comments
// (shell/TopBar.tsx) and, for its own document's runs, the head of the Comments pane beside the slides, the story or a
// page (Checks.tsx CommentsPane), so a run that commented on the Report alone leaves the canvas's button as it was. A
// run counts once it ends (the stream's `check` record, then the checks' list). The runs looked at are kept per browser
// and workspace (localStorage), so a reload shows the dot again until the analyst looks: the first time a browser reads
// a workspace's checks, every run that has ended counts as looked at, so only later runs are news. A run is looked at
// once the analyst opens a Comments control it shows on, or one of its comments on the page or on the canvas
// (useLookedAt).
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import type { Check } from '../lib/types'
import { readStorage, storageKey, writeStorage } from '../lib/workspace'

/** One run that left comments the analyst has not looked at. */
export interface NewRun {
  check: string
  /** a document's slug, or CANVAS for the cards */
  surface: string
  run: string
  comments: number
  ended: string
}

type RunsOf = Pick<Check, 'id' | 'shown' | 'runs'>

/** The runs of the checks that are on that ended done with comments, each not in `seen`, in the order they ended.
 * Pure. */
export function newRuns(checks: readonly RunsOf[], seen: ReadonlySet<string>): NewRun[] {
  const out: NewRun[] = []
  for (const c of checks) {
    if (!c.shown) continue
    for (const [surface, r] of Object.entries(c.runs ?? {})) {
      if (!r || r.status !== 'done' || !r.run || !((r.comments ?? 0) > 0) || seen.has(r.run)) continue
      out.push({ check: c.id, surface, run: r.run, comments: r.comments, ended: r.ended ?? '' })
    }
  }
  return out.sort((a, b) => a.ended.localeCompare(b.ended))
}

/** Every run of the checks that is not running: what a browser counts as looked at the first time it reads a
 * workspace's checks. Pure. */
export function endedRuns(checks: readonly RunsOf[]): string[] {
  return checks.flatMap((c) => Object.values(c.runs ?? {}).flatMap((r) => (r?.run && r.status !== 'running' ? [r.run] : [])))
}

/** Every run the checks list, running or not. Pure. */
const allRuns = (checks: readonly RunsOf[]): string[] => checks.flatMap((c) => Object.values(c.runs ?? {}).flatMap((r) => (r?.run ? [r.run] : [])))

// ---- the runs looked at, per workspace: null until this browser first read the workspace's checks ----

const SEEN_KEY = 'comments-seen'
const seenStores = new Map<string, { seen: ReadonlySet<string> | null; subs: Set<() => void> }>()

function seenStore(ws: string) {
  let s = seenStores.get(ws)
  if (!s) {
    const raw = readStorage<unknown>(storageKey(ws, SEEN_KEY), null)
    seenStores.set(ws, (s = { seen: Array.isArray(raw) ? new Set(raw.map(String)) : null, subs: new Set() }))
  }
  return s
}

/** The runs looked at in workspace `ws`, null while this browser has not read its checks. */
export const seenRuns = (ws: string): ReadonlySet<string> | null => seenStore(ws).seen

/** The analyst looked at `runs`: they join the runs looked at, kept in this browser. With `keep`, the runs the checks
 * still list, any other run is forgotten, so the list stays as long as the checks' runs. */
export function markSeen(ws: string, runs: readonly string[], keep?: readonly string[]): void {
  const s = seenStore(ws)
  const was = s.seen ?? new Set<string>()
  const live = keep ? new Set([...keep, ...runs]) : null
  const next = new Set([...was, ...runs].filter((r) => !live || live.has(r)))
  if (s.seen && next.size === was.size && [...next].every((r) => was.has(r))) return
  s.seen = next
  writeStorage(storageKey(ws, SEEN_KEY), [...next])
  s.subs.forEach((fn) => fn())
}

export function useSeenRuns(ws: string): ReadonlySet<string> | null {
  const sub = useCallback(
    (fn: () => void) => {
      const s = seenStore(ws)
      s.subs.add(fn)
      return () => void s.subs.delete(fn)
    },
    [ws],
  )
  return useSyncExternalStore(
    sub,
    () => seenStore(ws).seen,
    () => null,
  )
}

/** Forget every workspace's runs looked at as this page holds them, so they are read from storage again (tests). */
export function resetSeen(): void {
  seenStores.clear()
}

/** The analyst opened a comment of run `run`: that run is looked at. Before this browser first read the workspace's
 * checks nothing is kept, since that first read counts every ended run as looked at. */
export function useLookedAt(ws: string, run: string | null | undefined): void {
  useEffect(() => {
    if (run && seenRuns(ws)) markSeen(ws, [run])
  }, [ws, run])
}

// ---- the dot ----

export interface NewComments {
  /** the new runs on the surface, in the order they ended; empty when there is nothing new there */
  runs: NewRun[]
  /** the analyst opened the surface's Comments control: its new runs are looked at */
  look: () => void
}

/** The new comments of workspace `ws` on `surface`, for the dot on its Comments control, from the workspace's checks
 * (Checks.tsx useChecks): a run target (CANVAS for the cards, a document's slug for its Comments pane), or which run
 * targets count (checkComments.ts isDocument for the documents). */
export function useNewComments(ws: string, checks: { list: readonly RunsOf[]; ready: boolean }, surface: string | ((surface: string) => boolean)): NewComments {
  const seen = useSeenRuns(ws)
  const { list, ready } = checks
  // the first read of this workspace's checks in this browser: what has ended is not news
  useEffect(() => {
    if (ready && seen == null) markSeen(ws, endedRuns(list), allRuns(list))
  }, [ws, ready, seen, list])
  const runs = useMemo(() => {
    if (!ready || !seen) return []
    const on = typeof surface === 'string' ? (s: string) => s === surface : surface
    return newRuns(list, seen).filter((r) => on(r.surface))
  }, [ready, seen, list, surface])
  const look = useCallback(() => {
    if (runs.length) markSeen(ws, runs.map((r) => r.run), allRuns(list))
  }, [ws, runs, list])
  return { runs, look }
}
