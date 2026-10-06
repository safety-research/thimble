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
 * (CONTINUE_HERE_LINE). One thimble stopped when main went into plan mode says so, and how to go on (planLine). */
export function stoppedLine(m: Pick<ChatMeta, 'status' | 'stopped_by' | 'role' | 'route' | 'agent_type'> | null | undefined, back = false): string {
  if (!m || m.status !== 'stopped' || !isSubagent(m)) return ''
  if (m.stopped_by === 'quit') {
    return m.role === 'orient' && !back
      ? 'Stopped when your Claude Code session ended. Run `thimble --continue` in this folder, then send it a message to continue.'
      : 'Stopped when your Claude Code session ended.'
  }
  if (m.stopped_by === 'analyst') return 'Stopped.'
  if (m.stopped_by === 'user') return 'Stopped with Esc in your terminal.'
  if (m.stopped_by === 'plan') return planLine(m.role, m.agent_type)
  return ''
}

/** How a run thimble stopped when main went into plan mode goes on once main leaves it, by its agent's role (backend
 * subagents.PLAN_HOW). A view's build, its review and a code ticket share the chat role `dev`, so the agent's type
 * names the role; a chat without one goes by its chat role (PLAN_CHAT_ROLES). */
const PLAN_HOW: Record<string, string> = {
  orientation: 'send it a message to continue it',
  critic: 'send the orientation a message to continue it',
  writer: 'choose Write again',
  'view-builder': 'choose Retry on the view',
  'view-reviewer': 'choose Review again on the view',
  check: 'choose Run on the check',
  'dev-ticket': 'choose Retry on the ticket',
}
const PLAN_CHAT_ROLES: Record<string, string> = { orient: 'orientation', step: 'critic', writer: 'writer', dev: 'view-builder', check: 'check' }

/** The line of a run thimble stopped through Claude Code when main went into plan mode, where its agents would have to
 * ask before every step: why, and how to go on (backend subagents.plan_line), by the agent's type (`thimble:<role>`)
 * where it is known, else by its chat's role. */
export function planLine(role: string | null | undefined, agentType?: string | null): string {
  const own = agentType?.startsWith('thimble:') ? agentType.slice('thimble:'.length) : ''
  const how = PLAN_HOW[own] ?? PLAN_HOW[PLAN_CHAT_ROLES[role ?? ''] ?? ''] ?? 'start it again'
  return `Stopped when your Claude Code session went into plan mode, where thimble's agents would have to ask you before every step. Leave plan mode (shift+tab in your terminal), then ${how}.`
}

/** The line a thread ends with once thimble stopped its run as main went into plan mode (planLine), or null: an
 * orientation's, a writer's or a check's thread (ChatPanel SessionView) and a view's build (ViewBuildView), whose
 * transcript's own end says only "stopped". Pure. */
export function planStoppedLine(m: Pick<ChatMeta, 'status' | 'stopped_by' | 'role' | 'agent_type'> | null | undefined, running: boolean): string | null {
  return !running && m?.status === 'stopped' && m.stopped_by === 'plan' ? planLine(m.role, m.agent_type) : null
}

export type Continue = 'here' | 'earlier-session' | 'earlier-version' | 'stopped-by-user' | null

/** Whether a follow-up can still continue an orientation: `earlier-version` for a chat no subagent ran (0.5.0, or a
 * pre-release 0.6.0 that ran it headless), `stopped-by-user` for one stopped with Esc in its agent view, which Claude
 * Code resumes no more (backend subagents.mark_cancelled), so a message starts a continuation in its thread (backend
 * orient_session.continue_stopped), `earlier-session` when its agent belongs to another Claude
 * Code session than the one that is main now (`mainSid`), `here` otherwise; null while nothing is known. */
export function continueOf(m: Pick<ChatMeta, 'continue' | 'route' | 'agent_id' | 'session' | 'sessions' | 'precached'> | null | undefined, mainSid: string | null | undefined): Continue {
  if (!m) return null
  if (m.continue === 'earlier-version') return 'earlier-version'
  if (m.continue === 'stopped-by-user') return 'stopped-by-user'
  if (m.precached) return null
  if (!isSubagent(m) || !m.agent_id) return 'earlier-version'
  const sessions = [...(m.sessions ?? []), ...(m.session ? [m.session] : [])].filter(Boolean)
  if (mainSid && sessions.length && !sessions.includes(mainSid)) return 'earlier-session'
  return 'here'
}

/** The latest session id an orientation's records are under, which `thimble -r` resumes. */
export const lastSession = (m: Pick<ChatMeta, 'session' | 'sessions'> | null | undefined): string => m?.sessions?.[m.sessions.length - 1] || m?.session || ''

/** The composer's text for an orientation that cannot take a message here (backend tools.md orient-continue-*); ''
 * for one that can, an orientation stopped with Esc among them, whose message starts a continuation
 * (STOPPED_CONTINUE_LINE). */
export function continueText(kind: Continue, sid: string): string {
  if (kind === 'earlier-version') return 'This orientation ran in an earlier version of thimble and cannot be continued. Start a new orientation to explore further.'
  if (kind === 'earlier-session')
    return `This orientation ran in an earlier Claude Code session. To continue it, quit and run \`thimble -r ${sid || '<session id>'}\` in this folder, or start a new orientation.`
  return ''
}

/** The line of an orientation stopped by main's quit and resumed with `thimble --continue`: a message continues it. */
export const CONTINUE_HERE_LINE = 'Stopped when Claude Code quit. Send a message to continue it.'

/** The line of an orientation stopped with Esc in its agent view, which Claude Code resumes no more: a message starts
 * a new run in its thread with what the stopped run left (backend orient_session.continue_stopped). */
export const STOPPED_CONTINUE_LINE =
  'Stopped with Esc in your terminal, and Claude Code does not continue an agent stopped that way. Send a message to continue it: thimble starts a new run in this thread that takes up its work.'

/** The line while the orientation waits for its critic's report. */
export const PAUSED_LINE = 'Waiting for the critique'

/** The line when a Stop found the agent had ended already. */
export const STOP_DONE_LINE = 'It had already ended.'

/** The line when thimble could not stop it, and how to stop it in the terminal. */
export const stopFailedLine = (reason: string): string =>
  `thimble could not stop it${reason ? `: ${reason.replace(/[.\s]+$/, '')}` : ''}. Stop it in your terminal: ↓ to it in the agent tray, Enter, then Esc.`

/** Without thimble's module in main's session, Stop is not offered; the card says how to stop it in the terminal. */
export const NO_STOP_LINE = "To stop it, press Esc in its view in your terminal (↓ to it in the agent tray, then Enter)."
