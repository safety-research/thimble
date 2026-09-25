// A document's history as the Report tab's History lists it: one row per generation, newest first, with when and by
// whom it was written, its length and what changed. A writer run is one draft whose earlier saves are folded under it
// as revisions. Drafts are numbered by their place in the list. Pure.
import type { DocHistory, DocVersion } from '../lib/types'

/** One save History can show or compare: generation `n`, or its revision `rev` (an earlier save of its run). */
export interface DraftRef {
  n: number
  rev: number | null
}

export interface RevisionRow {
  i: number
  /** `Save 1` */
  label: string
  when: string
  ts: string
  words: string
  available: boolean
}

/** What History shows in place of the editor: one save read-only, or what changed from one save to another. */
export type HistoryView = { kind: 'draft'; target: DraftRef } | { kind: 'diff'; from: DraftRef; to: DraftRef }

export interface HistoryRow {
  n: number
  /** `Draft 3`, by its place in the list (the oldest is Draft 1) */
  label: string
  /** `13:52` today, `Sep 24, 13:52` another day, empty when unknown */
  when: string
  /** the ISO time, for the tooltip */
  ts: string
  /** Writer, You or Claude */
  by: string
  /** `1,247 words`, empty when unknown */
  words: string
  /** what changed from the draft before; `First draft` for the first */
  changes: string[]
  /** what the analyst asked for, when the write was asked for with words */
  asked: string | null
  current: boolean
  /** whether its text is kept, so it opens */
  available: boolean
  /** the writer's chat it was saved in */
  writer: string | null
  /** the earlier saves of its run, oldest first */
  revisions: RevisionRow[]
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (n: number) => String(n).padStart(2, '0')

/** `13:52` for a time today, `Sep 24, 13:52` for another day (local time); empty for none or a bad one. */
export function whenLabel(ts: string | null | undefined, now: Date = new Date()): string {
  if (!ts) return ''
  const t = new Date(ts)
  if (Number.isNaN(t.getTime())) return ''
  const clock = `${pad(t.getHours())}:${pad(t.getMinutes())}`
  const sameDay = t.getFullYear() === now.getFullYear() && t.getMonth() === now.getMonth() && t.getDate() === now.getDate()
  if (sameDay) return clock
  const year = t.getFullYear() === now.getFullYear() ? '' : ` ${t.getFullYear()}`
  return `${MONTHS[t.getMonth()]} ${t.getDate()}${year}, ${clock}`
}

/** Who wrote a generation: the writer when it was saved in a writer's session, you for the analyst's own save, and
 * otherwise Claude (main's session, whose saves the server stamps `terminal`). */
export function whoWrote(v: Pick<DocVersion, 'source' | 'writer'>): string {
  if (v.writer) return 'Writer'
  if (v.source === 'analyst') return 'You'
  return 'Claude'
}

/** What changed in a generation, as its row says it. */
export function changesOf(v: Pick<DocVersion, 'n' | 'summary'>): string[] {
  const lines = (v.summary ?? []).map((x) => x.trim()).filter(Boolean)
  if (lines.length) return lines
  return v.n === 1 ? ['First draft'] : []
}

const wordsLabel = (w: number | null | undefined) => (w != null ? `${w.toLocaleString('en-US')} ${w === 1 ? 'word' : 'words'}` : '')

/** The rows of a history, newest first as the server lists them. */
export function historyRows(h: DocHistory | null | undefined, now: Date = new Date()): HistoryRow[] {
  const sorted = [...(h?.versions ?? [])].sort((a, b) => b.n - a.n)
  return sorted.map((v, k) => ({
    n: v.n,
    label: `Draft ${sorted.length - k}`,
    when: whenLabel(v.ts, now),
    ts: v.ts,
    by: whoWrote(v),
    words: wordsLabel(v.words),
    changes: changesOf({ n: sorted.length - k, summary: v.summary }),
    asked: v.instructions?.trim() || null,
    current: v.current,
    available: v.available,
    writer: v.writer,
    revisions: [...(v.revisions ?? [])]
      .sort((a, b) => a.i - b.i)
      .map((r) => ({ i: r.i, label: `Save ${r.i}`, when: whenLabel(r.ts, now), ts: r.ts, words: wordsLabel(r.words), available: r.available })),
  }))
}

/** Whether two refs name the same save. */
export const sameRef = (a: DraftRef | null | undefined, b: DraftRef | null | undefined): boolean =>
  a != null && b != null && a.n === b.n && (a.rev ?? null) === (b.rev ?? null)

/** The current draft's ref, null for an empty history. */
export function currentRef(rows: readonly HistoryRow[]): DraftRef | null {
  const r = rows.find((x) => x.current) ?? rows[0]
  return r ? { n: r.n, rev: null } : null
}

/** The save before one, to compare with: the previous draft, or the previous save within a run; null when none has
 * its text kept. */
export function previousOf(rows: readonly HistoryRow[], ref: DraftRef): DraftRef | null {
  const at = rows.findIndex((r) => r.n === ref.n)
  if (at < 0) return null
  if (ref.rev != null) {
    const revs = rows[at].revisions
    const k = revs.findIndex((r) => r.i === ref.rev)
    for (let x = k - 1; x >= 0; x--) if (revs[x].available) return { n: ref.n, rev: revs[x].i }
    if (k < 0) return null
  }
  const older = rows.slice(at + 1).find((r) => r.available)
  if (older) return { n: older.n, rev: null }
  if (ref.rev == null) {
    // the first draft: its run's last save before it
    const last = [...rows[at].revisions].reverse().find((r) => r.available)
    if (last) return { n: ref.n, rev: last.i }
  }
  return null
}

/** A save's name: `Draft 2`, `Draft 2 · Save 1`, `Current`. */
export function draftName(rows: readonly HistoryRow[], ref: DraftRef): string {
  const r = rows.find((x) => x.n === ref.n)
  if (!r) return `Draft ${ref.n}`
  if (ref.rev == null) return r.label
  return `${r.label} · Save ${ref.rev}`
}

/** A save's meta line: when, who and how long, as its row shows it. */
export function draftMeta(rows: readonly HistoryRow[], ref: DraftRef): string {
  const r = rows.find((x) => x.n === ref.n)
  if (!r) return ''
  if (ref.rev == null) return rowMeta(r)
  const s = r.revisions.find((x) => x.i === ref.rev)
  return s ? rowMeta({ when: s.when, by: r.by, words: s.words }) : ''
}

/** The line a row shows under its draft: when, who, how long, the parts there are. */
export function rowMeta(r: Pick<HistoryRow, 'when' | 'by' | 'words'>): string {
  return [r.when, r.by, r.words].filter(Boolean).join(' · ')
}
