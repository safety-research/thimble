// fixer.ts: thimble's fixer, the subagent that makes a change the person asked for, in the background, in a scratch
// copy of thimble (~/.thimble/fixes/work/<id>). Its type is thimble:fixer (prompts/fixer.md is its system prompt).
//
//   startFixer($, fix, words)   spawns it in the copy, with the person's words; the bar shows `fixing: <title>`
//   fixerCall($, e)             each of its tool calls: Bash runs in the sandbox runtime (the kernel's `fix sandbox`
//                               gives the command's start: no network, writes only the copy and its temp folder);
//                               Write and Edit only in the copy; nothing else
//   fixerCheck($, e)            those calls need no dialog: the person asked for the fix, and they cannot reach
//                               anything else
//   fixerEnded($, e)            its end: thimble commits the change in the copy and runs the tests in the sandbox
//                               (`thimble fix done`), then the line above the bar says the fix is ready
//
//   state: fixers (agentId → the fix's id), fixerBox (the sandbox command's start, by the fix's id)
import type { EngineInterface } from 'claude-code'

import { busyWhile } from '../bar/busy'
import { failNotice } from '../bar/notice'
import { spawnFork } from '../core/forks'
import { tellAtNextPrompt } from '../core/tell'
import { cut } from '../core/text.js'
import { promptText } from '../prompts/prompts'
import { type Fix, fixOf, jsonOf, kernelFix, refreshFixes, setFixLine } from './fixes'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export const FIXER = 'thimble:fixer'
const FIXERS = { plugin: 'thimble', key: 'fixers' } as const
const BOX = { plugin: 'thimble', key: 'fixerBox' } as const

let registered = false

/** The fixer's type, registered once per load of the plugin. Null when it is ready, else why not. */
async function ensureType($: Engine): Promise<string | null> {
  if (registered) return null
  try {
    const prompt = await promptText($, 'fixer')
    await $.agent.register({
      name: 'fixer',
      description: "Changes thimble's own code for the person, in a scratch copy, when they ask with /thimble-fix. Only the plugin starts it.",
      prompt,
      tools: ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob'],
      background: true,
      omitClaudeMd: true,
    } as Any)
    registered = true
    return null
  } catch (err) {
    return String((err as Error)?.message || err).slice(0, 240)
  }
}

/** The model never starts the fixer itself: only /thimble-fix does. */
export async function fixerOffered(): Promise<{ isOffered: boolean }> {
  return { isOffered: false }
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

/** The fixer's first message: the person's words, each round, and where it works. */
function firstMessage(fix: Fix, earlier: boolean): string {
  const words = fix.words || []
  const asked = words.length > 1
    ? words.map((w, i) => `Round ${i + 1}: ${w}`).join('\n')
    : words[0] || fix.title
  return [
    `The person asked for this change to their thimble (fix ${fix.id}):`,
    '',
    asked,
    '',
    `Your working folder is the copy: ${fix.work}.`,
    ...(earlier ? [`An earlier change for this request, which did not fit or failed its tests, is in $HOME/earlier.patch; start from it when it helps.`] : []),
  ].join('\n')
}

/** Start the fixer on a fix whose copy the kernel just made (a request, a round, a redo). */
export async function startFixer($: Engine, fix: Fix, earlier = false): Promise<string | null> {
  const bad = await ensureType($)
  if (bad) return `The fixer did not start (${bad}).`
  // the command's start for its shell, kept for each of its Bash calls
  const box = await kernelFix($, ['sandbox', String(fix.id)], { timeoutMs: 30000 })
  const argv = box.ok ? jsonOf<string[]>(box.out) : null
  if (!argv) return `The fixer did not start: ${cut(box.err || 'the sandbox could not be set up', 220)}`
  await $.state.set(BOX, { ...(((await $.state.get(BOX)).value ?? {}) as Record<string, string[]>), [String(fix.id)]: argv } as never)
  const r = await spawnFork($, { kind: 'fixer', prompt: firstMessage(fix, earlier), description: `fix ${fix.id}: ${cut(fix.title, 40)}`, type: FIXER, cwd: fix.work || undefined })
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

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`

/** The places the fixer may write: its copy and its temp folder. */
function writable(argv: string[]): string[] {
  const rules = jsonOf<Any>(argv[argv.indexOf('--srt') + 2] ?? '')
  return ((rules?.filesystem?.allowWrite ?? []) as { path: string }[]).map(x => String(x.path).replace(/\/+$/, ''))
}

/** The Bash commands thimble wrapped, by tool_use_id, so their check needs no dialog. */
const wrapped = new Map<string, string>()

/** One tool call of a fixer: rewritten into the sandbox, let through, or refused. */
export async function fixerCall($: Engine, e: Any, id: number): Promise<{ command?: string; deny?: string } | null> {
  const argv = (((await $.state.get(BOX)).value ?? {}) as Record<string, string[]>)[String(id)]
  if (!argv) return { deny: 'thimble lost the sandbox of this fix; end now.' }
  if (e.tool === 'Bash') {
    const command = [...argv, String(e.command ?? '')].map(quote).join(' ')
    if (e.tool_use_id) wrapped.set(String(e.tool_use_id), command)
    return { command }
  }
  if (e.tool === 'Write' || e.tool === 'Edit' || e.tool === 'MultiEdit' || e.tool === 'NotebookEdit') {
    const p = String(e.file_path ?? e.notebook_path ?? '')
    const ok = p.startsWith('/') && !p.split('/').includes('..') && writable(argv).some(w => p === w || p.startsWith(`${w}/`))
    return ok ? null : { deny: `The fixer changes only its copy of thimble (${writable(argv)[0] ?? 'the copy'}); ${p || 'that file'} is outside it.` }
  }
  // what reaches past the copy and the sandbox: the network, other agents, other servers
  if (/^(?:WebFetch|WebSearch|Agent|Task|SendMessage)$|^mcp__/.test(String(e.tool))) return { deny: `The fixer works offline, in its copy of thimble: ${e.tool} is not for it.` }
  return null
}

/** A fixer's call needs no dialog when thimble wrapped it in the sandbox, or it writes in its copy. */
export async function fixerCheck($: Engine, e: Any, id: number): Promise<boolean> {
  if (e.tool === 'Bash') return !!e.tool_use_id && wrapped.get(String(e.tool_use_id)) === String((e.input as Any)?.command ?? '')
  if (['Read', 'Grep', 'Glob'].includes(e.tool)) return true
  const argv = (((await $.state.get(BOX)).value ?? {}) as Record<string, string[]>)[String(id)]
  const p = String((e.input as Any)?.file_path ?? '')
  return !!argv && p.startsWith('/') && !p.split('/').includes('..') && writable(argv).some(w => p.startsWith(`${w}/`))
}

/** What the fixer's last message says: its title, what it does, or that it is a request with no code. */
export function endOf(answer: string): { title: string; summary: string; request: boolean } {
  const text = String(answer || '')
  const title = /^\s*\**title\**\s*:\s*(.+)$/im.exec(text)?.[1]?.replace(/\*+/g, '').trim() ?? ''
  const req = /^\s*\**request\**\s*:\s*([\s\S]+)$/im.exec(text)?.[1]?.trim()
  const does = /^\s*\**what it does\**\s*:\s*([\s\S]+)$/im.exec(text)?.[1]?.trim()
  return { title: cut(title, 60), summary: cut((req ?? does ?? '').replace(/\s+/g, ' '), 1200), request: req != null && does == null }
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
  const args = ['done', String(id), '--summary', '-', ...(end.title ? ['--title', end.title] : []), ...(end.request ? ['--request'] : [])]
  const r = await kernelFix($, args, { stdin: end.summary || ' ', timeoutMs: 600000, doing: `testing fix ${id}${fix ? `: ${cut(end.title || fix.title, 28)}` : ''}` })
  await refreshFixes($)
  if (!r.ok) {
    await setFixLine($, { id, kind: 'problem', said: `Fix ${id} could not be checked: ${cut(r.err || 'thimble fix done gave nothing', 200)}` })
    return
  }
  const done = jsonOf<Fix>(r.out)
  const kind = done?.state === 'ready' ? 'ready' : done?.state === 'request' ? 'request' : 'failed'
  await setFixLine($, { id, kind })
  if (kind === 'ready') await tellAtNextPrompt($, `fix-${id}`, `thimble's fixer finished fix ${id} ("${done?.title}"); it waits for the person's y. Nothing for you to do.`)
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
    const ids = Object.entries(map).filter(([, id]) => id === f.id).map(([a]) => a)
    if (ids.some(a => alive.has(a))) continue
    await fixerEnded($, { agentId: ids[0] ?? '', answer: '' }, f.id)
  }
}

/** The fixer could not be told apart (a reload lost it) or failed to start: the line says so. */
export function fixerProblem($: Engine, text: string): void {
  failNotice($, text)
}
