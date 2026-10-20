// The parts of a card the ⌘ pointer reaches inside it (CmdPointer.tsx). Inside an element marked `data-anchor-parts`,
// the pointer takes the innermost part under it: a table's cell, row or column, a line of printed output, a chart's
// mark, or any element marked `data-part` (with `data-part-text` when its visible text is not what to quote). The card's
// header, a band along its edge and anything else take the whole card. The question and takeaway are treated as text.
import { parseRef, tdRef } from '../lib/refs'
import { caretAt, squeezeText, type Anchor } from './anchors'

export interface Part {
  /** the element the part is or is drawn in: the thread's description and, unless `rect` is given, the highlight */
  el: Element
  anchor: string
  text: string
  /** the part's box where it is less than its element (a line of printed output, a point of a line chart) */
  rect?: DOMRect
}

/** A band this wide (px) inside a card's edge takes the whole card. */
export const EDGE_PX = 8
/** What of a card takes it whole: its header row on the board, a report figure's head, a resize edge. */
const WHOLE = '.bcell-top, .bcell-edge, .wu-fig-head'
/** Printed text, drawn a line to a row: an output's text and a code card's code. */
const LINES = 'pre.outputs-text, pre.bcell-code'
/** The half size (px) of the box a point of a line or an area chart lights. */
const POINT_R = 6

export const nearEdge = (r: { left: number; top: number; right: number; bottom: number }, x: number, y: number, band = EDGE_PX): boolean =>
  x < r.left + band || x > r.right - band || y < r.top + band || y > r.bottom - band

const visibleText = (el: Element): string => squeezeText((el as HTMLElement).innerText ?? el.textContent ?? '')
/** A table cell's text as the table holds it (innerText would carry a header's CSS capitals). */
const cellText = (el: Element): string => squeezeText(el.textContent ?? '')

/** The part of the card `a` under the pointer at `x`, `y` (over `target`), or null when the card itself is. */
export function partOf(a: Anchor, target: EventTarget | null, x: number, y: number): Part | null {
  if (!a.el.hasAttribute('data-anchor-parts') || !(target instanceof Element) || !a.el.contains(target)) return null
  const card = parseRef(a.anchor)
  if (card?.kind !== 'cell') return null
  if (target.closest(WHOLE) || nearEdge(a.el.getBoundingClientRect(), x, y)) return null
  const own = target.closest<HTMLElement | SVGElement>('[data-part]')
  if (own && a.el.contains(own)) return { el: own, anchor: own.dataset.part || a.anchor, text: squeezeText(own.dataset.partText ?? visibleText(own)) }
  const mark = markPart(target, x, y, a.anchor)
  if (mark) return mark
  const td = target.closest('td, th')
  if (td instanceof HTMLTableCellElement && a.el.contains(td)) return tablePart(td, card.cellId, a.anchor)
  const pre = target.closest<HTMLElement>(LINES)
  if (pre && a.el.contains(pre)) return linePart(pre, x, y, card.cellId, a.anchor)
  return null
}

// ----------------------------------------------------------------------------- a table

/**
 * A table's part, read as lib/tableCell reads a table: a value is its cell (column header and row label), a label is
 * its row, a header is its column.
 */
export function tablePart(cell: HTMLTableCellElement, cardId: string, cardAnchor: string): Part | null {
  const table = cell.closest('table')
  const tr = cell.parentElement
  if (!table || !(tr instanceof HTMLTableRowElement)) return null
  const head = table.rows[0]
  const isBody = tr !== head && Array.from(tr.cells).some((c) => c.tagName === 'TD')
  if (!isBody) return { el: cell, anchor: cardAnchor, text: cellText(cell) }
  const label = tr.cells[0]
  const row = label.getAttribute('data-label') ?? cellText(label)
  const cols = head ? Array.from(head.cells).map(cellText) : []
  if (cell === label) {
    const values = Array.from(tr.cells)
      .slice(1)
      .map((c, i) => `${cols[i + 1] || i + 1}: ${cellText(c)}`)
    return { el: tr, anchor: cardAnchor, text: squeezeText([cellText(label), ...values].join(' · ')) }
  }
  const col = cols[cell.cellIndex] ?? ''
  // a cell of the card's output answers to its span; a table drawn from anything else (a label's values) has no span,
  // and its text says where the cell is
  const ref = table.closest('[data-out]') ? tdRef(cardId, col, row) : null
  return ref ? { el: cell, anchor: ref, text: cellText(cell) } : { el: cell, anchor: cardAnchor, text: squeezeText(`${col} · ${cellText(label)}: ${cellText(cell)}`) }
}

// ----------------------------------------------------------------------------- a line of printed text

/** Where offset `at` of `text` falls: the line around it, [start, end), and its number from 1. */
export function lineAt(text: string, at: number): { start: number; end: number; n: number } {
  const i = Math.max(0, Math.min(at, text.length))
  const start = i > 0 ? text.lastIndexOf('\n', i - 1) + 1 : 0
  const nl = text.indexOf('\n', i)
  const end = nl < 0 ? text.length : nl
  let n = 1
  for (let k = text.indexOf('\n'); k >= 0 && k < start; k = text.indexOf('\n', k + 1)) n++
  return { start, end, n }
}

function linePart(pre: HTMLElement, x: number, y: number, cardId: string, cardAnchor: string): Part | null {
  const c = caretAt(x, y)
  if (!c || c.node.nodeType !== Node.TEXT_NODE || !pre.contains(c.node)) return null
  const nodes: Text[] = []
  const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text)
  let at = 0
  for (const n of nodes) {
    if (n === c.node) break
    at += n.data.length
  }
  const all = nodes.map((n) => n.data).join('')
  const line = lineAt(all, at + c.offset)
  const text = all.slice(line.start, line.end)
  // a blank line, and the ellipsis a capped output ends with, are no line of the output
  if (!text.trim() || text.trim() === '…') return null
  const range = document.createRange()
  let pos = 0
  for (const n of nodes) {
    const next = pos + n.data.length
    if (line.start >= pos && line.start <= next) range.setStart(n, line.start - pos)
    if (line.end >= pos && line.end <= next) {
      range.setEnd(n, line.end - pos)
      break
    }
    pos = next
  }
  const box = range.getBoundingClientRect()
  // the caret names the nearest line from anywhere in the block: the point must be on the line's own height
  if (box.height <= 0 || y < box.top - 2 || y > box.bottom + 2) return null
  const out = pre.classList.contains('outputs-text') ? pre.closest('[data-out]')?.getAttribute('data-out') : null
  const anchor = out != null && out !== '' ? `card:${cardId}@out${out}#L${line.n}` : cardAnchor
  return { el: pre, anchor, text: squeezeText(text), rect: new DOMRect(box.left - 2, box.top, box.width + 4, box.height) }
}

// ----------------------------------------------------------------------------- a chart's mark

/** A mark as Vega's SVG renderer binds it to its element (`__data__`): the item, its mark and its datum. */
interface VegaItem {
  datum?: Record<string, unknown>
  tooltip?: unknown
  x?: number
  y?: number
  mark?: { marktype?: string; role?: string; items?: VegaItem[] }
}

/** What a thread calls a mark, by Vega's mark type. */
const MARK_NAMES: Record<string, string> = { rect: 'bar', symbol: 'point', line: 'point on a line', area: 'point on an area', trail: 'point on a line', arc: 'slice', rule: 'rule', text: 'label' }
/** Marks drawn as one path for all their data, whose part is the datum nearest the pointer. */
const PATH_MARKS = new Set(['line', 'area', 'trail'])

/** A datum's time as Vega-Lite keeps a parsed date: milliseconds since 1970, whole seconds, between 1973 and 2286. */
const isEpochMs = (v: number): boolean => Number.isInteger(v) && v >= 1e11 && v < 1e13 && v % 1000 === 0

/** A field's value as a thread quotes it: a date (or a datum's time in milliseconds) as its day, and its time when it
 * has one, a number in full. */
export function fieldValue(v: unknown): string {
  if (v instanceof Date || (typeof v === 'number' && isEpochMs(v))) {
    const iso = new Date(v).toISOString()
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.replace('.000Z', 'Z')
  }
  if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString('en-US') : v.toLocaleString('en-US', { maximumFractionDigits: 4 })
  return String(v)
}

/** A field Vega-Lite derives for a stack, `<field>_start` or `<field>_end` beside `<field>` itself. */
const stackField = (k: string, fields: Record<string, unknown>): boolean => {
  const m = /^(.+)_(start|end)$/.exec(k)
  return !!m && m[1] in fields
}

/** A mark's text: its kind, then its fields, the chart's tooltip where it has one, else the datum's own fields (Vega's
 * internal ones, named with a leading `_`, a stack's bounds and nested values left out). */
export function markText(marktype: string, item: { datum?: Record<string, unknown>; tooltip?: unknown }): string {
  const tip = item.tooltip
  const fields = tip && typeof tip === 'object' ? (tip as Record<string, unknown>) : (item.datum ?? {})
  const kept = Object.entries(fields).filter(([k, v]) => !k.startsWith('_') && !stackField(k, fields) && v != null && (typeof v !== 'object' || v instanceof Date))
  const body = typeof tip === 'string' && tip ? tip : kept.map(([k, v]) => `${k}: ${fieldValue(v)}`).join(' · ')
  return squeezeText(`${MARK_NAMES[marktype] ?? marktype} · ${body}`)
}

function markPart(target: Element, x: number, y: number, cardAnchor: string): Part | null {
  const svg = target.closest('.outputs-vega svg')
  if (!svg) return null
  for (let el: Element | null = target; el && el !== svg; el = el.parentElement) {
    const item = (el as Element & { __data__?: VegaItem }).__data__
    const type = item?.mark?.marktype
    if (!item?.datum || !type || item.mark?.role !== 'mark') continue
    if (!PATH_MARKS.has(type)) return { el, anchor: cardAnchor, text: markText(type, item) }
    // one path draws every datum: the part is the datum nearest the pointer, a point on the path
    const ctm = (el as SVGGraphicsElement).getScreenCTM?.()
    const items = (item.mark?.items ?? [item]).filter((i) => i.datum && typeof i.x === 'number' && typeof i.y === 'number')
    if (!ctm || !items.length) return { el, anchor: cardAnchor, text: markText(type, item) }
    // the datum whose x is nearest, as a line is read along its axis; of two at the same x, the nearer in y
    let best: { item: VegaItem; px: number; py: number; dx: number; dy: number } | null = null
    for (const i of items) {
      const p = new DOMPoint(i.x, i.y).matrixTransform(ctm)
      const dx = Math.abs(p.x - x)
      const dy = Math.abs(p.y - y)
      if (!best || dx < best.dx || (dx === best.dx && dy < best.dy)) best = { item: i, px: p.x, py: p.y, dx, dy }
    }
    const b = best!
    return { el, anchor: cardAnchor, text: markText(type, b.item), rect: new DOMRect(b.px - POINT_R, b.py - POINT_R, 2 * POINT_R, 2 * POINT_R) }
  }
  return null
}
