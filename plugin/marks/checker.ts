// checker.ts: the check of a reply's marks. After each of main's turns that answered with marks, a fork of the
// session (core/forks.ts, kind `checker`; for a reply with many marks, up to MAX_FORKS forks at once, each with a share
// of the marks) reads prompts/checker.md with its marks filled in and gives one answer per mark: verified, corrected,
// wrong or unconfirmed, with its evidence. `thimble dev validate` (engine/validate.py) then checks that evidence without a model and
// without running code (engine/kernel/evidence.py): a quote must be in the file's line, and computed evidence names one
// of the session's real Bash calls (the checker's or main's) by a part of its output, and that call's real output must
// show the words. Its result is what the person sees.
//
//   noteRow($, row, text)     a text row of main's reply, as session.append stored it
//   startCheck($, e)          at the end of main's turn: the reply's marks (store.ts, all `checking`), the forks
//   endCheck($, e)            at the end of a checker's turn: the validator, its marks' statuses
//   resumeChecks($)           at session start: the checks a reload of the plugin left running, on the busy line again;
//                             a check whose fork is gone gives up, and says so
//   checkerDenial(e)          why the checker may not make a call: it reads files, and runs code only as one Python script
//   repairOf($, row, n)       x on a wrong or not-confirmed citation (tray): what a check of that one mark again needs
//   launchRepair($, r, hold)  that check's fork, with a request to find the right value and correct the cited words;
//                             its mark is `checking` while it runs, and its end is endCheck's as any check's. Call it
//                             inside a hook (the spawn is its first call); a key's spawn waits out the word window
//                             (`hold`, marks/register.ts holds it) and is refused when the person typed a word
//
// Every way a fork's check ends (an answer, a refusal, an error, a validator that fails, a fork that is gone) leaves no
// mark of its share `checking`. When a reply's last mark settles, main is told what changed (tellText), once; when a
// repair ends, main is told how that one mark ended (repairTellText).
//
// state: marksRows (main's text rows of the turn that runs), marksRunning (the checks that run, by the fork's agent);
// the marks themselves are in store.ts
import { update, type EngineInterface } from 'claude-code'

import { busyWhile } from '../bar/busy'
import { failNotice, noticeLine } from '../bar/notice'
import { startDir } from '../core/env'
import { spawnFork } from '../core/forks'
import { tempDir } from '../core/home'
import { tellAtNextPrompt } from '../core/tell'
import { fenced } from '../core/text.js'
import { promptText } from '../prompts/prompts'
import { fill } from '../prompts/registry.mjs'
import { featureOn } from '../settings/features.mjs'
import { record } from '../telemetry/telemetry'
import { marksIn, sentenceOf } from './message.js'
import { counts, editReply, type MarkItem, type MarkStatus, newReply, notesOf, type Reply, replyKeyOf, replyOf } from './store'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** One fork's check: the reply, and the numbers of the marks this fork checks. `cwd` is the shell's folder, where the
 *  fork's code runs; `root` the folder the session started in, which the pane's paths start from. A relative path of
 *  the evidence is read from either. */
type Check = { agentId: string; key: string; turnId: string; marks: number[]; cwd: string; root: string; replyEnd: number; spawnedAt: number; repair?: boolean }

const RUNNING = { plugin: 'thimble', key: 'marksRunning' } as const
const ROWS = { plugin: 'thimble', key: 'marksRows' } as const

/** A reply with many marks is split between forks, each with about PER_FORK marks (at most MAX_FORKS forks): a fork's
 *  time grows with its marks (about 10 s to start, then 3 to 9 s a mark, mostly the answer it writes for each), and
 *  the forks run at once, each from main's cached conversation, so the reply settles when its slowest share does. */
export const PER_FORK = 4
export const MAX_FORKS = 8

const READS = new Set(['Read', 'Grep', 'Glob', 'Bash'])

/** A Bash command that only runs one Python script from a here-document (`python3 - <<'PY'`, the script, `PY`), after a
 *  `cd` at most (with `&&`, `;` or a line of its own): the form checker.md asks for, and the one
 *  engine/kernel/evidence.py shows as a call's code. */
function oneScript(command: string): boolean {
  const lines = String(command).trimEnd().replace(/^\s*cd\s+\S+[ \t]*\n/, m => m.replace('\n', '; ')).split('\n')
  const m = /^(?:cd\s+\S+\s*(?:&&|;)\s*)?\S*python[\d.]*\s+(?:-\S+\s+)*-\s*<<-?[ \t]*(['"]?)(\w+)\1[ \t]*$/.exec(lines[0] ?? '')
  if (!m || lines.length < 3) return false
  const end = (l: string) => l.trim() === m[2]
  return end(lines[lines.length - 1]!) && !lines.slice(1, -1).some(end)
}

/** Why the checker may not make this call, or null when it may: it reads files with Read, Grep and Glob, and runs code
 *  only as one Python script, whose output is its evidence. */
export function checkerDenial(e: { tool: unknown; command?: unknown }): string | null {
  const tool = String(e.tool)
  if (!READS.has(tool)) return 'The check of the citations only reads: it can use Read, Grep, Glob, and Bash to run one Python script.'
  if (tool === 'Bash' && !oneScript(String(e.command ?? ''))) return "The check runs code only as one Python script: python3 - <<'PY', the code, PY, and nothing else in the call. Read, Grep and Glob read files."
  return null
}

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

/** The checker's prompt: checker.md with the marks (`n. [words] in: <sentence>`), the shell's folder and the folder
 *  the session started in filled in. */
export function checkerPrompt(template: string, items: MarkItem[], cwd: string, root: string): string {
  return fill(template, { MARKS: items.map(m => `${m.n}. [${m.words}] in: ${m.sentence}`).join('\n'), CWD: cwd, ROOT: root })
}

/** The reply with its items changed, and the time it settled once no mark is checked. */
function settle(r: Reply, now: number, items: MarkItem[]): Reply {
  return { ...r, items, settledAt: items.some(m => m.status === 'checking') ? null : now }
}

/** What main reads with the person's next prompt: each mark the check corrected or flagged, as the person reads it in
 *  the reply (so main uses it from now on and need not say it again), and each note, which the person does not see. A
 *  mark whose evidence did not hold is not shown to be wrong, and main hears it that way. The check's own words (its
 *  reason, its note) are quoted, since they may quote the records. */
const q = (w: string) => (/^["“]/.test(w) ? w : `"${w}"`)
const why = (m: MarkItem) => (m.reason ? ` (the check: ${q(m.reason)})` : '')

export function tellText(items: MarkItem[]): string {
  const said = items.filter(m => m.status === 'corrected' || m.status === 'failed').map(m => {
    if (m.status === 'corrected') return `- ${q(m.was ?? m.words)} is corrected to ${q(m.shown)}${why(m)}`
    if (m.failedBy === 'evidence') return `- ${q(m.words)} is flagged as not confirmed${why(m)}`
    return `- ${q(m.words)} is flagged as wrong${why(m)}`
  })
  const notes = notesOf(items).map(n => `- ${q(n)}`)
  if (!said.length && !notes.length) return ''
  const parts = ['thimble checked the citations of your last reply against the data. Its words in the blocks below may quote the records.']
  if (said.length) parts.push(`The analyst sees these changes in the reply:\n${fenced(said.join('\n'))}`)
  if (notes.length) parts.push(`The check also found these uncited statements false. The analyst does not see these:\n${fenced(notes.join('\n'))}`)
  parts.push('Use the corrected facts from now on. The analyst has read the changes in the reply, so a correction of them in your next reply would tell them twice. A claim the check could not confirm may still be true: when you need it again, check it first.')
  return parts.join('\n')
}

/** What main reads with the person's next prompt when a repair (x) ended: how its mark ended, as the person reads it. */
export function repairTellText(items: MarkItem[]): string {
  const lines = items.map(m => {
    if (m.status === 'corrected') return `- ${q(m.was ?? m.words)} is corrected to ${q(m.shown)}${why(m)}`
    if (m.status === 'verified') return `- ${q(m.words)} is verified as written${why(m)}`
    if (m.status === 'failed') return `- ${q(m.words)} is still flagged as ${m.failedBy === 'evidence' ? 'not confirmed' : 'wrong'}${why(m)}`
    return `- ${q(m.words)} could not be checked again${why(m)}`
  })
  const notes = notesOf(items).map(n => `- ${q(n)}`)
  if (!lines.length) return ''
  const parts = [`The analyst pressed x (repair) on a citation of yours, and thimble checked it again against the data. Its words in the block below may quote the records.\n${fenced(lines.join('\n'))}`]
  if (notes.length) parts.push(`The check also found these uncited statements false. The analyst does not see these:\n${fenced(notes.join('\n'))}`)
  parts.push('The analyst sees the result in the reply. Use it from now on.')
  return parts.join('\n')
}

/** A change of the reply's marks; when it settled the last mark this check tells of, main is told what changed: a
 *  reply's check tells of every mark no repair checks, a repair of its own mark. Two forks that end at once edit in
 *  turn (store.ts editReply), so exactly one of them settles the reply. */
async function edit($: Engine, c: Check, change: (r: Reply) => Reply): Promise<Reply | null> {
  const mine = new Set(c.marks)
  const counted = (m: MarkItem) => m.status === 'checking' && (c.repair ? mine.has(m.n) : !m.repair)
  let open = false
  const reply = await editReply($, c.key, r => {
    open = r.items.some(counted)
    return change(r)
  })
  if (reply && open && !reply.items.some(counted)) {
    const text = c.repair ? repairTellText(reply.items.filter(m => mine.has(m.n))) : tellText(reply.items)
    if (text) await tellAtNextPrompt($, c.repair ? `marks:${c.key}:repair:${c.marks.join(',')}` : `marks:${c.key}`, text)
  }
  return reply
}

/** Every mark of a check that is still checked becomes unchecked: no check could give an answer. */
async function giveUp($: Engine, c: Check, why: string, now: number): Promise<void> {
  const mine = new Set(c.marks)
  if (!((await replyOf($, c.key))?.items ?? []).some(m => mine.has(m.n) && m.status === 'checking')) return
  await edit($, c, r => settle(r, now, r.items.map(m => (mine.has(m.n) && m.status === 'checking' ? { ...m, status: 'unchecked' as MarkStatus, reason: why } : m))))
}

/** The marks split into the forks' shares, in order: one share up to PER_FORK marks, else as many as PER_FORK gives
 *  (at most MAX_FORKS), of about equal size. The marks of one sentence stay in one share up to a share's size, since a
 *  fork writes the notes on its sentences; each run of a sentence's marks goes to the share its middle falls in. */
export function splitMarks<M extends { sentence: string }>(items: M[]): M[][] {
  const k = Math.min(MAX_FORKS, Math.max(1, Math.ceil(items.length / PER_FORK)))
  const size = Math.ceil(items.length / k)
  const runs: M[][] = []
  for (const m of items) {
    const run = runs[runs.length - 1]
    if (run && run[0]!.sentence === m.sentence && run.length < size) run.push(m)
    else runs.push([m])
  }
  const out: M[][] = Array.from({ length: k }, () => [])
  let before = 0
  for (const run of runs) {
    out[Math.min(k - 1, Math.floor(((before + run.length / 2) * k) / items.length))]!.push(...run)
    before += run.length
  }
  return out.filter(s => s.length)
}

const checkingWord = (n: number) => `checking ${n} citation${n === 1 ? '' : 's'}`

/** The busy line's step while a reply's forks run, until none of them does: the marks still checked, counting down as
 *  each fork's share settles. */
async function showRunning($: Engine, key: string, total: number, agents: string[]): Promise<void> {
  await busyWhile($, checkingWord(total), async () => {
    const now = await running($)
    if (!agents.some(id => !!now[id])) return false
    const left = ((await replyOf($, key))?.items ?? []).filter(m => m.status === 'checking').length
    return left ? checkingWord(left) : true
  })
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
  const root = await startDir($)
  const whole: Check = { agentId: '', key, turnId: e.turnId, marks: items.map(m => m.n), cwd, root, replyEnd: reply[reply.length - 1]!.at, spawnedAt: now }
  if (e.reason !== 'answer') {
    await giveUp($, whole, 'the reply was interrupted before its citations were checked', now)
    return
  }
  let template = ''
  try {
    template = await promptText($, 'checker')
  } catch (err) {
    await giveUp($, whole, 'thimble could not read its checker text', now)
    failNotice($, `thimble could not read its checker text (${String((err as Error)?.message || err).slice(0, 80)}), so the citations are not checked. Reinstall thimble.`)
    return
  }
  const started: string[] = []
  for (const share of splitMarks(items)) {
    const c: Check = { ...whole, marks: share.map(m => m.n) }
    const fork = await spawnFork($, { kind: 'checker', prompt: checkerPrompt(template, share, cwd, root), description: 'checking citations' })
    if (!fork.agentId) {
      await giveUp($, c, 'the check could not start', now)
      failNotice($, `The check of the citations could not start (${String(fork.deny || 'no reason given').slice(0, 80)}), so they are not checked.`)
      continue
    }
    const agentId = fork.agentId
    const spawnedAt = Number(await $.clock.now())
    await update($, RUNNING, cur => ({ ...(cur ?? {}), [agentId]: { ...c, agentId, spawnedAt } }))
    started.push(agentId)
  }
  if (started.length) await showRunning($, key, items.length, started)
}

// ------------------------------------------------------------------------------------------------ repair (x)

/** The words the fork shows as in /tasks, and how marks/register.ts's agent.spawn hook knows a repair's spawn. */
export const REPAIR_DESCRIPTION = 'checking a citation again (x)'

/** A repair's spawn held for a key's word window: it waits until `until`, and is refused once `cancelled`. */
export type RepairHold = { until: number; cancelled: boolean }
/** What a check of one mark again needs: its reply, its mark, and the checker's text with the request. */
export type Repair = { key: string; turnId: string; n: number; prompt: string; cwd: string; root: string }

let held: RepairHold | null = null
const starting = new Set<string>()

/** The repair whose spawn runs now (marks/register.ts holds it for its word window). */
export function heldRepair(): RepairHold | null {
  return held
}

/** The request under the checker's text for a repair: which mark, what the first check found, and the task. The check's
 *  reason is quoted, since it may quote the records. */
export function repairRequest(m: MarkItem): string {
  const found = m.failedBy === 'evidence' ? 'could not confirm it' : 'found it wrong'
  return [
    `The analyst pressed x to repair citation ${m.n}. It may stand in an earlier reply than your last. The first check ${found}${m.reason ? `: ${q(m.reason)}` : '.'}`,
    'Check it again from the start, and look in the records for the right value. When you find it, answer `corrected` with the true words and the evidence that shows them.',
  ].join('\n')
}

/** x on citation `n` of `row`: what a check of it again needs; null when there is nothing to repair (it is not wrong
 *  or not confirmed, or a repair of it runs), or why none can start. */
export async function repairOf($: Engine, row: string, n: number): Promise<Repair | string | null> {
  const key = await replyKeyOf($, row)
  const r = key ? await replyOf($, key) : null
  const m = r?.items.find(x => x.n === n)
  if (!key || !r || !m || m.status !== 'failed' || starting.has(`${key}:${n}`)) return null
  if (Object.values(await running($)).some(c => c.key === key && c.marks.includes(n))) return null
  let template = ''
  try {
    template = await promptText($, 'checker')
  } catch (err) {
    return `thimble could not read its checker text (${String((err as Error)?.message || err).slice(0, 80)}). Reinstall thimble.`
  }
  const cwd = String(await $.session.cwd())
  const root = await startDir($)
  return { key, turnId: r.turnId, n, cwd, root, prompt: `${checkerPrompt(template, [m], cwd, root)}\n\n${repairRequest(m)}` }
}

/** The repair's fork. Its spawn is the first call, so it is made inside the hook that calls this (the key's or the
 *  press's): the plugin's other hooks then serve the fork as they serve a reply's check. Answers why it did not start,
 *  or '' (it started, or the person typed a word and the spawn was refused). */
export async function launchRepair($: Engine, r: Repair, hold: RepairHold): Promise<string> {
  const id = `${r.key}:${r.n}`
  starting.add(id)
  held = hold
  try {
    const fork = await spawnFork($, { kind: 'checker', prompt: r.prompt, description: REPAIR_DESCRIPTION })
    if (held === hold) held = null
    if (hold.cancelled) return ''
    if (!fork.agentId) return `The repair did not start (${String(fork.deny || 'no reason given').slice(0, 80)}). Press x on the citation to try again.`
    const agentId = fork.agentId
    const now = Number(await $.clock.now())
    // the mark is checked again: its earlier result goes, its place and words stay
    await editReply($, r.key, rep => ({
      ...rep, settledAt: null,
      items: rep.items.map(m => {
        if (m.n !== r.n) return m
        const { status: _s, was: _w, reason: _r, failedBy: _f, evidence: _e, note: _n, ...base } = m
        return { ...base, shown: m.words, status: 'checking' as MarkStatus, repair: true as const }
      }),
    }))
    const c: Check = { agentId, key: r.key, turnId: r.turnId, marks: [r.n], cwd: r.cwd, root: r.root, replyEnd: now, spawnedAt: now, repair: true }
    await update($, RUNNING, cur => ({ ...(cur ?? {}), [agentId]: c }))
    await showRunning($, r.key, 1, [agentId])
    return ''
  } finally {
    if (held === hold) held = null
    starting.delete(id)
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

/** The person's line when a check gave no answer, by why its turn ended. */
function giveUpLine(reason: string): string {
  if (reason === 'refusal') return "The model's safeguards refused the check of the citations, so they are not checked. Another model may check them: /model."
  if (reason === 'aborted') return 'The check of the citations was stopped, so they are not checked.'
  return 'The check of the citations stopped on an error, so they are not checked. The next reply is checked again.'
}

/** The validator's result for a fork's answer, or why there is none. */
async function validate($: Engine, c: Check, e: { agentId: string; answer: string }, items: MarkItem[]): Promise<{ results?: Any[]; problem?: string }> {
  // main's calls too: the check may cite what main printed (the validator keeps the calls whose output the answer cites)
  const calls = [...bashCalls(await $.session.messages({ agentId: e.agentId }), 'checker'), ...bashCalls(await $.session.messages(), 'main')]
  const ran = await $.process.run([`${$.plugin.root.replace(/\/+$/, '')}/bin/thimble`, 'dev', 'validate'], {
    cwd: c.cwd, timeoutMs: 120000,
    stdin: JSON.stringify({ cwd: c.cwd, root: c.root, tmp: await tempDir($), marks: items.map(m => ({ n: m.n, words: m.words, sentence: m.sentence })), answer: e.answer, calls }),
  })
  let out: { parsed: boolean; results: Any[] } | null = null
  try { out = JSON.parse(String(ran.stdout || '')) } catch { out = null }
  if (!out || ran.exitCode !== 0) return { problem: `thimble could not validate the check of the citations (${String(ran.stderr || 'no output').trim().split('\n').pop()?.slice(0, 80)}), so they are not checked.` }
  if (!out.parsed) return { problem: 'The check of the citations gave no answer thimble could read, so they are not checked.' }
  return { results: out.results }
}

/** At the end of the checker's turn: its answer validated, each mark's status written, and the timings recorded. */
export async function endCheck($: Engine, e: { agentId: string; reason: string; answer: string; usage?: unknown }): Promise<void> {
  const c = (await running($))[e.agentId]
  if (!c) return
  const forkEnd = Number(await $.clock.now())
  try {
    if (e.reason !== 'answer') {
      await giveUp($, c, e.reason === 'refusal' ? 'safeguards refused the check' : `the check ended: ${e.reason}`, forkEnd)
      // a refusal is no failure of thimble's, so its line offers no fix of thimble
      if (e.reason === 'refusal') noticeLine($, giveUpLine(e.reason))
      else failNotice($, giveUpLine(e.reason))
      return
    }
    const mine = new Set(c.marks)
    const items = ((await replyOf($, c.key))?.items ?? []).filter(m => mine.has(m.n))
    let v: { results?: Any[]; problem?: string }
    try {
      v = await validate($, c, e, items)
    } catch (err) {
      v = { problem: `thimble could not validate the check of the citations (${String((err as Error)?.message || err).slice(0, 80)}), so they are not checked.` }
    }
    if (!v.results) {
      await giveUp($, c, 'thimble could not validate the check', forkEnd)
      failNotice($, v.problem!)
      return
    }
    const byN = new Map(v.results.map(r => [Number(r.n), r]))
    const settled = Number(await $.clock.now())
    const reply = await edit($, c, r => settle(r, settled, r.items.map(m => {
      if (!mine.has(m.n)) return m
      const res = byN.get(m.n)
      if (!res) return { ...m, status: 'unchecked' as MarkStatus, reason: 'the check gave no answer for this citation' }
      const { n: _n, ...rest } = res
      return { ...m, ...rest, shown: String(res.shown ?? m.words) }
    })))
    if (!reply) return
    const count = (s: string, by?: string) => reply.items.filter(m => mine.has(m.n) && m.status === s && (!by || m.failedBy === by)).length
    await record($, {
      kind: 'marks', feature: 'checker', marks: c.marks.length, reply_marks: reply.items.length, verified: count('verified'), corrected: count('corrected'),
      wrong: count('failed', 'check'), unconfirmed: count('failed', 'evidence'), unchecked: count('unchecked'),
      reply_end: c.replyEnd, spawned_ms: c.spawnedAt - c.replyEnd, fork_ms: forkEnd - c.spawnedAt, validate_ms: settled - forkEnd, settled_ms: settled - c.replyEnd,
      reply_settled: !counts(reply).checking, usage: e.usage ?? null, repair: !!c.repair,
    })
  } finally {
    // whatever ended the check, none of its marks stays checked
    await giveUp($, c, 'the check ended before it judged this citation', Number(await $.clock.now())).catch(() => undefined)
    await update($, RUNNING, cur => Object.fromEntries(Object.entries(cur ?? {}).filter(([id]) => id !== e.agentId)))
  }
}

/** At session start (a reload of the plugin, a resumed session): each check still running is on the busy line again,
 *  and a check whose fork Claude Code no longer runs gives up, with a notice. */
export async function resumeChecks($: Engine): Promise<void> {
  const now = await running($)
  if (!Object.keys(now).length) return
  const agents = new Map((await $.agent.list()).map(a => [a.id, a.status]))
  const alive = (id: string) => agents.has(id) && !['completed', 'failed', 'killed'].includes(String(agents.get(id)))
  const gone = Object.values(now).filter(c => !alive(c.agentId))
  for (const c of gone) await giveUp($, c, 'the check stopped: thimble lost the copy that checked it', Number(await $.clock.now()))
  if (gone.length) {
    await update($, RUNNING, cur => Object.fromEntries(Object.entries(cur ?? {}).filter(([id]) => !gone.some(c => c.agentId === id))))
    failNotice($, 'A check of the citations stopped: thimble lost the copy that checked them, so they are not checked. The next reply is checked again.')
  }
  const byReply = new Map<string, string[]>()
  for (const c of Object.values(now).filter(c => alive(c.agentId))) byReply.set(c.key, [...(byReply.get(c.key) ?? []), c.agentId])
  for (const [key, ids] of byReply) await showRunning($, key, (await replyOf($, key))?.items.length ?? ids.length, ids)
}
