// A side thread that answers while the panel does not show it (the analyst moved on) says so in three places: one row
// in main's chat at that moment ("↳ thread · <its question> · answered", `new` in green until read; a press opens the
// thread), its unread mark in the threads panel and in /thimble-home, and `N new` after `show all threads` on every
// panel's path row. A view main proposes gets a row of its own under the answer that proposed it ("↳ view · <its name> ·
// built"), kept the same way. Main's model reads nothing new:
// the row is drawn under a row main's chat already holds, and main keeps only the hidden note it got before
// (threads.ts threadNote).
//
// The row stands under the latest row of main's chat a hook of the mod can draw a line under (its anchor): a text row
// of main's reply, the analyst's prompt, the line saying how long a turn took, or a command's output. They are drawn by
// the uuid they were stored under (their `requestId`), which a resumed session keeps. register.tsx keeps the rows by
// that uuid in the plugin's state (`threadRows`) and draws; this file holds the rules, without `$`.
import type { ChatSignal, ChatThread } from '../types'
import { plainCites } from './cite'

/** A row as session.append hands it, the parts that say where it is drawn. */
export type AppendedRow = { door: string; origin?: { kind?: string }; message: { type: string; name?: string; content?: unknown } }

function texts(content: unknown): string[] {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  return content.flatMap(b => (b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string' ? [(b as { text: string }).text] : []))
}

/** Whether a row of main's conversation is drawn by a component the mod can add a line under: a text block of main's
 *  reply (AssistantMessage), a prompt the analyst typed (UserMessage), the turn's duration (TurnDuration) or a
 *  command's output (CommandOutput). A tool call is not: Claude Code may fold it into a group. */
export function isAnchor(r: AppendedRow): boolean {
  const m = r.message
  if (r.door === 'response') return m.type === 'assistant' && texts(m.content).some(t => t.trim().length > 0)
  if (r.door === 'prompt') return m.type === 'user' && r.origin?.kind === 'composer'
  if (r.door === 'notice') return m.type === 'system' && m.name === 'turn_duration'
  if (r.door === 'command') return m.type === 'system' && m.name === 'local_command' && texts(m.content).some(t => /^\s*<local-command-std(?:out|err)>/.test(t))
  return false
}

function firstWords(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  if (one.length <= n) return one
  const cut = one.slice(0, n + 1)
  const sp = cut.lastIndexOf(' ')
  return `${(sp > n / 2 ? cut.slice(0, sp) : one.slice(0, n)).replace(/[\s,;:.]+$/, '')}…`
}

/** What a turn's end says in main's chat: `answered`, `failed`, or null for a turn that is not news (still running, or
 *  stopped by the analyst). */
export function signalEnd(t: Pick<ChatThread, 'turns'>, turn: number): 'answered' | 'failed' | null {
  const x = t.turns[turn - 1]
  if (!x) return null
  if (x.state === 'done') return 'answered'
  if (x.state === 'error' && !/^\s*stopped/.test(x.a)) return 'failed'
  return null
}

/** The row's words: the question of the turn it reports, short, as its shown words. */
export function signalQuestion(t: Pick<ChatThread, 'turns' | 'label'>, turn: number, n = 48): string {
  const q = t.turns[turn - 1]?.q
  return q ? `"${firstWords(plainCites(q), n)}"` : `about ${firstWords(plainCites(t.label), n)}`
}

/** Whether the turn a row reports is read: the analyst has seen as many answers as it was. */
export function signalRead(t: Pick<ChatThread, 'turns'>, turn: number, seen: number | undefined): boolean {
  const answeredBy = t.turns.slice(0, turn).filter(x => x.state === 'done').length
  return seen !== undefined && seen >= answeredBy
}

/** What signals.json holds: the session it was written in (an anchor names a row of that session's transcript), the
 *  latest anchor, the answers seen of each thread, the thread rows each anchor carries (`waiting`: rows waiting for the
 *  first anchor, when a thread answered before main's chat held one), the views whose `↳ view` row each carries, and
 *  the views built and not yet opened (`new` after their names). */
export type SignalFile = { session: string; last: string; seen: Record<string, number>; rows: Record<string, ChatSignal[]>; views: Record<string, string[]>; fresh?: string[] }

export const SIGNALS_EMPTY: SignalFile = { session: '', last: '', seen: {}, rows: {}, views: {}, fresh: [] }
const ROWS_MAX = 200

function isSignal(x: unknown): x is ChatSignal {
  const s = x as Partial<ChatSignal> | null
  return !!s && typeof s.thread === 'string' && typeof s.turn === 'number'
}

export function parseSignals(raw: string): SignalFile {
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return { ...SIGNALS_EMPTY, seen: {}, rows: {}, views: {}, fresh: [] }
  }
  const o = (v ?? {}) as Partial<Record<keyof SignalFile, unknown>>
  const seen: Record<string, number> = {}
  for (const [k, n] of Object.entries((o.seen ?? {}) as Record<string, unknown>)) if (typeof n === 'number' && n >= 0) seen[k] = n
  const rows: Record<string, ChatSignal[]> = {}
  for (const [k, xs] of Object.entries((o.rows ?? {}) as Record<string, unknown>)) {
    const ok = Array.isArray(xs) ? xs.filter(isSignal).map(s => ({ thread: s.thread, turn: s.turn })) : []
    if (ok.length) rows[k] = ok
  }
  const views: Record<string, string[]> = {}
  for (const [k, xs] of Object.entries((o.views ?? {}) as Record<string, unknown>)) {
    const ok = Array.isArray(xs) ? xs.filter((x): x is string => typeof x === 'string' && x !== '') : []
    if (ok.length) views[k] = ok
  }
  const fresh = Array.isArray(o.fresh) ? o.fresh.filter((x): x is string => typeof x === 'string' && x !== '') : []
  return { session: typeof o.session === 'string' ? o.session : '', last: typeof o.last === 'string' ? o.last : '', seen, rows, views, fresh }
}

/** signals.json's text: the rows of the latest 200 anchors. */
export function signalsJson(f: SignalFile): string {
  const keys = Object.keys(f.rows)
  const rows = Object.fromEntries(keys.slice(Math.max(0, keys.length - ROWS_MAX)).map(k => [k, f.rows[k]!]))
  const vkeys = Object.keys(f.views ?? {})
  const views = Object.fromEntries(vkeys.slice(Math.max(0, vkeys.length - ROWS_MAX)).map(k => [k, f.views[k]!]))
  return JSON.stringify({ session: f.session, last: f.last, seen: f.seen, rows, views, fresh: f.fresh ?? [] }, null, 1)
}

/** The rows `anchor` carries once a signal is added: the same turn of a thread is reported once. */
export function withSignal(rows: readonly ChatSignal[], s: ChatSignal): ChatSignal[] {
  return rows.some(x => x.thread === s.thread && x.turn === s.turn) ? rows.slice() : [...rows, s]
}

/** How many threads hold answers the analyst has not read, and the one when there is only one. */
export function newsOf(threads: readonly Pick<ChatThread, 'id' | 'turns'>[], seen: (id: string) => number | undefined): { n: number; one: string } {
  const fresh = threads.filter(t => {
    const s = seen(t.id)
    return s !== undefined && t.turns.filter(x => x.state === 'done').length > s
  })
  return { n: fresh.length, one: fresh.length === 1 ? fresh[0]!.id : '' }
}
