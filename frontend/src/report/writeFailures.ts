// A writer's failure on a document, from the stream's `report {status: failed}` record, and a writer's start that did
// not happen, from `report {status: refused, refused}` (backend report_types.write_refused), which the document's card
// shows as the refused card (chat/Refused) until a later write starts or the analyst dismisses it. It is a state that lasts, so it
// shows in one place, never as a toast: a ✕ on the document's tab and an error card under the type bar, with Retry and
// Report a problem, until the analyst dismisses it or a later write starts or saves. Like any report record, a new one
// lights the Report tab's dot while no pane shows the Report (shell/dots). Dismissals are kept per workspace in localStorage by the
// record's `seq`, so they hold across loads while a new failure still shows.
import { useSyncExternalStore } from 'react'
import { apiErrorAt, apiFailureText } from '../chat/model'
import { bus } from '../lib/bus'
import type { Refusal, WsEvent } from '../lib/types'
import { readStorage, storageKey, writeStorage } from '../lib/workspace'
import { failureText } from '../shell/ProblemReport'

export interface WriteFailure {
  slug: string
  /** what the writer's session said when it ended, or the server's line for a writer that saved nothing */
  note: string
  /** the writer's chat, which Report a problem takes first */
  chat: string | null
  /** the record's place in the stream, which a dismissal names */
  seq: number
}

/** The failure card's head and the tab's tooltip: the writer's last words, or for Claude Code's API error line what
 * failed. */
export function failedText(f: Pick<WriteFailure, 'slug' | 'note'>): string {
  const at = apiErrorAt(f.note)
  const why = at < 0 ? f.note : `${apiFailureText(f.note.slice(at))}.`
  return `The ${f.slug} was not written.${why ? ` ${why}` : ''}`
}

/** The failure card's detail behind its chevron: the writer's note when it ends in an API error line; else nothing. */
export const failedDetail = (f: Pick<WriteFailure, 'note'>): string => (apiErrorAt(f.note) >= 0 ? f.note.trim() : '')

/** The failure card's line on retrying: nothing writes it again but Retry. */
export const WRITE_RETRY_NOTE = 'Not retried. The write ended here.'

/** What Report a problem opens with for the failure. */
export const failedReport = (f: WriteFailure) => ({ description: failureText(`The writer of ${f.slug} failed.`, f.note), focus: f.chat ? [f.chat] : [] })

/** The failures standing after `ev`, per document: a failure is set by its record and ended by a later write of the
 * document starting or being saved. Pure, so the rule is tested without a page. */
export function nextFailures(cur: Readonly<Record<string, WriteFailure>>, ev: WsEvent): Record<string, WriteFailure> {
  const e = ev as { type?: unknown; slug?: unknown; status?: unknown; note?: unknown; chat?: unknown; seq?: unknown }
  if (e.type !== 'report' || typeof e.slug !== 'string' || !e.slug) return cur as Record<string, WriteFailure>
  if (e.status === 'failed') {
    const f: WriteFailure = { slug: e.slug, note: typeof e.note === 'string' ? e.note : '', chat: typeof e.chat === 'string' ? e.chat : null, seq: typeof e.seq === 'number' ? e.seq : -1 }
    return { ...cur, [e.slug]: f }
  }
  if ((e.status === 'generating' || e.status === 'generated' || e.status === 'deleted') && cur[e.slug]) {
    const next = { ...cur }
    delete next[e.slug]
    return next
  }
  return cur as Record<string, WriteFailure>
}

/** A writer's start that did not happen, on its document. */
export interface WriteRefusal {
  slug: string
  refusal: Refusal
  seq: number
}

/** The refusals standing after `ev`, per document: set by a `refused` record, ended by a later write starting or being
 * saved. Pure. */
export function nextRefusals(cur: Readonly<Record<string, WriteRefusal>>, ev: WsEvent): Record<string, WriteRefusal> {
  const e = ev as { type?: unknown; slug?: unknown; status?: unknown; refused?: unknown; seq?: unknown }
  if (e.type !== 'report' || typeof e.slug !== 'string' || !e.slug) return cur as Record<string, WriteRefusal>
  if (e.status === 'refused' && e.refused && typeof e.refused === 'object') {
    const r = e.refused as Refusal
    return { ...cur, [e.slug]: { slug: e.slug, refusal: { ...r, kind: r.kind ?? 'error', reason: r.reason ?? '' }, seq: typeof e.seq === 'number' ? e.seq : -1 } }
  }
  if ((e.status === 'generating' || e.status === 'generated' || e.status === 'deleted') && cur[e.slug]) {
    const next = { ...cur }
    delete next[e.slug]
    return next
  }
  return cur as Record<string, WriteRefusal>
}

let refusals: Record<string, WriteRefusal> = {}

let failures: Record<string, WriteFailure> = {}
const subs = new Set<() => void>()

// listening from module load, before the stream opens, so the replayed history reaches the store
bus.on('wsEvent', (ev) => {
  const next = nextFailures(failures, ev)
  const nextR = nextRefusals(refusals, ev)
  if (next === failures && nextR === refusals) return
  failures = next
  refusals = nextR
  subs.forEach((fn) => fn())
})

/** A refusal this tab's own Write was just answered with, before the stream's record of it arrives. */
export function noteRefusal(slug: string, refusal: Refusal): void {
  refusals = { ...refusals, [slug]: { slug, refusal, seq: refusals[slug]?.seq ?? -2 } }
  subs.forEach((fn) => fn())
}

/** The writers' refusals standing per document, less those the analyst dismissed in this tab. */
export function useWriteRefusals(): { refusals: Record<string, WriteRefusal>; dismiss: (slug: string) => void } {
  const all = useSyncExternalStore(subscribe, () => refusals, () => refusals)
  const dismiss = (slug: string) => {
    const next = { ...refusals }
    delete next[slug]
    refusals = next
    subs.forEach((fn) => fn())
  }
  return { refusals: all, dismiss }
}

function subscribe(fn: () => void): () => void {
  subs.add(fn)
  return () => {
    subs.delete(fn)
  }
}

const dismissedKey = (ws: string) => storageKey(ws, 'writeFailuresDismissed')

/** The failures standing per document, less those the analyst dismissed. */
export function useWriteFailures(ws: string): { failures: Record<string, WriteFailure>; dismiss: (f: WriteFailure) => void } {
  const all = useSyncExternalStore(subscribe, () => failures, () => failures)
  const dismissed = useSyncExternalStore(subscribeDismissed, () => readDismissed(ws), () => EMPTY)
  const shown: Record<string, WriteFailure> = {}
  for (const [slug, f] of Object.entries(all)) if (!dismissed.includes(f.seq)) shown[slug] = f
  const dismiss = (f: WriteFailure) => {
    // only the failures that still stand are kept, so the list stays as short as the type bar
    const standing = new Set(Object.values(failures).map((x) => x.seq))
    writeDismissed(ws, [...dismissed.filter((s) => standing.has(s)), f.seq])
  }
  return { failures: shown, dismiss }
}

const EMPTY: number[] = []
const dismissedSubs = new Set<() => void>()
let dismissedCache: { ws: string; list: number[] } | null = null

function subscribeDismissed(fn: () => void): () => void {
  dismissedSubs.add(fn)
  return () => {
    dismissedSubs.delete(fn)
  }
}

function readDismissed(ws: string): number[] {
  if (dismissedCache?.ws !== ws) {
    const raw = readStorage<unknown>(dismissedKey(ws), [])
    dismissedCache = { ws, list: Array.isArray(raw) ? raw.filter((x): x is number => typeof x === 'number') : [] }
  }
  return dismissedCache.list
}

function writeDismissed(ws: string, list: number[]) {
  dismissedCache = { ws, list }
  writeStorage(dismissedKey(ws), list)
  dismissedSubs.forEach((fn) => fn())
}
