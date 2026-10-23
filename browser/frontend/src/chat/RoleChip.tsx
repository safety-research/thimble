// The model line at the foot of a thread's composer whose message goes to one of thimble's agents rather than to main.
// A follow-up to the orientation runs on its run's own model and effort (thimble's plugin registers them before it
// sends), so the line shows those (`values`) and does not change them. A change to a view goes to the dev role, whose
// line is the settings popover's row for it, drawn as ModelLine; a pick is saved as the settings popover saves it and
// applies from the role's next run. thimble's agents have no fast mode, so neither line has a bolt.
import { useEffect, useState } from 'react'
import { bus } from '../lib/bus'
import { loadSettings, modelChoices, onSettingsChange, saveRole } from '../lib/models'
import { track } from '../lib/telemetry'
import type { ModelConf, RunValues, Settings } from '../lib/types'
import { roleEfforts } from '../shell/SettingsPopover'
import { ModelLine } from './ModelLine'

/** The tooltip of a follow-up's model, which the run's own values fix. */
export const RUN_VALUES_TIP = "A follow-up runs on the run's own model and effort"

export function RoleChip({ ws, role, label, values }: {
  ws: string
  /** the role in settings.models: orient, dev */
  role: string
  /** the run's own values, which a follow-up keeps: shown, not changed */
  values?: RunValues | null
  /** the session the line names, in its controls' accessible names: "the orientation", "the view build" */
  label: string
}) {
  const [settings, setSettings] = useState<Settings | null>(null)
  useEffect(() => {
    let alive = true
    const read = () =>
      loadSettings(ws)
        .then((s) => alive && setSettings(s))
        .catch(() => undefined)
    void read()
    const off = onSettingsChange((w) => w === ws && void read())
    return () => {
      alive = false
      off()
    }
  }, [ws])
  if (values?.model)
    return (
      <span className="role-line" data-role={role} data-run>
        <ModelLine model={values.model} modelTip={RUN_VALUES_TIP} effort={values.effort || null} efforts={[values.effort || '']} noFast label={label} />
      </span>
    )
  const conf = settings?.models?.[role]
  if (!conf) return null
  const pick = (patch: Partial<ModelConf>) => {
    track('chat-settings', { target: `ui:model-${role}`, detail: { role, ...patch } })
    setSettings((s) => (s ? { ...s, models: { ...s.models, [role]: { ...conf, ...patch } } } : s))
    saveRole(ws, role, patch).catch((e: Error) => bus.emit('toast', { text: `Could not change the model: ${e.message}`, kind: 'error' }))
  }
  return (
    <span className="role-line" data-role={role}>
      <ModelLine
        model={conf.model || null}
        models={modelChoices(settings, conf.model)}
        onModel={(m) => pick({ model: m })}
        effort={conf.effort || null}
        efforts={roleEfforts(role)}
        onEffort={(e) => pick({ effort: e })}
        noFast
        label={label}
      />
    </span>
  )
}
