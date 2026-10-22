// checker.ts: the check of a reply's marks. After each of main's turns that answered with marks, a fork of the
// session (core/forks.ts, kind `checker`; for a reply with many marks, up to MAX_FORKS forks at once, each with a share
// of the marks) reads prompts/checker.md with its marks filled in and gives one answer per mark: verified, corrected or
// failed, with its evidence. engine/validate.py then checks that evidence without a model and without running code
// (engine/kernel/evidence.py): a quote must be in the file's line, and computed evidence must be code that one of the
// session's real Bash calls ran, whose real output shows the words. Its result is what the person sees.
//
//   noteRow($, row, text)     a text row of main's reply, as session.append stored it
//   startCheck($, e)          at the end of main's turn: the reply's marks (store.ts, all `checking`), the forks
//   endCheck($, e)            at the end of a checker's turn: the validator, its marks' statuses, what main is told
//   allowedTool(tool)         the tools the checker may call: it only reads
//
// state: marksRows (main's text rows of the turn that runs), marksRunning (the checks that run, by the fork's agent);
// the marks themselves are in store.ts
import { update, type EngineInterface } from 'claude-code'

import { busyWhile } from '../bar/busy'
import { failNotice } from '../bar/fix'
import { startDir } from '../core/env'
import { spawnFork } from '../core/forks'
import { tellAtNextPrompt } from '../core/tell'
import { promptText } from '../prompts/prompts'
import { featureOn } from '../settings/features.mjs'
import { record } from '../telemetry/telemetry'
import { marksIn, sentenceOf } from './message.js'
import { counts, editReply, type MarkItem, type MarkStatus, newReply, type Reply, replyOf } from './store'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** One fork's check: the reply, and the numbers of the marks this fork checks. `cwd` is the shell's folder, where the
 *  fork's code runs and its paths start; `root` the folder the session started in, which the pane's paths start from. */
type Check = { agentId: string; key: string; turnId: string; marks: number[]; cwd: string; root: string; replyEnd: number; spawnedAt: number }

const RUNNING = { plugin: 'thimble', key: 'marksRunning' } as const
const ROWS = { plugin: 'thimble', key: 'marksRows' } as const

/** A reply with many marks is split between forks, each with about PER_FORK marks (at most MAX_FORKS forks): a fork's
 *  time grows with its marks (about 10 s to start, then 3 to 9 s a mark, by how much its code has to compute), and the
 *  forks run at once, each from main's cached conversation, so the reply settles when its slowest share does. */
export const PER_FORK = 5
export const MAX_FORKS = 6

const READS = new Set(['Read', 'Grep', 'Glob', 'Bash'])

/** The checker reads files and runs code that prints; it changes nothing. */
export const allowedTool = (tool: string) => READS.has(String(tool))
export const DENIED = 'The check of the marks only reads: it can use Read, Grep, Glob and Bash.'

/** One of main's text rows, as session.append stored it: kept until main's turn ends (in the state, so a reload of the
 *  plugin mid-turn keeps them). */
export async function noteRow($: Engine, row: string, text: string): Promise<void> {
  const at = Number(await $.clock.now())
  await update($, ROWS, cur => [...(cur ?? []), { row, text, at }])
}

async function running($: Engine): Promise<Record<string, Check>> {
  return ((await $.state.get(RUNNING)).value ?? {}) as Record<string, Check>
}

/** Every mark of the reply's rows, numbered from 1 across them, each with its row and sentence. */
function itemsOf(reply: { row: string; text: string }[]): MarkItem[] {
  let n = 0
  return reply.flatMap(r => marksIn(r.text).map((m: Any) => ({
    n: ++n, row: r.row, words: m.words, start: m.start, end: m.end, sentence: sentenceOf(r.text, m), status: 'checking' as MarkStatus, shown: m.words,
  })))
}

/** The checker's prompt: checker.md with the marks (`n. [words] in: <sentence>`) and the working folder filled in. */
export function checkerPrompt(template: string, items: MarkItem[], cwd: string): string {
  const lines = items.map(m => `${m.n}. [${m.words}] in: ${m.sentence}`)
  return template.replace('{marks}', lines.join('\n')).replaceAll('{cwd}', cwd)
}

/** The reply with its items changed, and the time it settled once no mark is checked. */
function settle(r: Reply, now: number, items: MarkItem[]): Reply {
  return { ...r, items, settledAt: items.some(m => m.status === 'checking') ? null : now }
}

/** Every mark of a check that is still checked becomes unchecked: no check could give an answer. */
async function giveUp($: Engine, c: Check, why: string, now: number): Promise<void> {
  const mine = new Set(c.marks)
  await editReply($, c.key, r => settle(r, now, r.items.map(m => (mine.has(m.n) && m.status === 'checking' ? { ...m, status: 'unchecked' as MarkStatus, reason: why } : m))))
}

/** The marks split into the forks' shares, in order: one share up to PER_FORK marks, else as many as PER_FORK gives
 *  (at most MAX_FORKS), of about equal size, and the marks of one sentence always in one share. */
export function splitMarks<M extends { sentence: string }>(items: M[]): M[][] {
  const k = Math.min(MAX_FORKS, Math.max(1, Math.ceil(items.length / PER_FORK)))
  const size = Math.ceil(items.length / k)
  const out: M[][] = [[]]
  for (const m of items) {
    const cur = out[out.length - 1]!
    if (cur.length >= size && cur[cur.length - 1]!.sentence !== m.sentence && out.length < k) out.push([m])
    else cur.push(m)
  }
  return out
}

/** At the end of one of main's turns: when its reply holds marks, the reply's marks go in the store, and the checker
 *  forks start, each with its share of the marks. An interrupted turn's marks stay unchecked. Call it inside the
 *  turn.complete hook, so the plugin's other hooks serve the fork (core/forks.ts). */
export async function startCheck($: Engine, e: { turnId: string; reason: string }): Promise<void> {
  const noted = ((await $.state.get(ROWS)).value ?? []) as { row: string; text: string; at: number }[]
  await $.state.set(ROWS, [])
  const reply = noted.filter(r => r.text.trim())
  if (!reply.length || !featureOn('marks')) return
  const items = itemsOf(reply)
  if (!items.length) return
  const now = Number(await $.clock.now())
  const key = reply[reply.length - 1]!.row
  const rows = [...new Set([...items.map(m => m.row), key])]
  await newReply($, { key, turnId: e.turnId, rows, startedAt: now, settledAt: null, items })
  const cwd = String(await $.session.cwd())
  const whole: Check = { agentId: '', key, turnId: e.turnId, marks: items.map(m => m.n), cwd, root: await startDir($), replyEnd: reply[reply.length - 1]!.at, spawnedAt: now }
  if (e.reason !== 'answer') {
    await giveUp($, whole, 'the reply was interrupted before its marks were checked', now)
    return
  }
  let template = ''
  try {
    template = await promptText($, 'checker')
  } catch (err) {
    await giveUp($, whole, 'thimble could not read its checker text', now)
    failNotice($, `thimble could not read its checker text (${String((err as Error)?.message || err).slice(0, 80)}), so the marks are not checked. Reinstall thimble.`)
    return
  }
  const shares = splitMarks(items)
  const started: string[] = []
  for (const share of shares) {
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
    started.push(agentId)
  }
  if (started.length) {
    await busyWhile($, `checking ${items.length} mark${items.length === 1 ? '' : 's'}`, async () => {
      const now = await running($)
      return started.some(id => !!now[id])
    })
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

/** What main reads with the person's next prompt: each mark the check corrected or flagged, as the person reads it,
 *  and what the check found wrong in a sentence outside its marks. A mark whose evidence did not hold is not shown to
 *  be wrong, and main hears it that way. */
export function tellText(items: MarkItem[]): string {
  const q = (w: string) => (/^["“]/.test(w) ? w : `"${w}"`)
  const said = items.filter(m => m.status === 'corrected' || m.status === 'failed').map(m => {
    if (m.status === 'corrected') return `- ${q(m.was ?? m.words)} is corrected to ${q(m.shown)}${m.reason ? `: ${m.reason}` : ''}`
    if (m.failedBy === 'evidence') return `- ${q(m.words)} is marked as not confirmed: the check could not show it from the data`
    return `- ${q(m.words)} is marked as wrong${m.reason ? `: ${m.reason}` : ''}`
  })
  const seen = new Set<string>()
  const notes = items.filter(m => m.note && !seen.has(m.sentence) && seen.add(m.sentence)).map(m => `- In "${m.sentence}": ${m.note}`)
  if (!said.length && !notes.length) return ''
  const parts = ['thimble checked the marks of your last reply against the data.']
  if (said.length) parts.push(`The analyst now sees these changes in it:\n${said.join('\n')}\nUse the corrected words from now on. A claim marked as wrong is wrong as the check read the data. A claim the check could not confirm may still be true: when you need it again, check it first.`)
  if (notes.length) parts.push(`The check also found these statements wrong, which no mark carried, so the analyst does not see a flag on them:\n${notes.join('\n')}\nCorrect them for the analyst when you next write about them.`)
  return parts.join('\n')
}

/** The person's line when a check gave no answer, by why its turn ended. */
function giveUpLine(reason: string): string {
  if (reason === 'refusal') return "The model's safeguards refused the check of the marks, so they are not checked. /model can switch to another model."
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
    const items = ((await replyOf($, c.key))?.items ?? []).filter(m => mine.has(m.n))
    const calls = [...bashCalls(await $.session.messages({ agentId: e.agentId }), 'checker'), ...bashCalls(await $.session.messages(), 'main')]
    const plugin = $.plugin.root.replace(/\/+$/, '')
    const ran = await $.process.run([await python($), `${plugin}/engine/validate.py`], {
      cwd: c.cwd, timeoutMs: 120000,
      stdin: JSON.stringify({ cwd: c.cwd, root: c.root, marks: items.map(m => ({ n: m.n, words: m.words, sentence: m.sentence })), answer: e.answer, calls }),
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
    const reply = await editReply($, c.key, r => settle(r, settled, r.items.map(m => {
      if (!mine.has(m.n)) return m
      const v = byN.get(m.n)
      if (!v) return { ...m, status: 'unchecked' as MarkStatus, reason: 'the check gave no answer for this mark' }
      const { n: _n, ...rest } = v
      return { ...m, ...rest, shown: String(v.shown ?? m.words) }
    })))
    if (!reply) return
    const text = tellText(reply.items)
    if (text) await tellAtNextPrompt($, `marks:${c.key}`, text)
    const count = (s: string) => reply.items.filter(m => mine.has(m.n) && m.status === s).length
    await record($, {
      kind: 'marks', feature: 'checker', marks: c.marks.length, reply_marks: reply.items.length, verified: count('verified'), corrected: count('corrected'), failed: count('failed'), unchecked: count('unchecked'),
      reply_end: c.replyEnd, spawned_ms: c.spawnedAt - c.replyEnd, fork_ms: forkEnd - c.spawnedAt, validate_ms: settled - forkEnd, settled_ms: settled - c.replyEnd,
      reply_settled: !counts(reply).checking, usage: e.usage ?? null,
    })
  } finally {
    await update($, RUNNING, cur => Object.fromEntries(Object.entries(cur ?? {}).filter(([id]) => id !== e.agentId)))
  }
}
