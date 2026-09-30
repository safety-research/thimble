// The settings' Extensions section: a switch per extension added to thimble, for this workspace, and under it a switch
// per view it gives, saved with the rest. An extension runs in every workspace until its switch turns it off; one that
// cannot run here whatever the switch says (switched off in thimble's config, or unable to load) has its switch
// disabled and says why. A view's switch stands where the check on whether it fits put it until the analyst moves it,
// which overrides the check either way; beside it is the check's reason. Conflicts among the running extensions are
// listed under the rows.
import { Switch } from '../components/Switch'
import type { ExtensionRow, Extensions } from '../lib/types'

/** The key a view's switch has: `<extension>/<view>`. */
export const viewKey = (name: string, slug: string): string => `${name}/${slug}`

/** The workspace switches a save sends: each extension whose switch differs from the loaded one. Pure. */
export function changedExtensions(loaded: ExtensionRow[], now: Record<string, boolean>): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const e of loaded) if (e.name in now && now[e.name] !== e.on) out[e.name] = now[e.name]
  return out
}

/** The view switches a save sends, [extension, view, on] for each whose switch differs from the loaded one. Pure. */
export function changedViews(loaded: ExtensionRow[], now: Record<string, boolean>): [string, string, boolean][] {
  const out: [string, string, boolean][] = []
  for (const e of loaded)
    for (const v of e.views ?? []) {
      const k = viewKey(e.name, v.slug)
      if (k in now && now[k] !== v.on) out.push([e.name, v.slug, now[k]])
    }
  return out
}

interface Props {
  data: Extensions
  on: Record<string, boolean>
  setOn: (name: string, v: boolean) => void
  viewOn: Record<string, boolean>
  setViewOn: (key: string, v: boolean) => void
}

export function ExtensionsSettings({ data, on, setOn, viewOn, setViewOn }: Props) {
  if (!data.extensions.length) return null
  return (
    <div className="settings-switches settings-extensions" role="group" aria-label="Extensions">
      <span className="label settings-extensions-head">extensions</span>
      {data.extensions.map((e) => (
        <div className="settings-extension" key={e.name} data-extension={e.name} data-active={e.active}>
          <div className="settings-switch">
            <Switch checked={!!on[e.name]} disabled={e.locked} onChange={(v) => setOn(e.name, v)} aria-labelledby={`settings-ext-${e.name}`} />
            <span className="settings-switch-text">
              <span className="settings-switch-label" id={`settings-ext-${e.name}`}>
                {e.name}
                {e.version && <span className="settings-extension-version"> {e.version}</span>}
              </span>
              {e.note && <span className="settings-switch-note">{e.note}</span>}
            </span>
          </div>
          {(e.views ?? []).map((v) => {
            const k = viewKey(e.name, v.slug)
            const id = `settings-ext-${e.name}-${v.slug}`
            return (
              <div className="settings-switch settings-extension-view" key={v.slug} data-view={v.slug} data-shown={v.shown}>
                <Switch checked={!!viewOn[k]} disabled={v.locked || !on[e.name]} onChange={(x) => setViewOn(k, x)} aria-labelledby={id} />
                <span className="settings-switch-text">
                  <span className="settings-switch-label" id={id}>
                    {v.name}
                  </span>
                  {v.note && <span className="settings-switch-note">{v.note}</span>}
                </span>
              </div>
            )
          })}
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
