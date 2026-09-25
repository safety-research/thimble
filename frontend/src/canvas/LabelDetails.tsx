// A label card's details, as a drawer inside the card frame: DEFINITION (name and description, edited in place),
// COMPUTED (kind, model, pattern or code), APPLIED TO (scope, units covered, globs, and the files not included),
// CLASSES for a label over files (colour and highlight per value), EXAMPLES (rows per value with verdict buttons) and,
// for a prompt label, CALIBRATE (re-apply with the verdicts as few-shot examples).
import { useContext, useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react'
import { Button, Segmented } from '../components/Button'
import { Card } from '../components/Card'
import { Chip } from '../components/Chip'
import { TextArea } from '../components/Field'
import { Menu } from '../components/Menu'
import { RefChip } from '../components/RefChip'
import { Spinner } from '../components/Spinner'
import { Switch } from '../components/Switch'
import { TipButton } from '../components/Tooltip'
import { classesOf, colourVar, globPatterns, isFilesLabel, marksWord, nextColour } from '../files/labels'
import { labelApi } from '../lib/api'
import { bus } from '../lib/bus'
import { loadSettings, modelLabel } from '../lib/models'
import { track } from '../lib/telemetry'
import type { ConceptCoverage, ConceptDetail, LabelClass, LabelRowText } from '../lib/types'
import { CanvasContext } from './context'
import { EXAMPLES_PAGE, effectiveValue, exampleCount, groupCoverage, labelValues, otherValues, pickValue, reapplyPaths, scopeWord, unitTotal } from './details'
import { cutExcerpt, excerptOf } from './excerpts'

const fail = (e: unknown) => bus.emit('toast', { text: (e as Error)?.message || String(e), kind: 'error' })
const EXCERPT_MAX = 360

export interface LabelDetailsProps {
  concept: ConceptDetail
  /** re-read the concept (after a verdict or an apply) */
  reload: () => Promise<void>
  /** the concept a route answered, taken as the card's at once */
  set: (k: ConceptDetail) => void
}

export function LabelDetails({ concept, reload, set }: LabelDetailsProps) {
  const { ws } = useContext(CanvasContext)
  const values = useMemo(() => labelValues(concept.labels, concept.counts), [concept.labels, concept.counts])
  const last = concept.applications?.length ? concept.applications[concept.applications.length - 1] : concept.last_run ?? null
  return (
    <div className="canvas-card-details canvas-label-details" role="region" aria-label="Label details">
      <Definition concept={concept} set={set} />
      <Computed concept={concept} ws={ws} />
      <AppliedTo concept={concept} paths={last?.paths ?? []} />
      {isFilesLabel(concept) && <Classes concept={concept} set={set} />}
      <Examples concept={concept} values={values} reload={reload} />
      {concept.kind === 'prompt' && <Calibrate concept={concept} paths={reapplyPaths(last)} reload={reload} />}
    </div>
  )
}

/** DEFINITION: the label's name, then the description as prose; a click turns it into a field, saved on blur or Enter
 * (Escape drops the edit). */
function Definition({ concept, set }: { concept: ConceptDetail; set: (k: ConceptDetail) => void }) {
  const { ws } = useContext(CanvasContext)
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(concept.description ?? '')
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (!editing) setText(concept.description ?? '')
  }, [concept.description, editing])
  const start = (e: MouseEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest('a, button, .chip')) return
    setEditing(true)
  }
  const save = async () => {
    const next = text.trim()
    setEditing(false)
    if (next === (concept.description ?? '').trim()) return
    setSaving(true)
    track('cell-edit', { target: `concept:${concept.id}`, detail: { field: 'description' } })
    try {
      set(await labelApi.update(ws, concept.id, { description: next }))
    } catch (e) {
      fail(e)
    } finally {
      setSaving(false)
    }
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      setEditing(false)
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void save()
    }
  }
  return (
    <section className="canvas-details-section">
      <span className="label">definition</span>
      <span className="canvas-label-name">{concept.name}</span>
      {editing ? (
        <TextArea bare block autoGrow autoFocus rows={2} maxHeight={240} className="canvas-label-def-editor" value={text} onChange={setText} onKeyDown={onKey} onBlur={() => void save()} aria-label="Definition" />
      ) : (
        <div className="canvas-label-def" onClick={start}>
          {concept.description ? <span className="canvas-label-def-text">{concept.description}</span> : null}
          {saving ? <Spinner size={10} label="saving" /> : <Button variant="icon" size="sm" icon="edit" title="Edit" aria-label="Edit the definition" onClick={() => setEditing(true)} />}
        </div>
      )}
    </section>
  )
}

/** COMPUTED: the kind as a chip, the model when a prompt judges, and the pattern, code or prompt spec in a mono block. */
function Computed({ concept, ws }: { concept: ConceptDetail; ws: string }) {
  const [model, setModel] = useState<string>('')
  useEffect(() => {
    if (concept.kind !== 'prompt' || concept.model) return
    let alive = true
    loadSettings(ws)
      .then((s) => alive && setModel(String(s.models?.labels?.model ?? '')))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [ws, concept.kind, concept.model])
  const shownModel = concept.model || model
  const spec = (concept.spec ?? '').trim()
  return (
    <section className="canvas-details-section">
      <span className="label">computed</span>
      <div className="canvas-details-run">
        <Chip kind="status" tone="neutral">
          {concept.kind}
        </Chip>
        {concept.kind === 'prompt' && shownModel ? <Chip kind="value">{modelLabel(shownModel)}</Chip> : null}
        {typeof concept.version === 'number' && concept.version > 1 ? <Chip kind="value">v{concept.version}</Chip> : null}
      </div>
      {spec ? <pre className={concept.kind === 'code' ? 'canvas-details-shell canvas-label-spec canvas-label-code' : 'canvas-details-shell canvas-label-spec'}>{spec}</pre> : null}
    </section>
  )
}

/** APPLIED TO: the scope, the units covered, what a label over files marks and its glob (else the last run's path
 * globs); under NOT INCLUDED the corpus files with no rows. */
function AppliedTo({ concept, paths }: { concept: ConceptDetail; paths: string[] }) {
  const { ws } = useContext(CanvasContext)
  const [cov, setCov] = useState<ConceptCoverage | null>(null)
  const stamp = `${concept.n_labeled ?? 0}:${concept.run?.status ?? ''}:${concept.version ?? 0}`
  useEffect(() => {
    let alive = true
    labelApi
      .coverage(ws, concept.id)
      .then((c) => alive && setCov(c))
      .catch(() => alive && setCov(null))
    return () => {
      alive = false
    }
  }, [ws, concept.id, stamp])
  const groups = useMemo(() => groupCoverage(cov), [cov])
  const fileUnit = isFilesLabel(concept)
  const globs = fileUnit ? globPatterns(concept.glob) : []
  return (
    <section className="canvas-details-section">
      <span className="label">applied to</span>
      <div className="canvas-details-run">
        <Chip kind="value">{scopeWord(concept.unit)}</Chip>
        <Chip kind="value">{unitTotal(concept.n_labeled, concept.unit)}</Chip>
        {fileUnit && cov ? <Chip kind="value">{`${groups.covered.length.toLocaleString()} of ${groups.total.toLocaleString()} files`}</Chip> : null}
        {fileUnit ? <Chip kind="value">{marksWord(concept)}</Chip> : null}
        {(globs.length ? globs : paths).map((p) => (
          <Chip key={p} kind="ref" icon="file">
            {p}
          </Chip>
        ))}
      </div>
      {fileUnit && groups.notCovered.length > 0 ? (
        <>
          <span className="label canvas-label-sublabel">not included</span>
          <ul className="canvas-label-files">
            {groups.notCovered.map((p) => (
              <li key={p} className="canvas-label-file">
                {p}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  )
}

/** CLASSES (a label over files): each value's colour and whether the Files reader highlights it. A click on the square
 * steps the colour through the palette; both are saved at once (PUT /concepts/{id} {classes}). */
function Classes({ concept, set }: { concept: ConceptDetail; set: (k: ConceptDetail) => void }) {
  const { ws } = useContext(CanvasContext)
  const [saving, setSaving] = useState(false)
  const classes = classesOf(concept)
  const save = async (next: LabelClass[]) => {
    if (saving) return
    set({ ...concept, classes: next })
    setSaving(true)
    track('label-edit', { target: `concept:${concept.id}`, detail: { field: 'classes', via: 'canvas' } })
    try {
      set(await labelApi.update(ws, concept.id, { classes: next }))
    } catch (e) {
      set(concept)
      fail(e)
    } finally {
      setSaving(false)
    }
  }
  const change = (i: number, patch: Partial<LabelClass>) => void save(classes.map((c, j) => (j === i ? { ...c, ...patch } : c)))
  return (
    <section className="canvas-details-section">
      <span className="label">classes</span>
      <div className="canvas-label-classes">
        {classes.map((c, i) => (
          <div key={c.name} className="canvas-label-class">
            <TipButton tip="Change colour" className="canvas-label-colour" style={{ '--c': colourVar(c.color) } as CSSProperties} aria-label={`Change the colour of ${c.name}`} disabled={saving} onClick={() => change(i, { color: nextColour(c.color, classes.filter((_, j) => j !== i).map((x) => x.color)) })} />
            <span className="canvas-label-classname">{c.name}</span>
            <span className="canvas-label-classcount">{(concept.counts?.[c.name] ?? 0).toLocaleString()}</span>
            <Switch checked={c.highlight} onChange={(v) => change(i, { highlight: v })} label={`Highlight ${c.name}`} disabled={saving} />
          </div>
        ))}
      </div>
    </section>
  )
}

interface ExampleState {
  rows: LabelRowText[]
  total: number
  loading: boolean
}

/** EXAMPLES: a Segmented of the values, then pages of rows for the chosen value, each with its excerpt and verdict buttons. */
function Examples({ concept, values, reload }: { concept: ConceptDetail; values: string[]; reload: () => Promise<void> }) {
  const { ws } = useContext(CanvasContext)
  const [chosen, setChosen] = useState<string | null>(null)
  const value = pickValue(values, concept.counts, chosen)
  const [state, setState] = useState<ExampleState>({ rows: [], total: 0, loading: false })
  const [texts, setTexts] = useState<Record<string, string>>({})
  const [pending, setPending] = useState<string | null>(null)
  // a new value, or a run that changed the rows: the first page again
  const stamp = `${value ?? ''}:${concept.n_labeled ?? 0}:${concept.run?.status === 'running' ? 'run' : ''}`
  useEffect(() => {
    if (!value) {
      setState({ rows: [], total: 0, loading: false })
      return
    }
    let alive = true
    setState({ rows: [], total: 0, loading: true })
    labelApi
      .rows(ws, concept.id, { value, limit: EXAMPLES_PAGE, offset: 0 })
      .then((r) => alive && setState({ rows: r.rows, total: r.total, loading: false }))
      .catch((e) => {
        if (alive) {
          setState({ rows: [], total: 0, loading: false })
          fail(e)
        }
      })
    return () => {
      alive = false
    }
  }, [ws, concept.id, stamp])
  // a row's own text stands; a record row without one reads its excerpt through the ref route
  useEffect(() => {
    let alive = true
    for (const r of state.rows) {
      if (texts[r.ref] !== undefined) continue
      if (typeof r.text === 'string' && r.text.trim()) {
        setTexts((cur) => (cur[r.ref] === r.text ? cur : { ...cur, [r.ref]: r.text as string }))
        continue
      }
      if (concept.unit === 'cell' || concept.unit === 'span') {
        setTexts((cur) => ({ ...cur, [r.ref]: '' }))
        continue
      }
      void excerptOf(ws, r.ref).then((t) => alive && setTexts((cur) => (cur[r.ref] === t ? cur : { ...cur, [r.ref]: t })))
    }
    return () => {
      alive = false
    }
  }, [ws, state.rows])
  const more = async () => {
    if (!value || state.loading) return
    setState((s) => ({ ...s, loading: true }))
    try {
      const r = await labelApi.rows(ws, concept.id, { value, limit: EXAMPLES_PAGE, offset: state.rows.length })
      setState((s) => ({ rows: [...s.rows, ...r.rows.filter((x) => !s.rows.some((y) => y.ref === x.ref))], total: r.total, loading: false }))
    } catch (e) {
      setState((s) => ({ ...s, loading: false }))
      fail(e)
    }
  }
  const verdict = async (row: LabelRowText, label: string) => {
    if (pending) return
    setPending(row.ref)
    try {
      await labelApi.verdict(ws, concept.id, row.ref, label)
      setState((s) => ({ ...s, rows: s.rows.map((r) => (r.ref === row.ref ? { ...r, analyst: label } : r)) }))
      void reload()
    } catch (e) {
      fail(e)
    } finally {
      setPending(null)
    }
  }
  if (!values.length) return null
  return (
    <section className="canvas-details-section">
      <span className="label">examples</span>
      <Segmented label="Value" value={value ?? ''} onChange={(v) => setChosen(v)} options={values.map((v) => ({ value: v, label: v }))} />
      {state.rows.length > 0 ? (
        <div className="canvas-label-rows">
          {state.rows.map((row) => {
            const eff = effectiveValue(row)
            const t = texts[row.ref]
            const busy = pending === row.ref
            return (
              <Card key={row.ref} flat className="canvas-label-row" data-ref={row.ref}>
                <div className="canvas-label-rowhead">
                  <RefChip ref={row.ref} workspace={ws} />
                  {row.analyst ? (
                    <Chip kind="status" tone={row.analyst === row.label ? 'positive' : 'warning'} icon="check">
                      {row.analyst}
                    </Chip>
                  ) : null}
                  <span className="card-foot-spacer" />
                  {busy ? <Spinner size={10} label="saving" /> : null}
                  <Button variant="icon" size="sm" icon="check" title="Agree" aria-label="Agree" disabled={busy || !eff} onClick={() => eff && void verdict(row, eff)} />
                  {/* the menu's sheet is portaled; its pointerdown bubbles through React to the canvas root, which would start a pan */}
                  <span className="canvas-label-menu" onPointerDown={(e) => e.stopPropagation()}>
                    <Menu
                      label="Disagree"
                      align="end"
                      trigger={<Button variant="icon" size="sm" icon="x" title="Disagree" aria-label="Disagree" disabled={busy || otherValues(values, eff).length === 0} />}
                      items={otherValues(values, eff).map((v) => ({ id: v, label: v, onSelect: () => void verdict(row, v) }))}
                    />
                  </span>
                </div>
                {t ? <div className="canvas-example-text">{cutExcerpt(t, EXCERPT_MAX)}</div> : t === undefined ? <Spinner size={10} label="loading" /> : null}
                {row.rationale ? <div className="canvas-label-rationale">{row.rationale}</div> : null}
              </Card>
            )
          })}
        </div>
      ) : state.loading ? (
        <div className="canvas-details-wait">
          <Spinner size={10} label="loading" />
        </div>
      ) : null}
      {state.rows.length > 0 && state.rows.length < state.total ? (
        <div className="canvas-details-actions">
          <Button size="sm" icon="plus" busy={state.loading} onClick={() => void more()}>
            {`${Math.min(EXAMPLES_PAGE, state.total - state.rows.length)} more`}
          </Button>
          <Chip kind="value">{`${state.rows.length.toLocaleString()} of ${state.total.toLocaleString()}`}</Chip>
        </div>
      ) : null}
    </section>
  )
}

/** CALIBRATE (prompt kind): re-apply the label with the analyst's verdicts as few-shot examples, with progress beside it. */
function Calibrate({ concept, paths, reload }: { concept: ConceptDetail; paths: string[]; reload: () => Promise<void> }) {
  const { ws } = useContext(CanvasContext)
  const [starting, setStarting] = useState(false)
  const n = exampleCount(concept.n_reviewed ?? concept.calibration?.n)
  const run = concept.run ?? null
  const running = run?.status === 'running'
  const last = concept.applications?.length ? concept.applications[concept.applications.length - 1] : null
  const apply = async () => {
    if (starting || running || n === 0) return
    setStarting(true)
    try {
      await labelApi.apply(ws, concept.id, { paths, examples: true, comment: true })
      await reload()
    } catch (e) {
      fail(e)
    } finally {
      setStarting(false)
    }
  }
  return (
    <section className="canvas-details-section">
      <span className="label">calibrate</span>
      <div className="canvas-details-actions">
        <Button size="sm" icon="run" busy={starting || running} disabled={n === 0 || running} onClick={() => void apply()}>
          {`apply with ${n} ${n === 1 ? 'example' : 'examples'}`}
        </Button>
        {running ? (
          <Chip kind="status" tone="accent">
            {typeof run?.total === 'number' ? `${(run.done ?? 0).toLocaleString()} of ${run.total.toLocaleString()}` : (run?.done ?? 0).toLocaleString()}
          </Chip>
        ) : run?.status === 'error' ? (
          <Chip kind="status" tone="negative">
            failed
          </Chip>
        ) : last?.examples ? (
          <Chip kind="value" icon="check">{`${last.examples} ${last.examples === 1 ? 'example' : 'examples'}`}</Chip>
        ) : null}
        {typeof concept.est_precision === 'number' ? <Chip kind="value">{`${Math.round(concept.est_precision * 100)}% agreed`}</Chip> : null}
      </div>
    </section>
  )
}
