// checker.ts: the check of a reply's marks. After each of main's turns that answered with marks, a fork of the
// session (core/forks.ts, kind `checker`; for a reply with many marks, up to MAX_FORKS forks at once, each with a share
// of the marks) reads prompts/checker.md with its marks filled in and gives one answer per mark: verified, corrected,
// wrong or unconfirmed, with its evidence. `thimble dev validate` (engine/validate.py) then checks that evidence without a model and
// without running code (engine/kernel/evidence.py): a quote must be in the file's line, and computed evidence names one
// of the session's real Bash calls (the checker's or main's) by a part of its output, and that call's real output must
// show the words; card evidence names a place of one of the session's cards (cards/store.ts), whose value must show
// them. Before the forks start, the cards' places and values are written to a file the checker greps (cardsIndex).
// Its result is what the person sees.
//
//   noteRow($, row, text)     a text row of main's reply, as session.append stored it
//   startCheck($, e)          at the end of main's turn: the reply's marks (store.ts, all `checking`), the forks
//   endCheck($, e)            at the end of a checker's turn: the validator, its marks' statuses
//   resumeChecks($)           at session start: the checks a reload of the plugin left running, on the busy line again;
//                             a check whose fork is gone gives up, and says so
//   checkerDenial(e)          why the checker may not make a call: it reads files, and runs code only as one Python script
//   refusalOf(deny)           what Claude Code's refusal of a check says: auto mode's classifier gave no verdict on it
//                             and gives none on such a call this session (`unreviewed`), could not answer for now
//                             (`unavailable`), refused it (`judged`), or another cause (`other`)
//   cannotStart(deny, ok)     the line a check that Claude Code refused gives: what refused it, and for `unreviewed` the
//                             key that lets thimble start its checks (y), until the person gave that OK (`ok`)
//   checkKey($, key, until)   y while that line shows: the person's OK for this session, and the check it is about
//                             starts again (hooks/keys.ts)
//   allowsCheck($, e, o, v)   whether thimble answers allow to Claude Code's verdict `v` on a spawn (tool.check,
//                             marks/register.ts): a checker's spawn of thimble's own, once the person gave that OK,
//                             where Claude Code would ask, never where a rule, a hook or the person decides
//   awaitsCheck($, row)       whether a row of main's is in the turn that runs or the one whose check starts now
//   repairOf($, row, n)       x on a failed citation (tray): what a check of that one mark again needs; for a mark
//                             whose check did not run, the check itself
//   launchRepair($, r, hold)  that check's fork, with a request to find the right value and correct the cited words;
//                             its mark is `checking` while it runs, and its end is endCheck's as any check's. Call it
//                             inside a hook (the spawn is its first call); a key's spawn waits out the word window
//                             (`hold`, marks/register.ts holds it) and is refused when the person typed a word
//   autoRepair($, agentId)    after a reply's check ended (endCheck): each citation it found wrong or could not confirm
//                             is repaired at once, as x repairs it; a repair's own failure starts none. Call it in a
//                             hook around endCheck's (marks/register.ts): the repair's fork skips the hook that spawned
//                             it, so its end still reaches endCheck
//
// The setting Citations (settings/features.mjs citations) says when marks are made and checked: `auto cite + verify`,
// Claude's marks after each reply; `auto cite` (the default), a reply's marks wait `deferred` (drawn as the reply's own
// cited words), and opening one (tray.ts openMark) checks that one (checkOpened), as a reply's check would; `manual`,
// Claude makes none; `off`, none. In every mode but off, words the person selects and asks about (c, marks/cite.ts)
// wait `deferred` until the tray opens them, as one Claude made.
//
// Every way a fork's check ends (an answer, a refusal, an error, a validator that fails, a fork that is gone) leaves no
// mark of its share `checking`: a mark it gave no answer for is failed, as the person sees it (store.ts notRun). A check
// that cannot start at all (Claude Code refused the fork, or thimble cannot read the checker's text) judged nothing: its
// marks wait, not checked (`deferred`, a dim ? after each), opening one checks it, and one line says why (cannotStart):
// once a session for each cause while the replies' own checks run into it, and each time a check the person asked for
// (opening a citation, x) cannot start.
//
// Claude Code decides the fork's spawn as it decides a call of Claude's (Claude Code 2.1.307). In auto mode it lets a
// plugin's own call run without auto mode's classifier, unless the person's settings give the classifier rules of
// their own (autoMode soft_deny or hard_deny): then the classifier must judge it. Where auto mode classifies on
// Anthropic's server, that classifier judges only the calls in Claude's own replies, so it gives no verdict on the
// check, and Claude Code refuses it each time (`unreviewed`; Claude Code's own toast: `fork denied by auto mode ·
// Classifier unavailable`). Claude Code takes no allow rule for a subagent in auto mode, so no setting of the person's
// lets the check start there; a plugin's answer at tool.check does. So the line names what refused the check and
// offers y: the person's OK lets thimble answer Claude Code's ask on its own checks with allow this session
// (checksAllowed, allowsCheck), never its deny (a deny rule wins), and the check the line is about starts again. A
// classifier that judged the check, or could not answer for now, is said as such; the mode stays the person's.
//
// When a reply's last mark settles, main is told what changed (tellText), once; when a repair ends, main is told how
// that one mark ended (repairTellText): who started it, the person (x) or thimble (auto).
//
// state: marksRows (main's text rows of the turn that runs), marksRunning (the checks that run, by the fork's agent),
// checksAllowed (the person's OK, y), checksHeld (the check the line about an unreviewed check is about); the marks
// themselves are in store.ts
import { update, type EngineInterface } from 'claude-code'

import { busyWhile } from '../bar/busy'
import { cardsDir } from '../cards/store'
import { failCleared, failLineNow, failNotice, noticeLine, reasonOf } from '../bar/notice'
import { startDir } from '../core/env'
import { spawnFork } from '../core/forks'
import { tempDir } from '../core/home'
import { tellAtNextPrompt } from '../core/tell'
import { fenced } from '../core/text.js'
import { promptText } from '../prompts/prompts'
import { fill } from '../prompts/registry.mjs'
import { choiceOf, claudeCites } from '../settings/features.mjs'
import { record } from '../telemetry/telemetry'
import { marksIn, plainSentence, sentenceOf } from './message.js'
import { counts, editReply, type MarkItem, type MarkStatus, newReply, notesOf, notRun, type Reply, replyKeyOf, replyOf } from './store'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** One fork's check: the reply, and the numbers of the marks this fork checks. `cwd` is the shell's folder, where the
 *  fork's code runs; `root` the folder the session started in, which the pane's paths start from. A relative path of
 *  the evidence is read from either. */
type Check = { agentId: string; key: string; turnId: string; marks: number[]; cwd: string; root: string; replyEnd: number; spawnedAt: number; repair?: boolean; auto?: boolean; thread?: string }

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

/** Whether a row of main's has no reply in the store yet because its turn runs or its check starts now: its marks
 *  are not failed yet (marks/register.ts draws them pending). */
export async function awaitsCheck($: Engine, row: string): Promise<boolean> {
  return (((await $.state.get(ROWS)).value ?? []) as { row: string }[]).some(r => r.row === row)
}

async function running($: Engine): Promise<Record<string, Check>> {
  return ((await $.state.get(RUNNING)).value ?? {}) as Record<string, Check>
}

/** Every mark of the reply's rows, numbered from 1 across them, each with its row and sentence. */
function itemsOf(reply: { row: string; text: string }[], later = false): MarkItem[] {
  let n = 0
  return reply.flatMap(r => marksIn(r.text).map((m: Any) => ({
    n: ++n, row: r.row, words: m.words, start: m.start, end: m.end, sentence: sentenceOf(r.text, m), status: (later ? 'deferred' : 'checking') as MarkStatus, shown: m.words,
  })))
}

/** What the checker checks: main's last reply, or a side thread's answer, which main's conversation does not hold. */
export const LAST_REPLY = 'your last reply'
export const threadAnswer = (about: string) =>
  `an answer that a side thread of this session gave the analyst about ${about}. That thread's work is not in your conversation, so find the evidence in the files`

/** The checker's prompt: checker.md with the marks (`n. [words] in: <sentence>`), what holds them (`reply`), the
 *  shell's folder, the folder the session started in and the file of the cards' values (cardsIndex) filled in. */
export function checkerPrompt(template: string, items: MarkItem[], cwd: string, root: string, cards = '', reply = LAST_REPLY): string {
  return fill(template, { MARKS: items.map(m => `${m.n}. [${m.words}] in: ${m.sentence}`).join('\n'), CWD: cwd, ROOT: root, CARDS: cards, REPLY: reply })
}

/** The command that validates a check's answer (engine/validate.py), which also writes the cards' index. */
function validateArgv($: Engine): string[] {
  return [`${$.plugin.root.replace(/\/+$/, '')}/bin/thimble`, 'dev', 'validate']
}

/** The cards' index the last check wrote: a repair (x) reads it, so the key's hook makes no more calls before its
 *  spawn ('' after a reload of the plugin: the repair's check then finds no card). */
let lastIndex = ''

/** The file the checker greps for a value a card shows: each place of the session's cards and its value
 *  (engine/kernel/evidence.py card_index), written in the temp folder before the check starts. An empty file when it
 *  cannot be written: the check then finds no card and uses its other evidence. */
export async function cardsIndex($: Engine): Promise<string> {
  const path = `${await tempDir($)}/cards-index.tsv`
  lastIndex = path
  try {
    const dir = await cardsDir($)
    const cards = await $.fs.list(dir).catch(() => [])
    if (!cards.length) await $.fs.write(path, '')
    else await $.process.run(validateArgv($), { cwd: await startDir($), timeoutMs: 30000, stdin: JSON.stringify({ index: path, cards_dir: dir }) })
  } catch {
    // the check runs without the cards
  }
  return path
}

/** The reply with its items changed, and the time it settled once no mark is checked. */
function settle(r: Reply, now: number, items: MarkItem[]): Reply {
  return { ...r, items, settledAt: items.some(m => m.status === 'checking') ? null : now }
}

/** What main reads with the person's next prompt: each mark the check corrected or flagged, as the person reads it in
 *  the reply (so main uses it from now on and need not say it again), and each note, which the person does not see.
 *  The person sees every failed mark alike (not confirmed); main hears whether the check found it false or only could
 *  not confirm it. The check's own words (its
 *  reason, its note) are quoted, since they may quote the records. */
const q = (w: string) => (/^["“]/.test(w) ? w : `"${w}"`)
const why = (m: MarkItem) => (m.reason ? ` (the check: ${q(m.reason)})` : '')
/** A correction as main reads it: a narrowing keeps the rest of the words in the reply, uncited; a rewrite puts a new
 *  sentence in place of the one main wrote. */
const fixedLine = (m: MarkItem) => (m.rewrite
  ? `- the sentence ${q(plainSentence(m.sentence))} is rewritten as ${q(plainSentence(m.rewrite))}, which cites ${q(m.shown)}${why(m)}`
  : m.narrowed
    ? `- ${q(m.was ?? m.words)} is narrowed: only ${q(m.shown)} is cited, and the rest reads as your own words${why(m)}`
    : `- ${q(m.was ?? m.words)} is corrected to ${q(m.shown)}${why(m)}`)

export function tellText(items: MarkItem[]): string {
  // words the analyst asked about (c, marks/cite.ts): main did not cite them, the analyst asked where they come from
  // a mark whose check did not run is no finding of the check's
  const said = items.filter(m => m.status === 'corrected' || (m.status === 'failed' && m.failedBy !== 'none')).map(m => {
    if (m.status === 'corrected') return fixedLine(m)
    if (m.failedBy === 'evidence') return `- ${q(m.words)} is flagged as not confirmed${why(m)}`
    return `- ${q(m.words)} is flagged as wrong${why(m)}`
  })
  const notes = notesOf(items).map(n => `- ${q(n)}`)
  if (!said.length && !notes.length) return ''
  const told = items.filter(m => m.status === 'corrected' || m.status === 'failed' || m.note)
  const asked = told.length > 0 && told.every(m => m.asked)
  const parts = [asked
    ? 'The analyst asked where words of your reply come from, and thimble checked them against the data. Its words in the blocks below may quote the records.'
    : 'thimble checked the citations of your last reply against the data. Its words in the blocks below may quote the records.']
  if (said.length) parts.push(`The analyst sees these changes in the reply:\n${fenced(said.join('\n'))}`)
  if (notes.length) parts.push(`The check also found these uncited statements false. The analyst does not see these:\n${fenced(notes.join('\n'))}`)
  parts.push('Use the corrected facts from now on. The analyst has read the changes in the reply, so a correction of them in your next reply would tell them twice. A claim the check could not confirm may still be true: when you need it again, check it first.')
  return parts.join('\n')
}

/** What main reads with the person's next prompt when a repair ended: how its mark ended, as the person reads it, and
 *  who started it: the person with x, or thimble (`auto`, right after the check failed it). */
export function repairTellText(items: MarkItem[], auto = false): string {
  const lines = items.map(m => {
    if (m.status === 'corrected') return fixedLine(m)
    if (m.status === 'verified') return `- ${q(m.words)} is verified as written${why(m)}`
    if (m.status === 'failed' && m.failedBy === 'none') return `- ${q(m.words)} could not be checked${why(m)}`
    if (m.status === 'failed') return `- ${q(m.words)} is still flagged as ${m.failedBy === 'evidence' ? 'not confirmed' : 'wrong'}${why(m)}`
    return `- ${q(m.words)} could not be checked again${why(m)}`
  })
  const notes = notesOf(items).map(n => `- ${q(n)}`)
  if (!lines.length) return ''
  const head = auto ? 'A citation of yours failed its check, so thimble checked it again against the data.' : 'The analyst pressed x (repair) on a citation of yours, and thimble checked it against the data.'
  const parts = [`${head} Its words in the block below may quote the records.\n${fenced(lines.join('\n'))}`]
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
  // a side thread's answer: main never read it, so it hears nothing of its check
  if (reply && open && !c.thread && !reply.items.some(counted)) {
    const text = c.repair ? repairTellText(reply.items.filter(m => mine.has(m.n)), !!c.auto) : tellText(reply.items)
    if (text) await tellAtNextPrompt($, c.repair ? `marks:${c.key}:repair:${c.marks.join(',')}` : `marks:${c.key}`, text)
  }
  return reply
}

/** Every mark of a check that is still checked did not run (`why`, a sentence): no check could give an answer, so the
 *  person sees it failed, and x starts its check. */
async function giveUp($: Engine, c: Check, why: string, now: number): Promise<void> {
  const mine = new Set(c.marks)
  if (!((await replyOf($, c.key))?.items ?? []).some(m => mine.has(m.n) && m.status === 'checking')) return
  await edit($, c, r => settle(r, now, r.items.map(m => (mine.has(m.n) && m.status === 'checking' ? notRun(m, why) : m))))
}

/** Every mark of a check that is still checked waits to be checked (`deferred`, drawn with a dim ? after it): the check
 *  could not start, so it judged none of them, and opening one checks it (checkOpened). */
async function notChecked($: Engine, c: Check, now: number): Promise<void> {
  const mine = new Set(c.marks)
  if (!((await replyOf($, c.key))?.items ?? []).some(m => mine.has(m.n) && m.status === 'checking')) return
  await edit($, c, r => settle(r, now, r.items.map(m => (mine.has(m.n) && m.status === 'checking' ? { ...m, status: 'deferred' as MarkStatus } : m))))
}

/** What Claude Code's refusal of a check says, as thimble acts on it (Claude Code 2.1.307's words for auto mode's
 *  classifier). `unreviewed`: the classifier gave no verdict on the check and gives none on such a call this session,
 *  as the classifier on Anthropic's server gives none on a call no reply of Claude's made (`the request that produced
 *  this action did not ask for one`, or a failure it calls hard). `unavailable`: it could not answer for now (busy,
 *  rate-limited, told to wait): a later check may run. `judged`: it judged the check and refused it, `reason` why.
 *  `other`: another cause (a deny rule, another plugin's hook, a mode), `reason` the refusal's first sentence. */
export type Refusal = { kind: 'unreviewed' | 'unavailable' | 'judged' | 'other'; reason: string }

export function refusalOf(deny: string | undefined): Refusal {
  const said = String(deny || '')
  const judged = /denied by the Claude Code auto mode classifier\. Reason: (.+?)\.(?:\s|$)/.exec(said)
  if (judged) return { kind: 'judged', reason: judged[1]!.trim() }
  if (/\bauto mode\b/i.test(said)) {
    const why = /\((rate-limited|overloaded|server error|timed out|connection failed)\)/.exec(said)?.[1] ?? ''
    if (/\btransient failure of the check\b|\btemporarily unavailable\b|\bclassifier \([^)]*\) to wait\b/.test(said)) return { kind: 'unavailable', reason: why }
    if (/\bgave no verdict\b|\bhard failure\b/.test(said)) return { kind: 'unreviewed', reason: reasonOf(said) }
  }
  return { kind: 'other', reason: reasonOf(said || 'no reason given') }
}

/** The key that gives thimble the person's OK to start its checks where auto mode's classifier gives no verdict on
 *  them, and the line that offers it. */
export const ALLOW_KEY = 'y'
export const UNREVIEWED_LINE = `Auto mode's classifier gave no verdict on thimble's check of citations, so Claude Code refused it. Press ${ALLOW_KEY} to allow thimble's checks this session.`

/** The line a check of citations that could not start gives (Claude Code's refusal, `deny`): what refused it. Where
 *  auto mode's classifier gave no verdict, the key that lets thimble start its checks, until the person gave that OK
 *  (`allowed`): a refusal after it is said as any other. A refusal by auto mode is the person's mode at work, not
 *  thimble's failure, so its line is a notice. */
export function cannotStart(deny: string | undefined, allowed = false): { text: string; notice: boolean; kind: Refusal['kind'] } {
  const r = refusalOf(deny)
  if (r.kind === 'unreviewed' && !allowed) return { kind: r.kind, notice: true, text: UNREVIEWED_LINE }
  if (r.kind === 'unavailable') return { kind: r.kind, notice: true, text: `Auto mode's classifier was unavailable for thimble's check of citations${r.reason ? ` (${r.reason})` : ''}, so Claude Code refused it. Open a citation to check it.` }
  if (r.kind === 'judged') return { kind: r.kind, notice: true, text: `Auto mode's classifier refused thimble's check of citations (${reasonOf(r.reason)}), so they are not checked.` }
  return { kind: 'other', notice: false, text: `The check of the citations could not start (${r.reason}), so they are not checked. ${OPEN_ONE}` }
}

/** What the failure line of a check that could not start is about: a check that starts takes it away. */
const START = 'marks:start'
const REFUSED = { plugin: 'thimble', key: 'checksRefused' } as const
const ALLOWED = { plugin: 'thimble', key: 'checksAllowed' } as const
const HELD = { plugin: 'thimble', key: 'checksHeld' } as const

/** A check the line about an unreviewed check is about, which y starts again: a reply's (its marks that still wait) or
 *  a repair's (x). */
type Held = { kind: 'check'; whole: Check; reply: string; note?: string } | { kind: 'repair'; repair: Repair }

/** The line of a check that could not start (cannotStart's, or thimble's own failure): a reply's check says it once a
 *  session, as the same cause stops each check after it; a check the person asked for (`asked`: opening a citation, x)
 *  says it each time, since it answers the press. The line that offers y keeps the check it is about (`held`). */
async function sayCannotStart($: Engine, line: { text: string; notice: boolean }, asked = false, held?: Held): Promise<void> {
  const said = ((await $.state.get(REFUSED)).value ?? []) as string[]
  if (!said.includes(line.text)) await $.state.set(REFUSED, [...said, line.text])
  else if (!asked) return
  if (line.text === UNREVIEWED_LINE && held) await $.state.set(HELD, held as never)
  if (line.notice) noticeLine($, line.text, START)
  else failNotice($, line.text, START)
}

/** Whether the person let thimble start its checks this session (y). */
async function checksAllowed($: Engine): Promise<boolean> {
  return (await $.state.get(ALLOWED)).value === true
}

/** The words the forks of thimble's checks show as in /tasks, by which allowsCheck knows a checker's spawn: a reply's
 *  check, a citation's that was opened, and a check y started again (a repair's: REPAIR_DESCRIPTION). */
const CHECK_DESCRIPTION = 'checking citations'
const OPENED_DESCRIPTION = 'checking a citation'
export const AGAIN_DESCRIPTION = 'checking citations again (y)'

/** Whether thimble answers allow at tool.check (marks/register.ts) to Claude Code's verdict `v` on the spawn `e`: a
 *  checker's spawn of thimble's own (`origin`, who raised the call), once the person let thimble start its checks (y),
 *  where Claude Code would ask (and auto mode's classifier would settle it). A deny (a deny rule), an ask a rule, a
 *  hook or the person's own ask holds, and the organization's ceiling stand. */
export async function allowsCheck($: Engine, e: { input?: unknown }, origin: { plugin?: string } | undefined, v: { decision?: string; rule?: string; hook?: string; decider?: string; ceiling?: string }): Promise<boolean> {
  if (v.decision !== 'ask' || v.rule || v.hook || v.decider || (v.ceiling && v.ceiling !== 'allow')) return false
  if (origin?.plugin !== 'thimble') return false
  const input = (e.input ?? {}) as { description?: unknown; subagent_type?: unknown }
  if (![CHECK_DESCRIPTION, OPENED_DESCRIPTION, AGAIN_DESCRIPTION, REPAIR_DESCRIPTION].includes(String(input.description))) return false
  if (input.subagent_type !== undefined && input.subagent_type !== 'fork') return false
  return checksAllowed($)
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
 *  forks start, each with its share of the marks. An interrupted turn's marks did not run (failed; x starts their
 *  check). Call it inside the turn.complete hook, so the plugin's other hooks serve the fork (core/forks.ts). */
export async function startCheck($: Engine, e: { turnId: string; reason: string }): Promise<void> {
  const noted = ((await $.state.get(ROWS)).value ?? []) as { row: string; text: string; at: number }[]
  // the rows stay noted until their reply is in the store, so they draw pending until then (awaitsCheck)
  const done = async () => { await $.state.set(ROWS, []) }
  const reply = noted.filter(r => r.text.trim())
  if (!reply.length || !claudeCites()) return await done()
  const later = choiceOf('citations') !== 'auto cite + verify'
  const items = itemsOf(reply, later)
  if (!items.length) return await done()
  const now = Number(await $.clock.now())
  const key = reply[reply.length - 1]!.row
  const rows = [...new Set([...items.map(m => m.row), key])]
  try {
    await newReply($, { key, turnId: e.turnId, rows, startedAt: now, settledAt: later ? now : null, items })
  } finally {
    await done()
  }
  // checked when the person opens one (checkOpened)
  if (later) return
  const cwd = String(await $.session.cwd())
  const root = await startDir($)
  const whole: Check = { agentId: '', key, turnId: e.turnId, marks: items.map(m => m.n), cwd, root, replyEnd: reply[reply.length - 1]!.at, spawnedAt: now }
  if (e.reason !== 'answer') {
    await giveUp($, whole, 'The reply was interrupted.', now)
    return
  }
  await spawnChecks($, whole, items)
}

/** The checker forks of a reply's marks, each with its share; `reply` says what holds them (checkerPrompt). */
async function spawnChecks($: Engine, whole: Check, items: MarkItem[], reply = LAST_REPLY): Promise<void> {
  const now = whole.spawnedAt
  let template = ''
  try {
    template = await promptText($, 'checker')
  } catch (err) {
    await notChecked($, whole, now)
    await sayCannotStart($, { notice: false, text: `thimble could not read its checker text (${reasonOf(err)}), so the citations are not checked. Reinstall thimble.` })
    return
  }
  const started: string[] = []
  const cards = await cardsIndex($)
  const shares = splitMarks(items)
  for (const [k, share] of shares.entries()) {
    const c: Check = { ...whole, marks: share.map(m => m.n) }
    const fork = await spawnFork($, { kind: 'checker', prompt: checkerPrompt(template, share, whole.cwd, whole.root, cards, reply), description: CHECK_DESCRIPTION })
    if (!fork.agentId) {
      // what refused this share refuses the next ones too: they wait with it, and no more forks are asked for
      const rest: Check = { ...whole, marks: shares.slice(k).flat().map(m => m.n) }
      await notChecked($, rest, now)
      await sayCannotStart($, cannotStart(fork.deny, await checksAllowed($)), false, { kind: 'check', whole: rest, reply })
      break
    }
    await failCleared($, START)
    const agentId = fork.agentId
    const spawnedAt = Number(await $.clock.now())
    await update($, RUNNING, cur => ({ ...(cur ?? {}), [agentId]: { ...c, agentId, spawnedAt } }))
    started.push(agentId)
  }
  if (started.length) await showRunning($, whole.key, items.length, started)
}

/** What y starts again: the forks of a reply's check, one per share with its prompt (the marks that still wait), or a
 *  repair. Made before the key's hook gives its answer, so the spawns are the first calls it makes (startAgain). */
type Again = { kind: 'check'; whole: Check; reply: string; note?: string; shares: { marks: number[]; prompt: string }[] } | { kind: 'repair'; repair: Repair }

/** The check a line about an unreviewed check is about, as y starts it again: null when none of its marks waits any
 *  more (each was opened and checked since; a repair's citation no longer failed, or checked again now), or thimble
 *  cannot read its checker text. The cards' index is the last check's, as a repair's is. */
async function againOf($: Engine, h: Held | null): Promise<Again | null> {
  if (!h) return null
  if (h.kind === 'repair') {
    const m = (await replyOf($, h.repair.key))?.items.find(x => x.n === h.repair.n)
    const runs = Object.values(await running($)).some(c => c.key === h.repair.key && c.marks.includes(h.repair.n))
    return m?.status === 'failed' && !runs ? h : null
  }
  const items = ((await replyOf($, h.whole.key))?.items ?? []).filter(m => h.whole.marks.includes(m.n) && m.status === 'deferred')
  if (!items.length) return null
  let template = ''
  try { template = await promptText($, 'checker') } catch { return null }
  const shares = splitMarks(items).map(share => ({ marks: share.map(m => m.n), prompt: `${checkerPrompt(template, share, h.whole.cwd, h.whole.root, lastIndex, h.reply)}${h.note ? `\n\n${h.note}` : ''}` }))
  return { kind: 'check', whole: { ...h.whole, marks: items.map(m => m.n) }, reply: h.reply, ...(h.note ? { note: h.note } : {}), shares }
}

/** y at an empty prompt while the line that offers it shows (cannotStart, `unreviewed`): the person's OK for thimble
 *  to start its checks this session (allowsCheck), and the check that line is about starts again (startAgain), its
 *  spawns held for the key's word window. A letter in that window undoes both (hooks/keys.ts): the person typed a
 *  word. Null for any other key, or while no such line shows. */
export async function checkKey($: Engine, key: string, until: number): Promise<{ now: () => Promise<unknown>; undo: () => Promise<unknown>; later: () => Promise<unknown> } | null> {
  if (key !== ALLOW_KEY) return null
  const line = await failLineNow($)
  if (line?.about !== START || line.text !== UNREVIEWED_LINE) return null
  const kept = ((await $.state.get(HELD)).value ?? null) as Held | null
  const again = await againOf($, kept)
  const hold: RepairHold = { until, cancelled: false }
  return {
    now: async () => {
      await $.state.set(ALLOWED, true)
      await $.state.set(HELD, null)
      // the spawns while the key's hook still runs (they are startAgain's first calls), so the plugin's other hooks
      // serve them (core/forks.ts): its tool.check answers them
      if (again) void startAgain($, again, hold).catch(() => undefined)
    },
    undo: async () => {
      hold.cancelled = true
      await $.state.set(ALLOWED, null)
      await $.state.set(HELD, kept as never)
    },
    // the key stands: its line goes (a check that starts takes it away first; a line a new refusal gave stays)
    later: async () => { if ((await failLineNow($))?.text === UNREVIEWED_LINE) await failCleared($, START) },
  }
}

/** The check y starts again: a repair as x starts one, or a reply's forks, all asked for at once (the first calls this
 *  makes, so they are made while the key's hook runs), each waiting out the key's word window (marks/register.ts). A
 *  share's marks are checked once its fork starts; what Claude Code refused waits as it did, and its line says why. */
async function startAgain($: Engine, a: Again, hold: RepairHold): Promise<void> {
  if (a.kind === 'repair') {
    const why = await launchRepair($, a.repair, hold)
    if (why) failNotice($, why, 'marks:repair')
    return
  }
  held = hold
  let forks: { agentId?: string; deny?: string }[]
  try {
    forks = await Promise.all(a.shares.map(s => spawnFork($, { kind: 'checker', prompt: s.prompt, description: AGAIN_DESCRIPTION })))
  } finally {
    if (held === hold) held = null
  }
  if (hold.cancelled) return
  const now = Number(await $.clock.now())
  const started: string[] = []
  for (const [k, fork] of forks.entries()) {
    const marks = a.shares[k]!.marks
    const agentId = fork.agentId
    if (!agentId) continue
    await editReply($, a.whole.key, rep => ({ ...rep, settledAt: null, items: rep.items.map(m => (marks.includes(m.n) && m.status === 'deferred' ? { ...m, status: 'checking' as MarkStatus } : m)) }))
    await update($, RUNNING, cur => ({ ...(cur ?? {}), [agentId]: { ...a.whole, marks, agentId, spawnedAt: now } }))
    started.push(agentId)
  }
  if (started.length) await failCleared($, START)
  // what Claude Code refused waits as it did, and the line says why
  const refused = forks.flatMap((f, k) => (f.agentId ? [] : a.shares[k]!.marks))
  const deny = forks.find(f => !f.agentId)?.deny
  if (refused.length) await sayCannotStart($, cannotStart(deny, await checksAllowed($)), true, { kind: 'check', whole: { ...a.whole, marks: refused }, reply: a.reply, ...(a.note ? { note: a.note } : {}) })
  if (started.length) await showRunning($, a.whole.key, a.whole.marks.length - refused.length, started)
}

/** At the end of a side thread's turn (threads/thread.ts): its answer's marks are checked as a reply's are, in the
 *  store under `row`, a name of the answer's own, which the thread's pane draws them by. Its Bash calls are evidence
 *  as main's are (`agentId`, the thread's agent). Main is told nothing: it never read the answer. Call it inside the
 *  thread's turn.complete hook, as startCheck. */
export async function checkAnswer($: Engine, a: { row: string; text: string; turnId: string; agentId: string; about: string; reason: string }): Promise<void> {
  if (!claudeCites() || (await replyOf($, a.row))) return
  const later = choiceOf('citations') !== 'auto cite + verify'
  const items = itemsOf([{ row: a.row, text: a.text }], later)
  if (!items.length) return
  const now = Number(await $.clock.now())
  await newReply($, { key: a.row, turnId: a.turnId, rows: [a.row], startedAt: now, settledAt: later ? now : null, items, thread: { agentId: a.agentId, about: a.about } })
  if (later) return
  const whole: Check = { agentId: '', key: a.row, turnId: a.turnId, marks: items.map(m => m.n), cwd: String(await $.session.cwd()), root: await startDir($), replyEnd: now, spawnedAt: now, thread: a.agentId }
  if (a.reason !== 'answer') {
    await giveUp($, whole, 'The answer was interrupted.', now)
    return
  }
  await spawnChecks($, whole, items, threadAnswer(a.about))
}

// ------------------------------------------------------------------------------------------------ repair (x)

/** The words the fork shows as in /tasks, and how marks/register.ts's agent.spawn hook knows a repair's spawn. */
export const REPAIR_DESCRIPTION = 'checking a citation again (x)'

/** A repair's spawn held for a key's word window: it waits until `until`, and is refused once `cancelled`. */
export type RepairHold = { until: number; cancelled: boolean }
/** What a check of one mark again needs: its reply, its mark, and the checker's text with the request. */
export type Repair = { key: string; turnId: string; n: number; prompt: string; cwd: string; root: string; thread?: string; auto?: boolean }

let held: RepairHold | null = null
const starting = new Set<string>()

/** The repair whose spawn runs now (marks/register.ts holds it for its word window). */
export function heldRepair(): RepairHold | null {
  return held
}

/** The request under the checker's text for a repair: which mark, what the first check found, and the task. The check's
 *  reason is quoted, since it may quote the records. A mark whose check did not run is checked as any reply's is. */
export function repairRequest(m: MarkItem): string {
  if (m.failedBy === 'none') return `The analyst pressed x to check citation ${m.n}, whose first check did not run. It may stand in an earlier reply than your last.`
  const found = m.failedBy === 'evidence' ? 'could not confirm it' : 'found it wrong'
  return [
    `The analyst pressed x to repair citation ${m.n}. It may stand in an earlier reply than your last. The first check ${found}${m.reason ? `: ${q(m.reason)}` : '.'}`,
    'Check it again from the start. When the cited words hold, answer `verified` with the evidence that shows them. Else make the citation correct: change the cited words or the sentence, whatever makes it true to the records, and answer `corrected` with the evidence that shows the new cited words.',
    'When the value is right but the cited words also hold your own words that no record shows, such as a translation or an explanation, answer `narrowed` with only the part of the cited words that the evidence shows.',
  ].join('\n')
}

/** x on citation `n` of `row`: what a check of it again needs (for one whose check did not run, the check); null when
 *  there is nothing to repair (it did not fail, or a check of it runs), or why none can start. */
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
    return `thimble could not read its checker text (${reasonOf(err)}). Reinstall thimble.`
  }
  const cwd = String(await $.session.cwd())
  const root = await startDir($)
  const reply = r.thread ? threadAnswer(r.thread.about) : LAST_REPLY
  return { key, turnId: r.turnId, n, cwd, root, ...(r.thread ? { thread: r.thread.agentId } : {}), prompt: `${checkerPrompt(template, [m], cwd, root, lastIndex, reply)}\n\n${repairRequest(m)}` }
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
    if (!fork.agentId) {
      // auto mode refused it: its line, as any check the person asked for says it, which y answers for this repair
      const line = cannotStart(fork.deny, await checksAllowed($))
      if (line.kind !== 'other') { await sayCannotStart($, line, true, { kind: 'repair', repair: r }); return '' }
      return `The repair did not start (${reasonOf(fork.deny || 'no reason given')}). Press x on the citation to try again.`
    }
    await failCleared($, START)
    const agentId = fork.agentId
    const now = Number(await $.clock.now())
    // the mark is checked again: its earlier result goes, its place and words stay
    await editReply($, r.key, rep => ({
      ...rep, settledAt: null,
      items: rep.items.map(m => {
        if (m.n !== r.n) return m
        const { status: _s, was: _w, reason: _r, failedBy: _f, evidence: _e, note: _n, narrowed: _x, ...base } = m
        return { ...base, shown: m.words, status: 'checking' as MarkStatus, repair: true as const }
      }),
    }))
    const c: Check = { agentId, key: r.key, turnId: r.turnId, marks: [r.n], cwd: r.cwd, root: r.root, replyEnd: now, spawnedAt: now, repair: true, ...(r.auto ? { auto: true } : {}), ...(r.thread ? { thread: r.thread } : {}) }
    await update($, RUNNING, cur => ({ ...(cur ?? {}), [agentId]: c }))
    await showRunning($, r.key, 1, [agentId])
    return ''
  } finally {
    if (held === hold) held = null
    starting.delete(id)
  }
}

/** A citation opened (tray.ts openMark) whose reply waits to be checked until one is opened (Citations `auto cite`, or words the person asked about with c): its check,
 *  one fork for it alone, as a reply's check is made. Call it inside the hook of the press or key that opened it (the
 *  spawn is its first call). Nothing for a citation that is checked, or whose check runs. */
export async function checkOpened($: Engine, row: string, n: number): Promise<void> {
  const key = await replyKeyOf($, row)
  const r = key ? await replyOf($, key) : null
  const m = r?.items.find(x => x.n === n)
  if (!key || !r || !m || m.status !== 'deferred' || choiceOf('citations') === 'off' || starting.has(`${key}:${n}`)) return
  const id = `${key}:${n}`
  starting.add(id)
  try {
    let template = ''
    try { template = await promptText($, 'checker') } catch { return }
    const cwd = String(await $.session.cwd())
    const root = await startDir($)
    const reply = r.thread ? threadAnswer(r.thread.about) : LAST_REPLY
    const note = `The analyst opened citation ${n} to read its evidence. It may stand in an earlier reply than your last.`
    const prompt = `${checkerPrompt(template, [m], cwd, root, lastIndex, reply)}\n\n${note}`
    const fork = await spawnFork($, { kind: 'checker', prompt, description: OPENED_DESCRIPTION })
    if (!fork.agentId) {
      const line = cannotStart(fork.deny, await checksAllowed($))
      const at = Number(await $.clock.now())
      const whole: Check = { agentId: '', key, turnId: r.turnId, marks: [n], cwd, root, replyEnd: at, spawnedAt: at, ...(r.thread ? { thread: r.thread.agentId } : {}) }
      await sayCannotStart($, line.kind !== 'other' ? line : { notice: false, text: `The check of citation ${n} could not start (${reasonOf(fork.deny || 'no reason given')}). Open it again to try again.` }, true, { kind: 'check', whole, reply, note })
      return
    }
    await failCleared($, START)
    const agentId = fork.agentId
    const now = Number(await $.clock.now())
    await editReply($, key, rep => ({ ...rep, settledAt: null, items: rep.items.map(x => (x.n === n ? { ...x, status: 'checking' as MarkStatus } : x)) }))
    const c: Check = { agentId, key, turnId: r.turnId, marks: [n], cwd, root, replyEnd: now, spawnedAt: now, ...(r.thread ? { thread: r.thread.agentId } : {}) }
    await update($, RUNNING, cur => ({ ...(cur ?? {}), [agentId]: c }))
    await showRunning($, key, 1, [agentId])
  } finally {
    starting.delete(id)
  }
}

/** The citations each ended check found wrong or could not confirm, by the check's fork, until autoRepair starts their
 *  repairs. endCheck notes them; the hook around it (marks/register.ts) reads them as the same event ends. */
const toRepair = new Map<string, { key: string; marks: number[] }>()

/** After the check of fork `agentId` ended: a repair of each citation it found wrong or could not confirm, at once,
 *  with x's request, each in a fork of its own; the citation spins as for x, and its end replaces it as x's does. A
 *  repair's own end starts none (endCheck notes only a reply's check), so a citation that fails again stays failed and
 *  waits for x. A citation whose check did not run is left to x too: what stopped its check would stop this one. Call
 *  it inside a hook, as launchRepair. */
export async function autoRepair($: Engine, agentId: string): Promise<void> {
  const due = toRepair.get(agentId)
  toRepair.delete(agentId)
  if (!due) return
  const items = (await replyOf($, due.key))?.items ?? []
  for (const n of due.marks) {
    const m = items.find(x => x.n === n)
    if (!m) continue
    const r = await repairOf($, m.row, n)
    if (r === null) continue
    const why = typeof r === 'string' ? r : await launchRepair($, { ...r, auto: true }, { until: 0, cancelled: false })
    if (why) failNotice($, why, 'marks:repair')
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

/** What the person can do about citations whose check did not run: each shows as failed, and x starts its check. */
const CHECK_ONE = 'Press x on one in the tray to check it.'
/** What the person can do about citations whose check could not start: each waits, not checked, and opening one checks
 *  it. */
const OPEN_ONE = 'Open one to check it.'

/** The person's line when a check gave no answer, by why its turn ended. */
function giveUpLine(reason: string): string {
  if (reason === 'refusal') return "The model's safeguards refused the check of the citations, so they are not checked. Another model may check them: /model."
  if (reason === 'aborted') return `The check of the citations was stopped, so they are not checked. ${CHECK_ONE}`
  return `The check of the citations stopped on an error, so they are not checked. ${CHECK_ONE}`
}

/** The validator's result for a fork's answer, or why there is none. */
async function validate($: Engine, c: Check, e: { agentId: string; answer: string }, items: MarkItem[]): Promise<{ results?: Any[]; problem?: string }> {
  // main's calls too: the check may cite what main printed (the validator keeps the calls whose output the answer cites)
  // a side thread's answer: the thread's calls are its own code, as main's are a reply's
  const calls = [...bashCalls(await $.session.messages({ agentId: e.agentId }), 'checker'), ...bashCalls(await $.session.messages(c.thread ? { agentId: c.thread } : undefined), 'main')]
  const ran = await $.process.run(validateArgv($), {
    cwd: c.cwd, timeoutMs: 120000,
    stdin: JSON.stringify({ cwd: c.cwd, root: c.root, tmp: await tempDir($), cards_dir: await cardsDir($), marks: items.map(m => ({ n: m.n, words: m.words, sentence: m.sentence })), answer: e.answer, calls }),
  })
  let out: { parsed: boolean; results: Any[] } | null = null
  try { out = JSON.parse(String(ran.stdout || '')) } catch { out = null }
  if (!out || ran.exitCode !== 0) return { problem: `thimble could not validate the check of the citations (${reasonOf(String(ran.stderr || 'no output').trim().split('\n').pop())}), so they are not checked. ${CHECK_ONE}` }
  if (!out.parsed) return { problem: `The check of the citations gave no answer thimble could read, so they are not checked. ${CHECK_ONE}` }
  return { results: out.results }
}

/** At the end of the checker's turn: its answer validated, each mark's status written, and the timings recorded. */
export async function endCheck($: Engine, e: { agentId: string; reason: string; answer: string; usage?: unknown }): Promise<void> {
  toRepair.delete(e.agentId)
  const c = (await running($))[e.agentId]
  if (!c) return
  const forkEnd = Number(await $.clock.now())
  try {
    if (e.reason !== 'answer') {
      await giveUp($, c, e.reason === 'refusal' ? "The model's safeguards refused it." : e.reason === 'aborted' ? 'It was stopped.' : 'It stopped on an error.', forkEnd)
      // a refusal is no failure of thimble's, so a notice, not a failure line
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
      v = { problem: `thimble could not validate the check of the citations (${reasonOf(err)}), so they are not checked. ${CHECK_ONE}` }
    }
    if (!v.results) {
      await giveUp($, c, 'thimble could not validate its answer.', forkEnd)
      failNotice($, v.problem!)
      return
    }
    const byN = new Map(v.results.map(r => [Number(r.n), r]))
    const settled = Number(await $.clock.now())
    const reply = await edit($, c, r => settle(r, settled, r.items.map(m => {
      if (!mine.has(m.n)) return m
      const res = byN.get(m.n)
      if (!res) return notRun(m, 'Its answer left this citation out.')
      const { n: _n, ...rest } = res
      return { ...m, ...rest, shown: String(res.shown ?? m.words) }
    })))
    if (!reply) return
    // a reply's check: the citations it found wrong or could not confirm are repaired as soon as it ends (autoRepair)
    const found = c.repair ? [] : reply.items.filter(m => mine.has(m.n) && m.status === 'failed' && m.failedBy !== 'none').map(m => m.n)
    if (found.length) toRepair.set(e.agentId, { key: c.key, marks: found })
    const count = (s: string, by?: string) => reply.items.filter(m => mine.has(m.n) && m.status === s && (!by || m.failedBy === by)).length
    await record($, {
      kind: 'marks', feature: 'checker', marks: c.marks.length, reply_marks: reply.items.length, verified: count('verified'), corrected: count('corrected'),
      wrong: count('failed', 'check'), unconfirmed: count('failed', 'evidence'), unchecked: count('failed', 'none'),
      reply_end: c.replyEnd, spawned_ms: c.spawnedAt - c.replyEnd, fork_ms: forkEnd - c.spawnedAt, validate_ms: settled - forkEnd, settled_ms: settled - c.replyEnd,
      reply_settled: !counts(reply).checking, usage: e.usage ?? null, repair: !!c.repair,
    })
  } finally {
    // whatever ended the check, none of its marks stays checked
    await giveUp($, c, 'It ended before it judged this citation.', Number(await $.clock.now())).catch(() => undefined)
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
  for (const c of gone) await giveUp($, c, 'thimble lost the copy that checked it.', Number(await $.clock.now()))
  if (gone.length) {
    await update($, RUNNING, cur => Object.fromEntries(Object.entries(cur ?? {}).filter(([id]) => !gone.some(c => c.agentId === id))))
    failNotice($, `A check of the citations stopped: thimble lost the copy that checked them, so they are not checked. ${CHECK_ONE}`)
  }
  const byReply = new Map<string, string[]>()
  for (const c of Object.values(now).filter(c => alive(c.agentId))) byReply.set(c.key, [...(byReply.get(c.key) ?? []), c.agentId])
  for (const [key, ids] of byReply) await showRunning($, key, (await replyOf($, key))?.items.length ?? ids.length, ids)
}
