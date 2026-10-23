// fixer.ts: thimble's fixer, the subagent that makes a change the person asked for, in the background, in a scratch
// copy of thimble (~/.thimble/fixes/work/<id>). It is a fork of the person's session, so it sees the conversation
// ("this" means something in it); prompts/fixer.md opens its first message.
//
//   startFixer($, fix, words)   forks the session into the copy, with the words and a text copy of what thimble shows
//                               now (screen.ts); the bar shows `fixing: <title>` with its time
//   fixerCall($, e, id)         each of its tool calls: Bash runs in the sandbox runtime (the kernel's `fix sandbox`
//                               gives the command's start: no network, reads only the system, its tools and the copy,
//                               writes only the copy and its temp folder), in the foreground, for at most 5 minutes;
//                               Write and Edit only in the copy; its other calls as they are
//   fixerCheck($, e)            a Bash call thimble put in the sandbox needs no dialog, as Claude Code's own sandboxed
//                               commands need none, unless the person's rules deny the command; its other calls go
//                               through Claude Code's own permission handling in the person's mode
//   liveFixer($)                the fix whose fixer still works, and its agent: more words for it go to that fixer
//   fixerEnded($, e)            its end: thimble commits the change in the copy and runs the tests (`thimble fix done`),
//                               then the line above the bar asks whether to use it (y; the person's key applies it), and
//                               Claude Code sends a notification. When Claude started the fix, Claude is told, so that it
//                               can tell the person.
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
import { type Fix, fixesDir, fixOf, jsonOf, kernelFix, refreshFixes, setFixLine } from './fixes'
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

/** The fix a fixer agent works on, or null when the agent is no fixer. */
export async function fixOfAgent($: Engine, agentId: string | undefined): Promise<number | null> {
  if (!agentId) return null
  const id = (await fixers($))[agentId]
  return typeof id === 'number' ? id : null
}

/** For a request that may change a fix the person has (fix.refines): that fix, its title, what it does and its words,
 *  and how the end says the change refines it. `always`: the person named the fix (/thimble-fix N <words>). */
export function refinesText(f: Fix, always: boolean): string {
  const words = (f.words || []).map(w => `"${w}"`).join(', then ')
  const what = `fix ${f.id} ("${f.title}"${f.summary ? `: ${f.summary}` : ''}; asked in the words ${words})`
  return always
    ? `The person asked to change their ${what}. Its change is in your copy. End with the line \`Changes fix ${f.id}\` in place of the Title line: thimble makes your change part of fix ${f.id}.`
    : `The person ${f.state === 'on' ? 'applied' : 'has'} ${what}, and its change is in your copy. These words may ask to change that fix. When your change refines fix ${f.id}, end with the line \`Changes fix ${f.id}\` in place of the Title line; when it is a change of its own, end with a title as usual.`
}

/** The fixer's first message: the task (prompts/fixer.md), the words of each round, where it works, the fix these
 *  words may change, and a text copy of what thimble shows now. */
function firstMessage(fix: Fix, earlier: string | null, task: string, by: Asker, screen: string, refines: Fix | null = null): string {
  const words = fix.words || []
  const asked = words.length > 1
    ? words.map((w, i) => `Round ${i + 1}: ${w}`).join('\n')
    : words[0] || fix.title
  return [
    task.trim(),
    '',
    by === 'claude'
      ? `Claude, in the conversation above, saw thimble misbehave and asked for this change to the person's thimble (fix ${fix.id}):`
      : `The person asked for this change to their thimble (fix ${fix.id}):`,
    '',
    asked,
    '',
    ...(refines ? [refinesText(refines, !!fix.refines_always), ''] : []),
    `Your working folder is the copy: ${fix.work}.`,
    ...(earlier ? [`An earlier change for this request, which did not fit or failed its tests, is in ${earlier}; start from it when it helps.`] : []),
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
  // no type: a fork of the session, which sees the conversation
  const refines = fix.refines != null ? await fixOf($, fix.refines) : null
  const r = await spawnFork($, { kind: 'fixer', prompt: firstMessage(fix, earlier ? `${fixesDir(await thimbleHome($))}/tmp/${fix.id}/earlier.patch` : null, task, await askerOf($, fix.id), screen, refines), description: `fix ${fix.id}: ${cut(fix.title, 40)}`, cwd: fix.work || undefined })
  if (r.deny !== undefined || !r.agentId) return `The fixer did not start (${cut(String(r.deny || 'no agent started'), 200)}).`
  await $.state.set(FIXERS, { ...(await fixers($)), [r.agentId]: fix.id } as never)
  const word = `fixing: ${cut(fix.title, 36)} · in a copy`
  void busyWhile($, word, async () => !ending.has(fix.id) && (await fixOf($, fix.id))?.state === 'working')
  watch($, fix.id)
  return null
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

/** The newest fix whose fixer still works, and its agent, or null: more words for that fix go to it. A fixer that
 *  ended (its change is being tested) takes no more words. */
export async function liveFixer($: Engine): Promise<{ fix: Fix; agentId: string } | null> {
  const list = await refreshFixes($)
  const working = (list?.fixes ?? []).filter(f => f.state === 'working' && !ending.has(f.id))
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

/** What the fixer's last message says: its title, what it does, or that it is a request with no code; `changes`: the
 *  fix its change refines (a line `Changes fix N`). */
export function endOf(answer: string): { title: string; summary: string; request: boolean; changes: number | null } {
  const text = String(answer || '')
  const title = /^\s*\**title\**\s*:\s*(.+)$/im.exec(text)?.[1]?.replace(/\*+/g, '').trim() ?? ''
  const changes = /^\s*\**changes fix\s+#?(\d+)\b/im.exec(text)?.[1]
  const req = /^\s*\**request\**\s*:\s*([\s\S]+)$/im.exec(text)?.[1]?.trim()
  const does = /^\s*\**what it does\**\s*:\s*([\s\S]+)$/im.exec(text)?.[1]?.trim()
  return { title: cut(title, 60), summary: cut((req ?? does ?? '').replace(/\s+/g, ' '), 1200), request: req != null && does == null, changes: changes ? Number(changes) : null }
}

/** The fixer ended: thimble commits its change and tests it, then the line says what came of it. */
const ending = new Set<number>()

export async function fixerEnded($: Engine, e: Any, id: number): Promise<void> {
  if (ending.has(id)) return
  ending.add(id)
  try {
    await ended($, e, id)
  } catch (err) {
    await setFixLine($, { id, kind: 'problem', said: `Fix ${id} could not be checked: ${cut(String((err as Error)?.message || err), 200)}. /thimble-fix lists it.` }).catch(() => undefined)
  } finally {
    ending.delete(id)
  }
}

async function ended($: Engine, e: Any, id: number): Promise<void> {
  if ((await fixOf($, id))?.state !== 'working') return
  const all = await fixers($)
  delete all[String(e.agentId)]
  await $.state.set(FIXERS, all as never)
  const end = endOf(String(e.answer ?? ''))
  const fix = await fixOf($, id)
  const args = ['done', String(id), '--summary', '-', ...(end.title ? ['--title', end.title] : []), ...(end.request ? ['--request'] : []),
    ...(end.changes != null && !end.request ? ['--changes', String(end.changes)] : [])]
  const r = await kernelFix($, args, { stdin: end.summary || ' ', timeoutMs: 600000, doing: `testing fix ${id}${fix ? `: ${cut(end.title || fix.title, 28)}` : ''}` })
  await refreshFixes($)
  if (!r.ok) {
    await setFixLine($, { id, kind: 'problem', said: `Fix ${id} could not be checked: ${cut(r.err || 'thimble fix done gave nothing', 200)}` })
    return
  }
  const done = jsonOf<Fix>(r.out)
  const kind = done?.state === 'ready' ? 'ready' : done?.state === 'request' ? 'request' : 'failed'
  // a change that went into the fix it refines: the line is that fix's; one that did not fit it is a new fix
  const changed = kind === 'ready' && done?.folded != null && done.id !== id
  const at = changed ? done!.id : id
  await setFixLine($, { id: at, kind, ...(changed ? { changed: true } : {}), ...(kind === 'ready' && done?.fold_failed != null ? { notFolded: done.fold_failed } : {}) })
  const title = done?.title || fix?.title || `fix ${id}`
  const did = changed ? `thimble changed fix ${at}` : 'thimble fixed'
  if (kind === 'ready') {
    // the person may be in another window: Claude Code's own notification, with the line's words
    try { await $.ui.notify(`${did}: ${title} · ${testsWord(done)}`, { title: 'thimble' }) } catch { /* the line says it */ }
  }
  if ((await askerOf($, id)) === 'claude') {
    const said = kind === 'ready'
      ? `${changed ? `changed fix ${at}, which ` : ''}is ready and ${testsWord(done)}; the person turns it on with y`
      : kind === 'request' ? 'changed no code; it is kept as a request in the person\'s list of fixes' : `did not pass its checks (${cut(done?.error || 'its tests failed', 200)})`
    await tellAtNextPrompt($, `fix-${id}`, `The thimble fix you started, fix ${id} ("${title}"), ${said}. Tell the person in one short line.`)
  } else if (kind === 'ready') {
    await tellAtNextPrompt($, `fix-${at}`, changed
      ? `thimble's fixer changed fix ${at} ("${title}"); it is off until the person's y turns the changed fix on. Nothing for you to do.`
      : `thimble's fixer finished fix ${id} ("${title}"); it waits for the person's y. Nothing for you to do.`)
  }
}

/** What came of a fix's tests, in the line's words: `tests pass`. */
export function testsWord(f: Pick<Fix, 'tests'> | null | undefined): string {
  const t = f?.tests
  return t === 'passed' ? 'tests pass' : t === 'skipped' ? 'tests not run' : t ? `tests ${t}` : 'tests not run'
}

/** A fix that still says `working` whose fixer no longer runs (its end came while the plugin reloaded, or never
 *  reached it): thimble takes what its copy holds, as at its end. */
export async function recoverFixers($: Engine, working: Fix[]): Promise<void> {
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
