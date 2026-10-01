// What a thread shows of its work that its own log does not say: where its question is while nothing of the run shows
// yet (with main, which has not forked the thread, or with the fork of main that answers it), and the edits main made
// itself to the cards the thread is anchored on, which land in main's log rather than the thread's.
import type { ChatMeta, ChatRecord } from '../lib/types'
import { toolDisplayName, type Row, type ToolRow } from './model'

/** `sent`: the question waits for main to fork the thread; `working`: a fork of main answers it. */
export type ThreadStage = 'sent' | 'working'

/** What a working thread's line says at each stage. */
export const STAGE_TEXT: Record<ThreadStage, string> = { sent: 'Sent to main', working: 'Main is working on it' }

/** Where a running thread's question is (ThreadStage); null while the thread does not run. Pure. */
export function threadStage(meta: Pick<ChatMeta, 'fork'> | null | undefined, running: boolean): ThreadStage | null {
  if (!running) return null
  const fork = meta?.fork
  return fork?.agent_id && !fork.ended ? 'working' : 'sent'
}

const ANCHOR_CARD_RE = /^(?:card|cell):([A-Za-z0-9_-]+)/
const CALL_CARD_RE = /^(?:(?:card|cell):)?([A-Za-z0-9_-]+)/

/** The card an edit_card call names (`card`, or `cell` in older calls), or null. */
export function editedCard(row: Pick<ToolRow, 'input'>): string | null {
  const inp = (row.input && typeof row.input === 'object' ? row.input : {}) as Record<string, unknown>
  const m = CALL_CARD_RE.exec(String(inp.card ?? inp.cell ?? '').trim())
  return m ? m[1] : null
}

const time = (ts: string | undefined): number => (ts ? Date.parse(ts) : NaN)

/**
 * Main's own edits of the cards the thread is anchored on (`anchors`), keyed by the index of the question each answered:
 * an edit_card call among main's rows (`mainRows`) on one of those cards, made after one of the thread's questions and
 * before the run it started ended (the log's next `done` or `error`). Pure.
 */
export function mainEdits(records: readonly ChatRecord[], mainRows: readonly Row[], anchors: readonly string[]): Map<number, ToolRow[]> {
  const out = new Map<number, ToolRow[]>()
  const cards = new Set(anchors.map((a) => ANCHOR_CARD_RE.exec(a.trim())?.[1]).filter((id): id is string => !!id))
  if (!cards.size) return out
  // each question's window: from when it was asked to the end of the run it started (Infinity while that run goes on)
  const windows: { index: number; from: number; to: number }[] = []
  records.forEach((r, i) => {
    if (r.type !== 'user' || Number.isNaN(time(r.ts))) return
    const end = records.slice(i + 1).find((x) => x.type === 'done' || x.type === 'error')
    const to = end && 'ts' in end && !Number.isNaN(time(end.ts)) ? time(end.ts) : Infinity
    windows.push({ index: i, from: time(r.ts), to })
  })
  if (!windows.length) return out
  for (const row of mainRows) {
    if (row.kind !== 'tool' || toolDisplayName(row.name) !== 'edit_card') continue
    const card = editedCard(row)
    const at = time(row.ts)
    if (!card || !cards.has(card) || Number.isNaN(at)) continue
    const w = [...windows].reverse().find((x) => at >= x.from && at < x.to)
    if (!w) continue
    out.set(w.index, [...(out.get(w.index) ?? []), row])
  }
  return out
}
