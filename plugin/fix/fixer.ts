// fixer.ts: thimble's fixer, the subagent that makes a change the person asked for, in the background, in a scratch
// copy of thimble (~/.thimble/fixes/work/<id>). It is a fork of the person's session, so it sees the conversation
// ("this" means something in it); prompts/fixer.md opens its first message. Its calls go through Claude Code's own
// permission handling in the person's mode, as any subagent's do.
//
//   startFixer($, fix, words)   forks the session into the copy, with the words and a text copy of what thimble shows
//                               now (screen.ts); the bar shows `fixing: <title>` with its time
//   liveFixer($)                the fix whose fixer still works, and its agent: more words for it go to that fixer
//   fixerEnded($, e)            its end: thimble commits the change in the copy and runs the tests (`thimble fix done`),
//                               then the line above the bar asks whether to use it (y; the person's key applies it), and
//                               Claude Code sends a notification. When Claude started the fix, Claude is told, so that it
//                               can tell the person.
//
//   state: fixers (agentId → the fix's id), fixBy (the fixes Claude started, by their id)
import type { EngineInterface } from 'claude-code'

import { busyWhile } from '../bar/busy'
import { failNotice } from '../bar/notice'
import { spawnFork } from '../core/forks'
import { thimbleHome } from '../core/home'
import { tellAtNextPrompt } from '../core/tell'
import { cut } from '../core/text.js'
import { promptText } from '../prompts/prompts'
import { type Fix, fixesDir, fixesNow, fixOf, jsonOf, kernelFix, refreshFixes, setFixLine } from './fixes'
import { screenCopy } from './screen'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const FIXERS = { plugin: 'thimble', key: 'fixers' } as const
const BY = { plugin: 'thimble', key: 'fixBy' } as const

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

/** One fix the person has, for the fixer: its number, title, what it does and the person's words. */
const fixText = (f: Fix) => `fix ${f.id} ("${f.title}"${f.summary ? `: ${f.summary}` : ''}; asked in the words ${(f.words || []).map(w => `"${w}"`).join(', then ')})`

/** For a request that may change a fix the person has (fix.refines): that fix, and the other fixes that are on, and how
 *  the end says which one the change refines, or asks. `always`: the person named the fix (/thimble-fix N <words>). */
export function refinesText(f: Fix, always: boolean, others: Fix[] = []): string {
  if (always) return `The person asked to change their ${fixText(f)}. Its change is in your copy. End with the line \`Changes fix ${f.id}\` in place of the Title line: thimble makes your change part of fix ${f.id}.`
  const rest = others.filter(o => o.id !== f.id)
  return [
    `The person ${f.state === 'on' ? 'applied' : 'has'} ${fixText(f)}${f.state === 'on' ? ' last' : ''}, and its change is in your copy. These words may ask to change that fix.`,
    ...(rest.length ? [`Their other fixes that are on, also in your copy: ${rest.map(fixText).join('; ')}.`] : []),
    `When your change refines one of these fixes, end with the line \`Changes fix N\` (its number) in place of the Title line; when it is a change of its own, end with a title as usual. When the words could be about more than one of them and the conversation does not tell which, change nothing and end with one line \`Which fix: <one short question>\`.`,
  ].join(' ')
}

/** The fixer's first message: the task (prompts/fixer.md), the words of each round, where it works, the fix these
 *  words may change, and a text copy of what thimble shows now. */
function firstMessage(fix: Fix, earlier: string | null, task: string, by: Asker, screen: string, refines: Fix | null = null, others: Fix[] = []): string {
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
    ...(refines ? [refinesText(refines, !!fix.refines_always, others), ''] : []),
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
  // no type: a fork of the session, which sees the conversation
  const refines = fix.refines != null ? await fixOf($, fix.refines) : null
  // the person's other fixes that are on, newest first: the words may be about one of them
  const others = ((await fixesNow($))?.fixes ?? []).filter(f => f.state === 'on' && f.commit).sort((a, b) => (b.on_at ?? 0) - (a.on_at ?? 0)).slice(0, 8)
  const r = await spawnFork($, { kind: 'fixer', prompt: firstMessage(fix, earlier ? `${fixesDir(await thimbleHome($))}/tmp/${fix.id}/earlier.patch` : null, task, await askerOf($, fix.id), screen, refines, others), description: `fix ${fix.id}: ${cut(fix.title, 40)}`, cwd: fix.work || undefined })
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
export function endOf(answer: string): { title: string; summary: string; request: boolean; changes: number | null; which: string | null } {
  const text = String(answer || '')
  const title = /^\s*\**title\**\s*:\s*(.+)$/im.exec(text)?.[1]?.replace(/\*+/g, '').trim() ?? ''
  const changes = /^\s*\**changes fix\s+#?(\d+)\b/im.exec(text)?.[1]
  const which = /^\s*\**which fix\**\s*:\s*(.+)$/im.exec(text)?.[1]?.replace(/\*+/g, '').trim() || null
  const req = /^\s*\**request\**\s*:\s*([\s\S]+)$/im.exec(text)?.[1]?.trim()
  const does = /^\s*\**what it does\**\s*:\s*([\s\S]+)$/im.exec(text)?.[1]?.trim()
  return { title: cut(title, 60), summary: cut((req ?? does ?? '').replace(/\s+/g, ' '), 1200), request: req != null && does == null, changes: changes ? Number(changes) : null, which: which ? cut(which, 200) : null }
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
  if (end.which && fix) {
    await askWhich($, fix, end.which)
    return
  }
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

/** The fixer could not tell which fix the words are for: its copy goes, and the line asks the person (a number key
 *  for one of the fixes that are on, 0 for a new fix); Claude, when it asked, is told to ask them. */
async function askWhich($: Engine, fix: Fix, question: string): Promise<void> {
  await kernelFix($, ['remove', String(fix.id)], { timeoutMs: 60000 })
  const list = await refreshFixes($)
  const choices = (list?.fixes ?? []).filter(f => f.state === 'on' && f.id < 10).sort((a, b) => (b.on_at ?? 0) - (a.on_at ?? 0)).map(f => f.id).slice(0, 5)
  const words = (fix.words || []).join('\n')
  await setFixLine($, { id: fix.id, kind: 'ask', said: question, choices, words, by: await askerOf($, fix.id) })
  if ((await askerOf($, fix.id)) === 'claude') {
    await tellAtNextPrompt($, `fix-${fix.id}`, `thimble's fixer could not tell which of the person's fixes your words are for, and changed nothing: "${question}". Ask the person in one short line, then call the fix-thimble skill again with the fix's number before the words ("3 <words>"), or "new <words>" for a new fix.`)
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
