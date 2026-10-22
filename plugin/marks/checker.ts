// checker.ts: the check of a reply's marks. After each of main's turns that answered with marks, a fork of the
// session (core/forks.ts, kind `checker`; for a reply with many marks, up to MAX_FORKS forks at once, each with a share
// of the marks) reads prompts/checker.md with its marks filled in and gives one answer per mark: verified, corrected or failed, with its evidence. engine/validate.py then checks that evidence without a model
// and without running code (engine/kernel/evidence.py): a quote must be in the file's line, and computed evidence must
// be code that one of the session's real Bash calls ran, whose real output shows the words. Its result is what the
// person sees.
//
//   noteRow($, row, text)     a text row of main's reply, as session.append stored it
//   startCheck($, e)          at the end of main's turn: the marks of its rows, the state (all `checking`), the forks
//   endCheck($, e)            at the end of a checker's turn: the validator, its marks' statuses, what main is told
//   allowedTool(tool)         the tools the checker may call: it only reads
//
// state: marks (by reply row: ReplyMarks, which the renderer reads), marksRows (main's text rows of the turn that runs),
// marksRunning (the checks that run, by the fork's agent); all in the state, so a reload of the plugin loses none
import { update, type EngineInterface } from 'claude-code'

import { busyWhile } from '../bar/busy'
import { failNotice } from '../bar/fix'
import { spawnFork } from '../core/forks'
import { tellAtNextPrompt } from '../core/tell'
import { promptText } from '../prompts/prompts'
import { featureOn } from '../settings/features.mjs'
import { record } from '../telemetry/telemetry'
import { marksIn, sentenceOf } from './message.js'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export type MarkStatus = 'checking' | 'verified' | 'corrected' | 'failed' | 'unchecked'
export type Evidence =
  | { kind: 'computed'; code: string; output: string; highlight: [number, number][]; by: 'checker' | 'main' }
  | { kind: 'quote' | 'code'; file: string; line: string; lines: { n: number; text: string; highlight?: [number, number]; decoded?: true }[] }
export type MarkItem = { n: number; words: string; start: number; end: number; sentence: string; status: MarkStatus; shown: string; was?: string; reason?: string; evidence?: Evidence }
export type ReplyMarks = {
  row: string
  turnId: string
  /** the reply's last text row: it draws the footer, and holds the counts of the whole reply */
  last: boolean
  total: number
  checking: boolean
  startedAt: number
  settledAt: number | null
  failed: number
  unchecked: number
  items: MarkItem[]
}
/** One fork's check: the reply's rows, and the numbers of the marks this fork checks. */
type Check = { agentId: string; turnId: string; rows: string[]; marks: number[]; cwd: string; replyEnd: number; spawnedAt: number }

const MARKS = { plugin: 'thimble', key: 'marks' } as const
const RUNNING = { plugin: 'thimble', key: 'marksRunning' } as const

/** A reply with many marks is split between forks, each with about PER_FORK marks (at most MAX_FORKS forks): a fork's
 *  time grows with its marks, and the forks run at once, each from main's cached conversation. */
export const PER_FORK = 10
export const MAX_FORKS = 4

const READS = new Set(['Read', 'Grep', 'Glob', 'Bash'])

/** The checker reads files and runs code that prints; it changes nothing. */
export const allowedTool = (tool: string) => READS.has(String(tool))
export const DENIED = 'The check of the marks only reads: it can use Read, Grep, Glob and Bash.'

const ROWS = { plugin: 'thimble', key: 'marksRows' } as const

/** One of main's text rows, as session.append stored it: kept until main's turn ends (in the state, so a reload of the
 *  plugin mid-turn keeps them). */
export async function noteRow($: Engine, row: string, text: string): Promise<void> {
  const at = Number(await $.clock.now())
  await update($, ROWS, cur => [...(cur ?? []), { row, text, at }])
}

export async function marksOf($: Engine, row: string): Promise<ReplyMarks | null> {
  return ((await $.state.get({ ...MARKS, id: row })).value ?? null) as ReplyMarks | null
}

async function running($: Engine): Promise<Record<string, Check>> {
  return ((await $.state.get(RUNNING)).value ?? {}) as Record<string, Check>
}

/** Every mark of the reply's rows, numbered from 1 across them, each with its sentence. */
function itemsOf(reply: { row: string; text: string }[]): Map<string, MarkItem[]> {
  const out = new Map<string, MarkItem[]>()
  let n = 0
  for (const r of reply) {
    out.set(r.row, marksIn(r.text).map((m: Any) => ({ n: ++n, words: m.words, start: m.start, end: m.end, sentence: sentenceOf(r.text, m), status: 'checking' as MarkStatus, shown: m.words })))
  }
  return out
}

/** The checker's prompt: checker.md with the marks (`n. [words] in: <sentence>`) and the working folder filled in. */
export function checkerPrompt(template: string, items: MarkItem[], cwd: string): string {
  const lines = items.map(m => `${m.n}. [${m.words}] in: ${m.sentence}`)
  return template.replace('{marks}', lines.join('\n')).replaceAll('{cwd}', cwd)
}

/** The rows of a reply, each with its items as `edit` leaves them, and the reply's counts on its last row. */
async function writeReply($: Engine, reply: string[], o: { turnId: string; startedAt: number; settledAt: number | null }, edit: (items: MarkItem[]) => MarkItem[]): Promise<ReplyMarks[]> {
  const kept: ReplyMarks[] = []
  for (const row of reply) {
    const cur = await marksOf($, row)
    if (cur) kept.push({ ...cur, items: edit(cur.items) })
  }
  const all = kept.flatMap(r => r.items)
  const checking = all.some(m => m.status === 'checking')
  const failed = all.filter(m => m.status === 'failed').length
  const unchecked = all.filter(m => m.status === 'unchecked').length
  for (const r of kept) await $.state.set({ ...MARKS, id: r.row }, { ...r, ...o, settledAt: checking ? null : o.settledAt, checking, failed, unchecked, total: all.length })
  return kept
}

/** Every mark of a check that is still checked becomes unchecked: no check could give an answer. */
async function giveUp($: Engine, c: Check, why: string, now: number): Promise<void> {
  const mine = new Set(c.marks)
  await writeReply($, c.rows, { turnId: c.turnId, startedAt: c.spawnedAt, settledAt: now }, items => items.map(m => (mine.has(m.n) && m.status === 'checking' ? { ...m, status: 'unchecked' as MarkStatus, reason: why } : m)))
}

/** The marks split into the forks' shares, in order: one share up to PER_FORK marks, else as many as PER_FORK gives
 *  (at most MAX_FORKS), of about equal size, and the marks of one sentence always in one share. */
export function splitMarks(items: MarkItem[]): MarkItem[][] {
  const k = Math.min(MAX_FORKS, Math.max(1, Math.ceil(items.length / PER_FORK)))
  const size = Math.ceil(items.length / k)
  const out: MarkItem[][] = [[]]
  for (const m of items) {
    const cur = out[out.length - 1]!
    if (cur.length >= size && cur[cur.length - 1]!.sentence !== m.sentence && out.length < k) out.push([m])
    else cur.push(m)
  }
  return out
}

/** At the end of one of main's turns: when its reply holds marks, each of its rows gets its marks in the state, and
 *  the checker forks start, each with its share of the marks. An interrupted turn's marks stay unchecked. Call it inside the turn.complete hook, so the
 *  plugin's other hooks serve the fork (core/forks.ts). */
export async function startCheck($: Engine, e: { turnId: string; reason: string }): Promise<void> {
  const noted = ((await $.state.get(ROWS)).value ?? []) as { row: string; text: string; at: number }[]
  await $.state.set(ROWS, [])
  const reply = noted.filter(r => r.text.trim())
  const replyEnd = reply.length ? reply[reply.length - 1]!.at : 0
  if (!reply.length || !featureOn('marks')) return
  const byRow = itemsOf(reply)
  const items = [...byRow.values()].flat()
  if (!items.length) return
  const now = Number(await $.clock.now())
  const last = reply[reply.length - 1]!.row
  const base = { turnId: e.turnId, startedAt: now, settledAt: null, failed: 0, unchecked: 0, total: items.length, checking: true }
  for (const r of reply) {
    const mine = byRow.get(r.row) ?? []
    if (mine.length || r.row === last) await $.state.set({ ...MARKS, id: r.row }, { ...base, row: r.row, last: r.row === last, items: mine })
  }
  const rowsWith = reply.filter(r => (byRow.get(r.row) ?? []).length || r.row === last).map(r => r.row)
  const cwd = String(await $.session.cwd())
  const whole: Check = { agentId: '', turnId: e.turnId, rows: rowsWith, marks: items.map(m => m.n), cwd, replyEnd, spawnedAt: now }
  if (e.reason !== 'answer') {
    await giveUp($, whole, 'the reply was interrupted before its marks were checked', now)
    return
  }
  let template = ''
  try {
    template = (await promptText($, 'checker')).text
  } catch (err) {
    await giveUp($, whole, 'thimble could not read its checker text', now)
    failNotice($, `thimble could not read its checker text (${String((err as Error)?.message || err).slice(0, 80)}), so the marks are not checked. Reinstall thimble.`)
    return
  }
  for (const share of splitMarks(items)) {
    const c: Check = { ...whole, marks: share.map(m => m.n) }
    const fork = await spawnFork($, { kind: 'checker', prompt: checkerPrompt(template, share, cwd), description: 'checking marks' })
    if (!fork.agentId) {
      await giveUp($, c, 'the check could not start', now)
      failNotice($, `The check of the marks could not start (${String(fork.deny || 'no reason given').slice(0, 80)}), so they are not checked.`)
      continue
    }
    const agentId = fork.agentId
    const spawnedAt = Number(await $.clock.now())
    await update($, RUNNING, cur => ({ ...(cur ?? {}), [agentId]: { ...c, agentId, spawnedAt } }))
    await busyWhile($, 'checking marks', async () => !!(await running($))[agentId])
  }
}

/** The real Bash calls of a conversation, with their output as the model read it: a call that ended with an error
 *  counts too, since what it printed before the error is real output. */
function bashCalls(msgs: Any, by: 'checker' | 'main'): { command: string; output: string; by: string }[] {
  if (!Array.isArray(msgs)) return []
  const out: { command: string; output: string; by: string }[] = []
  for (const m of msgs) {
    for (const u of m?.toolUses ?? []) {
      if (String(u?.tool) === 'Bash' && typeof u?.input?.command === 'string' && typeof u?.text === 'string') out.push({ command: u.input.command, output: u.text, by })
    }
  }
  return out
}

/** The Python that runs the kernel, as bin/thimble picks it: THIMBLE_PYTHON, else the plugin's own .venv, else
 *  python3. */
async function python($: Engine): Promise<string> {
  const own = await $.env.get('THIMBLE_PYTHON')
  if (own) return own
  const venv = `${$.plugin.root.replace(/\/+$/, '')}/.venv/bin/python`
  return (await $.fs.exists(venv)) ? venv : 'python3'
}

/** What main reads with the person's next prompt: each mark the check corrected or failed. */
export function tellText(items: MarkItem[]): string {
  const said = items.filter(m => m.status === 'corrected' || m.status === 'failed').map(m => (m.status === 'corrected'
    ? `- mark ${m.n}: "${m.was ?? m.words}" is corrected to "${m.shown}"${m.reason ? ` (${m.reason})` : ''}`
    : `- mark ${m.n}: "${m.words}" failed: ${m.reason || 'no source supports it'}`))
  if (!said.length) return ''
  return `thimble checked the marks of your reply. The person now sees these changes on it:\n${said.join('\n')}\nUse the corrected words from now on, and do not repeat a claim that failed.`
}

/** The person's line when a check gave no answer, by why its turn ended. */
function giveUpLine(reason: string): string {
  if (reason === 'refusal') return 'Safeguards refused the check of the marks, so they are not checked. /model can switch to Opus 4.8, which can check them.'
  if (reason === 'aborted') return 'The check of the marks was stopped, so they are not checked.'
  return 'The check of the marks stopped on an error, so they are not checked. The next reply is checked again.'
}

/** At the end of the checker's turn: its answer validated, each mark's status written, main told what changed, and
 *  the timings recorded. */
export async function endCheck($: Engine, e: { agentId: string; reason: string; answer: string; usage?: unknown }): Promise<void> {
  const c = (await running($))[e.agentId]
  if (!c) return
  const forkEnd = Number(await $.clock.now())
  try {
    if (e.reason !== 'answer') {
      await giveUp($, c, e.reason === 'refusal' ? 'safeguards refused the check' : `the check ended: ${e.reason}`, forkEnd)
      failNotice($, giveUpLine(e.reason))
      return
    }
    const mine = new Set(c.marks)
    const items = (await Promise.all(c.rows.map(r => marksOf($, r)))).flatMap(r => r?.items ?? []).filter(m => mine.has(m.n))
    const calls = [...bashCalls(await $.session.messages({ agentId: e.agentId }), 'checker'), ...bashCalls(await $.session.messages(), 'main')]
    const root = $.plugin.root.replace(/\/+$/, '')
    const ran = await $.process.run([await python($), `${root}/engine/validate.py`], {
      cwd: c.cwd, timeoutMs: 120000,
      stdin: JSON.stringify({ cwd: c.cwd, marks: items.map(m => ({ n: m.n, words: m.words })), answer: e.answer, calls }),
    })
    let out: { parsed: boolean; results: Any[] } | null = null
    try { out = JSON.parse(String(ran.stdout || '')) } catch { out = null }
    if (!out || ran.exitCode !== 0) {
      await giveUp($, c, 'thimble could not validate the check', forkEnd)
      failNotice($, `thimble could not validate the check of the marks (${String(ran.stderr || 'no output').trim().split('\n').pop()?.slice(0, 80)}), so they are not checked.`)
      return
    }
    if (!out.parsed) {
      await giveUp($, c, 'the check gave no answer thimble could read', forkEnd)
      failNotice($, 'The check of the marks gave no answer thimble could read, so they are not checked.')
      return
    }
    const byN = new Map(out.results.map(r => [Number(r.n), r]))
    const settled = Number(await $.clock.now())
    const kept = await writeReply($, c.rows, { turnId: c.turnId, startedAt: c.spawnedAt, settledAt: settled }, xs => xs.map(m => {
      if (!mine.has(m.n)) return m
      const r = byN.get(m.n)
      if (!r) return { ...m, status: 'unchecked' as MarkStatus, reason: 'the check gave no answer for this mark' }
      const { n: _n, ...rest } = r
      return { ...m, ...rest, shown: String(r.shown ?? m.words) }
    }))
    const all = kept.flatMap(r => r.items)
    const text = tellText(all)
    if (text) await tellAtNextPrompt($, `marks:${c.rows[c.rows.length - 1]}`, text)
    const count = (s: string) => all.filter(m => mine.has(m.n) && m.status === s).length
    await record($, {
      kind: 'marks', feature: 'checker', marks: c.marks.length, reply_marks: all.length, verified: count('verified'), corrected: count('corrected'), failed: count('failed'), unchecked: count('unchecked'),
      reply_end: c.replyEnd, spawned_ms: c.spawnedAt - c.replyEnd, fork_ms: forkEnd - c.spawnedAt, validate_ms: settled - forkEnd, settled_ms: settled - c.replyEnd,
      reply_settled: !all.some(m => m.status === 'checking'), usage: e.usage ?? null,
    })
  } finally {
    await update($, RUNNING, cur => Object.fromEntries(Object.entries(cur ?? {}).filter(([id]) => id !== e.agentId)))
  }
}
