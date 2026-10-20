// aside.ts: work a key asks of Claude, done beside the conversation. v asks for another view of an answer; the card
// is drawn under that answer, and the chat shows no prompt and no reply of Claude's, only one short line under the
// answer while the work runs (`visualize… another view of this answer · 3 steps · 24s`).
//
// The mechanism: a fork of main ($.agent.spawn with subagentType 'fork'), started in the background. A fork has the
// conversation as its context (the answer, the queries behind it, the thimble guidance), its model and its tools, so
// it makes the card as main would, with the `thimble` command, and its Bash calls go through the same permission checks
// as main's. Its messages stay out of main's conversation:
//   - its steps are read from its transcript each second ($.session.messages), for the line and for its commands;
//   - the cards it saves are placed under the message the key was pressed on (shell.tsx places what asideFor names):
//     read after its own calls where its tool.call reaches this plugin, else at its end, and a save another call read
//     first from the change feed goes under the message when the agent's commands name the card;
//   - its end is heard at its turn.complete, and a hand-back or task notification it leaves in main's queue is dropped;
//   - main learns of the card from one row it reads and the person does not see ($.session.append), so a later turn
//     knows the card exists and where it is drawn.
// The other mechanisms were weighed: hiding the plugin's prompt and Claude's reply rows (ui.render) still runs a turn
// of main, which holds the prompt while it runs; $.model.fork has no tools, so it cannot query the data a card draws.
// Where the fork is refused (a build without forks), the caller asks main as before (shell.tsx ask).
//
// Any key can use it: askAside($, {row, verb, what, about, request}) starts the work and returns false when it could
// not; onAsideMade(verb, made) says what main reads once the work saved its cards.
import type { EngineInterface, Register } from 'claude-code'

import type { Aside, ObjRef } from '../types'
import { claimAgent } from '../telemetry/telemetry'
import { ownReport } from './threads.js'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const ASIDE = { plugin: 'thimble', key: 'aside' } as const
const ASIDEOF = { plugin: 'thimble', key: 'asideof' } as const

/** How many of an agent's commands are kept to tell its saves by (asideFor). */
const KEEP_CMDS = 40

/** Each running aside's ticker in this load of the module, by its agent. */
const live = new Map<string, { cancel?: () => void } | null>()
/** What main reads once a verb's agent saved its cards, by the verb: set by the module that asks (onAsideMade). */
const madeBy = new Map<string, (a: Aside) => string>()

/** What main reads once a verb's agent saved its cards: a row it reads and the person does not see. */
export function onAsideMade(verb: string, made: (a: Aside) => string): void {
  madeBy.set(verb, made)
}

export type AsideAsk = {
  /** the message the key was pressed on: the cards are drawn under it, and the progress line too */
  row: string
  /** the key's verb, which the line names (`visualize`) and the session's events file the agent's turns under */
  verb: string
  /** what is being made, in a few words (`another view of this answer`) */
  what: string
  /** the message's first words, for the row main reads after */
  about: string
  /** the request the agent works from */
  request: string
}

/** The aside running or finished on a message, or null. */
export async function asideOn($: Engine, row: string): Promise<Aside | null> {
  return ((await $.state.get({ ...ASIDE, id: row })).value ?? null) as Aside | null
}

/** The message a key's agent works for, by the agent's id, or null for any other agent (or main). */
export async function asideRowOf($: Engine, agentId: string | undefined): Promise<string | null> {
  if (!agentId) return null
  const of = ((await $.state.get(ASIDEOF)).value ?? {}) as Record<string, string>
  return of[agentId] ?? null
}

async function patch($: Engine, row: string, f: (a: Aside) => Aside): Promise<Aside | null> {
  const a = await asideOn($, row)
  if (!a) return null
  const next = f(a)
  await $.state.set({ ...ASIDE, id: row }, next)
  return next
}

/** Start the work beside the conversation. False when no agent could start (the caller asks main instead). */
export async function askAside($: Engine, o: AsideAsk): Promise<boolean> {
  const was = await asideOn($, o.row)
  if (was?.status === 'running') return true
  let r: Any
  const description = `thimble · ${o.verb}`
  try {
    r = await $.agent.spawn({ subagentType: 'fork', prompt: o.request, description })
  } catch (err) {
    r = { deny: String((err as Error)?.message || err) }
  }
  if (!r || r.deny || !r.model) return false
  const of = ((await $.state.get(ASIDEOF)).value ?? {}) as Record<string, string>
  // the engine names the agent it started; failing that, the newest agent of this description not already known
  let agentId = r.agentId ? String(r.agentId) : null
  if (!agentId) agentId = ((await $.agent.list().catch(() => [])) as Any[]).filter(x => x?.description === description && !(String(x.id) in of)).at(-1)?.id ?? null
  if (!agentId) return false
  const now = await $.clock.now()
  await $.state.set({ ...ASIDE, id: o.row }, { row: o.row, verb: o.verb, what: o.what, about: o.about, agentId, status: 'running', at: now, secs: 0, steps: 0, cmds: [], saves: [] })
  await $.state.set(ASIDEOF, { ...of, [agentId]: o.row })
  claimAgent(agentId, o.verb, null)
  // the line counts the seconds and the steps while the agent works
  const tick = $.clock.every(1000, () => { void follow($, agentId, o.row).catch(() => undefined) }) as unknown as { cancel?: () => void }
  live.set(agentId, tick)
  return true
}

/** What the agent ran so far, from its transcript: each tool call, and the command of each Bash call. */
async function stepsOf($: Engine, agentId: string): Promise<{ n: number; last: string | null; cmds: string[] } | null> {
  const m = await $.session.messages({ agentId } as Any).catch(() => null)
  if (!Array.isArray(m)) return null
  const uses = (m as Any[]).flatMap(x => (x?.role === 'assistant' && Array.isArray(x.toolUses) ? x.toolUses : []))
  const cmds = uses.filter((u: Any) => u?.tool === 'Bash').map((u: Any) => String(u?.input?.command || '')).filter(Boolean)
  const lastUse = uses[uses.length - 1]
  return { n: uses.length, last: lastUse ? stepOf(String(lastUse.tool), lastUse.input) : null, cmds: cmds.slice(-KEEP_CMDS) }
}

/** One look at a running agent: its seconds, its steps and its commands on its line. */
async function follow($: Engine, agentId: string, row: string): Promise<void> {
  const t = await $.clock.now()
  const st = await stepsOf($, agentId)
  await patch($, row, a => (a.status !== 'running' ? a : {
    ...a, secs: Math.round((t - a.at) / 1000),
    ...(st ? { steps: Math.max(a.steps, st.n), ...(st.last ? { last: st.last } : {}), cmds: [...new Set([...a.cmds, ...st.cmds])].slice(-KEEP_CMDS) } : {}),
  }))
}

/** Whether a command names the card `id` as a word of its own. */
const names = (cmd: string, id: string) => new RegExp(`(^|[^A-Za-z0-9_.-])${id.replace(/[.]/g, '\\.')}([^A-Za-z0-9_.-]|$)`).test(cmd)

/** The message a save belongs under when a key's agent made it: the agent's own call (`agentId`), or, seen from
 *  another call that read the change feed first, a running aside whose commands name the card (read from its
 *  transcript now). Null otherwise. */
export async function asideFor($: Engine, agentId: string | undefined, id: string): Promise<string | null> {
  const own = await asideRowOf($, agentId)
  if (own) return own
  const of = ((await $.state.get(ASIDEOF)).value ?? {}) as Record<string, string>
  for (const [agent, row] of Object.entries(of)) {
    const a = await asideOn($, row)
    if (a?.status !== 'running') continue
    const cmds = [...a.cmds, ...((await stepsOf($, agent))?.cmds ?? [])]
    if (cmds.some(c => names(c, id))) return row
  }
  return null
}

/** At the end of a key's agent: whether a save read from the change feed then is its own. Its commands name the card,
 *  or, with main at rest (`mainIdle`), nothing else could have saved it. */
export async function asideMade($: Engine, agentId: string, id: string, mainIdle: boolean): Promise<boolean> {
  const row = await asideRowOf($, agentId)
  if (!row) return false
  if (mainIdle) return true
  const a = await asideOn($, row)
  const cmds = [...(a?.cmds ?? []), ...((await stepsOf($, agentId))?.cmds ?? [])]
  return cmds.some(c => names(c, id))
}

/** A card the agent saved, as it is drawn under the message. */
export async function asideSaved($: Engine, row: string, ref: ObjRef): Promise<void> {
  await patch($, row, a => ({ ...a, saves: [...a.saves.filter(x => !(x.id === ref.id && x.root === ref.root)), ref] }))
}

/** The shell looked at where the card landed (shell.tsx cardLanded): it says so once. */
export async function markTold($: Engine, row: string): Promise<void> {
  await patch($, row, a => ({ ...a, told: true }))
}

/** The key was pressed again on the message: a line left by a failed aside goes. */
export async function clearAside($: Engine, row: string): Promise<void> {
  const a = await asideOn($, row)
  if (a && a.status !== 'running') await $.state.set({ ...ASIDE, id: row }, null)
}

/** The progress line under the message, as words and a tone, or null with nothing to say. */
export function asideLine(a: Aside | null): { text: string; error: boolean } | null {
  if (!a) return null
  if (a.status === 'running') {
    const parts = [`${a.verb}… ${a.what}`]
    if (a.steps) parts.push(`${a.steps} step${a.steps === 1 ? '' : 's'}`)
    if (a.secs) parts.push(`${a.secs}s`)
    return { text: parts.join(' · '), error: false }
  }
  if (a.status === 'failed') return { text: `× ${a.verb} made no card${a.error ? `: ${a.error}` : ''} · press ${a.verb[0]} to try again`, error: true }
  return null
}

/** A command as the line names it: `thimble run`, else its first word. */
function stepOf(tool: string, input: Any): string {
  if (tool !== 'Bash') return tool
  const c = String(input?.command || '').trim()
  const m = /\bthimble\s+([a-z]+)/.exec(c)
  return m ? `thimble ${m[1]}` : c.split(/\s+/)[0] || 'Bash'
}

export const registerAside: Register = on => {
  // each call of a key's agent, where it reaches this plugin: its command kept at once, so a save another call reads
  // first from the change feed is still placed under the message (asideFor); its steps come from its transcript
  on('tool.call', { agentId: /./ }, async ($, e, next) => {
    try {
      const row = await asideRowOf($, e.agentId)
      const cmd = String((e as unknown as { command?: string }).command || '')
      if (row && cmd) await patch($, row, a => ({ ...a, cmds: [...new Set([...a.cmds, cmd])].slice(-KEEP_CMDS) }))
    } catch {
      // the agent's transcript gives the command a second later
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // the agent's end: its cards stand under the message, and main reads one row naming them
  on('turn.complete', { agentId: /./ }, async ($, e, next) => {
    const r = await next(e)
    try {
      const row = await asideRowOf($, e.agentId)
      if (row && e.agentId) {
        live.get(e.agentId)?.cancel?.()
        live.delete(e.agentId)
        const a = await asideOn($, row)
        if (a && a.status === 'running') {
          const answer = String((e as unknown as { answer?: string }).answer || '').replace(/\s+/g, ' ').trim()
          const t = await $.clock.now()
          if (a.saves.length) {
            const done: Aside = { ...a, status: 'done', secs: Math.round((t - a.at) / 1000) }
            await $.state.set({ ...ASIDE, id: row }, done)
            const text = madeBy.get(a.verb)?.(done)
            if (text) await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
          } else {
            const why = e.reason !== 'answer' ? (e.reason === 'aborted' ? 'it was stopped' : `it ended in ${e.reason === 'refusal' ? 'a refusal' : 'an error'}`) : answer ? answer.slice(0, 120) : 'it saved no card'
            await $.state.set({ ...ASIDE, id: row }, { ...a, status: 'failed', error: why })
          }
        }
      }
    } catch {
      // the line shows its last state
    }
    return r
  }).catch(($, e, next) => next(e))

  // a key's agent's hand-back or task notification never enters main's conversation (as a side thread's does not)
  on('prompt.submit', { origin: { kind: /^(task-notification|peer)$/ } }, async ($, e, next) => {
    const of = ((await $.state.get(ASIDEOF)).value ?? {}) as Record<string, string>
    const id = ownReport(e.text, Object.keys(of))
    if (!id) return next(e)
    const a = await asideOn($, of[id]!)
    return { drop: `${a?.verb ?? 'thimble'} finished` }
  }).catch(($, e, next) => next(e))
}

/** For tests: the module's memory, cleared. */
export function resetAside(): void {
  for (const l of live.values()) l?.cancel?.()
  live.clear()
  madeBy.clear()
}
