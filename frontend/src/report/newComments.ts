// New comments: a check that is on ended a run that left comments the analyst has not looked at. The chat's notice
// strip tells of them in one notice (chat/Notice NewCommentsNotice): how many there are and on what, with Show, which
// opens the first surface they are on with its Comments pane and its first new comment open, and ×. A run counts once
// it ends (the stream's `check` record, then the checks' list), so the notice grows as each run of a batch ends rather
// than adding one per comment. The runs looked at are kept per browser and workspace (localStorage), so a reload shows
// the notice again until the analyst looks: the first time a browser reads a workspace's checks, every run that has
// ended counts as looked at, so only later runs are news. A run is looked at once Show opens its surface, × dismisses
// the notice, or the analyst opens one of its comments on the page or on the canvas (markSeen).
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { bus } from '../lib/bus'
import { teleport } from '../lib/teleport'
import { track } from '../lib/telemetry'
import type { Check } from '../lib/types'
import { readStorage, storageKey, writeStorage } from '../lib/workspace'
import { CANVAS } from './checkComments'
import { BUILTIN_SLUGS } from './model'

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

/** The surfaces new runs commented on, in the order their first run ended, each with its count and its runs. Pure. */
export function bySurface(runs: readonly NewRun[]): { surface: string; comments: number; runs: string[] }[] {
  const out = new Map<string, { surface: string; comments: number; runs: string[] }>()
  for (const r of runs) {
    const s = out.get(r.surface) ?? { surface: r.surface, comments: 0, runs: [] }
    s.comments += r.comments
    s.runs.push(r.run)
    out.set(r.surface, s)
  }
  return [...out.values()]
}

/** How the notice names a surface: the cards, a built-in document as its tab spells it after "the" (the Report), a
 * custom one by its name. Pure. */
export function surfaceName(surface: string, docLabel: string): string {
  if (surface === CANVAS) return 'the cards'
  return (BUILTIN_SLUGS as readonly string[]).includes(surface) ? `the ${docLabel}` : docLabel
}

/** The notice's words: how many new comments, and on what. Pure. */
export function newCommentsText(runs: readonly NewRun[], name: (surface: string) => string): string {
  const n = runs.reduce((k, r) => k + r.comments, 0)
  const places = bySurface(runs).map((s) => name(s.surface))
  const where = places.length <= 1 ? (places[0] ?? '') : `${places.slice(0, -1).join(', ')} and ${places[places.length - 1]}`
  return `${n} new comment${n === 1 ? '' : 's'} on ${where}`
}

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

// ---- Show: the surface that holds the new comments opens them ----

/** What Show asks of a surface: open its Comments pane and the first comment of these runs. */
export interface Reveal {
  ws: string
  surface: string
  runs: readonly string[]
}

/** The storage name of whether a document's Comments pane is open (Checks.tsx CommentsPane). */
export const PANE_KEY = 'report-checks-pane'

let reveal: Reveal | null = null
const revealSubs = new Set<() => void>()

/** Ask the surface `surface` (a document's slug, or CANVAS) of workspace `ws` to open the first comment of `runs`:
 * the report opens its sidebar's Comments pane (kept open, so a pane that mounts later opens too), the canvas opens the
 * comment beside its card. The surface takes the request once it can (takeReveal). */
export function revealComments(ws: string, surface: string, runs: readonly string[]): void {
  if (surface !== CANVAS) writeStorage(storageKey(ws, PANE_KEY), true)
  reveal = { ws, surface, runs: [...runs] }
  revealSubs.forEach((fn) => fn())
}

/** The surface took the request, or gave up on it. */
export function takeReveal(): void {
  if (!reveal) return
  reveal = null
  revealSubs.forEach((fn) => fn())
}

function subscribeReveal(fn: () => void): () => void {
  revealSubs.add(fn)
  return () => void revealSubs.delete(fn)
}

/** Show's request to surface `surface` of workspace `ws`, else null. */
export function useReveal(ws: string, surface: string): Reveal | null {
  const r = useSyncExternalStore(
    subscribeReveal,
    () => reveal,
    () => null,
  )
  return r && r.ws === ws && r.surface === surface ? r : null
}

/** How long a surface waits for the comments Show asked for (the document or the cards read again) before it gives up
 * and shows the Comments pane alone. */
export const REVEAL_WAIT_MS = 3000

/** A surface's part of Show: once `comments` (those it shows, in reading order) hold one of the runs Show named and
 * `ready` (its checks are read), `open` opens the first; when none comes within REVEAL_WAIT_MS, `open(null)` shows the
 * Comments pane alone. */
export function useTakeReveal<T extends { id: string; run?: string | null }>(ws: string, surface: string, comments: readonly T[], ready: boolean, open: (first: T | null) => void): void {
  const r = useReveal(ws, surface)
  const opener = useRef(open)
  opener.current = open
  useEffect(() => {
    if (!r || !ready) return
    const first = comments.find((c) => !!c.run && r.runs.includes(c.run))
    if (first) {
      takeReveal()
      opener.current(first)
      return
    }
    const t = window.setTimeout(() => {
      takeReveal()
      opener.current(null)
    }, REVEAL_WAIT_MS)
    return () => window.clearTimeout(t)
  }, [r, ready, comments])
}

/** The analyst opened a comment of run `run`: that run is looked at. Before this browser first read the workspace's
 * checks nothing is kept, since that first read counts every ended run as looked at. */
export function useLookedAt(ws: string, run: string | null | undefined): void {
  useEffect(() => {
    if (run && seenRuns(ws)) markSeen(ws, [run])
  }, [ws, run])
}

// ---- the notice ----

export interface NewComments {
  /** the new runs, in the order they ended; empty when there is nothing to tell */
  runs: NewRun[]
  /** Show: the first surface opens its new comments, which are then looked at */
  show: () => void
  /** ×: every new run is looked at */
  dismiss: () => void
}

/** The new comments of workspace `ws`, for the notice strip, from its checks (Checks.tsx useChecks). */
export function useNewComments(ws: string, checks: { list: readonly RunsOf[]; ready: boolean }): NewComments {
  const seen = useSeenRuns(ws)
  const { list, ready } = checks
  // the first read of this workspace's checks in this browser: what has ended is not news
  useEffect(() => {
    if (ready && seen == null) markSeen(ws, endedRuns(list), allRuns(list))
  }, [ws, ready, seen, list])
  const runs = useMemo(() => (ready && seen ? newRuns(list, seen) : []), [ready, seen, list])
  const total = runs.reduce((k, r) => k + r.comments, 0)
  const dismiss = useCallback(() => {
    track('ui-click', { target: 'notice:comments', detail: { action: 'dismiss', comments: total } })
    markSeen(ws, runs.map((r) => r.run), allRuns(list))
  }, [ws, runs, list, total])
  const show = useCallback(() => {
    const first = bySurface(runs)[0]
    if (!first) return
    track('ui-click', { target: 'notice:comments', detail: { action: 'show', comments: first.comments, surface: first.surface } })
    markSeen(ws, first.runs, allRuns(list))
    revealComments(ws, first.surface, first.runs)
    if (first.surface === CANVAS) bus.emit('showTab', { tab: 'canvas' })
    else teleport(`report:${first.surface}`)
  }, [ws, runs, list])
  return { runs, show, dismiss }
}
