// The figure block: a canvas card embedded in the report, with its question, `from canvas` and ×, its output at the
// card's width (or its body, for cards with no run), and a caption edited in place. Before a card is picked the block is
// the picker. Locked (a scene, a slide), the caption is text; `FigureView` is the same figure outside the editor.
import { useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react'
import type { BlockNoteEditor } from '@blocknote/core'
import { CardBody } from '../canvas/bodies'
import { useConceptDetail, useConcepts } from '../canvas/concepts'
import { CanvasContext } from '../canvas/context'
import { Button } from '../components/Button'
import { Card } from '../components/Card'
import { Chip } from '../components/Chip'
import { TextArea } from '../components/Field'
import { chartLabels, Output, outIndex, primaryArtifact } from '../components/Outputs'
import { GlyphCites } from '../components/RefChip'
import { Spinner } from '../components/Spinner'
import { api } from '../lib/api'
import { hhmm } from '../lib/time'
import { parseRef } from '../lib/refs'
import { teleport } from '../lib/teleport'
import type { Cell, WriteupFigure } from '../lib/types'
import { useReportCtx } from './context'
import { figureCandidates, readableText } from './model'

const FIGURE_TABLE_ROWS = 20

export interface FigureBlockProps {
  block: { id: string; props: { cell: string; caption: string } }
  editor: BlockNoteEditor<any, any, any>
}

const artifactKind = (c: Cell) => primaryArtifact(c.outputs)?.kind ?? null

const figureCells = new Map<string, Promise<Cell | null>>()

/** The cell a figure shows, fetched once per workspace and cell: any card, with outputs (a run) or without (a note, an
 * example, a label). */
export function fetchFigureCell(ws: string, ref: string): Promise<Cell | null> {
  const p = parseRef(ref)
  const cellId = p?.kind === 'cell' ? p.cellId : ref
  const key = `${ws}:${cellId}`
  let hit = figureCells.get(key)
  if (!hit) {
    hit = api
      .resolveRef(ws, `card:${cellId}`)
      .then((r) => {
        const rec = r.record
        return r.kind === 'cell' && rec && typeof rec === 'object' && typeof rec.id === 'string' ? (rec as Cell) : null
      })
      .catch(() => null)
    figureCells.set(key, hit)
  }
  return hit
}

/** A card changed on the canvas (a rerun, a new takeaway): the next figure that shows it fetches it again. */
export function forgetFigureCell(ws: string, cellId: string): void {
  figureCells.delete(`${ws}:${cellId}`)
}

function storedFigure(sections: { figures?: WriteupFigure[] }[] | undefined, id: string): WriteupFigure | undefined {
  for (const sec of sections ?? []) for (const f of sec.figures ?? []) if (f.id === id) return f
  return undefined
}

export function FigureBlock({ block, editor }: FigureBlockProps) {
  const { ws, docRef, readOnly } = useReportCtx()
  const stored = storedFigure(docRef.current?.sections, block.id)
  const setProps = (props: Partial<{ cell: string; caption: string }>) => editor.updateBlock(block.id, { props: { ...block.props, ...props } })
  const remove = () => editor.removeBlocks([block.id])
  const pending = !block.props.cell && !!stored?.make && (stored.status ?? 'pending') === 'pending'
  if (!block.props.cell && !pending) {
    if (readOnly) return null
    return (
      <div className="wu-fig wu-fig-pick" contentEditable={false}>
        <FigurePicker ws={ws} onPick={(c) => setProps({ cell: `card:${c.id}`, caption: block.props.caption || readableText(c.takeaway || c.title || '') })} onClose={remove} />
      </div>
    )
  }
  return <Figure ws={ws} id={block.id} cellRef={block.props.cell} caption={block.props.caption} stored={stored} readOnly={!!readOnly} onCaption={(v) => setProps({ caption: v })} onRemove={remove} />
}

/** A figure standing on its own, outside the editor, from its stored record: a scene's or a slide's figure. `bare`
 * draws the chart alone, without the card's frame, question and caption (a slide carries its own heading). */
export function FigureView({ ws, figure, bare = false }: { ws: string; figure: WriteupFigure; bare?: boolean }) {
  const pending = !figure.cell && !!figure.make && (figure.status ?? 'pending') === 'pending'
  if (!figure.cell && !pending) return null
  return <Figure ws={ws} id={figure.id} cellRef={figure.cell ?? ''} caption={figure.caption ?? ''} stored={figure} readOnly bare={bare} />
}

interface FigureProps {
  ws: string
  id: string
  cellRef: string
  caption: string
  stored: WriteupFigure | undefined
  readOnly: boolean
  bare?: boolean
  onCaption?: (caption: string) => void
  onRemove?: () => void
}

/** The width inside an element's padding, where its children lay out. */
function contentWidth(el: HTMLElement): number {
  const cs = getComputedStyle(el)
  return Math.floor(el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0))
}

function Figure({ ws, id, cellRef, caption, stored, readOnly, bare = false, onCaption, onRemove }: FigureProps) {
  const pending = !cellRef && !!stored?.make && (stored.status ?? 'pending') === 'pending'
  // Measure the figure's own element, not its body: the body draws nothing until it has a width, so a body measured at 0
    // in a hidden tab would stay at 0. A width of 0 keeps the last one, so the chart is not redrawn on every tab switch.
    // The measured element changes when the picker gives way to the figure, so it is state, not a ref.
  const [box, setBox] = useState<HTMLElement | null>(null)
  const [width, setWidth] = useState(0)
  const [cell, setCell] = useState<Cell | null | undefined>(undefined)
  const concepts = useConcepts(ws)

  useEffect(() => {
    let live = true
    setCell(undefined)
    if (!cellRef) return
    void fetchFigureCell(ws, cellRef).then((c) => live && setCell(c))
    return () => {
      live = false
    }
  }, [ws, cellRef])
  useLayoutEffect(() => {
    const el = box
    if (!el) return
    const measure = () => {
      const w = el.isConnected ? contentWidth(el) : 0
      if (w > 0) setWidth(w)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [box])

  const art = cell ? primaryArtifact(cell.outputs) : null
  const shown = art && art.kind !== 'error' ? art.bundle : null
  const body = pending ? (
    <div className="wu-fig-making">
      <Spinner label="working" /> <span>{stored?.make}</span>
    </div>
  ) : cell === undefined && cellRef ? (
    <div className="wu-fig-loading">
      <Spinner label="working" />
    </div>
  ) : shown && width > 0 ? (
    <FigureOutput table={art?.kind === 'table'} out={outIndex(cell?.outputs, shown)}>
      <Output bundle={shown} fitWidth={width} maxLines={30} maxRows={FIGURE_TABLE_ROWS} labels={chartLabels(cell?.labels, concepts)} />
    </FigureOutput>
  ) : cell && !art && width > 0 ? (
    <CardFigure ws={ws} cell={cell} width={width} />
  ) : null
  if (bare) {
    return (
      <div className="wu-fig-bare" ref={setBox} data-anchor={cellRef || undefined} data-anchor-text={caption} data-anchor-parts="">
        {body}
      </div>
    )
  }
  // the caption under the rule: the writer's or the analyst's; a locked figure without one shows the card's takeaway
  const take = caption || (readOnly ? readableText(cell?.takeaway ?? '') : '')
  return (
    <figure className="wu-fig" ref={setBox} data-fig={id} data-anchor={cellRef || undefined} data-anchor-text={caption || cell?.title || ''} data-anchor-parts="" contentEditable={false}>
      {!pending && (
        <div className="wu-fig-head">
          <span className="wu-fig-q">{cell?.title || (cell === null ? 'The card is gone' : '')}</span>
          {cellRef && (
            <button type="button" className="wu-fig-from" onClick={() => teleport(cellRef)}>
              from canvas
            </button>
          )}
          {!readOnly && onRemove && <Button variant="icon" size="sm" icon="x" title="Remove" aria-label="Remove" className="wu-fig-x" onClick={onRemove} />}
        </div>
      )}
      <div className="wu-fig-body">
        {body}
      </div>
      {/* a pending figure's caption is its request, already shown beside the spinner; the caption field fits its text once
          the block is laid out: it mounts before the first measure, so it remounts once */}
      {!pending && (readOnly ? !!take : !!onCaption) && (
        <div className="wu-fig-take">
          {readOnly || !onCaption ? (
            <span className="wu-fig-caption wu-fig-caption-read">{take}</span>
          ) : (
            <TextArea key={width > 0 ? 'laid-out' : 'unmeasured'} bare block autoGrow rows={1} className="wu-fig-caption" value={caption} onChange={(v) => onCaption(v.replace(/\n+/g, ' '))} aria-label="Caption" />
          )}
        </div>
      )}
    </figure>
  )
}

/** A card without a run to show, drawn by the canvas's own body for its kind (canvas/bodies CardBody), so a note, an
 * example, a label, a timeline or a custom card reads in the report as it does on the board. */
function CardFigure({ ws, cell, width }: { ws: string; cell: Cell; width: number }) {
  const board = useContext(CanvasContext)
  const ctx = useMemo(() => ({ ...board, ws }), [board, ws])
  const payload = (cell.payload ?? {}) as Record<string, unknown>
  const label = useConceptDetail(ws, cell.kind === 'label' && typeof payload.concept === 'string' ? payload.concept : null)
  return (
    <CanvasContext.Provider value={ctx}>
      <GlyphCites.Provider value={true}>
        {/* the wrapper keeps the body from reading as :empty (report.css hides an empty body) while it has nothing yet,
            such as a label whose definition is still loading */}
        <div className="wu-fig-card">
          <CardBody cell={cell} width={width} label={label} />
        </div>
      </GlyphCites.Provider>
    </CanvasContext.Provider>
  )
}

/**
 * The chart or table of a figure. A table wider than the column scrolls inside its box, and the box carries
 * `wu-fig-overflow` while it does, so the stylesheet draws a fade at the right edge where the table continues.
 */
function FigureOutput({ table, out, children }: { table?: boolean; out: number; children: ReactNode }) {
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  const [overflow, setOverflow] = useState(false)
  useLayoutEffect(() => {
    if (!el) return
    const check = () => setOverflow(el.scrollWidth > el.clientWidth + 1)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    for (const kid of Array.from(el.children)) ro.observe(kid)
    return () => ro.disconnect()
  }, [el, children])
  if (!table)
    return (
      <div className="wu-fig-chart" data-out={out}>
        {children}
      </div>
    )
  return (
    <div className={`wu-fig-scroll${overflow ? ' wu-fig-overflow' : ''}`} data-out={out}>
      <div className="wu-fig-chart wu-fig-table" ref={setEl}>
        {children}
      </div>
    </div>
  )
}

/** The cards a figure can show, from the canvas: a chart or a table each, one Card row per card with its kind and its time (who made it is not shown: the thread is the author). */
export function FigurePicker({ ws, onPick, onClose }: { ws: string; onPick: (cell: Cell) => void; onClose: () => void }) {
  const [state, setState] = useState<{ status: 'loading' } | { status: 'ok'; cells: Cell[] } | { status: 'error'; message: string }>({ status: 'loading' })
  useEffect(() => {
    let live = true
    api
      .canvas(ws)
      .then((r) => live && setState({ status: 'ok', cells: figureCandidates(r.cells, artifactKind) }))
      .catch((e) => live && setState({ status: 'error', message: (e as Error).message }))
    return () => {
      live = false
    }
  }, [ws])
  return (
    <div className="wu-picker" role="listbox" aria-label="Cards with a chart or a table">
      <div className="wu-picker-head">
        <span className="wu-head-spacer" />
        <Button variant="icon" size="sm" icon="x" title="Remove" aria-label="Remove" onClick={onClose} />
      </div>
      {state.status === 'loading' && (
        <div className="wu-picker-note">
          <Spinner label="Loading the cards" />
        </div>
      )}
      {state.status === 'error' && <div className="wu-picker-note wu-error-detail">{state.message}</div>}
      {state.status === 'ok' &&
        state.cells.map((c) => (
          <Card
            key={c.id}
            flat
            className="wu-picker-row"
            role="option"
            aria-selected={false}
            tabIndex={0}
            head={c.title || undefined}
            meta={
              <>
                <Chip kind="status">{artifactKind(c)}</Chip>
                <time className="time" dateTime={c.created_ts ?? c.ts}>
                  {hhmm(c.created_ts ?? c.ts)}
                </time>
              </>
            }
            onClick={() => onPick(c)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onPick(c)
            }}
          />
        ))}
    </div>
  )
}

