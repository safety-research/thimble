// The model line at the foot of a thread's composer whose message goes to one of thimble's agents rather than to main.
// A change to a view goes to the dev role, whose line is the settings popover's row for it, drawn as ModelLine; a pick
// is saved as the settings popover saves it and applies from the role's next run. The line has no bolt.
import { useEffect, useState } from 'react'
import { bus } from '../lib/bus'
import { loadSettings, modelChoices, onSettingsChange, saveRole } from '../lib/models'
import { track } from '../lib/telemetry'
import type { ModelConf, Settings } from '../lib/types'
import { roleEfforts } from '../shell/SettingsPopover'
import { ModelLine } from './ModelLine'

/** The tooltip of a follow-up's model, which the run's own values fix. */

export function RoleChip({ ws, role, label }: {
  ws: string
  /** the role in settings.models: dev */
  role: string
  /** the session the line names, in its controls' accessible names: "the view build" */
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
