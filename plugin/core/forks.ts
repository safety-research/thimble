// forks.ts: the forks of main thimble starts beside the conversation: the checker after each reply (marks), the
// designer when the person presses v (designer), and a side thread's agent when the person asks one (threads). A fork
// has main's conversation as its context, its model and its tools, so it works as main would, and its calls go through
// the same permission checks as main's.
//
//   spawnFork($, {kind, prompt, description, type?, cwd?})  $.agent.spawn with subagentType 'fork' (or `type`: a side
//                                thread's own agent type, where no fork starts; the fixer's, thimble:fixer, in its
//                                copy of thimble, `cwd`), in the background: {agentId}, or
//                                {deny} with the reason. Call it inside a hook, never from a timer: Claude Code skips
//                                only the hook that spawned the fork for the fork's own events, so this plugin's other
//                                hooks serve it (its tool calls, its steps, its end); a fork spawned from a timer has
//                                the whole plugin as its caller, and none of the plugin's hooks would see it.
//   forkOf(agentId)              {kind, agentId} of a fork thimble started, or null (main, or another agent)
//
// A module hears its fork's end in its own `turn.complete` hook ({agentId, reason, answer, refusal}), where
// forkOf(e.agentId) names the kind. (Claude Code follows `$` only into functions a file declares or imports, so a
// list of handlers that take `$` cannot be called from here.)
// A fork's end never reaches main's conversation: its task notification or hand-back is dropped at prompt.submit.
// Each fork's turns are filed under its kind in the session's events (telemetry claimAgent). Which agent is which fork
// is kept in $.state as soon as Claude Code names the agent, so a reload of the plugin still knows them; the newest
// KEPT forks are kept, long enough for any report of theirs to come.
import type { EngineInterface, Register } from 'claude-code'

import { claimAgent } from '../telemetry/telemetry'

type Engine = EngineInterface

export type ForkKind = 'checker' | 'designer' | 'thread' | 'fixer'

const FORKS = { plugin: 'thimble', key: 'forks' } as const
const KEPT = 64
const known = new Map<string, ForkKind>()

/** The forks a reload of the plugin left running, known again. */
async function restore($: Engine): Promise<void> {
  const kept = ((await $.state.get(FORKS)).value ?? {}) as Record<string, ForkKind>
  for (const [id, kind] of Object.entries(kept)) if (!known.has(id)) known.set(id, kind)
}

export function forkOf(agentId: string | undefined): { kind: ForkKind; agentId: string } | null {
  const kind = agentId ? known.get(agentId) : undefined
  return kind && agentId ? { kind, agentId } : null
}

export async function spawnFork($: Engine, o: { kind: ForkKind; prompt: string; description: string; type?: string; cwd?: string }): Promise<{ agentId?: string; deny?: string }> {
  let r: { agentId?: string; deny?: string } | undefined
  try {
    r = await $.agent.spawn({ subagentType: o.type ?? 'fork', prompt: o.prompt, description: o.description, ...(o.cwd ? { cwd: o.cwd } : {}) })
  } catch (err) {
    return { deny: String((err as Error)?.message || err) }
  }
  if (!r || r.deny !== undefined) return { deny: String(r?.deny || 'Claude Code started no agent') }
  if (!r.agentId) return { deny: 'Claude Code did not name the agent it started' }
  const agentId = String(r.agentId)
  known.set(agentId, o.kind)
  for (const old of [...known.keys()].slice(0, Math.max(0, known.size - KEPT))) known.delete(old)
  claimAgent(agentId, o.kind, o.kind)
  try { await $.state.set(FORKS, Object.fromEntries(known)) } catch { /* known for this load of the module */ }
  return { agentId }
}

/** The fork a row in main's queue reports on: a hand-back (`<agent-message from="<id>">`) or a task notification
 *  (`<task-id><id></task-id>`) of a fork thimble started. */
export function reportOf(text: string): string | null {
  const s = String(text || '')
  const m = /<agent-message from="([^"]+)">/.exec(s) || /<task-id>([^<]+)<\/task-id>/.exec(s)
  const id = m?.[1]?.trim()
  return id && known.has(id) ? id : null
}

export const registerForks: Register = on => {
  // a reload of the plugin: the forks still running are known again
  on('session.start', { cwd: /^\/?/ }, async ($, e, next) => {
    const r = await next(e)
    try {
      await restore($)
    } catch {
      // the forks started from now on are known
    }
    return r
  }).catch(($, e, next) => next(e))

  on('prompt.submit', { origin: { kind: /^(task-notification|peer)$/ } }, async ($, e, next) => {
    const id = reportOf(e.text)
    return id ? { drop: `thimble's ${known.get(id)} finished` } : next(e)
  }).catch(($, e, next) => next(e))
}
