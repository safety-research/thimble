// fixer.ts: thimble's fixer, the subagent that makes a change the person asked for, in the background, in a scratch
// copy of thimble (~/.thimble/fixes/work/<id>). It is a fork of the person's session, so it sees the conversation
// ("this" means something in it); prompts/fixer.md opens its first message. Its calls go through Claude Code's own
// permission handling in the person's mode, as any subagent's do.
//
//   startFixer($, fix, words)   forks the session into the copy, with the person's words; the bar shows `fixing: <title>`
//   fixerEnded($, e)            its end: thimble commits the change in the copy and runs the tests (`thimble fix done`),
//                               then the line above the bar asks whether to use it (y; the person's key applies it)
//
//   state: fixers (agentId → the fix's id)
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

const FIXERS = { plugin: 'thimble', key: 'fixers' } as const

async function fixers($: Engine): Promise<Record<string, number>> {
  return ((await $.state.get(FIXERS)).value ?? {}) as Record<string, number>
}

/** The fix a fixer agent works on, or null when the agent is no fixer. */
export async function fixOfAgent($: Engine, agentId: string | undefined): Promise<number | null> {
  if (!agentId) return null
  const id = (await fixers($))[agentId]
  return typeof id === 'number' ? id : null
}

/** The fixer's first message: the task (prompts/fixer.md), the person's words, each round, and where it works. */
function firstMessage(fix: Fix, earlier: boolean, task: string): string {
  const words = fix.words || []
  const asked = words.length > 1
    ? words.map((w, i) => `Round ${i + 1}: ${w}`).join('\n')
    : words[0] || fix.title
  return [
    task.trim(),
    '',
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
  let task: string
  try {
    task = await promptText($, 'fixer')
  } catch (err) {
    return `The fixer did not start (${cut(String((err as Error)?.message || err), 200)}).`
  }
  // no type: a fork of the session, which sees the conversation
  const r = await spawnFork($, { kind: 'fixer', prompt: firstMessage(fix, earlier, task), description: `fix ${fix.id}: ${cut(fix.title, 40)}`, cwd: fix.work || undefined })
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
