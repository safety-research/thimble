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
//                            when the session ended did not run (notRun)
//   notRun(m, why)           a mark whose check did not run or gave no answer: failed, with why
//   citedFiles($)            the conversation's cited files, each with what the last pass saw of it and the citations
//                            that rest on it (stale.ts), kept as each change of a reply's marks lands
//   sawFiles($, saw)         what a pass saw of the files it compared
import { update, type EngineInterface } from 'claude-code'

import { keptDir } from '../core/env'
import { safeName } from '../core/layout.mjs'

type Engine = EngineInterface

/** `deferred`: a mark that waits to be checked until the person opens it (the setting Citations auto, words the
 *  person asked about with c, a reply whose check could not start, or one its check could not judge because Claude Code
 *  refused the check's Python: checker.ts checkOpened, pythonEnded); drawn as the reply's own cited words, with a dim ?
 *  after it. */
export type MarkStatus = 'checking' | 'deferred' | 'verified' | 'corrected' | 'failed'
/** A cited place of a file: its path from the folder the session started in, the cited line or range, and those lines
 *  with a line around them, the words found highlighted. */
export type Place = { file: string; line: string; lines: { n: number; text: string; highlight?: [number, number]; decoded?: true }[] }
/** A table the evidence shows (engine/kernel/evidence.py table_of): the rows around the cited one, the cited cell `at`
 *  among them (c = -1: the row's name), and the rows left out above and below; `also`: the other cells that words with
 *  several values (a range, a pair) cite. */
export type EvidenceTable = { corner: string; cols: string[]; rows: { label: string; values: string[] }[]; at: { r: number; c: number }; above: number; below: number; also?: { r: number; c: number }[] }
export type Evidence =
  | { kind: 'computed'; code: string; output: string; highlight: [number, number][]; by: 'checker' | 'main'; table?: EvidenceTable }
  | ({ kind: 'quote' | 'code'; more?: Place[] } & Place)
  /** a value a card shows: its cell (`table`), or a line of its printed output (`output`, `highlight`, and `table` when
   *  that output is a table); `ref` names the place as a card's citation does. Words with several values cite a place
   *  for each (`refs`); places of another card or output are in `more`. A label's counts as they were when the cited
   *  words were written carry their `version`, when it was made (`at`), what made it and what changed after it */
  | { kind: 'card'; card: string; title: string; ref: string; value: string; table?: EvidenceTable; output?: string; highlight?: [number, number][]; refs?: string[]; more?: Evidence[]; version?: number; at?: number; made?: string; after?: string }
/** One mark: its number in the reply, its words, the row and place it stands at, its sentence, and its check. The
 *  person sees two outcomes: verified (`verified`, or `corrected`: the right words in place) and `failed`. `failedBy`
 *  says who failed it, for main alone: the checker (`check`: the claim is false and the check found no right words),
 *  thimble, when the checker's evidence did not hold (`evidence`: the claim is not confirmed), or no check
 *  (`none`: the check did not run or gave no answer, notRun; x starts it). `note` is what the check found wrong in the
 *  sentence outside the mark.
 *  `repair`: this check is a repair of it: one x started, or one thimble started when the reply's check failed it
 *  (checker.ts launchRepair, autoRepair).
 *  `narrowed`: a `corrected` mark whose check cites only a part of its words (`shown`): the rest is Claude's own wording,
 *  such as a translation, which the reply shows as plain words.
 *  `rewrite`: a `corrected` mark whose check rewrote its whole sentence (written as `sentence`, each citation
 *  `[words]`), which the reply shows in place of the old one; `sentence` and `was` keep what Claude wrote.
 *  `asked`: words the analyst selected and asked about (c, marks/cite.ts), not a mark Claude wrote:
 *  `start` and `end` are the words' place in the row's text as Claude wrote it (message.js withAsked).
 *  `unread`: the files a failed mark's check could not read and needed, as Claude Code refused them (checker.ts
 *  readEnded, endCheck).
 *  `sources`: what a verified or corrected mark rests on, as its check read it (Source).
 *  `rerun`: for computed evidence whose code its check ran again, what runs it again (Rerun).
 *  `fresh`: the files that changed after its check, once x checked it again for that: until a check of it passes, each
 *  check of it takes computed evidence only from its own calls (checker.ts repairOf, the validator's `fresh`), since
 *  what the session printed before the change shows the files as they were. */
export type MarkItem = {
  n: number; row: string; words: string; start: number; end: number; sentence: string
  status: MarkStatus; shown: string; was?: string; reason?: string; failedBy?: 'check' | 'evidence' | 'none'; evidence?: Evidence; note?: string; repair?: true; narrowed?: true; rewrite?: string; asked?: true; unread?: Unread[]; sources?: Source[]; rerun?: Rerun; fresh?: string[]
}
/** What a checked citation rests on (engine/kernel/evidence.py source): a file by the name a reason gives it, its real
 *  path, the cited lines when it rests on them alone (`head`: the hash of the first of several, which finds them where
 *  they moved), the file's size and mtime and the sha256 of what the check read. `changed` once what it rests on no
 *  longer reads so, `gone` once the file is not there (stale.ts): the citation is stale (tray/tray.mjs staleOf). Lines
 *  that only moved take their new numbers. */
export type Source = { file: string; path: string; line?: string; head?: string; size: number; mtime: number; sha256: string; changed?: true; gone?: true }
/** What runs the code of computed evidence again (engine/kernel/evidence.py check_computed): the call's command, the
 *  shell's folder and the session's, and the output the check gave. Its sources are the files that code read when the
 *  check ran it; once one of them changed, a pass runs it again (stale.ts), and the citation stays as it was when it
 *  prints that output again. */
export type Rerun = { command: string; cwd: string; root?: string; given: unknown }
/** A cited file as the last pass saw it (stale.ts): its size and mtime, or `gone`; null while no pass saw it since a
 *  resumed session read citations of it that their checks read at other times. */
export type Seen = { size: number; mtime: number } | { gone: true } | null
/** The conversation's cited files, by real path: what the last pass saw of each, and the citations that rest on it, by
 *  their reply's key. */
export type Cited = Record<string, { seen: Seen; by: Record<string, number[]> }>
/** A read of one file (checker.ts oneRead): a Read of it, or a Grep of it alone, by its absolute path. */
export type OneRead = { tool: 'Read' | 'Grep'; file: string }
/** A file a check could not read, by the tool that read it, and what lets it read the file (checker.ts readFix): `ok`,
 *  the person's OK, where Claude Code asked nobody about it; `ask`, Claude Code's own ask again, which the person did not
 *  say yes to; null, nothing the person can do here (a rule, a setting or auto mode's classifier refused it, or the
 *  classifier gave no verdict on it). */
export type Unread = OneRead & { fix: 'ok' | 'ask' | null }
/** `thread`: the reply is a side thread's answer (threads/thread.ts), by its agent and what it is about. */
export type Reply = { key: string; turnId: string; rows: string[]; startedAt: number; settledAt: number | null; items: MarkItem[]; thread?: { agentId: string; about: string }; wroteAt?: number }
/** What one row draws: its own marks, and the reply's counts. */
export type RowMarks = { row: string; last: boolean; items: MarkItem[] } & Counts
/** A reply's marks by what the person sees: `checking` the marks still checked, `verified` those the check confirmed
 *  or corrected in place (`corrected` counts the corrections among them), `failed` those it could not confirm, by
 *  any cause, a check that did not run too (a failed mark looks one way, whoever failed it). */
export type Counts = { total: number; checking: number; verified: number; corrected: number; failed: number }

const MARKS = { plugin: 'thimble', key: 'marks' } as const
const ROW = { plugin: 'thimble', key: 'marksRow' } as const
const CITED = { plugin: 'thimble', key: 'marksCited' } as const

/** The files a reply's citations rest on: by real path, the numbers of the citations that rest on each, and the stat
 *  their checks read it at (null when they read it at different times). */
function citedBy(r: Reply | null | undefined): Map<string, { ns: number[]; read: Seen }> {
  const out = new Map<string, { ns: number[]; read: Seen }>()
  for (const m of r?.items ?? []) {
    for (const s of m.sources ?? []) {
      const read: Seen = { size: s.size, mtime: s.mtime }
      const x = out.get(s.path)
      if (!x) out.set(s.path, { ns: [m.n], read })
      else {
        if (!x.ns.includes(m.n)) x.ns.push(m.n)
        if (!sameSeen(x.read, read)) x.read = null
      }
    }
  }
  return out
}

/** Whether two sights of a file are the same: both gone, or the same size and mtime (to the millisecond, as the kernel
 *  and the hooks each read it). Null is no sight: it matches nothing. */
export function sameSeen(a: Seen | undefined, b: Seen | undefined): boolean {
  if (!a || !b) return false
  if ('gone' in a || 'gone' in b) return 'gone' in a && 'gone' in b
  return a.size === b.size && Math.abs(a.mtime - b.mtime) < 1
}

/** The conversation's cited files (Cited), which stale.ts stats at each pass. */
export async function citedFiles($: Engine): Promise<Cited> {
  return ((await $.state.get(CITED)).value ?? {}) as Cited
}

/** What a pass saw of the files it compared, by path, kept for the next pass; a file no citation rests on any more is
 *  left out. */
export async function sawFiles($: Engine, saw: Record<string, Seen>): Promise<void> {
  await update($, CITED, cur => {
    const next: Cited = { ...((cur ?? {}) as Cited) }
    for (const [p, seen] of Object.entries(saw)) if (next[p]) next[p] = { ...next[p], seen }
    return next
  })
}

/** The index of cited files after an edit of reply `key` from `was` to `now`: each citation of it that no longer rests
 *  on a file is taken off that file, and each that rests on a file now is put on it, as changes, so two edits of one
 *  reply that land at once both count. A file new to the index is as its checks read it; a file no citation rests on
 *  goes. */
async function noteCited($: Engine, key: string, was: Reply | null, now: Reply | null): Promise<void> {
  const before = citedBy(was)
  const after = citedBy(now)
  const same = before.size === after.size && [...after].every(([p, x]) => {
    const b = before.get(p)
    return !!b && b.ns.length === x.ns.length && x.ns.every(n => b.ns.includes(n))
  })
  if (same) return
  await update($, CITED, cur => {
    const next: Cited = { ...((cur ?? {}) as Cited) }
    for (const p of new Set([...before.keys(), ...after.keys()])) {
      const gone = (before.get(p)?.ns ?? []).filter(n => !after.get(p)?.ns.includes(n))
      const added = (after.get(p)?.ns ?? []).filter(n => !before.get(p)?.ns.includes(n))
      if (!gone.length && !added.length) continue
      const f = next[p]
      const ns = [...new Set([...(f?.by[key] ?? []).filter(n => !gone.includes(n)), ...added])]
      const { [key]: _old, ...others } = f?.by ?? {}
      const by = ns.length ? { ...others, [key]: ns } : others
      if (!Object.keys(by).length) delete next[p]
      else next[p] = { seen: f ? f.seen : after.get(p)?.read ?? null, by }
    }
    return next
  })
}

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
  let was: Reply | null = null
  const out = await update($, { ...MARKS, id: key }, cur => {
    was = (cur ?? null) as Reply | null
    return (cur ? edit(cur as Reply) : cur) as unknown
  })
  await persist($, key)
  await noteCited($, key, was, (out ?? null) as Reply | null)
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
  }
}

/** The words the person reads when a mark's check did not run, or ran and gave no answer for it: the tray and the
 *  claims pane show this first sentence, the evidence pane the cause after it. */
export const NOT_RUN = 'The check did not run.'

/** A mark whose check did not run or gave no answer (`why`, a sentence or none): failed, as the person sees it, and x
 *  starts its check (checker.ts repairOf). Its earlier result goes, its place and words stay. */
export function notRun(m: MarkItem, why = ''): MarkItem {
  const { was: _w, evidence: _e, note: _n, sources: _s, rerun: _r, ...base } = m
  return { ...base, status: 'failed', failedBy: 'none', shown: m.words, reason: why ? `${NOT_RUN} ${why}` : NOT_RUN }
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
 *  that were still checked did not run: the check ended with the session that ran it. One that waits to be opened
 *  (`deferred`) still waits. The index of cited files is made again from all of them. */
export async function restoreMarks($: Engine): Promise<void> {
  const dir = `${await keptDir($)}/marks`
  let entries: { name: string; kind: string }[] = []
  // the cited files are this conversation's own, so a /clear or a /resume leaves the earlier one's
  const cited: Cited = {}
  try { entries = (await $.fs.list(dir)) as { name: string; kind: string }[] } catch { entries = [] }
  for (const x of entries) {
    if (x.kind !== 'file' || !x.name.endsWith('.json')) continue
    let r: Reply
    try { r = JSON.parse(String(await $.fs.read(`${dir}/${x.name}`))) as Reply } catch { continue }
    if (!r?.key || !Array.isArray(r.items)) continue
    const held = await replyOf($, r.key)
    const open = (m: MarkItem) => m.status === 'checking'
    const ended = !held && r.items.some(open)
    const now = held ?? (ended ? { ...r, items: r.items.map(m => (open(m) ? notRun(m, 'The session ended before it did.') : m)) } : r)
    // the files its citations rest on; what a pass saw of each is not kept, so a file its checks read at different
    // times is due
    for (const [p, x] of citedBy(now)) cited[p] = { seen: cited[p] && !sameSeen(cited[p].seen, x.read) ? null : x.read, by: { ...(cited[p]?.by ?? {}), [r.key]: x.ns } }
    if (held) continue
    await setReply($, now)
    if (ended) await persist($, r.key)
  }
  await $.state.set(CITED, cited)
}
