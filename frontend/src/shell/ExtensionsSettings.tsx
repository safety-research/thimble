// The settings' Extensions section: a switch per extension added to thimble, for this workspace, saved with the rest.
// An extension that cannot run here whatever the switch says (switched off in thimble's config, or unable to load) has
// its switch disabled; one that is not running says why. Conflicts among the running ones are listed under the rows.
import { Switch } from '../components/Switch'
import type { ExtensionRow, Extensions } from '../lib/types'

/** The workspace switches a save sends: each extension whose switch differs from the loaded one. Pure. */
export function changedExtensions(loaded: ExtensionRow[], now: Record<string, boolean>): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const e of loaded) if (e.name in now && now[e.name] !== e.on) out[e.name] = now[e.name]
  return out
}

export function ExtensionsSettings({ data, on, setOn }: { data: Extensions; on: Record<string, boolean>; setOn: (name: string, v: boolean) => void }) {
  if (!data.extensions.length) return null
  return (
    <div className="settings-switches settings-extensions" role="group" aria-label="Extensions">
      <span className="label settings-extensions-head">extensions</span>
      {data.extensions.map((e) => (
        <div className="settings-switch" key={e.name} data-extension={e.name} data-active={e.active}>
          <Switch checked={!!on[e.name]} disabled={e.locked} onChange={(v) => setOn(e.name, v)} aria-labelledby={`settings-ext-${e.name}`} />
          <span className="settings-switch-text">
            <span className="settings-switch-label" id={`settings-ext-${e.name}`}>
              {e.title}
              {e.version && <span className="settings-extension-version"> {e.version}</span>}
            </span>
            {!e.active && e.why && <span className="settings-switch-note">{e.why}</span>}
          </span>
        </div>
      ))}
      {data.conflicts.map((line) => (
        <p className="settings-modes-warn" role="note" key={line}>
          {line}
        </p>
      ))}
    </div>
  )
}
