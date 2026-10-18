// The Labels sidebar beside a view, shared by Files (a view picked in its views bar) and a view in a pane of its own
// (ViewSurface): the Labels pane, the label editor at the sidebar's edge (LabelEditor) and the seam that resizes it.
// Beside a view a label's row sets or clears the Files label filter, which the view keeps its records by. A view draws
// its own label controls and thimble draws none in its head; they open the label editor in a popover over the view
// (ViewPane), never this sidebar, which opens beside a view built without label controls while a label is on or a label
// marks the view's files, with the offer to add them (AddLabelControls). useLabelRuns keeps the runs of the labels'
// applies, polled while they run, Retry and Stop run, and brings the row of a run the analyst starts into view.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Button } from '../components/Button'
import { Spinner } from '../components/Spinner'
import { api, isNotFound, labelApi } from '../lib/api'
import { bus } from '../lib/bus'
import { demoStop } from '../lib/demo'
import { refreshProposals } from '../lib/proposals'
import { track } from '../lib/telemetry'
import type { ConceptRun, LabelDraft } from '../lib/types'
import { readStorage, storageKey, writeStorage } from '../lib/workspace'
import { Resizer } from '../shell/Resizer'
import { LabelEditor } from './LabelEditor'
import { viewLabels } from './labels'
import { LabelsPane } from './LabelsPane'
import { TREE } from './params'
import { stopLabelRun, useFilesFilter, type FilesLabels } from './useLabels'
import type { BuiltView } from './ViewsBar'

/** How often a label whose apply runs is read again, until the run ends. */
const RUN_POLL_MS = 1000

export interface LabelRuns {
  /** the runs seen per label: running ones, and the last record of one that ended */
  runs: ReadonlyMap<string, ConceptRun>
  setRun: (id: string, run: ConceptRun | null) => void
  /** apply a label again after a failed run */
  retry: (id: string, resume?: boolean) => Promise<void>
  /** a run the analyst started here (an edit card's Run or Re-run): followed as setRun follows a run, and its label's
   * row brought into view in the Labels pane (bug hunt G12: a new label ran at the bottom of a scrolled list) */
  start: (id: string, run: ConceptRun) => void
  /** the label whose row the Labels pane brings into view once it lists it, null once it has (`revealed`) */
  reveal: string | null
  revealed: () => void
  /** stop a label's run: it ends after the batch it is on, and the poll then reads its end */
  stop: (id: string) => Promise<void>
}

/** The runs of the labels' applies: a run the labels say is running is polled every RUN_POLL_MS until it ends, and its
 * record carries the progress, then the outcome or the failure the label's row shows. A label deleted, or one the
 * server no longer has, is no longer followed. */
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
  // the runs no longer followed, by label, with the run's id: a deleted label's, or one the server no longer has, which
  // a read of the labels from before the delete would otherwise bring back
  const dropped = useRef(new Map<string, string | null | undefined>())
  const latest = useRef(runs)
  latest.current = runs
  const drop = useCallback(
    (id: string) => {
      dropped.current.set(id, latest.current.get(id)?.run_id)
      setRun(id, null)
    },
    [setRun],
  )
  useEffect(() => {
    for (const k of labels.all) {
      if (k.run?.status !== 'running') continue
      if (dropped.current.has(k.id) && dropped.current.get(k.id) === k.run.run_id) continue
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
          // a label the server no longer has is no longer read; any other failure is read again next time
          .catch((e) => isNotFound(e) && drop(id))
    }, RUN_POLL_MS)
    return () => window.clearInterval(t)
  }, [polled, ws, setRun, drop])
  // a label deleted (here, by main, or in another window) is no longer followed (bug hunt G13: a label deleted while it
  // ran was read once a second until a reload, 315 times, each a 404)
  useEffect(() => bus.on('concepts', (e) => void (e.what === 'deleted' && drop(e.concept))), [drop])
  // Retry applies the label again over its glob; the run it starts is polled from the record the server answers, and a
  // refusal shows on the row as the failure did
  const retry = useCallback(
    (id: string, resume?: boolean) => {
      track('label-apply', { target: `concept:${id}`, detail: { retry: true, ...(resume ? { resume: true } : {}) } })
      return labelApi
        .apply(ws, id, resume ? { resume: true } : {})
        .then((run) => setRun(id, run))
        .catch((e: Error) => setRun(id, { status: 'error', message: e.message, started: new Date().toISOString() }))
    },
    [ws, setRun],
  )
  const [reveal, setReveal] = useState<string | null>(null)
  const start = useCallback(
    (id: string, run: ConceptRun) => {
      setRun(id, run)
      setReveal(id)
    },
    [setRun],
  )
  const revealed = useCallback(() => setReveal(null), [])
  const names = useRef(labels.byId)
  names.current = labels.byId
  const stop = useCallback((id: string) => stopLabelRun(ws, id, names.current.get(id)?.name ?? 'the label'), [ws])
  return useMemo(() => ({ runs, setRun, retry, start, reveal, revealed, stop }), [runs, setRun, retry, start, reveal, revealed, stop])
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

/** The sidebar's three parts, which the caller places: the Labels pane, the label editor at the sidebar's edge and the
 * seam. */
export function useLabelSide(p: LabelSideProps): { pane: ReactNode; card: ReactNode; resizer: ReactNode } {
  const { ws, labels, runs, editing, onEdit, drafted, onDraft, appliesTo, width } = p
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
      onStop={runs.stop}
      reveal={runs.reveal}
      onRevealed={runs.revealed}
      onHide={p.onHide}
      first={p.first}
      onFilter={p.filterable ? onFilter : undefined}
      filter={filter}
      note={p.note}
    />
  )
  // the card stands at the sidebar's edge (--side-w, files.css); the width is set on the card's slot alone, since a
  // custom property on the body would restyle every element in it on each drag move
  // a label deleted while its card is open (by main, or in another window) takes its card with it, rather than leaving
  // a new label's card in its place
  const card =
    editing && p.open && (editing === 'new' || labels.byId.has(editing)) ? (
      <div className="label-card-slot" style={{ '--side-w': `${width}px` } as CSSProperties}>
        <LabelEditor ws={ws} labels={labels} editing={editing} drafted={drafted} appliesTo={appliesTo} onEdit={onEdit} onDraft={onDraft} onRun={runs.start} run={editing === 'new' ? null : runs.runs.get(editing)} />
      </div>
    ) : null
  const resizer = <Resizer side="left" width={width} min={TREE.min} max={Math.max(TREE.min, Math.min(TREE.max, Math.floor(p.maxWidth)))} defaultWidth={TREE.def} onResize={p.onWidth} onEnd={p.onWidthEnd} />
  return { pane, card, resizer }
}

/** The change a view built without label controls is asked for (AddLabelControls), in the analyst's words. */
export const ADD_LABEL_CONTROLS = 'Add label controls to this view: the labels over its files, each with a switch to turn it on or off and its colors.'

/** Beside a view whose page draws no label controls of its own, as views built before they were required: one quiet
 * line that asks the dev agent to add them, as a change to the view, which then builds as any change does. */
export function AddLabelControls({ ws, view }: { ws: string; view: BuiltView }) {
  const [asked, setAsked] = useState(false)
  // whether the change asked for has started building, so its end, with no label controls yet, offers it again
  const building = useRef(false)
  useEffect(() => {
    setAsked(false)
    building.current = false
  }, [view.slug])
  useEffect(() => {
    if (!asked) return
    if (view.updating) building.current = true
    else if (building.current) {
      building.current = false
      setAsked(false)
    }
  }, [asked, view.updating])
  const ask = () => {
    if (demoStop()) return
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

/** A view in a pane of its own with its Labels sidebar: shown, for a view built without label controls, while labels
 * are on or a label marks its files, until the analyst hides it; with the Labels pane, the label editor and the seam as
 * Files has them beside a view. */
export function useViewSide(ws: string, view: BuiltView, labels: FilesLabels): { side: ReactNode; card: ReactNode; first?: ReadonlySet<string> } {
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
  return { side, card: shown ? parts.card : null, first }
}
