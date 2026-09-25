// The chips that name a document, a canvas group or a label. A document's and a canvas group's chip are drawn as a
// view's chip (ViewTab) with their glyph; a label's is its row in the Labels pane, a size smaller. Each is a button when
// it goes somewhere.
import { useEffect, useState } from 'react'
import type { CSSProperties, MouseEvent, ReactNode } from 'react'
import { useConcepts } from '../canvas/concepts'
import { Icon } from '../components/Icon'
import { classesOf, isFilesLabel, isMultiClass, mainColour } from '../files/labels'
import { docsApi } from '../lib/api'
import { bus } from '../lib/bus'
import type { Concept, TypesState } from '../lib/types'
import { BUILTIN_SLUGS, docLabel } from '../report/model'

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

/** The workspace's document types, for the names of its own types; read when a chip names one, again on each `report`
 * event. */
const typesCache = new Map<string, TypesState | null>()
const typesLoading = new Set<string>()
const typesListeners = new Set<() => void>()

function loadTypes(ws: string): void {
  if (typesLoading.has(ws)) return
  typesLoading.add(ws)
  docsApi
    .types(ws)
    .then((s) => typesCache.set(ws, s))
    .catch(() => typesCache.set(ws, typesCache.get(ws) ?? null))
    .finally(() => {
      typesLoading.delete(ws)
      typesListeners.forEach((fn) => fn())
    })
}

function useDocName(ws: string, slug: string): string {
  const builtin = (BUILTIN_SLUGS as readonly string[]).includes(slug)
  const [, bump] = useState(0)
  useEffect(() => {
    if (builtin || !ws) return
    const fn = () => bump((n) => n + 1)
    typesListeners.add(fn)
    if (!typesCache.has(ws)) loadTypes(ws)
    const off = bus.on('report', () => loadTypes(ws))
    return () => {
      typesListeners.delete(fn)
      off()
    }
  }, [ws, builtin])
  return docLabel(slug, typesCache.get(ws))
}

/** A note's words about a document with the type's name in them spelled as its tab spells it: "the report, generation
 * 1" reads "the Report, generation 1". Pure. */
export function withDocName(text: string, name: string): string {
  if (!name.trim()) return text
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, 'giu'), (_m, pre: string) => pre + name)
}

/** A chip that names a document, drawn as a view's chip is (`.view-tab`) with the document glyph: the name of its type
 * (Report, Slides, a workspace's own), or `children` in its place (a chat note's words about the document, the type's
 * name in them as its tab spells it). */
export function DocChip({ ws, slug, onClick, className, children }: { ws: string; slug: string; onClick?: (e: MouseEvent<HTMLElement>) => void; className?: string; children?: ReactNode }) {
  const name = useDocName(ws, slug)
  return (
    <SurfaceChip className={viewCls('doc-chip', className)} onClick={onClick} data-doc={slug}>
      <Icon name="report" size={12} className="view-tab-ico" />
      <span className="view-tab-name">{typeof children === 'string' ? withDocName(children, name) : (children ?? name)}</span>
    </SurfaceChip>
  )
}

/** A count of cards with its unit: 1 card, 4 cards. Pure. */
export const cardsText = (n: number): string => `${n} ${n === 1 ? 'card' : 'cards'}`

/** A chip that names a canvas group, drawn as a view's chip is (`.view-tab`) with the group glyph: its name and, when
 * given, how many cards (Orientation · 8 cards). */
export function GroupChip({ name, count, onClick, className, anchor }: { name: string; count?: number; onClick?: (e: MouseEvent<HTMLElement>) => void; className?: string; anchor?: string }) {
  return (
    <SurfaceChip className={viewCls('group-chip', className)} onClick={onClick} data-anchor={anchor}>
      <Icon name="group" size={12} className="view-tab-ico" />
      <span className="view-tab-name">{count != null ? `${name} · ${cardsText(count)}` : name}</span>
    </SurfaceChip>
  )
}

const byName = (concepts: ReadonlyMap<string, Concept>, name: string): Concept | undefined => [...concepts.values()].find((k) => k.name === name)

/** A chip that names a label, drawn as its row in the Labels pane, a size smaller: a label over files shows its colour
 * square (filled while on in Files) or, for a multi-class label, the label glyph; a label over cards or report sentences
 * shows the canvas or report glyph in its colour. Then its name. */
export function LabelChip({ ws, name, onClick, className }: { ws: string; name: string; onClick?: (e: MouseEvent<HTMLElement>) => void; className?: string }) {
  const k = byName(useConcepts(ws), name)
  const files = !k || isFilesLabel(k)
  const on = !!k && (!files || !!k.shown)
  const multi = !!k && isMultiClass(classesOf(k))
  return (
    <SurfaceChip className={cls('label-chip', on && 'on', className)} onClick={onClick} style={{ '--c': k ? mainColour(k) : 'var(--label-none)' } as CSSProperties} data-label={name}>
      {!files ? <Icon name={k?.unit === 'cell' ? 'canvas' : 'report'} size={11} className="label-chip-over" /> : multi ? <Icon name="label" size={11} className="label-chip-tag" /> : <span className="label-chip-box" />}
      <span className="surface-chip-name">{name}</span>
    </SurfaceChip>
  )
}
