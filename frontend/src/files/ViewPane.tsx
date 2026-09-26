// A view picked in the views bar: the corpus's view drawing a file in its sandboxed frame (ViewerFrame) at the place a
// ref names, with Raw one click away. A view that fails says so with Raw beside it. While a Files label filter is set,
// the head shows it as a chip that clears it, since the view keeps only the records the filter keeps. At the head's
// right end, the mark of the review of the view's pictures (ReviewMark).
import { useEffect, useState, type ReactNode } from 'react'
import { Button, Segmented } from '../components/Button'
import { CheckMark } from '../components/CheckMark'
import { FilterChip } from '../components/FilterChip'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import { refreshProposals } from '../lib/proposals'
import { track } from '../lib/telemetry'
import { hhmm } from '../lib/time'
import type { ViewReview } from '../lib/types'
import type { SourceKind } from '../lib/types'
import { Reader, ViewFailed } from './Reader'
import { useFilesFilter, type FilesLabels } from './useLabels'
import { ViewerFrame, type ViewQuote } from './ViewerFrame'
import type { BuiltView } from './ViewsBar'

interface Props {
  ws: string
  view: BuiltView
  /** the file the view shows: the one a ref named, else the first it claims */
  path: string | null
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
}

export function ViewPane({ ws, view, path, kind, targetRef, quote, onQuoteMissing, labels, onMode, lead }: Props) {
  const [mode, setMode] = useState<'view' | 'raw'>('view')
  const [failure, setFailure] = useState<string | null>(null)
  const filter = useFilesFilter(ws)
  const filterLabel = filter ? labels.byId.get(filter.concept) : undefined
  useEffect(() => {
    setMode('view')
    setFailure(null)
  }, [view.slug, targetRef])
  useEffect(() => {
    if (mode === 'view') onMode?.(view.name)
  }, [mode, view.name, onMode])
  const pick = (m: 'view' | 'raw') => {
    track('view-open', { target: `view:${view.slug}`, detail: { from: 'view-pane', to: m } })
    setMode(m)
  }
  return (
    <div className="view-pane">
      <div className="view-pane-head">
        {lead}
        <div className="view-pane-title">
          <span className="view-pane-name">{view.name}</span>
          {path && <span className="view-pane-file mono">{path}</span>}
        </div>
        {filter && filterLabel && <FilterChip concept={filter.concept} name={filterLabel.name} value={filter.value} className="view-pane-filter" onClear={() => void api.deleteFilter(ws, 'files').catch(() => undefined)} />}
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
        {view.review && <ReviewMark ws={ws} slug={view.slug} review={view.review} />}
      </div>
      <div className="view-pane-body">
        {mode === 'raw' && path ? (
          <div className="view-pane-raw">
            <Reader workspace={ws} path={path} kind={kind} targetRef={targetRef} labels={labels} only="raw" onMode={onMode} />
          </div>
        ) : (
          <>
            {failure && <ViewFailed name={view.name} detail={failure} onRaw={path ? () => pick('raw') : undefined} />}
            <ViewerFrame key={`${view.slug}:${view.built ?? ''}`} ws={ws} slug={view.slug} targetRef={targetRef} path={path ?? undefined} title={view.name} labels={labels.on} filter={filter} byId={labels.byId} onError={setFailure} quote={quote} onQuoteMissing={onQuoteMissing} className="view-pane-frame" />
          </>
        )}
      </div>
    </div>
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
 * when it is done, with what it revised and Undo, a flag when problems are left, and a run-again glyph when it failed
 * or was stopped. */
function ReviewMark({ ws, slug, review: r }: { ws: string; slug: string; review: ViewReview }) {
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
  const undo = act(() => api.viewReviewUndo(ws, slug), 'undo the revision')
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
          {revised.length > 0 && <span className="bcell-check-what">Revised: {revised.join('; ')}</span>}
          {r.state === 'done' && left.length > 0 && (
            <span className="bcell-check-what">
              Left: {left.slice(0, 3).join('; ')}
              {left.length > 3 ? ` and ${left.length - 3} more` : ''}
            </span>
          )}
          {r.state === 'done' && r.note && <span className="bcell-check-what">{r.note}</span>}
          {r.state === 'done' && !revised.length && !left.length && !r.undo && <span className="bcell-check-what">Nothing to fix.</span>}
          {(running || ended || (r.state === 'done' && revised.length > 0)) && (
            <span className="bcell-check-acts">
              {running && (
                <Button variant="ghost" size="sm" icon="stop" onClick={() => (close(), stop())}>
                  Stop
                </Button>
              )}
              {r.state === 'done' && revised.length > 0 && (
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
