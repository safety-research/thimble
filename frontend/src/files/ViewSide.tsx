// The Labels sidebar beside a view, shared by Files (a view picked in its views bar) and a view in a pane of its own
// (ViewSurface): the Labels pane, the label's edit card at the sidebar's edge and the seam that resizes it. Beside a
// view a label's row sets or clears the Files label filter, which the view keeps its records by. A view draws its own
// label controls and thimble draws none in its head, so the sidebar opens beside it when the view's controls open a
// label's editor; beside a view built without label controls it also opens while a label is on or a label marks the
// view's files, with the offer to add them (AddLabelControls). useLabelRuns keeps the runs of the labels' applies,
// polled while they run, and Retry.
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { Button } from '../components/Button'
import { Spinner } from '../components/Spinner'
import { api, labelApi } from '../lib/api'
import { bus } from '../lib/bus'
import { refreshProposals } from '../lib/proposals'
import { track } from '../lib/telemetry'
import type { ConceptRun, LabelDraft } from '../lib/types'
import { readStorage, storageKey, writeStorage } from '../lib/workspace'
import { Resizer } from '../shell/Resizer'
import { LabelCard } from './LabelCard'
import { LabelPrompt } from './LabelPrompt'
import { viewLabels } from './labels'
import { LabelsPane } from './LabelsPane'
import { TREE } from './params'
import { useFilesFilter, type FilesLabels } from './useLabels'
import type { BuiltView } from './ViewsBar'

/** How often a label whose apply runs is read again, until the run ends. */
const RUN_POLL_MS = 1000

export interface LabelRuns {
  /** the runs seen per label: running ones, and the last record of one that ended */
  runs: ReadonlyMap<string, ConceptRun>
  setRun: (id: string, run: ConceptRun | null) => void
  /** apply a label again after a failed run */
  retry: (id: string) => Promise<void>
}

/** The runs of the labels' applies: a run the labels say is running is polled every RUN_POLL_MS until it ends, and its
 * record carries the progress, then the outcome or the failure the label's row shows. */
export function useLabelRuns(ws: string, labels: FilesLabels): LabelRuns {
  const [runs, setRuns] = useState<Map<string, ConceptRun>>(new Map())
  const setRun = useCallback((id: string, run: ConceptRun | null) => {
    setRuns((cur) => {
      const next = new Map(cur)
      if (run) next.set(id, run)
      else next.delete(id)
      return next
    })
  }, [])
  useEffect(() => {
    for (const k of labels.all) {
      if (k.run?.status !== 'running') continue
      const seen = runs.get(k.id)
      if (!seen || (seen.run_id !== k.run.run_id && seen.status !== 'running')) setRun(k.id, k.run)
    }
  }, [labels.all, runs, setRun])
  const polled = useMemo(
    () =>
      [...runs]
        .filter(([, r]) => r.status === 'running')
        .map(([id]) => id)
        .sort()
        .join(' '),
    [runs],
  )
  useEffect(() => {
    if (!polled) return
    const ids = polled.split(' ')
    const t = window.setInterval(() => {
      for (const id of ids)
        labelApi
          .detail(ws, id)
          .then((k) => setRun(id, k.run ?? null))
          .catch(() => undefined)
    }, RUN_POLL_MS)
    return () => window.clearInterval(t)
  }, [polled, ws, setRun])
  // Retry applies the label again over its glob; the run it starts is polled from the record the server answers, and a
  // refusal shows on the row as the failure did
  const retry = useCallback(
    (id: string) => {
      track('label-apply', { target: `concept:${id}`, detail: { retry: true } })
      return labelApi
        .apply(ws, id, {})
        .then((run) => setRun(id, run))
        .catch((e: Error) => setRun(id, { status: 'error', message: e.message, started: new Date().toISOString() }))
    },
    [ws, setRun],
  )
  return useMemo(() => ({ runs, setRun, retry }), [runs, setRun, retry])
}

export interface LabelSideProps {
  ws: string
  labels: FilesLabels
  runs: LabelRuns
  open: boolean
  onToggleOpen: () => void
  /** the label whose edit card is open, 'new' for a new one */
  editing: string | 'new' | null
  onEdit: (id: string | 'new' | null) => void
  /** a new label's card filled from what Label from prompt drafted */
  drafted: LabelDraft | null
  onDraft: (draft: LabelDraft) => void
  /** what a new label applies to */
  appliesTo: string[]
  width: number
  onWidth: (w: number) => void
  onWidthEnd: (w: number) => void
  maxWidth: number
  /** beside a view: hide the sidebar */
  onHide?: () => void
  /** beside a view: the labels that mark its files, listed first */
  first?: ReadonlySet<string>
  /** beside a view: keep only the records that take a label's value (the Files label filter) */
  filterable?: boolean
  /** at the pane's top, under its head (AddLabelControls) */
  note?: ReactNode
}

/** The sidebar's three parts, which the caller places: the Labels pane, the edit card at the sidebar's edge and the
 * seam. */
export function useLabelSide(p: LabelSideProps): { pane: ReactNode; card: ReactNode; resizer: ReactNode } {
  const { ws, labels, runs, editing, onEdit, drafted, onDraft, appliesTo, width } = p
  const editLabel = editing && editing !== 'new' ? labels.byId.get(editing) ?? null : null
  const filter = useFilesFilter(ws)
  const onFilter = useCallback(
    (id: string, value: string | null) => void (value == null ? api.deleteFilter(ws, 'files') : api.putFilter(ws, 'files', id, value)).catch(() => undefined),
    [ws],
  )
  const pane = (
    <LabelsPane
      labels={labels}
      open={p.open}
      onToggleOpen={p.onToggleOpen}
      editing={editing}
      onEdit={onEdit}
      runs={runs.runs}
      onRetry={runs.retry}
      onHide={p.onHide}
      first={p.first}
      onFilter={p.filterable ? onFilter : undefined}
      filter={filter}
      note={p.note}
    />
  )
  // the card stands at the sidebar's edge (--side-w, files.css); the width is set on the card's slot alone, since a
  // custom property on the body would restyle every element in it on each drag move
  const card =
    editing && p.open ? (
      <div className="label-card-slot" style={{ '--side-w': `${width}px` } as CSSProperties}>
        <LabelCard
          ws={ws}
          label={editLabel}
          labels={labels}
          appliesTo={appliesTo}
          draft={drafted}
          onClose={() => onEdit(null)}
          onRun={runs.setRun}
          lead={editing === 'new' ? <LabelPrompt ws={ws} labels={labels} appliesTo={appliesTo} onRun={runs.setRun} onManual={onDraft} onEdit={onEdit} onDone={() => onEdit(null)} /> : undefined}
        />
      </div>
    ) : null
  const resizer = <Resizer side="left" width={width} min={TREE.min} max={Math.max(TREE.min, Math.min(TREE.max, Math.floor(p.maxWidth)))} defaultWidth={TREE.def} onResize={p.onWidth} onEnd={p.onWidthEnd} />
  return { pane, card, resizer }
}

/** The change a view built without label controls is asked for (AddLabelControls), in the analyst's words. */
export const ADD_LABEL_CONTROLS = 'Add label controls to this view: the labels over its files, each with a switch to turn it on or off and its colours.'

/** Beside a view whose page draws no label controls of its own, as views built before they were required: one quiet
 * line that asks the dev agent to add them, as a change to the view, which then builds as any change does. */
export function AddLabelControls({ ws, view }: { ws: string; view: BuiltView }) {
  const [asked, setAsked] = useState(false)
  useEffect(() => setAsked(false), [view.slug])
  const ask = () => {
    setAsked(true)
    track('view-build', { target: `view:${view.slug}`, detail: { change: 'label controls' } })
    api
      .messageView(ws, view.slug, ADD_LABEL_CONTROLS)
      .then(() => refreshProposals(ws))
      .catch((e: Error) => {
        setAsked(false)
        bus.emit('toast', { text: `Could not ask for label controls. ${e.message}`, kind: 'error' })
      })
  }
  // while another change to the view builds, its chip in the views bar says so, and the offer waits
  if (view.updating && !asked) return null
  return (
    <div className="files-labels-note">
      {asked ? (
        <span className="files-labels-note-busy">
          <Spinner />
          Adding label controls to the view
        </span>
      ) : (
        <Button variant="ghost" size="sm" onClick={ask}>
          Add label controls to the view
        </Button>
      )}
    </div>
  )
}

/** A view in a pane of its own with its Labels sidebar: shown when the view's controls open a label's editor, and, for
 * a view built without label controls, while labels are on or a label marks its files, until the analyst hides it; with
 * the Labels pane, the edit card and the seam as Files has them beside a view. */
export function useViewSide(
  ws: string,
  view: BuiltView,
  labels: FilesLabels,
): { side: ReactNode; card: ReactNode; first?: ReadonlySet<string>; editLabel: (id: string | null) => void } {
  const runs = useLabelRuns(ws, labels)
  const [choice, setChoice] = useState<boolean | null>(null)
  const [open, setOpen] = useState(true)
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const [drafted, setDrafted] = useState<LabelDraft | null>(null)
  const widthKey = storageKey(ws, 'sideWidth')
  const [width, setWidth] = useState(() => {
    const w = readStorage<unknown>(widthKey, TREE.def)
    return typeof w === 'number' && Number.isFinite(w) ? Math.min(TREE.max, Math.max(TREE.min, w)) : TREE.def
  })
  const first = useMemo(() => (view.claims ? viewLabels(labels.all, labels.presence, view.claims) : undefined), [view.claims, labels.all, labels.presence])
  const shown = choice ?? (!view.label_controls && (labels.on.length > 0 || !!first?.size))
  const edit = useCallback((id: string | 'new' | null) => {
    setEditing(id)
    setDrafted(null)
  }, [])
  const parts = useLabelSide({
    ws,
    labels,
    runs,
    open,
    onToggleOpen: () => setOpen(!open),
    editing,
    onEdit: edit,
    drafted,
    onDraft: (d) => {
      setEditing('new')
      setDrafted(d)
    },
    appliesTo: view.claims ?? (view.first_file ? [view.first_file] : []),
    width,
    onWidth: setWidth,
    onWidthEnd: (w) => {
      setWidth(Math.round(w))
      writeStorage(widthKey, Math.round(w))
    },
    maxWidth: TREE.max,
    onHide: () => setChoice(false),
    first,
    filterable: true,
    note: view.label_controls || view.builtin ? undefined : <AddLabelControls ws={ws} view={view} />,
  })
  const side = shown ? (
    <>
      <aside className="files-side files-side-labels" style={{ width }}>
        {parts.pane}
      </aside>
      {parts.resizer}
    </>
  ) : null
  const editLabel = useCallback(
    (id: string | null) => {
      setChoice(true)
      setOpen(true)
      edit(id ?? 'new')
    },
    [edit],
  )
  return { side, card: shown ? parts.card : null, first, editLabel }
}
