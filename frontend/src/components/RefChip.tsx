// A ref on every surface. Standalone (no `value`) it is a Chip: the icon of what it points to and a short name, the
// evidence chip for the data and the accent chip for the agent's work (refTone). Inside prose (`value`) it is an inline
// citation: the text itself is the link, with a quiet accent underline. `cite` marks a citation; in GlyphCites contexts
// a standalone citation is its target's glyph alone, a whole file's its name. The links toggle hides every citation
// (lib/links). Hovering shows the evidence in a label: the excerpt with the record's facts and the cited words
// highlighted; for a table cell (`card:<id>#<col>/<row>`) the table around it, or in place when the table is drawn right
// above; for printed output lines (`@out<i>#L<n>`) the lines around it; for a call (`call:<chat>/<n>`) its chip line over
// the cited output lines (lib/calls). A click, on the citation or on the chip that heads its label, teleports to the
// ref's surface (lib/teleport); a ⌘-click asks about it.
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import { openCited } from '../lib/citeTargets'
import { callOutput, callWords, fetchCall, onCallWords, outputLines } from '../lib/calls'
import { cellLabel, conceptLabel, ensureCellName, ensureConceptName, hasCellName, hasConceptName, onCellNames } from '../lib/cellName'
import { callLineText } from '../chat/model'
import { pointKeyHeld } from '../lib/platform'
import { cardPartLabel, cellSpanLabel, decodeLabel, hiddenPath, isEvidenceRef, parseRef, refLabel, shownValue } from '../lib/refs'
import { CITED, cellShown, cellWindow, citedLines, findCell, locateCell, readTable, restoreScroll, scrollWithin, valueSpan, visibleWithin, type At, type Grid, type Scrolled } from '../lib/tableCell'
import { teleport } from '../lib/teleport'
import type { Cell, ResolvedRef } from '../lib/types'
import { workspaceFromUrl } from '../lib/workspace'
import { Chip, type ChipTone } from './Chip'
import type { IconName } from './Icon'
import { chartLabels, Output, isNumericCell, primaryArtifact } from './Outputs'
import { useConcepts } from '../canvas/concepts'
import { Spinner } from './Spinner'
import { QuoteBox, RecordFacts } from '../canvas/Quote'
import { FACT_KINDS, markFacts, markValue, recordFacts, type RecordFact } from '../canvas/facts'
import { quoteParts, type QuotePart } from '../canvas/quotes'

/** The seven things a chip can point to, by the ref's kind; a record (a row of a file) is its file. */
const KIND_ICON: Record<string, IconName> = { cell: 'cell', group: 'group', concept: 'label', chat: 'thread', call: 'terminal', row: 'file', table: 'file', report: 'report', view: 'view' }
const INTERNAL = new Set(['cell', 'group', 'concept', 'report', 'view', 'call'])
/** The refs a chip names by a name in words (a label, a canvas group, a view, a thread, a document), set in the body
 * face; a card's id, a file, its lines and a call stay in mono. */
const NAME_KINDS = new Set(['concept', 'group', 'view', 'chat', 'report'])
export const kindIcon = (kind?: string): IconName => (kind && KIND_ICON[kind]) || 'file'
/** A ref's chip tone: the evidence chip for the data, the accent chip for what the agent made (lib/refs
 * isEvidenceRef). */
export const refTone = (ref: string): ChipTone => (isEvidenceRef(ref) ? 'evidence' : 'accent')

export { decodeLabel }

/** True where a standalone citation is its target's glyph alone, its name in the hover, so a long name does not crowd
 * the text: chat replies, inside a card's content wherever the card is drawn, and a report's text. A cited number stays
 * the link's text, and a whole file's citation its name. */
export const GlyphCites = createContext(false)

const ID_TOKEN = /\b(cell|concept|chat|group|report|view|call)[:]([A-Za-z0-9_-]{4,})(?:\/\d+)?(?:#[A-Za-z0-9_@.-]*)?/g
/** An id-looking `kind:<id>` replaced by its kind word, so a chip never shows a hash. */
export function scrubIds(s: string): string {
  return s.replace(ID_TOKEN, '$1')
}

export function compactLabel(ref: string): string {
  const p = parseRef(ref)
  if (!p) return scrubIds(ref.trim()) || 'reference'
  if (p.kind === 'cell') {
    const name = cellLabel(p.cellId) ?? 'card'
    // a table's cell is shown in its table, never named by its column and row
    if (p.col != null) return name
    if (p.out != null) return `${name} · ${cellSpanLabel(p)}`
    return name + (p.exec != null ? `@${p.exec}` : '')
  }
  if (p.kind === 'concept') return conceptLabel(p.conceptId) ?? refLabel(ref)
  return refLabel(ref)
}

/** A chip's name: a cell's or view's name alone, and for a ref into part of a card its table cell or lines (lib/refs
 * cardPartLabel), without the card's name when the chip sits in that card (`home`). Other refs read as compactLabel. */
export function chipLabel(ref: string, home?: string | null, ws = ''): string {
  const p = parseRef(ref)
  if (p?.kind === 'call') {
    // the chip line the call has in the thread, once a thread or a read registered it; its number until then
    const w = callWords(p.chat, p.n)
    const line = w ? callLineText(w.name, w.input, ws) : `call ${p.n}`
    return p.line != null ? `${line} · ${p.endLine != null ? `lines ${p.line}–${p.endLine}` : `line ${p.line}`}` : line
  }
  if (p?.kind === 'cell') {
    const name = cellLabel(p.cellId) ?? 'card'
    return cardPartLabel(p, name, home === p.cellId) ?? name + (p.exec != null ? `@${p.exec}` : '')
  }
  if (p?.kind === 'view' && p.key) return p.slug
  return compactLabel(ref)
}

/** Where inside its cell or view a ref points, for the hover label: an output's lines, a view's record key. A table's
 * cell is shown in its table instead, never named by its column and row. */
export function spanWhere(ref: string): string | undefined {
  const p = parseRef(ref)
  if (p?.kind === 'cell' && p.out != null) return cellSpanLabel(p) || undefined
  if (p?.kind === 'view' && p.key) return p.key
  return undefined
}

/** Where a view read the place: the view and its reader's label for a file ref a view resolves, the lines a view ref
 * stands for, so the hover always names the source under a view's excerpt. */
export function whereOf(r: ResolvedRef): string | undefined {
  if (r.view) return [r.view.name, r.view.label].filter(Boolean).join(' · ')
  if (r.kind === 'view' && r.refs?.length) {
    const first = refLabel(r.refs[0])
    const deleted = r.meta && (r.meta as { deleted?: boolean }).deleted ? ' · the view is deleted' : ''
    return (r.refs.length > 1 ? `${first} and ${r.refs.length - 1} more` : first) + deleted
  }
  return undefined
}

/** The subscription that redraws a chip when a name it shows becomes known: a card's, a label's, a call's chip line. */
const onNames = (fn: () => void): (() => void) => {
  const a = onCellNames(fn)
  const b = onCallWords(fn)
  return () => {
    a()
    b()
  }
}

/** the lines of a call's output its hover shows around the cited ones, and for a whole call from its start */
const CALL_CONTEXT = 2
const CALL_HEAD_LINES = 8

/** The lines a call's hover shows: the cited lines with CALL_CONTEXT lines on each side, marked, or the output's first
 * CALL_HEAD_LINES lines for the whole call; null when a cited line is not in the output. Pure. */
export function callWindow(text: string, line?: number, endLine?: number): { lines: string[]; from: number; to: number } | null {
  const all = outputLines(text)
  if (line == null) return { lines: all.slice(0, CALL_HEAD_LINES), from: -1, to: -2 }
  const end = endLine ?? line
  if (line < 1 || line > all.length) return null
  const lo = Math.max(1, line - CALL_CONTEXT)
  const hi = Math.min(all.length, end + CALL_CONTEXT)
  return { lines: all.slice(lo - 1, hi), from: line - lo, to: Math.min(end, all.length) - lo }
}

/** the label waits this long for the pointer to settle, then arrives in --dur-fast */
const HOVER_DELAY_MS = 90
const HIDE_DELAY_MS = 160
const EXCERPT_MAX = 400
/** the height a record in the hover label shows before it fades */
const QUOTE_MAX_H = 280
const POP_WIDTH = 360
const POP_WIDTH_CELL = 440
const POP_WIDTH_CHART = 640
const POP_WIDTH_TABLE = 680
const POP_PAD_X = 26
const POP_MARGIN = 8
const POP_GAP = 6

type Pop =
  | { state: 'loading'; rect: DOMRect }
  | { state: 'ok'; rect: DOMRect; excerpt: string; kind?: string; cell?: Cell; where?: string; table?: { grid: Grid; at: At }; lines?: CitedLines; parts?: QuotePart[]; facts?: RecordFact[] }
  | { state: 'error'; rect: DOMRect; message: string; detail?: string; muted?: boolean }
  | { state: 'name'; rect: DOMRect }

/** A printed output's lines around a cited one, and where the cited ones sit (lib/tableCell citedLines). */
type CitedLines = { lines: string[]; from: number; to: number }

/** The table a resolved cell citation read its value from (meta.table_html, a chart's rows as a table included), read
 * as a Grid with the cited cell located; null when the reply carries none or the cell is not in it. */
function citedTable(r: ResolvedRef, col: string, row: string): { grid: Grid; at: At } | null {
  const html = typeof r.meta?.table_html === 'string' ? r.meta.table_html : ''
  if (!html || typeof DOMParser === 'undefined') return null
  const table = new DOMParser().parseFromString(html, 'text/html').querySelector('table')
  if (!table) return null
  const { grid } = readTable(table)
  const span = r.meta?.span as { col?: unknown; row?: unknown } | undefined
  const at = locateCell(grid, col, row) ?? (typeof span?.col === 'string' && typeof span?.row === 'string' ? locateCell(grid, span.col, span.row) : null)
  return at ? { grid, at } : null
}

/** The tables of a card's own output (components/Outputs' html tables), where an in-place citation looks for its cell,
 * and the box that holds the output on the card and in its details. */
const OWN_TABLES = '.outputs-html table'
const OWN_BOX = '.bcell-output, .bdetail-artifact'

function cellOf(r: ResolvedRef): Cell | null {
  const rec = r.record
  if (r.kind !== 'cell' || !rec || typeof rec !== 'object' || typeof rec.id !== 'string' || !Array.isArray(rec.outputs)) return null
  return rec as Cell
}

export interface RefChipProps {
  ref: string
  /** the number or words rendered as prose with the ref behind them: the inline citation */
  value?: string
  compact?: boolean
  workspace?: string
  broken?: boolean
  brokenWhy?: string
  quiet?: boolean
  quietWhy?: string
  /** the chip arrived after the text it sits in: it fades in */
  late?: boolean
  /** the chip carries `data-anchor`, so a ⌘-click on it asks about its ref */
  anchor?: boolean
  /** a citation in prose: its target's glyph alone where GlyphCites holds (and for a card anywhere), and hidden while
   * the links are off */
  cite?: boolean
}

/** Place a body-portaled label beside the chip at `rect`, inside the viewport. */
export function placePop(el: HTMLElement, rect: DOMRect): void {
  const vw = window.innerWidth
  const vh = window.innerHeight
  el.style.left = `${POP_MARGIN}px`
  el.style.top = '0px'
  const w = el.offsetWidth
  const h = el.offsetHeight
  el.style.left = `${Math.max(POP_MARGIN, Math.min(rect.left, vw - w - POP_MARGIN))}px`
  const below = rect.bottom + POP_GAP
  const above = rect.top - POP_GAP
  const roomBelow = vh - POP_MARGIN - below
  const roomAbove = above - POP_MARGIN
  let top: number
  if (h <= roomBelow) top = below
  else if (h <= roomAbove) top = above - h
  else top = roomBelow >= roomAbove ? Math.max(POP_MARGIN, vh - POP_MARGIN - h) : POP_MARGIN
  el.style.top = `${top}px`
}

/** Whether ⌘ is picking (the pointer sets this on the body while it is live). */
const pointing = (): boolean => document.body.hasAttribute('data-cmd')

/** the ref kinds that are a record or part of one in a file, whose hover shows the record as it reads */
const FILE_KINDS = new Set(['record', 'range', 'block', 'span', 'page', 'pointer'])

/** the ref kinds with nothing to excerpt: the label names them and the click teleports */
const NAME_ONLY = new Set(['group', 'report', 'view', 'ui', 'chat'])

export function RefChip({ ref, value, compact, workspace, broken, brokenWhy, quiet, quietWhy, late, anchor, cite }: RefChipProps) {
  const ws = workspace ?? workspaceFromUrl() ?? ''
  const chipEl = useRef<HTMLElement>(null)
  const popEl = useRef<HTMLDivElement>(null)
  const showTimer = useRef<number | undefined>(undefined)
  const hideTimer = useRef<number | undefined>(undefined)
  const reqSeq = useRef(0)
  const [pop, setPop] = useState<Pop | null>(null)
  // the card the chip's text belongs to (a takeaway's card, its details): a ref into that card's own table or lines is
  // named without the card's name
  const [home, setHome] = useState<string | null>(null)
  useLayoutEffect(() => setHome(chipEl.current?.closest<HTMLElement>('[data-cite-home]')?.dataset.citeHome ?? null), [])
  const name = () => chipLabel(ref, home, ws)
  const label = useSyncExternalStore(onNames, name, name)
  const parsed = parseRef(ref)
  const unresolved = !parsed && !broken
  const wholeCell = parsed?.kind === 'cell' && parsed.col == null && parsed.out == null ? parsed.cellId : null
  const cellId = parsed?.kind === 'cell' ? parsed.cellId : null
  const conceptId = parsed?.kind === 'concept' ? parsed.conceptId : null
  const asText = value != null
  const icon = kindIcon(parsed?.kind)
  // a standalone citation of a card, or inside a card or report text (GlyphCites), is its glyph alone with its name in
  // the hover; a whole file's keeps its name, which a file's glyph does not tell, and so does a chip that lists what a
  // step made
  const glyphCites = useContext(GlyphCites)
  const wholeFile = parsed?.kind === 'path' && !parsed.locator
  const iconOnly = !asText && !broken && !!cite && !wholeFile && (glyphCites || parsed?.kind === 'cell')

  const call = parsed?.kind === 'call' ? parsed : null
  useEffect(() => {
    if (cellId && ws && !hasCellName(cellId)) void ensureCellName(ws, cellId)
    if (conceptId && ws && !hasConceptName(conceptId)) void ensureConceptName(ws, conceptId)
    // a call's chip line comes with its read from the store (lib/calls registers it)
    if (call && ws && !callWords(call.chat, call.n)) void fetchCall(ws, call.chat, call.n).catch(() => undefined)
  }, [ws, cellId, conceptId, call?.chat, call?.n])
  useEffect(
    () => () => {
      window.clearTimeout(showTimer.current)
      window.clearTimeout(hideTimer.current)
    },
    [],
  )

  // a cell of the card's own table marked in place while the citation is hovered, and the boxes scrolled to show it
  const inPlace = useRef<{ td: HTMLElement; scrolled: Scrolled[] } | null>(null)
  const unmark = () => {
    const cur = inPlace.current
    if (!cur) return
    inPlace.current = null
    cur.td.classList.remove(CITED)
    // a box the analyst cannot scroll (a sized card clips its body) goes back; a table they can scroll stays at the cell
    restoreScroll(cur.scrolled, true)
  }
  useEffect(() => unmark, [])
  /** The cited cell in the table drawn right above the citation: the card (or its details) the citation's own text sits
   * in holds the cited card's table, and the cell shows in it (not held back behind the table's row cap). */
  const ownCell = (): { td: HTMLElement; scrolled: Scrolled[] } | null => {
    if (parsed?.kind !== 'cell' || parsed.col == null || parsed.row == null) return null
    const home = chipEl.current?.closest<HTMLElement>('[data-cite-home]')
    if (!home || home.dataset.citeHome !== parsed.cellId) return null
    const hit = findCell(home, parsed.col, parsed.row, OWN_TABLES)
    if (!hit || !cellShown(hit)) return null
    // only the output's own boxes scroll, so the citation stays under the pointer; a cell that still does not show gets
    // the label instead
    const box = hit.td.closest<HTMLElement>(OWN_BOX) ?? home
    const scrolled = scrollWithin(hit.td, box)
    if (visibleWithin(hit.td, home)) return { td: hit.td, scrolled }
    restoreScroll(scrolled)
    return null
  }

  const cancelHide = () => window.clearTimeout(hideTimer.current)
  const scheduleHide = () => {
    cancelHide()
    hideTimer.current = window.setTimeout(() => setPop(null), HIDE_DELAY_MS)
  }
  const open = async () => {
    // under ⌘ the pointer's highlight speaks for the chip, so the evidence label stays shut
    if (pointing()) return
    const rect = chipEl.current?.getBoundingClientRect()
    if (!rect) return
    if (broken) return setPop({ state: 'error', rect, message: 'Unable to verify', detail: brokenWhy || undefined })
    if (quiet) return setPop({ state: 'error', rect, message: `Not linked${quietWhy ? ` — ${quietWhy}` : ''}`, muted: true })
    if (unresolved || !parsed) return setPop({ state: 'error', rect, message: 'Unknown reference', muted: true })
    if (NAME_ONLY.has(parsed.kind) && !(parsed.kind === 'view' && parsed.key)) {
      // a chip with its name already shows it; an inline citation's label, and a glyph alone's, names what it points to
      if (asText || iconOnly) setPop({ state: 'name', rect })
      return
    }
    // the cited table is the one right above: it scrolls to the cell and marks it, and no label opens over it
    unmark()
    const own = ownCell()
    if (own) {
      own.td.classList.add(CITED)
      inPlace.current = own
      return
    }
    setPop({ state: 'loading', rect })
    const seq = ++reqSeq.current
    if (parsed.kind === 'call') {
      // a call: its chip line over the cited lines of its whole output, the value marked, never its number in words
      try {
        const c = await fetchCall(ws, parsed.chat, parsed.n)
        if (seq !== reqSeq.current) return
        const lines = callWindow(callOutput(c), parsed.line, parsed.endLine)
        if (!lines) return setPop({ state: 'error', rect, message: 'This line is not in the call\'s output' })
        // an inline citation's head, and a glyph alone's, already names the call by its chip line; a chip's name may be
        // cut short
        return setPop({ state: 'ok', rect, excerpt: '', kind: 'call', where: asText || iconOnly ? undefined : callLineText(c.name, c.input, ws), lines })
      } catch (err) {
        if (seq !== reqSeq.current) return
        return setPop({ state: 'error', rect, message: 'Could not load this call', detail: (err as Error).message || undefined })
      }
    }
    try {
      const r = await api.resolveRef(ws, ref)
      if (seq !== reqSeq.current) return
      if (parsed.kind === 'cell' && parsed.col != null && parsed.row != null) {
        // a table's cell: the table around it, never its column and row in words
        const table = citedTable(r, parsed.col, parsed.row)
        if (table) return setPop({ state: 'ok', rect, excerpt: '', kind: 'cell', table })
        return setPop({ state: 'error', rect, message: 'This cell is no longer in the card\'s table' })
      }
      if (parsed.kind === 'cell' && parsed.out != null && parsed.line != null) {
        // a line of the card's printed output: the lines around it with the value marked, never its line number in words
        const span = r.meta?.span as { text?: unknown } | undefined
        const lines = typeof span?.text === 'string' ? citedLines(r.excerpt ?? '', span.text, parsed.line) : null
        if (lines) return setPop({ state: 'ok', rect, excerpt: '', kind: 'cell', lines })
        return setPop({ state: 'error', rect, message: 'This line is no longer in the card\'s output' })
      }
      const cell = wholeCell ? cellOf(r) : null
      const where = [hiddenPath(ref), spanWhere(ref), whereOf(r)].filter(Boolean).join(' · ') || undefined
      // a record of a file reads as the record (canvas/quotes), never its JSON or markdown source, with the cited words
      // marked and its facts over it (canvas/facts)
      const quoted = !cell && ((FILE_KINDS.has(r.kind) && (r.blocks?.length || r.view)) || r.kind === 'row' || r.kind === 'csvrow') ? quoteParts(r) : undefined
      const parts = quoted ? markValue(quoted, value) : undefined
      const facts = !cell && FACT_KINDS.has(r.kind) ? markFacts(recordFacts(r), value) : undefined
      setPop(cell ? { state: 'ok', rect, excerpt: r.excerpt ?? '', kind: 'cell', cell } : { state: 'ok', rect, excerpt: r.excerpt ?? '', kind: r.kind, where, parts, facts })
    } catch (err) {
      if (seq !== reqSeq.current) return
      setPop({ state: 'error', rect, message: 'Could not load this reference', detail: (err as Error).message || undefined })
    }
  }
  const onEnter = () => {
    cancelHide()
    window.clearTimeout(showTimer.current)
    if (home) bus.emit('citeHover', { card: home, ref })
    if (pointing()) return
    showTimer.current = window.setTimeout(() => void open(), HOVER_DELAY_MS)
  }
  const onLeave = () => {
    if (home) bus.emit('citeHover', { card: home, ref: null })
    window.clearTimeout(showTimer.current)
    reqSeq.current++
    unmark()
    scheduleHide()
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') onClick(e)
  }
  const onClick = (e: React.MouseEvent | React.KeyboardEvent) => {
    // a ⌘-click is the pointer's: it asks about the ref and never leaves the page
    if ('metaKey' in e && pointKeyHeld(e)) return
    e.stopPropagation()
    window.clearTimeout(showTimer.current)
    setPop(null)
    unmark()
    if (unresolved) return
    if (home && openCited(home, ref)) return
    teleport(ref)
  }

  const kind = asText ? undefined : parsed?.kind
  const anchorAttrs = anchor && !unresolved ? { 'data-anchor': ref, 'data-anchor-text': value ?? label } : {}
  const cls = ['refchip', asText ? 'refchip-value' : '', cite ? 'refchip-citation' : '', iconOnly ? 'refchip-icon' : '', kind && INTERNAL.has(kind) ? 'refchip-internal' : '', broken ? 'broken' : '', quiet && !broken ? 'refchip-quiet' : '', unresolved ? 'refchip-unresolved' : '', compact ? 'refchip-compact' : '', late ? 'refchip-late' : '']
    .filter(Boolean)
    .join(' ')
  const artifact = pop?.state === 'ok' && pop.cell ? primaryArtifact(pop.cell.outputs) : null
  const chartFrame = !!wholeCell && artifact?.kind === 'chart'
  // a table's cell and a printed output's line are both shown in the data around them, at the table label's size
  const tableFrame = pop?.state === 'ok' && (!!pop.table || !!pop.lines)
  const popWidth = chartFrame ? Math.min(POP_WIDTH_CHART, Math.floor(window.innerWidth * 0.7)) : tableFrame ? undefined : wholeCell ? POP_WIDTH_CELL : POP_WIDTH
  const interactive = !unresolved
  const handlers = { onMouseEnter: onEnter, onMouseLeave: onLeave, onFocus: onEnter, onBlur: onLeave, onKeyDown: onKey, onClick }

  useLayoutEffect(() => {
    const el = popEl.current
    if (!el || !pop) return
    const place = () => placePop(el, pop.rect)
    place()
    const ro = new ResizeObserver(place)
    ro.observe(el)
    return () => ro.disconnect()
  }, [pop])

  return (
    <>
      {asText ? (
        <span ref={chipEl as React.Ref<HTMLSpanElement>} className={cls} data-ref={ref} {...anchorAttrs} tabIndex={interactive ? -1 : undefined} role={interactive ? 'link' : undefined} {...handlers}>
          {shownValue(value ?? '')}
        </span>
      ) : (
        <Chip kind="ref" tone={refTone(ref)} as="span" ref={chipEl} icon={broken ? 'x' : icon} face={kind && NAME_KINDS.has(kind) ? 'sans' : 'mono'} className={cls} data-ref={ref} {...anchorAttrs} aria-label={iconOnly ? label : undefined} tabIndex={interactive ? -1 : undefined} role={interactive ? 'link' : undefined} {...handlers}>
          {iconOnly ? null : label}
        </Chip>
      )}
      {pop &&
        createPortal(
          <div ref={popEl} className={`refchip-pop overlay${wholeCell ? ' refchip-pop-cell' : ''}${tableFrame ? ' refchip-pop-table' : ''}`} role="tooltip" style={{ position: 'fixed', left: POP_MARGIN, top: 0, width: popWidth, maxWidth: tableFrame ? POP_WIDTH_TABLE : undefined }} onMouseEnter={cancelHide} onMouseLeave={scheduleHide} onMouseDown={(e) => e.stopPropagation()}>
            {/* an inline citation's label names the evidence: the chip, then the value; a standalone chip's name is already under the cursor, except a glyph alone's */}
            {(asText || (iconOnly && !(pop.state === 'ok' && pop.cell))) && (
              <div className="refchip-pop-head">
                <Chip kind="ref" tone={refTone(ref)} icon={icon} className="refchip-pop-chip" onClick={interactive ? onClick : undefined}>
                  {label}
                </Chip>
                {value && !tableFrame ? <span className="refchip-pop-value">{value}</span> : null}
              </div>
            )}
            {pop.state === 'loading' && (
              <div className="refchip-pop-body">
                <Spinner size={10} label="Resolving the reference" />
              </div>
            )}
            {pop.state === 'error' && (
              <div className={pop.muted ? 'refchip-pop-body' : 'refchip-pop-body refchip-pop-error'}>
                {pop.message}
                {pop.detail && <div className="refchip-pop-detail">{pop.detail}</div>}
              </div>
            )}
            {pop.state === 'ok' && !pop.cell && pop.where && <div className="refchip-pop-where mono">{pop.where}</div>}
            {pop.state === 'ok' && pop.facts?.length ? <RecordFacts facts={pop.facts} className="refchip-pop-facts" /> : null}
            {pop.state === 'ok' && pop.table && <TablePreview grid={pop.table.grid} at={pop.table.at} />}
            {pop.state === 'ok' && pop.lines && <LinesPreview {...pop.lines} value={value} />}
            {pop.state === 'ok' && !pop.table && !pop.lines && (pop.cell ? (
              <CellPreview ws={ws} cell={pop.cell} fitWidth={chartFrame && popWidth ? popWidth - POP_PAD_X : undefined} />
            ) : pop.parts?.length ? (
              <QuoteBox parts={pop.parts} max={QUOTE_MAX_H} className="refchip-pop-body refchip-pop-quote" />
            ) : pop.excerpt ? (
              <div className="refchip-pop-body mono">{pop.excerpt.length > EXCERPT_MAX ? pop.excerpt.slice(0, EXCERPT_MAX) + '…' : pop.excerpt}</div>
            ) : null)}
          </div>,
          document.body,
        )}
    </>
  )
}

/** A table's cell in its table: the header, the rows above and below it and the columns beside it (lib/tableCell
 * cellWindow), the cell at the centre, marked. It reads as tables read everywhere (outputs.css), a step larger. */
function TablePreview({ grid, at }: { grid: Grid; at: At }) {
  const w = cellWindow(grid, at)
  const first = w.rows[0] ?? 0
  const last = w.rows[w.rows.length - 1] ?? 0
  return (
    <div className={`refchip-table${first > 0 ? ' has-above' : ''}${last < grid.rows.length - 1 ? ' has-below' : ''}`}>
      <div className="outputs-html outputs-html-table">
        <table>
          <thead>
            <tr>
              <th>{grid.corner}</th>
              {w.cols.map((c) => (
                <th key={c} className={isNumericCell(grid.rows[at.r]?.values[c] ?? '') ? 'refchip-table-num' : undefined}>
                  {grid.cols[c]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {w.rows.map((r) => (
              <tr key={r}>
                <th>{grid.rows[r].label}</th>
                {w.cols.map((c) => {
                  const v = grid.rows[r].values[c] ?? ''
                  const cls = [isNumericCell(v) ? 'outputs-num' : '', r === at.r && c === at.c ? CITED : ''].filter(Boolean).join(' ')
                  return (
                    <td key={c} className={cls || undefined}>
                      {v}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** A printed output's cited lines among the lines around them, as a table's cell shows in its table: the value marked
 * in the first cited line that holds it, else the cited lines themselves. */
function LinesPreview({ lines, from, to, value }: CitedLines & { value?: string }) {
  let mark: { i: number; at: [number, number] } | null = null
  for (let i = from; i <= to && value && !mark; i++) {
    const at = valueSpan(lines[i], value)
    if (at) mark = { i, at }
  }
  return (
    <div className="refchip-lines mono">
      {lines.map((l, i) => {
        if (mark && i === mark.i) {
          const [a, b] = mark.at
          return (
            <div key={i} className="refchip-line">
              {l.slice(0, a)}
              <span className="hl">{l.slice(a, b)}</span>
              {l.slice(b)}
            </div>
          )
        }
        return (
          <div key={i} className={!mark && i >= from && i <= to ? `refchip-line ${CITED}` : 'refchip-line'}>
            {l || '\u00a0'}
          </div>
        )
      })}
    </div>
  )
}

/** The cell's question over its primary artifact. */
function CellPreview({ ws, cell, fitWidth }: { ws: string; cell: Cell; fitWidth?: number }) {
  const concepts = useConcepts(ws)
  const pick = primaryArtifact(cell.outputs)
  const title = (cell.title ?? '').trim() || cellLabel(cell.id) || 'card'
  return (
    <div className="refchip-cell">
      <div className="refchip-cell-title">{title}</div>
      {pick ? (
        <div className={`refchip-cell-artifact${pick.kind !== 'chart' ? ' refchip-cell-clip' : ''}`}>
          <Output bundle={pick.bundle} maxLines={40} fitWidth={fitWidth} labels={chartLabels(cell.labels, concepts)} />
        </div>
      ) : cell.status === 'running' ? (
        <div className="refchip-pop-note">
          <Spinner size={10} label="running" />
        </div>
      ) : cell.text ? (
        <div className="refchip-pop-note">{cell.text.slice(0, EXCERPT_MAX)}</div>
      ) : null}
    </div>
  )
}

export default RefChip
