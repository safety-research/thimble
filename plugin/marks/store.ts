// store.ts: each reply's marks and their checks, in $.state for drawing and on disk, so a resumed session draws the
// marks as their check left them and the evidence pane still opens.
//
//   <conversation folder>/marks/<reply>.json   one reply (Reply), written after each change (core/layout.mjs)
//   $.state: marks (Reply, by its key: the reply's last text row), marksRow (the reply's key, by each of its rows)
//
//   newReply($, reply)       a reply's marks, all `checking`, at the end of main's turn
//   editReply($, key, edit)  a change of the reply's marks (update(), so two forks that end at once both land)
//   rowMarks($, row)         what one row of the reply draws: its marks, and the reply's counts on its last row
//   replyKeyOf($, row)       the key of the reply a row belongs to
//   restoreMarks($)          the replies a resumed session's transcript holds, back in the state; a check that ran
//                            when the session ended is not checked
import { update, type EngineInterface } from 'claude-code'

import { keptDir } from '../core/env'
import { safeName } from '../core/layout.mjs'

type Engine = EngineInterface

export type MarkStatus = 'checking' | 'verified' | 'corrected' | 'failed' | 'unchecked'
/** A cited place of a file: its path from the folder the session started in, the cited line or range, and those lines
 *  with a line around them, the words found highlighted. */
export type Place = { file: string; line: string; lines: { n: number; text: string; highlight?: [number, number]; decoded?: true }[] }
export type Evidence =
  | { kind: 'computed'; code: string; output: string; highlight: [number, number][]; by: 'checker' | 'main' }
  | ({ kind: 'quote' | 'code'; more?: Place[] } & Place)
/** One mark: its number in the reply, its words, the row and place it stands at, its sentence, and its check. The
 *  person sees two outcomes: verified (`verified`, or `corrected`: the right words in place) and `failed`. `failedBy`
 *  says who failed it, for main alone: the checker (`check`: the claim is false and the check found no right words),
 *  or thimble, when the checker's evidence did not hold (`evidence`: the claim is not confirmed). `note` is what the check found wrong in the sentence outside the mark.
 *  `repair`: the person pressed x on it, and this check is the one x started (checker.ts startRepair). */
export type MarkItem = {
  n: number; row: string; words: string; start: number; end: number; sentence: string
  status: MarkStatus; shown: string; was?: string; reason?: string; failedBy?: 'check' | 'evidence'; evidence?: Evidence; note?: string; repair?: true
}
export type Reply = { key: string; turnId: string; rows: string[]; startedAt: number; settledAt: number | null; items: MarkItem[] }
/** What one row draws: its own marks, and the reply's counts (the last row draws them in the footer). */
export type RowMarks = { row: string; last: boolean; items: MarkItem[] } & Counts
/** A reply's marks by what the person sees: `checking` the marks still checked, `verified` those the check confirmed
 *  or corrected in place (`corrected` counts the corrections among them), `failed` those it could not confirm, by
 *  either cause (a failed mark looks one way, whoever failed it). */
export type Counts = { total: number; checking: number; verified: number; corrected: number; failed: number; unchecked: number }

const MARKS = { plugin: 'thimble', key: 'marks' } as const
const ROW = { plugin: 'thimble', key: 'marksRow' } as const

async function fileOf($: Engine, key: string): Promise<string> {
  return `${await keptDir($)}/marks/${safeName(key)}.json`
}

// the disk follows the state: one write at a time, each of the reply as it stands then, so the last write is the newest
let writing: Promise<unknown> = Promise.resolve()
function persist($: Engine, key: string): Promise<unknown> {
  writing = writing.then(async () => {
    const r = await replyOf($, key)
    if (r) await $.fs.write(await fileOf($, key), JSON.stringify(r))
  }).catch(() => undefined)
  return writing
}

export async function replyOf($: Engine, key: string): Promise<Reply | null> {
  return ((await $.state.get({ ...MARKS, id: key })).value ?? null) as Reply | null
}

async function setReply($: Engine, r: Reply): Promise<void> {
  await $.state.set({ ...MARKS, id: r.key }, r)
  for (const row of r.rows) await $.state.set({ ...ROW, id: row }, r.key)
}

export async function newReply($: Engine, r: Reply): Promise<void> {
  await setReply($, r)
  await persist($, r.key)
}

/** A change of the reply's marks, applied to the reply as it stands now; answers the reply as changed. */
export async function editReply($: Engine, key: string, edit: (r: Reply) => Reply): Promise<Reply | null> {
  const out = await update($, { ...MARKS, id: key }, cur => (cur ? edit(cur as Reply) : cur) as unknown)
  await persist($, key)
  return (out ?? null) as Reply | null
}

/** At each mark, the note the person reads under the block of its sentence: what the check found false in the words
 *  around the mark, one note a sentence (the forks share out sentences, so two notes on one sentence say the same
 *  thing). */
export function notesByMark(items: MarkItem[]): (string | undefined)[] {
  const seen = new Set<string>()
  return items.map(m => (m.note && !seen.has(m.sentence) && seen.add(m.sentence) ? m.note : undefined))
}

export function notesOf(items: MarkItem[]): string[] {
  return notesByMark(items).filter((n): n is string => !!n)
}

export function counts(r: Reply): Counts {
  const n = (f: (m: MarkItem) => boolean) => r.items.filter(f).length
  return {
    total: r.items.length,
    checking: n(m => m.status === 'checking'),
    verified: n(m => m.status === 'verified' || m.status === 'corrected'),
    corrected: n(m => m.status === 'corrected'),
    failed: n(m => m.status === 'failed'),
    unchecked: n(m => m.status === 'unchecked'),
  }
}

export async function replyKeyOf($: Engine, row: string): Promise<string | null> {
  return ((await $.state.get({ ...ROW, id: row })).value as string | undefined) ?? null
}

export async function rowMarks($: Engine, row: string): Promise<RowMarks | null> {
  const key = await replyKeyOf($, row)
  const r = key ? await replyOf($, key) : null
  if (!r) return null
  return { row, last: r.key === row, ...counts(r), items: r.items.filter(m => m.row === row) }
}

/** The replies kept for this conversation that the state does not hold (a resumed session), back in it. Their marks
 *  that were still checked stay unchecked: the check ended with the session that ran it. */
export async function restoreMarks($: Engine): Promise<void> {
  const dir = `${await keptDir($)}/marks`
  let entries: { name: string; kind: string }[] = []
  try { entries = (await $.fs.list(dir)) as { name: string; kind: string }[] } catch { return }
  for (const x of entries) {
    if (x.kind !== 'file' || !x.name.endsWith('.json')) continue
    let r: Reply
    try { r = JSON.parse(String(await $.fs.read(`${dir}/${x.name}`))) as Reply } catch { continue }
    if (!r?.key || !Array.isArray(r.items) || (await replyOf($, r.key))) continue
    const ended = r.items.some(m => m.status === 'checking')
    await setReply($, ended
      ? { ...r, items: r.items.map(m => (m.status === 'checking' ? { ...m, status: 'unchecked', reason: 'the session ended before the check did' } : m)) }
      : r)
    if (ended) await persist($, r.key)
  }
}
