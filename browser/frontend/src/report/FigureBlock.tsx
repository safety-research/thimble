// The figure block: a canvas card embedded in the report, filling the page's column, with its question, its output at
// the card's width (or its body, for cards with no run), and a caption edited in place. In the editor the block's
// actions (chat, delete, lock) stand inside the card, at the right of its question line (Editor.tsx BlockActions).
// Before a card is picked the block is the picker. A figure follows its card: when the card changes (the stream's `cell`
// record) it is read again and drawn in place, and a caption that still says the card's takeaway word for word takes
// the new takeaway, also after a change made while the figure was not on the page (captionSource), unless the analyst
// locked the figure.
// In the editor the question line is a handle that moves the figure, as the block's actions in the gutter do.
// In a figure style (lib/theme FigureStyle) a figure is drawn as that style's figure instead (FigureInStyle).
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { SideMenuExtension, type BlockNoteEditor } from '@blocknote/core'
import { ChatMarkdown } from '../chat/markdown'
import { CITATION, takeawayChecks } from '../marks/marks'
import { CardBody, exampleRefs } from '../canvas/bodies'
import { useConceptDetail, useConcepts, type ConceptDetailState } from '../canvas/concepts'
import { CanvasContext } from '../canvas/context'
import { RefEditor } from '../canvas/RefEditor'
import { Button } from '../components/Button'
import { Card } from '../components/Card'
import { Chip } from '../components/Chip'
import { chartLabels, figureKind, isVegaLite, Output, outIndex, pickMime, primaryArtifact } from '../components/Outputs'
import { GlyphCites } from '../components/RefChip'
import { Spinner } from '../components/Spinner'
import { Figure as StyledFigure } from '../figures/Figure'
import { BLOG_FIGURE, captionParts, headline, paperFit, paperSize, takeawayHeadline } from '../figures/figure'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import { hhmm } from '../lib/time'
import { parseRef } from '../lib/refs'
import { track } from '../lib/telemetry'
import { useTheme, type FigureStyle } from '../lib/theme'
import type { CardVersion, Cell, WriteupFigure } from '../lib/types'
import { useReportCtx } from './context'
import { anchorFor, figureCandidates, readableText } from './model'

const FIGURE_TABLE_ROWS = 20
/** How long a figure waits after its card's last change before it reads the card again, ms: the stream replays a
 * workspace's history when it opens, and a run changes a card several times. */
const FIGURE_REFETCH_MS = 300
/** The narrowest a figure's chart is laid out, px. In a narrower column (a narrow window, with the margin beside the
 * text) the chart keeps this width and scrolls in its box, as a wide table does: fitted narrower, its views get too
 * small to read. */
const FIGURE_CHART_MIN = 320

export interface FigureBlockProps {
  block: { id: string; props: { cell: string; caption: string } }
  editor: BlockNoteEditor<any, any, any>
}

const figureCells = new Map<string, Promise<Cell | null>>()

/** The card id a figure's `cell` names: `card:<id>`, or the bare id. */
const cellIdOf = (ref: string): string => {
  const p = parseRef(ref)
  return p?.kind === 'cell' ? p.cellId : ref
}

/** The cell a figure shows, fetched once per workspace and cell until the card changes: any card, with outputs (a run)
 * or without (a note, an example, a label). */
export function fetchFigureCell(ws: string, ref: string): Promise<Cell | null> {
  const cellId = cellIdOf(ref)
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

// A card changed on the canvas (a rerun, a new takeaway, a delete): the next read of it fetches it again. This handler is
// registered as the module loads, before any figure's own, so the figures that show the card share one new fetch.
bus.on('cell', (e) => {
  for (const key of Array.from(figureCells.keys())) if (key.endsWith(`:${e.cell}`)) figureCells.delete(key)
})

/** A card's takeaway as a caption says it: the words without citations, else its question, as a figure's caption starts
 * (FigurePicker, ReportPage captionOf). */
export const captionFrom = (cell: Pick<Cell, 'takeaway' | 'title'>): string => readableText(cell.takeaway || cell.title || '')

/** The caption a figure takes when its card changes from `was` to `now`: the new takeaway while the caption still says
 * the old one word for word (the analyst has not edited it), else null to keep it. A card with no takeaway yet (a rerun
 * clears it until a new one is written) changes no caption. Pure. */
export function followedCaption(caption: string, was: Pick<Cell, 'takeaway' | 'title'>, now: Pick<Cell, 'takeaway' | 'title'>): string | null {
  const next = readableText(now.takeaway || '')
  if (!next || readableText(caption) !== captionFrom(was) || next === readableText(caption)) return null
  return next
}

/** A card as it stood before one of its edits, by workspace, card and edit: read once, since it never changes. */
const figureVersions = new Map<string, Promise<CardVersion['version'] | null>>()

function versionBefore(ws: string, cellId: string, entry: string): Promise<CardVersion['version'] | null> {
  const key = `${ws}:${cellId}:${entry}`
  let hit = figureVersions.get(key)
  if (!hit) {
    hit = api.cardVersion(ws, cellId, entry).then(
      (v) => v.version,
      () => null,
    )
    figureVersions.set(key, hit)
  }
  return hit
}

/** The card as it stood when `caption` said its takeaway word for word (else its question), from the versions before
 * its edits of its takeaway or question, newest first; null when the caption says none of them. For a figure whose card
 * changed while no figure of it was on the page, such as before the Report was first shown or while the page was closed. */
export async function captionSource(ws: string, cell: Pick<Cell, 'id' | 'edited'>, caption: string): Promise<Pick<Cell, 'takeaway' | 'title'> | null> {
  const said = readableText(caption)
  if (!said) return null
  const edits = (cell.edited ?? []).filter((e) => e.id && e.fields?.some((f) => f === 'takeaway' || f === 'title')).reverse()
  for (const e of edits) {
    const v = await versionBefore(ws, cell.id, e.id as string)
    if (v && captionFrom(v) === said) return v
  }
  return null
}

function storedFigure(sections: { figures?: WriteupFigure[] }[] | undefined, id: string): WriteupFigure | undefined {
  for (const sec of sections ?? []) for (const f of sec.figures ?? []) if (f.id === id) return f
  return undefined
}

/** What makes the question line a handle that moves the figure block: the drag the block's actions in the gutter start
 * (BlockNote's side menu, Editor.tsx BlockActions), so it shows the same drop line and lands the same way. None outside
 * an editor that has the side menu. */
export interface FigureDrag {
  onDragStart: (e: DragEvent<HTMLElement>) => void
  onDragEnd: () => void
}

/** The end of the question-line drag that is under way, waiting for its drop (figureDrag). */
let pendingDrop: (() => void) | null = null

function figureDrag(editor: BlockNoteEditor<any, any, any>, blockId: string, slug: string): FigureDrag | undefined {
  const sideMenu = editor.getExtension?.(SideMenuExtension)
  if (!sideMenu) return undefined
  const stopWaiting = () => {
    if (pendingDrop) document.removeEventListener('drop', pendingDrop)
    pendingDrop = null
  }
  return {
    onDragStart: (e) => {
      const block = editor.getBlock(blockId)
      if (!block) return e.preventDefault()
      const source = e.currentTarget
      stopWaiting()
      sideMenu.blockDragStart(e, block)
      // a drop that moves the figure takes the question line that started the drag off the page with its old block, so
      // its dragend never reaches the page: once the drop is handled, the drag is ended here, the drag picture taken
      // away, and the page hears the end it would have heard (the editor's caret and focus, BlockNote's drag state)
      const dropped = () => {
        stopWaiting()
        window.setTimeout(() => {
          if (source.isConnected) return // its own dragend comes
          sideMenu.blockDragEnd()
          document.dispatchEvent(new Event('dragend'))
        }, 0)
      }
      pendingDrop = dropped
      document.addEventListener('drop', dropped)
      track('ui-click', { target: anchorFor(slug, { id: block.id, type: block.type }), detail: { action: 'block-move', handle: 'question' } })
    },
    onDragEnd: () => {
      stopWaiting()
      sideMenu.blockDragEnd()
    },
  }
}

export function FigureBlock({ block, editor }: FigureBlockProps) {
  const { ws, slug, docRef } = useReportCtx()
  const stored = storedFigure(docRef.current?.sections, block.id)
  const setProps = (props: Partial<{ cell: string; caption: string }>) => editor.updateBlock(block.id, { props: { ...block.props, ...props } })
  const remove = () => editor.removeBlocks([block.id])
  const pending = !block.props.cell && !!stored?.make && (stored.status ?? 'pending') === 'pending'
  if (!block.props.cell && !pending) {
    return (
      <div className="wu-fig wu-fig-pick" contentEditable={false}>
        <FigurePicker ws={ws} onPick={(c) => setProps({ cell: `card:${c.id}`, caption: block.props.caption || captionFrom(c) })} onClose={remove} />
      </div>
    )
  }
  const drag = figureDrag(editor, block.id, slug)
  // a change of the card carries an unedited caption to the new takeaway, except on a locked figure, which no model's
  // change reaches; the lock is read when the change comes, from the document as last saved
  const follow = (v: string) => {
    if (!storedFigure(docRef.current?.sections, block.id)?.locked) setProps({ caption: v })
  }
  return <Figure ws={ws} id={block.id} cellRef={block.props.cell} caption={block.props.caption} stored={stored} onCaption={(v) => setProps({ caption: v })} onFollow={follow} drag={drag} />
}

interface FigureProps {
  ws: string
  id: string
  cellRef: string
  caption: string
  stored: WriteupFigure | undefined
  onCaption?: (caption: string) => void
  /** the caption a change of the card carries over (followedCaption), in the editor */
  onFollow?: (caption: string) => void
  /** the question line's drag, in the editor */
  drag?: FigureDrag
}

/** The width inside an element's padding, where its children lay out. */
function contentWidth(el: HTMLElement): number {
  const cs = getComputedStyle(el)
  return Math.floor(el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0))
}

function Figure({ ws, id, cellRef, caption, stored, onCaption, onFollow, drag }: FigureProps) {
  const pending = !cellRef && !!stored?.make && (stored.status ?? 'pending') === 'pending'
  // Measure the figure's own element, not its body: the body draws nothing until it has a width, so a body measured at 0
    // in a hidden tab would stay at 0. A width of 0 keeps the last one, so the chart is not redrawn on every tab switch.
    // The measured element changes when the picker gives way to the figure, so it is state, not a ref.
  const [box, setBox] = useState<HTMLElement | null>(null)
  const [width, setWidth] = useState(0)
  const [cell, setCell] = useState<Cell | null | undefined>(undefined)
  // the caption edited in place, and where the click that opened it landed
  const [editing, setEditing] = useState<{ at: { x: number; y: number } | null } | null>(null)
  const concepts = useConcepts(ws)
  const { figures } = useTheme()
  // a label card's label, for its figure in a figure style (CardFigure reads its own in thimble's)
  const payload = (cell?.payload ?? {}) as Record<string, unknown>
  const label = useConceptDetail(ws, figures !== 'thimble' && cell?.kind === 'label' && typeof payload.concept === 'string' ? payload.concept : null)
  // the card is its citations' home, so a citation of its own table marks the cell in place, as on the canvas
  const citeHome = cellRef ? cellIdOf(cellRef) : undefined
  // the card as the caption last followed it, the latest caption and its setter, read by the card's updates
  const followed = useRef<Cell | null>(null)
  const captionNow = useRef({ caption, onFollow })
  captionNow.current = { caption, onFollow }
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => void (mounted.current = false)
  }, [])

  // the card, read again whenever it changes, so the figure redraws in place; while the card runs again the figure keeps
  // what it showed, and only the newest read is shown
  useEffect(() => {
    let live = true
    let seq = 0
    let timer: number | null = null
    setCell(undefined)
    followed.current = null
    if (!cellRef) return
    const id = cellIdOf(cellRef)
    const read = () => {
      const mine = ++seq
      void fetchFigureCell(ws, cellRef).then((c) => {
        if (!live || mine !== seq) return
        setCell((prev) => (c && prev && c.status === 'running' ? prev : c))
      })
    }
    read()
    const off = bus.on('cell', (e) => {
      if (e.cell !== id && e.cell !== followed.current?.id) return
      if (timer != null) window.clearTimeout(timer)
      timer = window.setTimeout(read, FIGURE_REFETCH_MS)
    })
    return () => {
      live = false
      if (timer != null) window.clearTimeout(timer)
      off()
    }
  }, [ws, cellRef])
  // a caption that still says the card's takeaway follows it to the new one
  useEffect(() => {
    if (!cell) return
    const was = followed.current
    const { caption: now, onFollow: set } = captionNow.current
    const next = was && set ? followedCaption(now, was, cell) : null
    // a card with no takeaway yet is not followed, so the caption is matched against the takeaway it had
    if (!was || cell.takeaway || !was.takeaway) followed.current = cell
    if (next != null) set?.(next)
    // the first read: a caption that says an earlier takeaway of the card, which changed while this figure was not on
    // the page, follows it as well, unless the caption or the card changed meanwhile
    if (was || !set || !cell.takeaway || readableText(now) === captionFrom(cell)) return
    void captionSource(ws, cell, now).then((source) => {
      const cur = captionNow.current
      const card = followed.current
      if (!source || !mounted.current || cur.caption !== now || card?.id !== cell.id) return
      const carried = followedCaption(cur.caption, source, card)
      if (carried != null) cur.onFollow?.(carried)
    })
  }, [cell, ws])
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
  const wide = shown && width < FIGURE_CHART_MIN && isVegaLite(pickMime(shown) ?? '') ? FIGURE_CHART_MIN : undefined
  const body = pending ? (
    <div className="wu-fig-making">
      <Spinner label="working" /> <span>{stored?.make}</span>
    </div>
  ) : cell === undefined && cellRef ? (
    <div className="wu-fig-loading">
      <Spinner label="working" />
    </div>
  ) : shown && width > 0 ? (
    <FigureOutput table={art?.kind === 'table'} wide={wide} out={outIndex(cell?.outputs, shown)}>
      <Output bundle={shown} fitWidth={wide ?? width} maxLines={30} maxRows={FIGURE_TABLE_ROWS} labels={chartLabels(cell?.labels, concepts)} />
    </FigureOutput>
  ) : cell && !art && width > 0 ? (
    <CardFigure ws={ws} cell={cell} width={width} />
  ) : null
  // the caption under the rule: the writer's or the analyst's; a locked figure without one shows the card's takeaway.
  // While it says the card's takeaway word for word it is shown as the takeaway, with its citations, as on the canvas
  const takeaway = cell?.takeaway ?? ''
  const take = takeaway && caption && readableText(caption) === readableText(takeaway) ? takeaway : caption
  const editable = !!onCaption
  // the caption field's text when it closes: kept as the caption unless it still says `shown`, what the field opened on
  const done = (shown: string) => (v: string) => {
    setEditing(null)
    const next = v.replace(/\s*\n+\s*/g, ' ').trim()
    if (next !== shown.trim()) onCaption?.(next)
  }
  // in a figure style a card that stands drawn is the style's figure, which says its caption, else the card's takeaway:
  // a caption that only repeats the card's question, which a figure written without one keeps, says nothing of its own
  // (backend exports._own). A figure being made, still read or whose card is gone stays as the report draws it
  if (figures !== 'thimble' && !pending && cell) {
    const said = take && readableText(take) !== readableText(cell.title ?? '') ? take : takeaway
    return (
      <figure className={`wu-fig wu-fig-${figures}`} ref={setBox} data-fig={id} data-anchor={cellRef || undefined} data-anchor-text={caption || cell.title || ''} data-anchor-parts="" data-cite-home={citeHome} contentEditable={false}>
        <FigureInStyle ws={ws} cell={cell} style={figures} width={width} label={label} caption={said} table={art?.kind === 'table'} body={body} editing={editing} onEdit={editable ? setEditing : undefined} onDone={done(said)} />
      </figure>
    )
  }
  return (
    <figure className="wu-fig" ref={setBox} data-fig={id} data-anchor={cellRef || undefined} data-anchor-text={caption || cell?.title || ''} data-anchor-parts="" data-cite-home={citeHome} contentEditable={false}>
      {!pending && (
        <div className="wu-fig-head">
          <span className="wu-fig-q" draggable={drag ? true : undefined} onDragStart={drag?.onDragStart} onDragEnd={drag?.onDragEnd}>
            {cell?.title || (cell === null ? 'The card is gone' : '')}
          </span>
        </div>
      )}
      <div className="wu-fig-body">
        {body}
      </div>
      {/* a pending figure's caption is its request, already shown beside the spinner. A click on the caption (not on a
          citation, which opens its evidence) edits it in place with its citations as tokens, as a takeaway on the canvas */}
      {!pending && (editable || !!take) && (
        <div className="wu-fig-take">
          {editing ? (
            <RefEditor className="wu-fig-caption chat-text" label="Caption" value={take} at={editing.at} onDone={done(take)} />
          ) : (
            <div
              ref={editable ? keepFromEditor : undefined}
              className={'wu-fig-caption chat-text' + (editable ? '' : ' wu-fig-caption-read') + (take ? '' : ' wu-fig-caption-empty')}
              role={editable ? 'textbox' : undefined}
              aria-label={editable ? 'Caption' : undefined}
              tabIndex={editable ? 0 : undefined}
              onClick={editable ? (e) => !(e.target as Element).closest(CITATION) && setEditing({ at: { x: e.clientX, y: e.clientY } }) : undefined}
              onKeyDown={editable ? (e) => e.key === 'Enter' && (e.preventDefault(), setEditing({ at: null })) : undefined}
            >
              {take && <ChatMarkdown text={take} checks={cell && take === takeaway ? takeawayChecks(cell) : undefined} among={cell ? exampleRefs(cell) : undefined} linked={!!cell && take === takeaway} />}
            </div>
          )}
        </div>
      )}
    </figure>
  )
}

/** A press on the caption is the caption's, not the editor's: the report's editor (ProseMirror) hears a press inside a
 * figure before React does and selects the figure, taking the focus from the caption field the click opens. A native
 * listener on the caption stops the press there; the caption's own handlers listen to the click. */
function keepFromEditor(el: HTMLElement | null) {
  el?.addEventListener('mousedown', (e) => e.stopPropagation())
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

interface FigureInStyleProps {
  ws: string
  cell: Cell
  style: Exclude<FigureStyle, 'thimble'>
  /** the figure's width in the column, px; 0 before it was measured */
  width: number
  label: ConceptDetailState
  /** what the figure says: its caption, else the card's takeaway */
  caption: string
  /** a table card, whose table (`body`, as the report draws it) Paper sets as wide as the text */
  table: boolean
  body: ReactNode
  editing: { at: { x: number; y: number } | null } | null
  /** a click or Enter on the caption opens its field, in the editor */
  onEdit?: (editing: { at: { x: number; y: number } | null }) => void
  onDone: (caption: string) => void
}

/** A figure in a figure style, as the export draws it (figures/Figure): Blog's panel at the column's width, at most its
 * own, with the caption as its headline in plain words and the question under it, or the first sentence of a caption
 * that is the card's takeaway, as any Blog figure heads with its card's takeaway; Paper's chart with its legend under it
 * in two columns, as paper-figure's LaTeX places its legend file, or a table as wide as the text, then the caption
 * `Figure N. Takeaway. Question`, its number the page's count of figures (report.css). A click on the headline or the
 * caption edits the caption in place, as on a figure in thimble's style. */
function FigureInStyle({ ws, cell, style, width, label, caption, table, body, editing, onEdit, onDone }: FigureInStyleProps) {
  const board = useContext(CanvasContext)
  const concepts = useConcepts(ws)
  const ctx = useMemo(() => ({ ...board, ws, concepts }), [board, ws, concepts])
  const field = (shown: ReactNode) =>
    editing ? (
      <RefEditor className="wu-fig-said" label="Caption" value={caption} at={editing.at} onDone={onDone} />
    ) : onEdit ? (
      <span
        ref={keepFromEditor}
        className="wu-fig-said"
        role="textbox"
        aria-label="Caption"
        tabIndex={0}
        onClick={(e) => onEdit({ at: { x: e.clientX, y: e.clientY } })}
        onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), onEdit({ at: null }))}
      >
        {shown}
      </span>
    ) : (
      shown
    )
  const said = readableText(caption) === readableText(cell.takeaway ?? '') ? takeawayHeadline(caption) : headline(caption)
  const parts = captionParts(0, caption, cell.title)
  // a Paper figure wider than the column (two columns' 509 px in a narrow text column) is drawn smaller, whole
  const fit = style === 'paper' && !table ? paperFit(width, paperSize(cell).width) : 1
  return (
    <CanvasContext.Provider value={ctx}>
      <GlyphCites.Provider value={true}>
        {style === 'blog' ? (
          width > 0 && <StyledFigure cell={cell} style="blog" label={label} width={Math.min(width, BLOG_FIGURE.width)} headline={said ? field(said) : undefined} />
        ) : (
          <>
            {table ? (
              <div className="wu-fig-art wu-fig-art-table">{body}</div>
            ) : (
              <div className="wu-fig-art" style={fit < 1 ? { zoom: fit } : undefined}>
                <StyledFigure cell={cell} style="paper" label={label} />
                <StyledFigure cell={cell} style="paper" part="legend" columns={2} label={label} />
              </div>
            )}
            <figcaption className="wu-fig-cap">
              {field(
                <>
                  {parts.takeaway ? <b>{parts.takeaway}</b> : null}
                  {parts.takeaway && parts.question ? ' ' : null}
                  {parts.question}
                </>,
              )}
            </figcaption>
          </>
        )}
      </GlyphCites.Provider>
    </CanvasContext.Provider>
  )
}

/**
 * The chart, table or drawing of a figure. A table wider than the column, or a chart laid out `wide` (px) in a narrower one,
 * scrolls inside its box, and the box carries `wu-fig-overflow` while it does, so the stylesheet draws a fade at the
 * right edge where it continues.
 */
function FigureOutput({ table, wide, out, children }: { table?: boolean; wide?: number; out: number; children: ReactNode }) {
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
  if (!table && !wide)
    return (
      <div className="wu-fig-chart" data-out={out}>
        {children}
      </div>
    )
  return (
    <div className={`wu-fig-scroll${overflow ? ' wu-fig-overflow' : ''}`} data-out={out}>
      <div className={`wu-fig-chart ${table ? 'wu-fig-table' : 'wu-fig-wide'}`} ref={setEl}>
        {table ? children : <div style={{ width: wide }}>{children}</div>}
      </div>
    </div>
  )
}

/** The cards a figure can show, from the canvas: the cards that draw a figure (figureKind), one Card row per card with what it draws and its time (who made it is not shown: the thread is the author). */
export function FigurePicker({ ws, onPick, onClose }: { ws: string; onPick: (cell: Cell) => void; onClose: () => void }) {
  const [state, setState] = useState<{ status: 'loading' } | { status: 'ok'; cells: Cell[] } | { status: 'error'; message: string }>({ status: 'loading' })
  useEffect(() => {
    let live = true
    api
      .canvas(ws)
      .then((r) => live && setState({ status: 'ok', cells: figureCandidates(r.cells, figureKind) }))
      .catch((e) => live && setState({ status: 'error', message: (e as Error).message }))
    return () => {
      live = false
    }
  }, [ws])
  return (
    <div className="wu-picker" role="listbox" aria-label="Cards that draw a figure">
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
                <Chip kind="status">{figureKind(c)}</Chip>
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

