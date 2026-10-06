// What the browser says about one of thimble's agents run as a subagent of the analyst's Claude Code session (its chat's
// meta, backend subagents.ensure_chat): the model and effort its run actually used, where the terminal shows it, why
// it stopped, and whether a follow-up can still continue it. Pure.
import { modelLabel } from '../lib/models'
import type { ChatMeta, RunValues } from '../lib/types'

/** Whether a chat is one of thimble's agents run as a subagent of main. */
export const isSubagent = (m: Pick<ChatMeta, 'route'> | null | undefined): boolean => m?.route === 'subagent'

/** The values the run `run` (the latest when unset) actually ran on, read from its transcript, else the run's own. */
export function runValues(m: Pick<ChatMeta, 'values' | 'ran' | 'run'> | null | undefined, run?: number): RunValues | null {
  if (!m) return null
  const k = String(run ?? m.run ?? 0)
  return m.ran?.[k] ?? m.values ?? null
}

/** A run's values as its card's header names them: `Opus 5.5 · xhigh`, the model alone for one with no effort; '' when
 * none are known. */
export function valuesText(v: RunValues | null | undefined): string {
  if (!v?.model) return ''
  return [modelLabel(v.model), v.effort || ''].filter(Boolean).join(' · ')
}

/** The agent's type as Claude Code's agent tray names it (`thimble:orientation`). */
export function trayName(m: Pick<ChatMeta, 'agent_type' | 'role'> | null | undefined): string {
  if (m?.agent_type) return m.agent_type
  const role = m?.role === 'orient' ? 'orientation' : m?.role ?? 'agent'
  return `thimble:${role}`
}

/** Where the analyst finds the agent in their terminal: ↓ to its row while it runs; once it finished, `/tasks` and
 * Enter, since a finished agent leaves the ↓ tray (U16). */
export function terminalLine(m: Pick<ChatMeta, 'agent_type' | 'role'> | null | undefined, running: boolean): string {
  const name = trayName(m)
  return running ? `In your terminal: ↓ to ${name} in the agent tray, then Enter.` : `In your terminal: /tasks, then Enter on ${name}.`
}

/** Why the agent's card says it stopped, or ''. An orientation main's quit stopped says how to continue it while no
 * session is back (`back` false); once `thimble --continue` brought main back, its thread says a message continues it
 * (CONTINUE_HERE_LINE). */
export function stoppedLine(m: Pick<ChatMeta, 'status' | 'stopped_by' | 'role' | 'route'> | null | undefined, back = false): string {
  if (!m || m.status !== 'stopped' || !isSubagent(m)) return ''
  if (m.stopped_by === 'quit') {
    return m.role === 'orient' && !back
      ? 'Stopped when your Claude Code session ended. Run `thimble --continue` in this folder, then send it a message to continue.'
      : 'Stopped when your Claude Code session ended.'
  }
  if (m.stopped_by === 'analyst') return 'Stopped.'
  return ''
}

export type Continue = 'here' | 'earlier-session' | 'earlier-version' | null

/** Whether a follow-up can still continue an orientation: `earlier-version` for a chat no subagent ran (0.5.0, or a
 * pre-release 0.6.0 that ran it headless), `earlier-session` when its agent belongs to another Claude Code session than
 * the one that is main now (`mainSid`), `here` otherwise; null while nothing is known. */
export function continueOf(m: Pick<ChatMeta, 'continue' | 'route' | 'agent_id' | 'session' | 'sessions' | 'precached'> | null | undefined, mainSid: string | null | undefined): Continue {
  if (!m) return null
  if (m.continue === 'earlier-version') return 'earlier-version'
  if (m.precached) return null
  if (!isSubagent(m) || !m.agent_id) return 'earlier-version'
  const sessions = [...(m.sessions ?? []), ...(m.session ? [m.session] : [])].filter(Boolean)
  if (mainSid && sessions.length && !sessions.includes(mainSid)) return 'earlier-session'
  return 'here'
}

/** The latest session id an orientation's records are under, which `thimble -r` resumes. */
export const lastSession = (m: Pick<ChatMeta, 'session' | 'sessions'> | null | undefined): string => m?.sessions?.[m.sessions.length - 1] || m?.session || ''

/** The composer's text for an orientation that cannot take a message here (backend tools.md orient-continue-*). */
export function continueText(kind: Continue, sid: string): string {
  if (kind === 'earlier-version') return 'This orientation ran in an earlier version of thimble and cannot be continued. Start a new orientation to explore further.'
  if (kind === 'earlier-session')
    return `This orientation ran in an earlier Claude Code session. To continue it, quit and run \`thimble -r ${sid || '<session id>'}\` in this folder, or start a new orientation.`
  return ''
}

/** The line of an orientation stopped by main's quit and resumed with `thimble --continue`: a message continues it. */
export const CONTINUE_HERE_LINE = 'Stopped when Claude Code quit. Send a message to continue it.'

/** The line while the orientation waits for its critic's report. */
export const PAUSED_LINE = 'Waiting for the critique'

/** The line when a Stop found the agent had ended already. */
export const STOP_DONE_LINE = 'It had already ended.'

/** The line when thimble could not stop it, and how to stop it in the terminal. */
export const stopFailedLine = (reason: string): string =>
  `thimble could not stop it${reason ? `: ${reason.replace(/[.\s]+$/, '')}` : ''}. Stop it in your terminal: ↓ to it in the agent tray, Enter, then Esc.`

/** Without thimble's module in main's session, Stop is not offered; the card says how to stop it in the terminal. */
export const NO_STOP_LINE = "To stop it, press Esc in its view in your terminal (↓ to it in the agent tray, then Enter)."
