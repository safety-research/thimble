// The settings' Extensions section: a switch per extension added to thimble, for this workspace, with what it gives and
// the settings it runs under, and under it a switch per view it gives, saved with the rest. An extension runs in every
// workspace until its switch turns it off; one that cannot run here whatever the switch says (switched off in
// thimble's config, or unable to load) has its switch disabled, drawn off, and says why. A view's switch stands where
// the check on whether it fits put it until the analyst moves it, which overrides the check either way; beside it is
// the check's reason. An extension with orientation instructions that comes on where an orientation ran asks whether
// to run them now; the answer is sent with the rest on Save. Conflicts among the running extensions are listed under
// the rows. The workspace's own views, which thimble built for it and no other workspace shows, come first under "This
// workspace", which has no switch of its own since it is on here without being added. Each of its views has one.
import { Segmented } from '../components/Button'
import { Switch } from '../components/Switch'
import type { ExtensionRow, Extensions, LocalExtension, LocalViewRow } from '../lib/types'

export const LOCAL_LABEL = 'This workspace'
export const LOCAL_NOTE = 'Views built here. No other workspace shows them.'
export const FILE_VIEWER_NOTE = 'Opens in the File browser'

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

/** The switches of the workspace's own views a save sends, [view, on] for each that differs from the loaded one. Pure. */
export function changedLocalViews(loaded: LocalViewRow[], now: Record<string, boolean>): [string, boolean][] {
  return loaded.filter((v) => v.slug in now && now[v.slug] !== v.on).map((v) => [v.slug, now[v.slug]])
}

/** Whether the row asks to run the extension's orientation instructions now: it is switched on here and either the
 * server offers it, or it gives instructions, an orientation ran here, and this switch was just turned on. Pure. */
export function asksToRun(e: ExtensionRow, on: boolean, orientationRan: boolean): boolean {
  if (!on || e.locked) return false
  return !!e.offer || (!!e.orients && orientationRan && !e.on)
}

/** The answers a save sends, [extension, run] for each row that still asks and was answered. Pure. */
export function answeredRuns(data: Extensions, on: Record<string, boolean>, answers: Record<string, boolean>): [string, boolean][] {
  return data.extensions.filter((e) => e.name in answers && asksToRun(e, !!on[e.name], !!data.orientation_ran)).map((e) => [e.name, answers[e.name]])
}

type RunAnswer = 'run' | 'not' | ''
const RUN_OPTIONS = [
  { value: 'run', label: 'Run now' },
  { value: 'not', label: 'Not now' },
] as const

interface Props {
  data: Extensions
  on: Record<string, boolean>
  setOn: (name: string, v: boolean) => void
  viewOn: Record<string, boolean>
  setViewOn: (key: string, v: boolean) => void
  /** the switches of the workspace's own views, by view */
  localOn: Record<string, boolean>
  setLocalOn: (slug: string, v: boolean) => void
  answers: Record<string, boolean>
  setAnswer: (name: string, run: boolean) => void
}

function LocalRows({ local, on, setOn }: { local: LocalExtension; on: Record<string, boolean>; setOn: (slug: string, v: boolean) => void }) {
  return (
    <div className="settings-extension settings-extension-local" data-extension={local.name} data-local>
      <div className="settings-switch">
        <span aria-hidden />
        <span className="settings-switch-text">
          <span className="settings-switch-label">{LOCAL_LABEL}</span>
          <span className="settings-switch-note">{LOCAL_NOTE}</span>
        </span>
      </div>
      {local.views.map((v) => {
        const id = `settings-local-${v.slug}`
        return (
          <div className="settings-switch settings-extension-view" key={v.slug} data-view={v.slug}>
            <Switch checked={!!on[v.slug]} onChange={(x) => setOn(v.slug, x)} aria-labelledby={id} />
            <span className="settings-switch-text">
              <span className="settings-switch-label" id={id}>
                {v.name}
              </span>
              {v.file_viewer && <span className="settings-switch-note">{FILE_VIEWER_NOTE}</span>}
            </span>
          </div>
        )
      })}
    </div>
  )
}

export function ExtensionsSettings({ data, on, setOn, viewOn, setViewOn, localOn, setLocalOn, answers, setAnswer }: Props) {
  const local = data.local?.views.length ? data.local : null
  if (!data.extensions.length && !local) return null
  return (
    <div className="settings-switches settings-extensions" role="group" aria-label="Extensions">
      <span className="label settings-extensions-head">extensions</span>
      {local && <LocalRows local={local} on={localOn} setOn={setLocalOn} />}
      {data.extensions.map((e) => {
        const asks = asksToRun(e, !!on[e.name], !!data.orientation_ran)
        return (
          <div className="settings-extension" key={e.name} data-extension={e.name} data-active={e.active}>
            <div className="settings-switch">
              <Switch checked={!!on[e.name] && !e.locked} disabled={e.locked} onChange={(v) => setOn(e.name, v)} aria-labelledby={`settings-ext-${e.name}`} />
              <span className="settings-switch-text">
                <span className="settings-switch-label" id={`settings-ext-${e.name}`} title={e.description || undefined}>
                  {e.name}
                  {e.version && <span className="settings-extension-version"> {e.version}</span>}
                </span>
                {!!e.parts?.length && <span className="settings-switch-note settings-extension-parts">{e.parts.join(' · ')}</span>}
                {e.consent && <span className="settings-switch-note settings-extension-consent">{e.consent}</span>}
                {e.note && <span className="settings-switch-note">{e.note}</span>}
              </span>
            </div>
            {asks && (
              <div className="settings-extension-ask">
                <span className="settings-switch-note">Run its orientation now?</span>
                <Segmented<RunAnswer>
                  size="sm"
                  track
                  label={`Run ${e.name}'s orientation now?`}
                  options={RUN_OPTIONS}
                  value={e.name in answers ? (answers[e.name] ? 'run' : 'not') : ''}
                  onChange={(v) => setAnswer(e.name, v === 'run')}
                />
              </div>
            )}
            {(e.views ?? []).map((v) => {
              const k = viewKey(e.name, v.slug)
              const id = `settings-ext-${e.name}-${v.slug}`
              return (
                <div className="settings-switch settings-extension-view" key={v.slug} data-view={v.slug} data-shown={v.shown}>
                  <Switch checked={!!viewOn[k] && !v.locked && !!on[e.name]} disabled={v.locked || !on[e.name]} onChange={(x) => setViewOn(k, x)} aria-labelledby={id} />
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
        )
      })}
      {data.conflicts.map((line) => (
        <p className="settings-modes-warn" role="note" key={line}>
          {line}
        </p>
      ))}
    </div>
  )
}
