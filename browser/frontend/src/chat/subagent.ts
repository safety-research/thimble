// What the browser says about one of thimble's agents run as a subagent of the analyst's Claude Code session (its chat's
// meta, backend subagents.ensure_chat): the model and effort its run actually used, and why it stopped. Pure.
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

/** Why the agent's card says it stopped, or ''. */
export function stoppedLine(m: Pick<ChatMeta, 'status' | 'stopped_by' | 'route'> | null | undefined): string {
  if (!m || m.status !== 'stopped' || !isSubagent(m)) return ''
  if (m.stopped_by === 'quit') return 'Stopped when your Claude Code session ended.'
  if (m.stopped_by === 'analyst') return 'Stopped.'
  if (m.stopped_by === 'user') return 'Stopped with Esc in your terminal.'
  return ''
}

/** The line when a Stop found the agent had ended already. */
export const STOP_DONE_LINE = 'It had already ended.'

/** The line when thimble could not stop it, and how to stop it in the terminal. */
export const stopFailedLine = (reason: string): string =>
  `thimble could not stop it${reason ? `: ${reason.replace(/[.\s]+$/, '')}` : ''}. Stop it in your terminal: ↓ to it in the agent tray, Enter, then Esc.`

/** How to stop main when thimble could not stop its turn. */
export const MAIN_ESC_LINE = 'To stop main, press Esc in your Claude Code terminal.'

/** The line when thimble could not stop main's turn for another reason, and how to stop it in the terminal. */
export const mainStopFailedLine = (reason: string): string => `thimble could not stop main: ${reason.replace(/[.\s]+$/, '')}. ${MAIN_ESC_LINE}`
