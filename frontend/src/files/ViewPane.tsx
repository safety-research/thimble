// A view picked in the views bar: the corpus's view drawing a file in its sandboxed frame (ViewerFrame) at the place a
// ref names, with Raw one click away. A view that fails says so with Raw beside it.
import { useEffect, useState, type ReactNode } from 'react'
import { Segmented } from '../components/Button'
import { track } from '../lib/telemetry'
import type { SourceKind } from '../lib/types'
import { Reader, ViewFailed } from './Reader'
import type { FilesLabels } from './useLabels'
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
      </div>
      <div className="view-pane-body">
        {mode === 'raw' && path ? (
          <div className="view-pane-raw">
            <Reader workspace={ws} path={path} kind={kind} targetRef={targetRef} labels={labels} only="raw" onMode={onMode} />
          </div>
        ) : (
          <>
            {failure && <ViewFailed name={view.name} detail={failure} onRaw={path ? () => pick('raw') : undefined} />}
            <ViewerFrame key={view.slug} ws={ws} slug={view.slug} targetRef={targetRef} path={path ?? undefined} title={view.name} labels={labels.on} onError={setFailure} quote={quote} onQuoteMissing={onQuoteMissing} className="view-pane-frame" />
          </>
        )}
      </div>
    </div>
  )
}
