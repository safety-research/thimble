// Main's model, effort and fast mode, as the composer's model line under main's chat and Settings' Main and side threads
// row change them: one setting shown in both places. Each goes to the server at once (backend events.py session/model,
// session/effort, session/fast), which keeps it in the workspace's settings as models.main for main's next turn and on
// main's meta for both places to show; a toast says when it applies, or why it could not be set.
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import { invalidateSettings, modelLabel } from '../lib/models'
import { track } from '../lib/telemetry'
import type { MainEffort } from '../lib/types'
import { NEXT_LAUNCH } from './ModelLine'

export type MainChoice = { model: string } | { effort: MainEffort } | { fast: boolean }

/** What the toast names: the model, the effort or fast mode, as chosen. Pure. */
export function choiceWords(choice: MainChoice): string {
  if ('model' in choice) return modelLabel(choice.model)
  if ('effort' in choice) return `Effort ${choice.effort}`
  return `Fast mode ${choice.fast ? 'on' : 'off'}`
}

/** Send one choice for main; true once the server holds it. `target` names the control in the telemetry: the composer's
 * line (`chat:main`) or Settings' row. */
export async function chooseMain(ws: string, choice: MainChoice, target = 'chat:main'): Promise<boolean> {
  track('chat-settings', { target, detail: choice })
  const what = 'model' in choice ? 'the model' : 'effort' in choice ? 'the effort' : 'fast mode'
  try {
    if ('model' in choice) await api.setModel(ws, choice.model)
    else if ('effort' in choice) await api.setEffort(ws, choice.effort)
    else await api.setFast(ws, choice.fast)
  } catch (err) {
    bus.emit('toast', { text: `Could not set ${what}: ${(err as Error).message}`, kind: 'error' })
    return false
  }
  // the model menus name the models the settings hold, and the row for view builds shows main's fast mode while its
  // own is not set (backend config.models_for), which a model without fast mode turns off too
  if (!('effort' in choice)) invalidateSettings(ws)
  bus.emit('toast', { text: `${choiceWords(choice)}: ${NEXT_LAUNCH}.`, kind: 'info' })
  return true
}
