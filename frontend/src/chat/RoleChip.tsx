// The model line at the foot of a thread's composer whose message goes to a session thimble starts rather than to main
// (the orientation's role, or the dev role for a view build). It is the settings popover's row for that role, drawn as
// ModelLine; a pick is saved as the settings popover saves it and applies from the role's next run.
import { useEffect, useState } from 'react'
import { bus } from '../lib/bus'
import { hasFastMode, loadSettings, modelChoices, onSettingsChange, saveRole } from '../lib/models'
import { track } from '../lib/telemetry'
import type { ModelConf, Settings } from '../lib/types'
import { roleEfforts } from '../shell/SettingsPopover'
import { ModelLine } from './ModelLine'

export function RoleChip({ ws, role, label }: {
  ws: string
  /** the role in settings.models: orient, dev */
  role: string
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
        onModel={(m) => pick({ model: m, fast: conf.fast && hasFastMode(m) })}
        effort={conf.effort}
        efforts={roleEfforts(role)}
        onEffort={(e) => pick({ effort: e })}
        fast={!!conf.fast}
        onFast={(on) => pick({ fast: on })}
        label={label}
      />
    </span>
  )
}
