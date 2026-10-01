// A view picked in the views bar: the corpus's view drawing its files in its sandboxed frame (ViewerFrame) at the place a
// ref names, with Raw one click away. Under the name, the files it reads (a click lists them, and a file picked opens in
// Raw), then thimble's notes on the view (ViewChrome): what it leaves out, a line that opens the list of it under the
// head, and what it derived. A view that fails says so with Raw beside it. While a Files label filter is set,
// the head shows it as a chip that clears it, since the view keeps only the records the filter keeps. At the head's
// right end, Open in (the other views that claim the file shown, and the File browser), the mode switch and the mark of
// the review of the view's pictures (ReviewMark).
// The pane keeps the version of the view it opened (usePinnedView): a newer one, from a change, the review or the
// orientation, never reloads under the analyst. The head says Updated with Reload, which loads it where they were: the
// element they picked, the scroll positions, the fields and the label filter. Undo in the review's mark loads at once.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button, Segmented } from '../components/Button'
import { CheckMark } from '../components/CheckMark'
import { FilterChip } from '../components/FilterChip'
import { Popover } from '../components/Menu'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import { refreshProposals } from '../lib/proposals'
import { refPath } from '../lib/refs'
import { track } from '../lib/telemetry'
import { hhmm } from '../lib/time'
import type { ViewQuery, ViewReview } from '../lib/types'
import type { SourceKind } from '../lib/types'
import { OpenIn } from './OpenIn'
import { inferKind } from './params'
import { Reader, ViewFailed } from './Reader'
import { kindIn, useFolderStore } from './Tree'
import { useFilesFilter, type FilesLabels } from './useLabels'
import { ResidueList, useResidueOpen, useShownLabels, useViewNotes, ViewNotesLine } from './ViewChrome'
import { ViewerFrame, type ViewLabelActions, type ViewQuote } from './ViewerFrame'
import { usePinnedView, ViewUpdated } from './viewVersion'
import type { BuiltView } from './ViewsBar'

interface Props {
  ws: string
  view: BuiltView
  /** the file Raw shows: the one a ref named, else the first the view claims */
  path: string | null
  /** the analyst opened the view on `path` (Open in), rather than thimble on its first file */
  picked?: boolean
  /** the file's kind, from the folder listing */
  kind: SourceKind
  targetRef?: string
  /** a passage inside the record `targetRef` names, which the view's page highlights */
  quote?: ViewQuote
  /** the view's page did not show `quote` */
  onQuoteMissing?: () => void
  labels: FilesLabels
  onMode?: (title: string) => void
  /** before the name: the button that shows the hidden Labels sidebar */
  lead?: ReactNode
  /** the labels that mark the view's files, which its page lists first */
  first?: ReadonlySet<string>
  /** open the new-label prompt in the Labels sidebar beside the view */
  onNewLabel?: () => void
  /** the card the view was opened from and its arguments (a card type's Open as view) */
  query?: ViewQuery
  /** the view dropped them */
  onClearQuery?: () => void
}

export function ViewPane({ ws, view, path, picked, kind, targetRef, quote, onQuoteMissing, labels, onMode, lead, first, onNewLabel, query, onClearQuery }: Props) {
  const [mode, setMode] = useState<'view' | 'raw'>('view')
  // a file or line picked in the head, which Raw shows in place of `path`
  const [rawAt, setRawAt] = useState<{ path: string; ref?: string } | null>(null)
  const folders = useFolderStore(ws)
  const [failure, setFailure] = useState<string | null>(null)
  const filter = useFilesFilter(ws)
  const filterLabel = filter ? labels.byId.get(filter.concept) : undefined
  const pin = usePinnedView(ws, view.slug, view.version)
  const { byId, toggle, setFocus, setColour } = labels
  const labelActions = useMemo<ViewLabelActions>(
    () => ({
      setOn: (id, on) => {
        const k = byId.get(id)
        if (!k || !!k.shown === on) return
        if (on) setFocus(id)
        toggle(id)
      },
      setColour,
      create: onNewLabel,
    }),
    [byId, toggle, setFocus, setColour, onNewLabel],
  )
  useEffect(() => {
    setMode('view')
    setFailure(null)
    setRawAt(null)
  }, [view.slug, targetRef])
  const reload = () => {
    track('view-open', { target: `view:${view.slug}`, detail: { from: 'view-pane', to: 'reload' } })
    setFailure(null)
    void pin.reload()
  }
  useEffect(() => {
    if (mode === 'view') onMode?.(view.name)
  }, [mode, view.name, onMode])
  const pick = (m: 'view' | 'raw') => {
    track('view-open', { target: `view:${view.slug}`, detail: { from: 'view-pane', to: m } })
    setMode(m)
  }
  const showRaw = (at: { path: string; ref?: string }) => {
    setRawAt(at)
    pick('raw')
  }
  const rawPath = rawAt?.path ?? path
  const rawKind = rawAt ? (kindIn(folders.store, rawAt.path) ?? inferKind(rawAt.path)) : kind
  const notes = useViewNotes(ws, view.slug, pin.pinned || undefined)
  const shownLabels = useShownLabels(labels, view.claims)
  const [residueOpen, toggleResidue] = useResidueOpen(ws, view.slug)
  const pickRef = (ref: string) => {
    const p = refPath(ref) ?? ref
    showRaw(p === ref ? { path: p } : { path: p, ref })
  }
  return (
    <div className="view-pane">
      <div className="view-pane-head">
        {lead}
        <div className="view-pane-title">
          <span className="view-pane-name">{view.name}</span>
          <span className="view-pane-sub">
            <ViewFiles view={view} current={mode === 'raw' ? rawPath : null} onPick={(f) => showRaw({ path: f })} />
            {mode === 'raw' && rawPath && (view.n_files ?? 0) > 1 && <span className="view-pane-file mono">{rawPath}</span>}
            <ViewNotesLine ws={ws} name={view.name} notes={notes} shownLabels={shownLabels} residueOpen={residueOpen} onResidue={toggleResidue} />
          </span>
        </div>
        {pin.stale && mode === 'view' && <ViewUpdated onReload={reload} className="view-pane-updated" />}
        {filter && filterLabel && <FilterChip concept={filter.concept} name={filterLabel.name} value={filter.value} className="view-pane-filter" onClear={() => void api.deleteFilter(ws, 'files').catch(() => undefined)} />}
        {path && <OpenIn ws={ws} path={rawAt?.path ?? path} current={view.slug} onOpen={(slug) => bus.emit('openIn', { path: rawAt?.path ?? path, ref: rawAt?.ref ?? targetRef, slug })} />}
        {path && (
          <Segmented
            label="Mode"
            size="md"
            value={mode}
            onChange={pick}
            options={[
              { value: 'view', label: view.name },
              { value: 'raw', label: 'Raw' },
            ]}
          />
        )}
        {view.review && <ReviewMark ws={ws} slug={view.slug} review={view.review} onUndo={pin.follow} />}
      </div>
      {residueOpen && <ResidueList notes={notes} onPick={pickRef} />}
      <div className="view-pane-body">
        {mode === 'raw' && rawPath ? (
          <div className="view-pane-raw">
            <Reader workspace={ws} path={rawPath} kind={rawKind} targetRef={rawAt ? rawAt.ref : targetRef} labels={labels} only="raw" onMode={onMode} />
          </div>
        ) : (
          <>
            {failure && <ViewFailed name={view.name} detail={failure} onRaw={path ? () => pick('raw') : undefined} />}
            <ViewerFrame key={`${view.slug}:${pin.pinned ?? ''}`} ws={ws} slug={view.slug} version={pin.pinned || undefined} restore={pin.restore} handle={pin.frame} targetRef={targetRef} path={path ?? undefined} pathPicked={picked} title={view.name} labels={labels.on} filter={filter} filterFiles={filter ? labels.presence.get(filter.concept) : undefined} byId={labels.byId} first={first} labelActions={labelActions} onError={setFailure} quote={quote} onQuoteMissing={onQuoteMissing} query={query} onQuery={(p) => !p && onClearQuery?.()} className="view-pane-frame" />
          </>
        )}
      </div>
    </div>
  )
}

/** The files a view reads, in its head: their count, or the file's name when it reads one, which a click lists them
 * under; a file picked there opens in Raw. */
function ViewFiles({ view, current, onPick }: { view: BuiltView; current: string | null; onPick: (path: string) => void }) {
  const [at, setAt] = useState<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  const files = view.files ?? (view.first_file ? [view.first_file] : [])
  const n = view.n_files ?? files.length
  if (!n) return null
  return (
    <>
      <button ref={setAt} type="button" className="view-pane-files" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {n === 1 ? files[0] : `${n.toLocaleString()} files`}
      </button>
      <Popover anchor={at} open={open} onClose={() => setOpen(false)} label={`The files ${view.name} reads`} className="view-pane-list">
        {files.map((f) => (
          <button
            key={f}
            type="button"
            className={'view-pane-list-item mono' + (f === current ? ' is-current' : '')}
            onClick={() => {
              setOpen(false)
              onPick(f)
            }}
          >
            {f}
          </button>
        ))}
        {n > files.length && <span className="view-pane-list-more">and {(n - files.length).toLocaleString()} more</span>}
      </Popover>
    </>
  )
}

/** What the review's mark says of its state, in one line. */
export function reviewLine(r: ViewReview): string {
  const at = hhmm(r.ts)
  if (r.state === 'running') return r.round ? `Revising the view from its review (round ${r.round})` : "Reviewing the view's pictures"
  if (r.state === 'failed') return r.note || 'The review did not finish'
  if (r.state === 'stopped') return (at ? `Stopped at ${at}` : 'Stopped') + (r.note ? `: ${r.note.replace(/\.$/, '')}` : '')
  return at ? `Checked at ${at}` : 'Checked'
}

/** The review of a view's pictures as the card check's mark: a spinner while it runs (a click stops it), a check glyph
 * when it is done, a flag when problems are left, and a run-again glyph when it failed or was stopped. Whenever it
 * revised the view and is not running, its hover offers Undo, and `onUndo` runs before it is sent. */
function ReviewMark({ ws, slug, review: r, onUndo }: { ws: string; slug: string; review: ViewReview; onUndo?: () => void }) {
  const running = r.state === 'running'
  const ended = r.state === 'failed' || r.state === 'stopped'
  const left = r.left ?? []
  const revised = r.revised ?? []
  const act = (call: () => Promise<unknown>, what: string) => () =>
    void call()
      .then(() => refreshProposals(ws))
      .catch((e: Error) => bus.emit('toast', { text: `Could not ${what}. ${e.message}`, kind: 'error' }))
  const again = act(() => api.viewReviewAgain(ws, slug), 'review the view again')
  const stop = act(() => api.viewReviewStop(ws, slug), 'stop the review')
  const undo = act(() => (onUndo?.(), api.viewReviewUndo(ws, slug)), 'undo the revision')
  const line = reviewLine(r)
  return (
    <CheckMark
      state={r.state}
      flagged={r.state === 'done' && left.length > 0}
      label={[line, running ? 'Stop the review' : ended ? 'Review again' : ''].filter(Boolean).join('. ')}
      popLabel="The view's review"
      onClick={running ? stop : ended ? again : undefined}
      className="view-pane-review"
    >
      {(close) => (
        <>
          <span className="bcell-check-when">{line}</span>
          {revised.length > 0 && (
            <span className="bcell-check-what">
              Revised: {revised.slice(0, 3).join('; ')}
              {revised.length > 3 ? ` and ${revised.length - 3} more` : ''}
            </span>
          )}
          {r.state === 'done' && left.length > 0 && (
            <span className="bcell-check-what">
              Left: {left.slice(0, 3).join('; ')}
              {left.length > 3 ? ` and ${left.length - 3} more` : ''}
            </span>
          )}
          {r.state === 'done' && r.note && <span className="bcell-check-what">{r.note}</span>}
          {r.state === 'done' && !revised.length && !left.length && !r.undo && <span className="bcell-check-what">Nothing to fix.</span>}
          {(running || ended || revised.length > 0) && (
            <span className="bcell-check-acts">
              {running && (
                <Button variant="ghost" size="sm" icon="stop" onClick={() => (close(), stop())}>
                  Stop
                </Button>
              )}
              {!running && revised.length > 0 && (
                <Button variant="ghost" size="sm" icon="undo" onClick={() => (close(), undo())}>
                  Undo
                </Button>
              )}
              {ended && (
                <Button variant="ghost" size="sm" icon="refresh" onClick={() => (close(), again())}>
                  Review again
                </Button>
              )}
            </span>
          )}
        </>
      )}
    </CheckMark>
  )
}
