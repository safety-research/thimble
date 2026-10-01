// The settings' Extensions section, in two groups, each under a heading: the views built for this workspace, which no
// other workspace shows and which are on here without being added, then the extensions added to thimble or shipped with
// it. Every row is the same: its name, one line under it, and its switch in one column at the right. The line says why
// an extension does not run here when that is known, else what it is, and a view's line what it shows, or that it opens
// in the File browser. A line too long for its row is cut, and shows in full when the row opens under its name, as do
// what an extension gives, what it adds with it and the settings it runs under. An extension runs in every workspace
// until its switch turns it off; one that cannot run here whatever the switch says (switched off in thimble's config,
// or unable to load) has its switch disabled and drawn off. One thimble ships that is not added reads as off, and
// turning it on adds it on Save. An extension's views follow it, each with its own switch, which stands where the check
// on whether it fits put it until the analyst moves it, and the check's reason as its line. An extension with
// orientation instructions or an orientation program that comes on where an orientation ran asks whether to run it now;
// the answer is sent with the rest on Save. Conflicts among the running extensions are listed under the rows.
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Segmented } from '../components/Button'
import { Icon } from '../components/Icon'
import { Switch } from '../components/Switch'
import type { ExtensionRow, Extensions, LocalExtension, LocalViewRow } from '../lib/types'

export const LOCAL_LABEL = "This workspace's views"
export const EXTENSIONS_LABEL = 'Extensions'
export const FILE_VIEWER_NOTE = 'Opens in the File browser'

/** The key a view's switch has: `<extension>/<view>`. */
export const viewKey = (name: string, slug: string): string => `${name}/${slug}`

/** The workspace switches a save sends: each extension whose switch differs from the loaded one. Pure. */
export function changedExtensions(loaded: ExtensionRow[], now: Record<string, boolean>): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const e of loaded) if (e.name in now && now[e.name] !== e.on) out[e.name] = now[e.name]
  return out
}

/** What a save does for each extension whose switch moved: adds one thimble ships that is not added and was turned on,
 * and switches any other for this workspace. Pure. */
export function extensionCalls(loaded: ExtensionRow[], now: Record<string, boolean>): [string, 'add' | 'on' | 'off'][] {
  const addable = new Set(loaded.filter((e) => e.addable).map((e) => e.name))
  return Object.entries(changedExtensions(loaded, now)).flatMap(([name, on]): [string, 'add' | 'on' | 'off'][] =>
    addable.has(name) ? (on ? [[name, 'add']] : []) : [[name, on ? 'on' : 'off']],
  )
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

/** Whether the row asks to run the extension's orientation now: it is switched on here and either the server offers
 * it, or Run now can run it here, an orientation ran here, and this switch was just turned on. Pure. */
export function asksToRun(e: ExtensionRow, on: boolean, orientationRan: boolean): boolean {
  if (!on || e.locked) return false
  return !!e.offer || (!!e.orients && orientationRan && !e.on)
}

/** The answers a save sends, [extension, run] for each row that still asks and was answered. Pure. */
export function answeredRuns(data: Extensions, on: Record<string, boolean>, answers: Record<string, boolean>): [string, boolean][] {
  return data.extensions.filter((e) => e.name in answers && asksToRun(e, !!on[e.name], !!data.orientation_ran)).map((e) => [e.name, answers[e.name]])
}

/** The line under an extension's name: why it does not run here, else its description, else what it gives. One
 * thimble ships that is not added has no why, since its switch off says it. Pure. */
export function extensionLine(e: ExtensionRow): string {
  const why = e.addable ? '' : e.note
  return why || e.description || (e.parts ?? []).join(' · ')
}

/** A fact that opens under a name: [what it is about, the words], the first '' for a description. */
export type Detail = [string, string]

/** What opens under an extension's name: its description when its line says something else, what it gives, the
 * extensions turning it on adds with it, the settings its agents run under, and whether its code runs in a sandbox.
 * Pure. */
export function extensionDetails(e: ExtensionRow): Detail[] {
  const line = extensionLine(e)
  const gives = (e.parts ?? []).join(' · ')
  const needs = e.addable && e.needs?.length ? `${e.needs.join(', ')}, added with it` : ''
  const code = e.sandboxed == null ? '' : e.sandboxed ? 'Runs in a sandbox' : 'Runs without a sandbox'
  const out: Detail[] = [
    ['', e.description && e.description !== line ? e.description : ''],
    ['Gives', gives !== line ? gives : ''],
    ['Needs', needs],
    ['Agents', e.consent ?? ''],
    ['Code', code],
  ]
  return out.filter(([, words]) => words)
}

/** The line under a view built here: that it opens in the File browser for a file viewer, else what it shows. Pure. */
export const localViewLine = (v: LocalViewRow): string => (v.file_viewer ? FILE_VIEWER_NOTE : (v.description ?? ''))

/** What opens under a view built here: a file viewer's description, which its line leaves out. Pure. */
export const localViewDetails = (v: LocalViewRow): Detail[] => (v.file_viewer && v.description ? [['', v.description]] : [])

/** The version beside an extension's name: only for one thimble does not ship, since a shipped one has thimble's. Pure. */
export const extensionVersion = (e: ExtensionRow): string => (e.builtin ? '' : e.version)

type RunAnswer = 'run' | 'not' | ''
const RUN_OPTIONS = [
  { value: 'run', label: 'Run now' },
  { value: 'not', label: 'Not now' },
] as const

type RowKind = 'local-view' | 'extension' | 'extension-view'

interface RowProps {
  row: string
  kind: RowKind
  labelId: string
  name: string
  version?: string
  line?: string
  /** the line is a reason, shown in full rather than cut to one line */
  wrap?: boolean
  details?: Detail[]
  control: ReactNode
  children?: ReactNode
}

/** One row: the name, the switch at the right of the name, the line under it, cut to one line unless it is a reason,
 * and `children` under all that. When there are `details`, or the line is cut, a caret after the name opens the row:
 * the line in full, then the details. */
function SwitchRow({ row, kind, labelId, name, version, line, wrap, details = [], control, children }: RowProps) {
  const [open, setOpen] = useState(false)
  const [cut, setCut] = useState(false)
  const [nameCut, setNameCut] = useState(false)
  const lineRef = useRef<HTMLSpanElement>(null)
  const nameRef = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const el = nameRef.current
    if (el) setNameCut(el.scrollWidth > el.clientWidth + 1)
  }, [name, version])
  useLayoutEffect(() => {
    const el = lineRef.current
    if (!el || wrap || open) return
    const measure = () => setCut(el.scrollWidth > el.clientWidth + 1)
    measure()
    let live = true
    document.fonts?.ready.then(() => live && measure())
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    ro?.observe(el)
    return () => {
      live = false
      ro?.disconnect()
    }
  }, [line, wrap, open])
  const expandable = details.length > 0 || (cut && !!line && !wrap)
  const lineId = `${labelId}-line`
  const moreId = `${labelId}-more`
  const label = (
    <>
      <span ref={nameRef} className="settings-ext-label" id={labelId} title={nameCut ? name : undefined}>
        {name}
      </span>
      {version && <span className="settings-ext-version">{version}</span>}
    </>
  )
  return (
    <div className={`settings-ext-row settings-ext-row-${kind}`} data-row={row} data-kind={kind}>
      {expandable ? (
        <button type="button" className={`settings-ext-name${open ? ' open' : ''}`} aria-expanded={open} aria-controls={[line ? lineId : '', details.length ? moreId : ''].join(' ').trim()} onClick={() => setOpen((o) => !o)}>
          {label}
          <Icon name="chevron-down" size={12} className="settings-ext-caret" />
        </button>
      ) : (
        <span className="settings-ext-name">{label}</span>
      )}
      <span className="settings-ext-switch">{control}</span>
      {line && (
        <span ref={lineRef} id={lineId} className={`settings-ext-line${open ? ' open' : ''}${wrap ? ' wrap' : ''}`} title={cut && !open && !wrap ? line : undefined}>
          {line}
        </span>
      )}
      {open && details.length > 0 && (
        <div className="settings-ext-more" id={moreId}>
          {details
            .filter(([key]) => !key)
            .map(([, words]) => (
              <p key={words}>{words}</p>
            ))}
          {details.some(([key]) => key) && (
            <dl className="settings-ext-facts">
              {details
                .filter(([key]) => key)
                .map(([key, words]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>{words}</dd>
                  </div>
                ))}
            </dl>
          )}
        </div>
      )}
      {children}
    </div>
  )
}

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

function LocalGroup({ local, on, setOn }: { local: LocalExtension; on: Record<string, boolean>; setOn: (slug: string, v: boolean) => void }) {
  return (
    <section className="settings-ext-group" data-local data-name={local.name} aria-labelledby="settings-ext-local-head">
      <h3 className="label settings-ext-head" id="settings-ext-local-head">
        {LOCAL_LABEL}
      </h3>
      {local.views.map((v) => {
        const id = `settings-local-${v.slug}`
        return (
          <SwitchRow
            key={v.slug}
            row={`local:${v.slug}`}
            kind="local-view"
            labelId={id}
            name={v.name}
            line={localViewLine(v)}
            details={localViewDetails(v)}
            control={<Switch checked={!!on[v.slug]} onChange={(x) => setOn(v.slug, x)} aria-labelledby={id} />}
          />
        )
      })}
    </section>
  )
}

export function ExtensionsSettings({ data, on, setOn, viewOn, setViewOn, localOn, setLocalOn, answers, setAnswer }: Props) {
  const local = data.local?.views.length ? data.local : null
  if (!data.extensions.length && !local) return null
  return (
    <div className="settings-switches settings-extensions" role="group" aria-label="Extensions">
      {local && <LocalGroup local={local} on={localOn} setOn={setLocalOn} />}
      {!!data.extensions.length && (
        <section className="settings-ext-group" aria-labelledby="settings-ext-head">
          <h3 className="label settings-ext-head" id="settings-ext-head">
            {EXTENSIONS_LABEL}
          </h3>
          {data.extensions.map((e) => {
            const asks = asksToRun(e, !!on[e.name], !!data.orientation_ran)
            const id = `settings-ext-${e.name}`
            return (
              <div className="settings-ext" key={e.name} data-extension={e.name} data-active={e.active}>
                <SwitchRow
                  row={`ext:${e.name}`}
                  kind="extension"
                  labelId={id}
                  name={e.name}
                  version={extensionVersion(e)}
                  line={extensionLine(e)}
                  wrap={!e.addable && !!e.note}
                  details={extensionDetails(e)}
                  control={<Switch checked={!!on[e.name] && !e.locked} disabled={e.locked} onChange={(v) => setOn(e.name, v)} aria-labelledby={id} />}
                >
                  {asks && (
                    <div className="settings-ext-ask">
                      <span>Run its orientation now?</span>
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
                </SwitchRow>
                {(e.views ?? []).map((v) => {
                  const k = viewKey(e.name, v.slug)
                  const vid = `settings-ext-${e.name}-${v.slug}`
                  return (
                    <SwitchRow
                      key={v.slug}
                      row={`ext:${k}`}
                      kind="extension-view"
                      labelId={vid}
                      name={v.name}
                      line={v.note || undefined}
                      wrap
                      control={<Switch checked={!!viewOn[k] && !v.locked && !!on[e.name]} disabled={v.locked || !on[e.name]} onChange={(x) => setViewOn(k, x)} aria-labelledby={vid} />}
                    />
                  )
                })}
              </div>
            )
          })}
        </section>
      )}
      {data.conflicts.map((line) => (
        <p className="settings-modes-warn" role="note" key={line}>
          {line}
        </p>
      ))}
    </div>
  )
}
