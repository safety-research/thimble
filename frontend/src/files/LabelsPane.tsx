// The Labels pane at the bottom of the Files sidebar (the whole sidebar beside a view, with the button that hides it):
// every label over files with its colour, then the labels over canvas cards and report sentences. A label over files
// shows its mark (LabelMark), filled while it is on; a click on the mark turns it on or off. A click on the name turns
// it on, focuses it, or turns the focused label off. An on label with more than two values lists them, and a click on
// one toggles its highlight. Under each name, the status of its last or running apply. A label over files has a palette
// on hover that changes its colours (LabelPalette). Beside a view, a label's row (and each value's) has a funnel on
// hover that sets the Files label filter, which the view keeps its records by.
import { useMemo, useRef, useState, type CSSProperties } from 'react'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { Spinner } from '../components/Spinner'
import { TipButton } from '../components/Tooltip'
import { teleport } from '../lib/teleport'
import { hhmm } from '../lib/time'
import type { Concept, ConceptRun } from '../lib/types'
import { classesOf, colourVar, isFilesLabel, isMultiClass, labelStatus, laneTags, mainColour, outcomeText, progressText, type LabelStatus } from './labels'
import { LabelMark } from './LabelMark'
import { LabelPalette } from './LabelPalette'
import type { FilesLabels } from './useLabels'

interface Props {
  labels: FilesLabels
  open: boolean
  onToggleOpen: () => void
  /** the label whose edit card is open, 'new' for a new one */
  editing: string | null
  onEdit: (id: string | 'new' | null) => void
  /** the runs the pane has seen per label: running ones, and the last record of one that ended */
  runs: ReadonlyMap<string, ConceptRun>
  /** apply a label again after a failed run; resolves once the server has answered */
  onRetry: (id: string) => Promise<void>
  /** beside a view, where the pane is the whole sidebar: hide that sidebar */
  onHide?: () => void
  /** beside a view: the labels that mark its files, listed first */
  first?: ReadonlySet<string>
  /** beside a view: keep only the records that take a label's value */
  onFilter?: (id: string, value: string) => void
}

export function LabelsPane({ labels, open, onToggleOpen, editing, onEdit, runs, onRetry, onHide, first, onFilter }: Props) {
  const files = labels.all.filter(isFilesLabel)
  const ordered = first ? [...files.filter((k) => first.has(k.id)), ...files.filter((k) => !first.has(k.id))] : files
  const nums = useMemo(() => new Map(laneTags(labels.on).map((t) => [t.id, t.n])), [labels.on])
  return (
    <section className="files-labels" aria-label="Labels">
      <div className="files-side-head">
        <button type="button" className="files-side-title" aria-expanded={open} onClick={onToggleOpen}>
          <Icon name="chevron-right" size={14} className="files-caret" />
          Labels
        </button>
        <Button variant="icon" size="sm" icon="plus" title="New label" aria-label="New label" active={editing === 'new'} onClick={() => onEdit(editing === 'new' ? null : 'new')} />
        {onHide && <Button variant="icon" size="sm" icon="sidebar" title="Hide labels" aria-label="Hide labels" onClick={onHide} />}
      </div>
      {open && labels.all.length > 0 && (
        <div className="files-labels-list">
          {[...ordered, ...labels.all.filter((k) => !isFilesLabel(k))].map((k) => (
            <LabelRow
              key={k.id}
              label={k}
              on={!!k.shown}
              n={nums.get(k.id) ?? 0}
              focused={labels.focus === k.id}
              marked={labels.focus === k.id && labels.on.length > 1}
              editing={editing === k.id}
              status={labelStatus(k, runs.get(k.id))}
              labels={labels}
              onEdit={onEdit}
              onRetry={onRetry}
              onFilter={isFilesLabel(k) ? onFilter : undefined}
            />
          ))}
        </div>
      )}
    </section>
  )
}

interface RowProps {
  label: Concept
  on: boolean
  /** a multi-class label's number among the multi-class labels that are on, 0 while it is off or single-class */
  n: number
  /** the focused label */
  focused: boolean
  /** the focus is marked on its row: it is focused and another label is on */
  marked: boolean
  editing: boolean
  status: LabelStatus | null
  labels: FilesLabels
  onEdit: Props['onEdit']
  onRetry: Props['onRetry']
  onFilter?: Props['onFilter']
}

function LabelRow({ label: k, on, n, focused, marked, editing, status, labels, onEdit, onRetry, onFilter }: RowProps) {
  const classes = classesOf(k)
  const running = status?.state === 'running'
  const files = isFilesLabel(k)
  const colour = mainColour(k)
  const paletteAt = useRef<HTMLButtonElement>(null)
  const [picking, setPicking] = useState(false)
  const turn = () => {
    if (!on) labels.setFocus(k.id)
    labels.toggle(k.id)
  }
  const pick = () => {
    if (on && !focused) labels.setFocus(k.id)
    else turn()
  }
  return (
    <div className={'files-label' + (marked ? ' is-focus' : '')} data-anchor={`concept:${k.id}`} data-anchor-text={k.name}>
      <div className={'files-label-row' + (editing ? ' editing' : '')}>
        {files ? (
          <>
            <TipButton tip={on ? 'Turn off' : 'Turn on'} className={'files-label-mark' + (on ? ' on' : '')} aria-pressed={on} aria-label={`${on ? 'Turn off' : 'Turn on'} ${k.name}`} onClick={turn}>
              <LabelMark multi={isMultiClass(classes)} colour={colour} on={on} n={n} />
            </TipButton>
            <button type="button" className={'files-label-toggle' + (on ? ' on' : '')} aria-pressed={on} onClick={pick} style={{ '--c': colour } as CSSProperties}>
              <span className="files-label-name">{k.name}</span>
            </button>
          </>
        ) : (
          <button
            type="button"
            className="files-label-toggle files-label-open on"
            title="Open on the canvas"
            onClick={() => teleport(`concept:${k.id}`)}
            style={{ '--c': mainColour(k) } as CSSProperties}
          >
            <Icon name={k.unit === 'cell' ? 'canvas' : 'report'} size={12} className="files-label-over" />
            <span className="files-label-name">{k.name}</span>
          </button>
        )}
        {running && <Spinner size={10} label="Running" />}
        {files && (
          <Button ref={paletteAt} variant="icon" size="sm" icon="palette" title="Change colour" aria-label={`Change the colours of ${k.name}`} className="files-label-colour" active={picking} onClick={() => setPicking(!picking)} />
        )}
        {onFilter && (classes.length <= 2 || !on) && (
          <Button variant="icon" size="sm" icon="filter" title="Show only these records" aria-label={`Show only the records ${k.name} marks`} className="files-label-filter" onClick={() => onFilter(k.id, (classes.find((c) => c.highlight) ?? classes[0])?.name ?? 'yes')} />
        )}
        <Button variant="icon" size="sm" icon="more-horizontal" title="Edit label" aria-label={`Edit ${k.name}`} className="files-label-edit" active={editing} onClick={() => onEdit(editing ? null : k.id)} />
      </div>
      {files && <LabelPalette label={k} anchor={paletteAt} open={picking} onClose={() => setPicking(false)} onPick={(value, n) => labels.setColour(k.id, value, n)} />}
      {status && <LabelStatusLine status={status} name={k.name} onRetry={() => onRetry(k.id)} />}
      {files && on && classes.length > 2 && (
        <div className="files-label-classes">
          {classes.map((c, i) => (
            <span key={c.name} className="files-class-row">
            <button
              type="button"
              className={'files-class-toggle' + (c.highlight ? ' on' : '')}
              aria-pressed={c.highlight}
              style={{ '--c': colourVar(c.color) } as CSSProperties}
              onClick={() => {
                labels.setFocus(k.id)
                labels.setClasses(k.id, classes.map((x, j) => (j === i ? { ...x, highlight: !x.highlight } : x)))
              }}
            >
              <span className="files-class-box" />
              {c.name}
            </button>
            {onFilter && <Button variant="icon" size="sm" icon="filter" title="Show only these records" aria-label={`Show only the records ${k.name} marks ${c.name}`} className="files-label-filter" onClick={() => onFilter(k.id, c.name)} />}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/** The line under a label's name: the run's progress, its outcome, or its failure with Retry. */
function LabelStatusLine({ status: s, name, onRetry }: { status: LabelStatus; name: string; onRetry: () => Promise<void> }) {
  const [retrying, setRetrying] = useState(false)
  if (s.state === 'running') {
    const share = s.total ? Math.min(1, s.done / s.total) : null
    return (
      <div className="files-label-status is-running">
        {s.total != null && <span className="files-label-count">{progressText(s)}</span>}
        <span className={'files-label-bar' + (share == null ? ' is-unknown' : '')} role="progressbar" aria-label={`${name} running`} aria-valuemin={0} aria-valuemax={s.total ?? undefined} aria-valuenow={share == null ? undefined : s.done}>
          <span className="files-label-fill" style={share == null ? undefined : { width: `${share * 100}%` }} />
        </span>
      </div>
    )
  }
  if (s.state === 'error') {
    return (
      <div className="files-label-status is-error" role="alert">
        <span className="files-label-error" title={s.message}>
          {s.message}
        </span>
        <Button
          size="sm"
          className="files-label-retry"
          aria-label={`Retry ${name}`}
          busy={retrying}
          onClick={() => {
            setRetrying(true)
            void onRetry().finally(() => setRetrying(false))
          }}
        >
          Retry
        </Button>
      </div>
    )
  }
  return (
    <div className="files-label-status">
      <span className="files-label-count">{outcomeText(s)}</span>
      {s.ts && (
        <>
          <span className="files-label-sep">·</span>
          <time className="time" dateTime={s.ts}>
            {hhmm(s.ts)}
          </time>
        </>
      )}
    </div>
  )
}
