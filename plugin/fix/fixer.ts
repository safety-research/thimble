// fixer.ts: thimble's fixer, the subagent that makes a change the person asked for, in the background, in a scratch
// copy of thimble (~/.thimble/fixes/work/<id>). It is a fork of the person's session, so it sees the conversation
// ("this" means something in it); prompts/fixer.md opens its first message.
//
//   startFixer($, fix, words)   forks the session into the copy, with the words and a text copy of what thimble shows
//                               now (screen.ts); the bar shows `fixing <name>` with its time (`changing <name>` for a
//                               round of a fix the person has); the subagent is named after the fix (fix-<slug>)
//   fixerCall($, e, id)         each of its tool calls: Bash runs in the sandbox runtime (the kernel's `fix sandbox`
//                               gives the command's start: no network, reads only the system, its tools and the copy,
//                               writes only the copy and its temp folder), in the foreground, for at most 5 minutes;
//                               Write and Edit only in the copy; its other calls as they are
//   fixerCheck($, e)            a Bash call thimble put in the sandbox needs no dialog, as Claude Code's own sandboxed
//                               commands need none, unless the person's rules deny the command; its other calls go
//                               through Claude Code's own permission handling in the person's mode
//   liveFixer($, N)             the fix whose fixer still works, and its agent: more words for it go to that fixer
//   fixerEnded($, e)            its end: thimble commits the change in the copy and runs the tests (`thimble fix done`),
//                               then the line above the bar asks whether to use it (y; the person's key applies it), and
//                               Claude Code sends a notification. When Claude started the fix, Claude is told, so that it
//                               can tell the person. When the check does not use the change (a safety file, a binary
//                               file, failing tests), a new fixer gets another round in the same copy at once
//                               (`thimble fix again`), told why; the person sees a failure only when a fixer ends with
//                               `Cannot: <why>`.
//
//   state: fixers (agentId → the fix's id), fixBy (the fixes Claude started, by their id), fixerBox (the sandbox
//          command's start, by the fix's id)
import type { EngineInterface } from 'claude-code'

import { busyWhile } from '../bar/busy'
import { failNotice } from '../bar/notice'
import { spawnFork } from '../core/forks'
import { thimbleHome } from '../core/home'
import { tellAtNextPrompt } from '../core/tell'
import { cut } from '../core/text.js'
import { promptText } from '../prompts/prompts'
import { type Fix, type Refusal, fixesDir, fixingWord, fixName, fixOf, fixSlug, jsonOf, kernelFix, refreshFixes, sessionIdNow, setFixLine } from './fixes'
import { screenCopy } from './screen'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const FIXERS = { plugin: 'thimble', key: 'fixers' } as const
const BY = { plugin: 'thimble', key: 'fixBy' } as const
const BOX = { plugin: 'thimble', key: 'fixerBox' } as const

/** Who asked for a fix: the person (/thimble-fix), or Claude (the fix-thimble skill). */
export type Asker = 'person' | 'claude'

export async function askerOf($: Engine, id: number): Promise<Asker> {
  return (((await $.state.get(BY)).value ?? {}) as Record<string, string>)[String(id)] === 'claude' ? 'claude' : 'person'
}

export async function setAsker($: Engine, id: number, by: Asker): Promise<void> {
  const all = { ...(((await $.state.get(BY)).value ?? {}) as Record<string, 'claude'>) }
  if (by === 'claude') all[String(id)] = 'claude'
  else delete all[String(id)]
  await $.state.set(BY, all as never)
}

async function fixers($: Engine): Promise<Record<string, number>> {
  return ((await $.state.get(FIXERS)).value ?? {}) as Record<string, number>
}

/** The fixes whose fixer works in this session: the records name the session (several sessions share the fixes'
 *  folder, and each knows only its own agents), or, for a record without one, this session started its fixer. Another
 *  session's fix is listed, but this one never ends it, adds words to it, or tells of it. */
export async function ownFixes($: Engine, fixes: Fix[]): Promise<Fix[]> {
  const sid = await sessionIdNow($)
  const started = new Set(Object.values(await fixers($)))
  return fixes.filter(f => (f.session ? f.session === sid : started.has(f.id)))
}

/** The fix a fixer agent works on, or null when the agent is no fixer. */
export async function fixOfAgent($: Engine, agentId: string | undefined): Promise<number | null> {
  if (!agentId) return null
  const id = (await fixers($))[agentId]
  return typeof id === 'number' ? id : null
}

/** For a round of a fix the person has (on, off or ready before this round): which fix it changes, so the fixer knows
 *  what is already in its copy. */
export function changingText(f: Fix): string {
  const had = f.prev?.state === 'on' ? 'has on' : f.prev?.state === 'off' ? 'has, off' : 'has'
  return `These words change the fix the person already ${had}, "${f.prev?.title || f.title}"${f.prev?.summary || f.summary ? ` (${f.prev?.summary || f.summary})` : ''}; its change is in your copy, and your change becomes part of it.`
}

/** For the next fixer after the check did not use a change (another round in the same copy, or r in a new one): what
 *  was refused and why, so that it puts the change elsewhere or fixes the tests, or says why it cannot. The prompt does
 *  not list the safety files; this names only the ones the change touched. `earlier`: r, whose copy is new. */
export function refusedText(r: Refusal, earlier: boolean): string {
  const where = earlier ? 'The earlier change is not in your copy' : 'Your last change is in your copy'
  const fix = r.files?.length
    ? `Leave ${r.files.join(', ')} as ${r.files.length > 1 ? 'they are' : 'it is'} and make the change in other files${earlier ? ', without the earlier change\'s parts in them' : ''}.`
    : `The end of their output:\n\n${r.tests ?? ''}\n\nFix what fails.`
  return `thimble did not use the last change for this fix: ${r.why}. ${where}. ${fix} When the request truly cannot be met without that, end with one line \`Cannot: <why, in plain words for the person>\` in place of the Title line; thimble shows that line to the person.`
}

/** The fixer's first message: the task (prompts/fixer.md), the words of each round, where it works, the fix these
 *  words change, what the check refused last time, and a text copy of what thimble shows now. */
function firstMessage(fix: Fix, earlier: string | null, task: string, by: Asker, screen: string): string {
  const words = fix.words || []
  const asked = words.length > 1
    ? words.map((w, i) => `Round ${i + 1}: ${w}`).join('\n')
    : words[0] || fix.title
  return [
    task.trim(),
    '',
    by === 'claude'
      ? `Claude, in the conversation above, saw thimble misbehave and asked for this change to the person's thimble:`
      : `The person asked for this change to their thimble:`,
    '',
    asked,
    '',
    ...(fix.prev ? [changingText(fix), ''] : []),
    ...(fix.patches ?? []).map(x => `The words name fix ${x.id} ("${x.title}"): its change is in ${x.path}, as a patch.`),
    ...(fix.patches?.length ? [''] : []),
    `Your working folder is the copy: ${fix.work}.`,
    ...(earlier ? [`An earlier change for this request, which thimble did not use, is in ${earlier}; start from it when it helps.`] : []),
    ...(fix.refused?.why ? [refusedText(fix.refused, !!earlier)] : []),
    '',
    'What thimble shows on the person\'s screen now, as text (the conversation above does not hold it):',
    '',
    screen,
  ].join('\n')
}

/** The text copy of the screen for a fixer about to start, made before its copy of thimble (so it shows the screen as
 *  the person saw it when they asked). */
export async function screenNow($: Engine): Promise<string> {
  return screenCopy($).catch(err => `(thimble could not copy the screen: ${cut(String((err as Error)?.message || err), 160)})`)
}

/** The fixes whose fixer is starting: a look for fixers that ended (recoverFixers) leaves them be. */
const starting = new Set<number>()

/** Start the fixer on a fix whose copy the kernel just made (a request, a round, a redo). `screen`: the text copy of
 *  the screen, when the caller made it before the copy. */
export async function startFixer($: Engine, fix: Fix, earlier = false, screen?: string): Promise<string | null> {
  starting.add(fix.id)
  try {
    return await start($, fix, earlier, screen ?? (await screenNow($)))
  } finally {
    starting.delete(fix.id)
  }
}

async function start($: Engine, fix: Fix, earlier: boolean, screen: string): Promise<string | null> {
  let task: string
  try {
    task = await promptText($, 'fixer')
  } catch (err) {
    return `The fixer did not start (${cut(String((err as Error)?.message || err), 200)}).`
  }
  // the command's start for its shell, kept for each of its Bash calls
  const box = await sandboxOf($, fix.id)
  if (typeof box === 'string') return `The fixer did not start: ${box}`
  // no type: a fork of the session, which sees the conversation; named after the fix, never its number
  const r = await spawnFork($, { kind: 'fixer', prompt: firstMessage(fix, earlier ? `${fixesDir(await thimbleHome($))}/tmp/${fix.id}/earlier.patch` : null, task, await askerOf($, fix.id), screen), description: fixingWord(fix), cwd: fix.work || undefined, name: fixSlug(fix) })
  if (r.deny !== undefined || !r.agentId) return `The fixer did not start (${cut(String(r.deny || 'no agent started'), 200)}).`
  await $.state.set(FIXERS, { ...(await fixers($)), [r.agentId]: fix.id } as never)
  busyFixer($, fix, async () => fixOf($, fix.id))
  watch($, fix.id)
  return null
}

/** The bar's step while a fix's fixer works (`fixing <name>`, or `changing <name>` for a round of a fix the person
 *  has), until it ends. `now`: the fix's record now. */
export function busyFixer($: Engine, fix: Fix, now: () => Promise<Fix | null | undefined>): void {
  void busyWhile($, fixingWord(fix), async () => {
    if (ending.has(fix.id)) return false
    const f = await now()
    return f?.state === 'working' ? fixingWord(f) : false
  })
}

/** While a fix works, a look every few seconds: a fixer that ended without its end reaching this plugin (a reload
 *  between) is taken as it stands. */
function watch($: Engine, id: number): void {
  let t: { cancel?: () => void } | null = null
  const look = async () => {
    const f = await fixOf($, id)
    if (f?.state !== 'working') { t?.cancel?.(); return }
    await recoverFixers($, [f])
  }
  try {
    t = $.clock.every(5000, () => { void look().catch(err => failNotice($, `thimble could not look at fix ${id}: ${cut(String((err as Error)?.message || err), 200)}`)) }) as unknown as { cancel?: () => void }
  } catch {
    t = null
  }
}

/** The sandbox command's start for a fix's shell (`thimble fix sandbox <id>`), kept by the fix's id; a string says why
 *  there is none. */
async function sandboxOf($: Engine, id: number): Promise<string[] | string> {
  const all = ((await $.state.get(BOX)).value ?? {}) as Record<string, string[]>
  if (all[String(id)]) return all[String(id)]!
  const r = await kernelFix($, ['sandbox', String(id)], { timeoutMs: 30000 })
  const argv = r.ok ? jsonOf<string[]>(r.out) : null
  if (!Array.isArray(argv) || !argv.length) return cut(r.err || 'the sandbox could not be set up', 220)
  await $.state.set(BOX, { ...(((await $.state.get(BOX)).value ?? {}) as Record<string, string[]>), [String(id)]: argv } as never)
  return argv
}

/** A fixer's shell command runs at most this long (the Bash tool's own limit, in milliseconds). */
export const FIXER_BASH_MS = 300000

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`

/** The places the sandbox lets the fixer write: its copy and its temp folder. */
function writable(argv: string[]): string[] {
  const rules = jsonOf<Any>(argv[argv.indexOf('--srt') + 2] ?? '')
  return ((rules?.filesystem?.allowWrite ?? []) as { path: string }[]).map(x => String(x.path).replace(/\/+$/, ''))
}

/** The Bash commands thimble put in the sandbox, by tool_use_id: the command as run → the command as the fixer wrote
 *  it, for their check. */
const wrapped = new Map<string, { run: string; asked: string }>()

/** One tool call of a fixer: its shell command put in the sandbox, a write outside its copy refused, else as it is. */
export async function fixerCall($: Engine, e: Any, id: number): Promise<{ call?: Any; deny?: string } | null> {
  const isWrite = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(e.tool)
  if (e.tool !== 'Bash' && !isWrite) return null
  const argv = await sandboxOf($, id)
  if (typeof argv === 'string') return { deny: `thimble could not set up this fix's sandbox (${argv}); end now.` }
  if (isWrite) {
    const p = String(e.file_path ?? e.notebook_path ?? '')
    const ok = p.startsWith('/') && !p.split('/').includes('..') && writable(argv).some(w => p === w || p.startsWith(`${w}/`))
    return ok ? null : { deny: `The fixer changes only its copy of thimble (${writable(argv)[0] ?? 'the copy'}); ${p || 'that file'} is outside it.` }
  }
  const asked = String(e.command ?? '')
  const run = [...argv, asked].map(quote).join(' ')
  if (e.tool_use_id) wrapped.set(String(e.tool_use_id), { run, asked })
  const timeout = Math.min(Number(e.timeout) > 0 ? Number(e.timeout) : FIXER_BASH_MS, FIXER_BASH_MS)
  return { call: { ...e, command: run, timeout, run_in_background: false } }
}

/** The call ran: its command is no longer kept. */
export function fixerCallDone(e: Any): void {
  if (e.tool_use_id) wrapped.delete(String(e.tool_use_id))
}

/** A fixer's Bash call that thimble put in the sandbox: allowed, unless the person's rules deny the command as the
 *  fixer wrote it. Null for any other call (Claude Code decides). */
export async function fixerCheck($: Engine, e: Any): Promise<{ decision: 'allow' | 'deny'; reason: string } | null> {
  if (e.tool !== 'Bash' || !e.tool_use_id) return null
  const w = wrapped.get(String(e.tool_use_id))
  if (!w || w.run !== String((e.input as Any)?.command ?? '')) return null
  const own = await $.tool.check({ tool: 'Bash', input: { command: w.asked } } as never).catch(() => null)
  if ((own as Any)?.decision === 'deny') return { decision: 'deny', reason: String((own as Any).reason || 'the person\'s settings deny this command') }
  return { decision: 'allow', reason: "thimble's fixer: in the sandbox runtime, which reads and writes only its copy of thimble" }
}

/** A fix whose fixer still works, and its agent, or null: more words for that fix go to it. A fixer that ended (its
 *  change is being tested) takes no more words. `target`: the fix the words name; then only that fix's fixer, so that
 *  one fixer changes a fix at a time. */
export async function liveFixer($: Engine, target: number | null = null): Promise<{ fix: Fix; agentId: string } | null> {
  const list = await refreshFixes($)
  const working = await ownFixes($, (list?.fixes ?? []).filter(f => f.state === 'working' && !ending.has(f.id) && (target == null || f.id === target)))
  if (!working.length) return null
  let alive: Set<string>
  try {
    alive = new Set((await $.agent.list()).filter(a => ['pending', 'running', 'waiting'].includes(String(a.status))).map(a => a.id))
  } catch {
    return null
  }
  const map = await fixers($)
  for (const f of working) {
    const agentId = Object.entries(map).find(([a, id]) => id === f.id && alive.has(a))?.[0]
    if (agentId) return { fix: f, agentId }
  }
  return null
}

/** What the fixer's last message says: its title, what it does, that it is a request with no code, or why it cannot
 *  be done. */
export function endOf(answer: string): { title: string; summary: string; request: boolean; cannot: string | null } {
  const text = String(answer || '')
  const title = /^\s*\**title\**\s*:\s*(.+)$/im.exec(text)?.[1]?.replace(/\*+/g, '').trim() ?? ''
  const cannot = /^\s*\**cannot\**\s*:\s*(.+)$/im.exec(text)?.[1]?.replace(/\*+/g, '').trim() || null
  const req = /^\s*\**request\**\s*:\s*([\s\S]+)$/im.exec(text)?.[1]?.trim()
  const does = /^\s*\**what it does\**\s*:\s*([\s\S]+)$/im.exec(text)?.[1]?.trim()
  return { title: cut(title, 60), summary: cut((req ?? does ?? '').replace(/\s+/g, ' '), 1200), request: req != null && does == null, cannot: cannot ? cut(cannot, 300) : null }
}

/** The fixer ended: thimble commits its change and tests it, then the line says what came of it. */
const ending = new Set<number>()

export async function fixerEnded($: Engine, e: Any, id: number): Promise<void> {
  if (ending.has(id)) return
  ending.add(id)
  let again: Fix | null = null
  try {
    again = await ended($, e, id)
  } catch (err) {
    const f = await fixOf($, id).catch(() => null)
    await setFixLine($, { id, kind: 'problem', said: `${f ? `“${fixName(f)}”` : `Fix ${id}`} could not be checked: ${cut(String((err as Error)?.message || err), 200)}. thimble fix list, in a shell, lists it.` }).catch(() => undefined)
  } finally {
    ending.delete(id)
  }
  if (!again) return
  // the check did not use the change: a new fixer in the same copy, told why (firstMessage); a fixer that cannot start
  // ends the fix with that reason, so that no look for ended fixers starts it again
  const bad = await startFixer($, again)
  if (bad) {
    await kernelFix($, ['done', String(id), '--cannot', '-'], { stdin: bad, timeoutMs: 60000 })
    await refreshFixes($)
    await setFixLine($, { id, kind: 'failed' })
  }
}

/** The fixer's end, checked; the fix again when the check did not use its change and a new round should answer it. */
async function ended($: Engine, e: Any, id: number): Promise<Fix | null> {
  // the kernel's record as it is now: another session or the shell may have changed it since this session's list
  const now = (await refreshFixes($))?.fixes.find(f => f.id === id)
  if (now?.state !== 'working' || !(await ownFixes($, [now])).length) return null
  const all = await fixers($)
  delete all[String(e.agentId)]
  await $.state.set(FIXERS, all as never)
  const end = endOf(String(e.answer ?? ''))
  const fix = await fixOf($, id)
  const name = fix ? fixName(fix) : `fix ${id}`
  // `Cannot: <why>`: the fixer found that the request cannot be met; the fix fails with its words
  const args = end.cannot
    ? ['done', String(id), '--cannot', '-']
    : ['done', String(id), '--summary', '-', ...(end.title ? ['--title', end.title] : []), ...(end.request ? ['--request'] : [])]
  const r = await kernelFix($, args, { stdin: end.cannot ?? (end.summary || ' '), timeoutMs: 600000, doing: `testing ${fix ? fixName(fix, 28) : `fix ${id}`}` })
  await refreshFixes($)
  if (!r.ok) {
    await setFixLine($, { id, kind: 'problem', said: `“${name}” could not be checked: ${cut(r.err || 'thimble fix done gave nothing', 200)}` })
    return null
  }
  const done = jsonOf<Fix>(r.out)
  // the check did not use the change (a safety file, a binary file, failing tests): another round in the same copy
  if (!end.cannot && done?.state === 'failed' && done.refused && done.work) {
    const a = await kernelFix($, ['again', String(id)], { timeoutMs: 60000 })
    const next = a.ok ? jsonOf<Fix>(a.out) : null
    await refreshFixes($)
    if (next?.state === 'working') return next
  }
  // a round of a fix the person has that changed no code: the fix stays as it was
  const kind = done?.unchanged ? 'request' : done?.state === 'ready' ? 'ready' : done?.state === 'request' ? 'request' : 'failed'
  await setFixLine($, { id, kind, ...(done?.unchanged ? { kept: true } : {}) })
  const title = done?.title || fix?.title || `fix ${id}`
  const changed = !!(done?.prev || (fix && fix.prev))
  if (kind === 'ready') {
    // the person may be in another window: Claude Code's own notification, with the line's words
    try { await $.ui.notify(`thimble ${changed ? 'changed' : 'fixed'}: ${title} · ${testsWord(done)}`, { title: 'thimble' }) } catch { /* the line says it */ }
  }
  if ((await askerOf($, id)) === 'claude') {
    const said = `The thimble ${changed ? 'change to the fix' : 'fix'} you started, "${title}", ${kind === 'ready'
      ? `is ready and ${testsWord(done)}; the person turns it on with y${changed ? ' (the version they have stays until then)' : ''}`
      : done?.unchanged ? 'changed no code; the fix stays as it was'
        : kind === 'request' ? 'changed no code; it is kept as a request in the person\'s list of fixes' : `did not pass its checks (${cut(done?.error || 'its tests failed', 200)})`}.`
    await tellAtNextPrompt($, `fix-${id}`, `${said} Tell the person in one short line.`)
  } else if (kind === 'ready') {
    await tellAtNextPrompt($, `fix-${id}`, changed
      ? `thimble's fixer changed the person's fix "${title}"; the new version waits for the person's y, and the one they have stays until then. Nothing for you to do.`
      : `thimble's fixer finished the fix "${title}"; it waits for the person's y. Nothing for you to do.`)
  }
  return null
}

/** What came of a fix's tests, in the line's words: `tests pass`. */
export function testsWord(f: Pick<Fix, 'tests'> | null | undefined): string {
  const t = f?.tests
  return t === 'passed' ? 'tests pass' : t === 'skipped' ? 'tests not run' : t ? `tests ${t}` : 'tests not run'
}

/** A fix that still says `working` whose fixer no longer runs (its end came while the plugin reloaded, or never
 *  reached it): thimble takes what its copy holds, as at its end. */
export async function recoverFixers($: Engine, working: Fix[]): Promise<void> {
  working = await ownFixes($, working)
  if (!working.length) return
  const map = await fixers($)
  let alive: Set<string>
  try {
    // a background agent that handed back its report waits idle: for a fixer, that is its end
    alive = new Set((await $.agent.list()).filter(a => ['pending', 'running', 'waiting'].includes(String(a.status))).map(a => a.id))
  } catch {
    return
  }
  for (const f of working) {
    if (starting.has(f.id)) continue
    const ids = Object.entries(map).filter(([, id]) => id === f.id).map(([a]) => a)
    if (ids.some(a => alive.has(a))) continue
    await fixerEnded($, { agentId: ids[0] ?? '', answer: '' }, f.id)
  }
}

/** The fixer could not be told apart (a reload lost it) or failed to start: the line says so. */
export function fixerProblem($: Engine, text: string): void {
  failNotice($, text)
}
