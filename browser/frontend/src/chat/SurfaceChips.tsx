// The chips that name a document, a canvas group or a label. In the chat each is drawn as a view's chip (ViewTab) with
// its glyph; a label's row chip, in a view's list of its fields and labels, is its row in the Labels pane, a size
// smaller. Each is a button when it goes somewhere.
import type { CSSProperties, MouseEvent, ReactNode } from 'react'
import { useConcepts } from '../canvas/concepts'
import { Icon } from '../components/Icon'
import { classesOf, isFilesLabel, isMultiClass, mainColour } from '../files/labels'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import { track } from '../lib/telemetry'
import { teleport } from '../lib/teleport'
import type { Concept } from '../lib/types'

interface BaseProps {
  onClick?: (e: MouseEvent<HTMLElement>) => void
  className?: string
  style?: CSSProperties
  children: ReactNode
  [data: `data-${string}`]: string | undefined
}

function SurfaceChip({ onClick, className, children, ...rest }: BaseProps) {
  return onClick ? (
    <button type="button" className={className} onClick={onClick} {...rest}>
      {children}
    </button>
  ) : (
    <span className={className} {...rest}>
      {children}
    </span>
  )
}

const cls = (...names: (string | false | undefined)[]) => ['surface-chip', ...names].filter(Boolean).join(' ')
const viewCls = (...names: (string | false | undefined)[]) => ['view-tab', ...names].filter(Boolean).join(' ')

const byName = (concepts: ReadonlyMap<string, Concept>, name: string): Concept | undefined => [...concepts.values()].find((k) => k.name === name)

/** A chip that names a label in the chat, drawn as a view's chip is (`.view-tab`) with the label glyph, as a document's
 * and a canvas group's chip are. */
export function LabelChip({ name, onClick, className }: { name: string; onClick?: (e: MouseEvent<HTMLElement>) => void; className?: string }) {
  return (
    <SurfaceChip className={viewCls('label-chip', className)} onClick={onClick} data-label={name}>
      <Icon name="label" size={12} className="view-tab-ico" />
      <span className="view-tab-name">{name}</span>
    </SurfaceChip>
  )
}

/** A label drawn as its row in the Labels pane, a size smaller, for a view's list of its fields and labels: a label over
 * files shows its color square (filled while on in Files) or, for a multi-class label, the label glyph; a label over
 * cards or report sentences shows the canvas or report glyph in its color. Then its name. */
export function LabelRowChip({ ws, name, onClick, className }: { ws: string; name: string; onClick?: (e: MouseEvent<HTMLElement>) => void; className?: string }) {
  const k = byName(useConcepts(ws), name)
  const files = !k || isFilesLabel(k)
  const on = !!k && (!files || !!k.shown)
  const multi = !!k && isMultiClass(classesOf(k))
  return (
    <SurfaceChip className={cls('label-row-chip', on && 'on', className)} onClick={onClick} style={{ '--c': k ? mainColour(k) : 'var(--label-none)' } as CSSProperties} data-label={name}>
      {!files ? <Icon name={k?.unit === 'cell' ? 'canvas' : 'report'} size={11} className="label-row-chip-over" /> : multi ? <Icon name="label" size={11} className="label-row-chip-tag" /> : <span className="label-row-chip-box" />}
      <span className="surface-chip-name">{name}</span>
    </SurfaceChip>
  )
}

/** Open a label by its name: its section of the Labels pane, or the Files tab when it is not found. */
export function openLabel(ws: string, name: string) {
  track('chip-teleport', { target: `label:${name}`, detail: { kind: 'section' } })
  api
    .concepts(ws)
    .then((cs) => {
      const c = cs.find((x) => x.name === name)
      if (c) teleport(`concept:${c.id}`)
      else bus.emit('showTab', { tab: 'files' })
    })
    .catch(() => bus.emit('showTab', { tab: 'files' }))
}
