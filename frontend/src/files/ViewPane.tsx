// A view picked in the views bar: the corpus's view drawing its files in its sandboxed frame (ViewerFrame) at the place a
// ref names. Under the name, one quiet line of thimble's notes on the view (ViewChrome ViewHeadLine): the files it reads
// (a click lists them, and a file picked opens in the File browser), what it leaves out, which opens the list of it
// under the head, and what it derived. The view draws its own label controls, and thimble draws none in the head. A view
// that fails says so, with Raw beside it when it reads a file, which opens that file in the File browser. While a Files
// label filter is set, the head shows it as a chip that clears it, with how many records the filter hides in the view.
// At the head's right end, the mark of the review of the view's pictures (ReviewMark). The head offers no other view and
// no Raw: a file's own modes (Transcript, Table, Raw, its viewers) are the File browser's. The view's label controls
// open the label editor in a popover over the view, beside the control that asked (LabelEditor), so nothing moves.
// The pane keeps the version of the view it opened (usePinnedView): a newer one, from a change, the review or the
// orientation, never reloads under the analyst. The head says Updated with Reload, which loads it where they were: the
// element they picked or the record the side panel shows (none once they closed it), the scroll positions, the fields
// and the label filter. Undo in the review's mark loads at once.
import { useEffect, useMemo, useState } from 'react'
import { Button } from '../components/Button'
import { CheckMark } from '../components/CheckMark'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import { refreshProposals } from '../lib/proposals'
import { refPath } from '../lib/refs'
import { track } from '../lib/telemetry'
import { hhmm } from '../lib/time'
import type { ViewQuery, ViewReview } from '../lib/types'
import { openLabelEditor } from './LabelEditor'
import { ViewFailed } from './Reader'
import { useFilesFilter, type FilesLabels } from './useLabels'
import { ResidueList, useResidueOpen, useShownLabels, useViewNotes, ViewFilter, ViewHeadLine } from './ViewChrome'
import { ViewerFrame, type ViewLabelActions, type ViewQuote } from './ViewerFrame'
import { usePinnedView, ViewUpdated } from './viewVersion'
import type { BuiltView } from './ViewsBar'

interface Props {
  ws: string
  view: BuiltView
  /** the file the view opens at: the one a ref named, else the first the view claims */
  path: string | null
  /** the analyst opened the view on `path` (Open in), rather than thimble on its first file */
  picked?: boolean
  targetRef?: string
  /** a passage inside the record `targetRef` names, which the view's page highlights */
  quote?: ViewQuote
  /** the view's page did not show `quote` */
  onQuoteMissing?: () => void
  labels: FilesLabels
  onMode?: (title: string) => void
  /** the labels that mark the view's files, which its page lists first */
  first?: ReadonlySet<string>
  /** the card the view was opened from and its arguments (a card type's Open as view) */
  query?: ViewQuery
  /** the view dropped them */
  onClearQuery?: () => void
}

export function ViewPane({ ws, view, path, picked, targetRef, quote, onQuoteMissing, labels, onMode, first, query, onClearQuery }: Props) {
  const [failure, setFailure] = useState<string | null>(null)
  const filter = useFilesFilter(ws)
  const filterLabel = filter ? labels.byId.get(filter.concept) : undefined
  const pin = usePinnedView(ws, view.slug, view.version)
  const { byId, toggle, setFocus, setColour } = labels
  // what a new label made in the editor applies to: the files the view claims
  const claims = view.claims
  const firstFile = view.first_file
  const labelActions = useMemo<ViewLabelActions>(
    () => ({
      setOn: (id, on) => {
        const k = byId.get(id)
        if (!k || !!k.shown === on) return
        if (on) setFocus(id)
        toggle(id)
      },
      setColour,
      edit: (id, at) => at && openLabelEditor({ id, ...at, appliesTo: claims ?? (firstFile ? [firstFile] : []) }),
    }),
    [byId, toggle, setFocus, setColour, claims, firstFile],
  )
  // how many records the label filter hides in the view, null while there is no filter or no exact count yet
  const [hidden, setHidden] = useState<number | null>(null)
  useEffect(() => setFailure(null), [view.slug, targetRef])
  useEffect(() => setHidden(null), [view.slug, pin.pinned])
  const reload = () => {
    track('view-open', { target: `view:${view.slug}`, detail: { from: 'view-pane', to: 'reload' } })
    setFailure(null)
    void pin.reload()
  }
  useEffect(() => {
    onMode?.(view.name)
  }, [view.name, onMode])
  // a file or a record picked in the head opens in the File browser, where the file's own modes are
  const openFile = (ref: string) => {
    track('view-open', { target: `view:${view.slug}`, detail: { from: 'view-pane', to: 'file' } })
    bus.emit('openRef', { ref, browser: true })
  }
  const notes = useViewNotes(ws, view.slug, pin.pinned || undefined)
  const shownLabels = useShownLabels(labels, view.claims)
  const [residueOpen, toggleResidue] = useResidueOpen(ws, view.slug)
  const files = view.files ?? (view.first_file ? [view.first_file] : [])
  return (
    <div className="view-pane">
      <div className="view-pane-head">
        <div className="view-pane-title">
          <span className="view-pane-name">{view.name}</span>
          <ViewHeadLine ws={ws} name={view.name} notes={notes} shownLabels={shownLabels} residueOpen={residueOpen} onResidue={toggleResidue} files={{ list: files, n: view.n_files ?? files.length, onPick: openFile }} libs={view.libs} />
        </div>
        {pin.stale && <ViewUpdated onReload={reload} className="view-pane-updated" />}
        {filter && filterLabel && <ViewFilter ws={ws} filter={filter} name={filterLabel.name} hidden={hidden} className="view-pane-filter" />}
        {view.review && <ReviewMark ws={ws} slug={view.slug} review={view.review} onUndo={pin.follow} />}
      </div>
      {residueOpen && <ResidueList notes={notes} onPick={openFile} />}
      <div className="view-pane-body">
        {failure && <ViewFailed name={view.name} detail={failure} onRaw={path ? () => openFile(targetRef && refPath(targetRef) === path ? targetRef : path) : undefined} />}
        <ViewerFrame key={`${view.slug}:${pin.pinned ?? ''}`} ws={ws} slug={view.slug} version={pin.pinned || undefined} restore={pin.restore} handle={pin.frame} targetRef={targetRef} path={path ?? undefined} pathPicked={picked} title={view.name} labels={labels.on} filter={filter} filterFiles={filter ? labels.presence.get(filter.concept) : undefined} byId={labels.byId} first={first} labelActions={labelActions} onHidden={setHidden} onError={setFailure} quote={quote} onQuoteMissing={onQuoteMissing} query={query} onQuery={(p) => !p && onClearQuery?.()} className="view-pane-frame" />
      </div>
    </div>
  )
}

/** The rounds a view's reviewer looks at its pictures, at most (backend view_review.ROUNDS, counted by finish_review). */
export const REVIEW_ROUNDS = 2

/** What the review's mark says of its state, in one line. */
export function reviewLine(r: ViewReview): string {
  const at = hhmm(r.ts)
  if (r.state === 'running') return r.round ? `Reviewing the view's pictures, round ${r.round} of ${REVIEW_ROUNDS}` : "Reviewing the view's pictures"
  if (r.state === 'queued') return r.note || 'Waits for a free subagent'
  if (r.state === 'failed') return r.note || 'The review did not finish'
  if (r.state === 'stopped') return (at ? `Stopped at ${at}` : 'Stopped') + (r.note ? `: ${r.note.replace(/\.$/, '')}` : '')
  return at ? `Checked at ${at}` : 'Checked'
}

/** The running review's Stop in its hover card: a first click asks, and Stop under the question stops it. */
function ReviewStop({ revising, onStop }: { revising: boolean; onStop: () => void }) {
  const [asking, setAsking] = useState(false)
  if (!asking)
    return (
      <Button variant="ghost" size="sm" icon="stop" onClick={() => setAsking(true)}>
        Stop
      </Button>
    )
  return (
    <span className="view-review-stop" role="group" aria-label="Stop the review">
      <span className="bcell-check-what">{revising ? 'Stop the review? The view goes back to its last version that passed its checks.' : 'Stop the review?'}</span>
      <span className="bcell-check-acts">
        <Button size="sm" onClick={() => setAsking(false)}>
          Cancel
        </Button>
        <Button size="sm" variant="secondary" onClick={onStop}>
          Stop
        </Button>
      </span>
    </span>
  )
}

/** The review's problems under a title, one per line, the first three and how many more. */
function ReviewList({ title, items }: { title: string; items: string[] }) {
  return (
    <span className="view-review-list">
      <span className="bcell-check-label">{title}</span>
      {items.slice(0, 3).map((x, i) => (
        <span key={i}>{x}</span>
      ))}
      {items.length > 3 && <span className="view-review-more">and {items.length - 3} more</span>}
    </span>
  )
}

/** The review of a view's pictures as the card check's mark: a spinner while it runs, a check glyph when it is done, a
 * flag when problems are left, and a run-again glyph when it failed or was stopped. A click on the running mark opens
 * its hover card, whose Stop asks before it stops the review. Whenever it revised the view and is not running, its
 * hover offers Undo, and `onUndo` runs before it is sent. */
export function ReviewMark({ ws, slug, review: r, onUndo }: { ws: string; slug: string; review: ViewReview; onUndo?: () => void }) {
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
      state={r.state === 'queued' ? 'running' : r.state /* a start that waits for a free subagent turns as one */}
      flagged={r.state === 'done' && left.length > 0}
      label={[line, ended ? 'Review again' : ''].filter(Boolean).join('. ')}
      popLabel="The view's review"
      onClick={ended ? again : undefined}
      className="view-pane-review"
    >
      {(close) => (
        <>
          <span className="bcell-check-when">{line}</span>
          {revised.length > 0 && <ReviewList title="Revised" items={revised} />}
          {r.state === 'done' && left.length > 0 && <ReviewList title="Left" items={left} />}
          {r.state === 'done' && r.note && <span className="bcell-check-what">{r.note}</span>}
          {r.state === 'done' && !revised.length && !left.length && !r.undo && <span className="bcell-check-what">Nothing to fix.</span>}
          {(running || ended || r.state === 'done') && (
            <span className="bcell-check-acts">
              {running && <ReviewStop revising={!!r.round} onStop={() => (close(), stop())} />}
              {!running && revised.length > 0 && (
                <Button variant="ghost" size="sm" icon="undo" onClick={() => (close(), undo())}>
                  Undo
                </Button>
              )}
              {!running && (
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
