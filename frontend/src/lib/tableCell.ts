// The table cell a value citation names (`card:<id>#<col>/<row>`), found the way the backend finds it (cite.table_cells
// and cite.find_td) so the hover and the click land on the cell the checker read. The first row is the header; each
// body row starts with its label, and second header rows (a named index) are skipped. A row is named by its label, or,
// with pandas' default index, by its value in the key column: the first column whose values are all distinct text.
//
// The pure half is tableGrid's shape, locateCell, cellWindow, citedLines and valueSpan; the DOM half reads a drawn
// <table> and marks, scrolls to and reveals the cell.
import { decodeLabel } from './refs'

export interface GridRow {
  label: string
  /** the row's name in a ref when it differs from what the label shows (a table card's `data-label`, canvas/FrameTable:
   * a number as the frame holds it, not in its column's format) */
  key?: string
  values: string[]
}

/** A table as its cells read: the corner's text (the index's name), the column labels, the rows. */
export interface Grid {
  corner: string
  cols: string[]
  rows: GridRow[]
}

/** A cell by its row and its column (both from 0, the column among `cols`). */
export interface At {
  r: number
  c: number
}

// a number as cite._norm compares it: commas and a trailing percent dropped, then one plain number (cite._PLAIN_NUM_RE)
const PLAIN_NUM = /^[-−]?(?:(?:0|[1-9][0-9]*)(?:\.[0-9]*)?|\.[0-9]+)$/
const isPlainNumber = (v: string): boolean => PLAIN_NUM.test(v.replace(/,/g, '').replace(/%$/, ''))

/** The cell at column `col`, row `row` (as a ref writes them, encoded or not), or null when the table has none. */
export function locateCell(grid: Grid, col: string, row: string): At | null {
  const cols = new Set([col, decodeLabel(col)])
  const rows = new Set([row, decodeLabel(row)])
  const c = grid.cols.findIndex((x) => cols.has(x))
  if (c < 0) return null
  const r = grid.rows.findIndex((x) => rows.has(x.key ?? x.label) || rows.has(x.label))
  if (r >= 0) return c < grid.rows[r].values.length ? { r, c } : null
  return byKeyColumn(grid, c, rows)
}

/** The row a key column names, in a table whose rows are numbered 0, 1, 2 (cite._by_key_column). */
function byKeyColumn(grid: Grid, c: number, names: Set<string>): At | null {
  if (!grid.rows.length || grid.rows.some((x, i) => (x.key ?? x.label) !== String(i))) return null
  const wanted = new Set(Array.from(names, (n) => n.trim()))
  for (let k = 0; k < grid.cols.length; k++) {
    const vals = grid.rows.map((x) => (x.values[k] ?? '').trim())
    if (!vals.every(Boolean) || new Set(vals).size !== vals.length || vals.every(isPlainNumber)) continue
    const r = vals.findIndex((v) => wanted.has(v))
    return r >= 0 && c < grid.rows[r].values.length ? { r, c } : null
  }
  return null
}

/** Which rows and columns a preview shows around a cell: `around` rows above and below it and at most `cols` value
 * columns, the cell's in the middle where the table allows, so the cell sits at the centre of what shows. */
export function cellWindow(grid: Grid, at: At, around = 2, cols = 4): { rows: number[]; cols: number[] } {
  const span = (n: number, i: number, before: number, width: number): number[] => {
    const start = Math.max(0, Math.min(i - before, n - width))
    return Array.from({ length: Math.min(width, n) }, (_, k) => start + k)
  }
  return {
    rows: span(grid.rows.length, at.r, around, 2 * around + 1),
    cols: span(grid.cols.length, at.c, Math.floor((cols - 1) / 2), cols),
  }
}

// ------------------------------------------------------------------------------------- a cited line of an output
// A value citation of a card's printed output (`card:<id>@out<i>#L<n>[-L<m>]`) shows the lines around it with the value
// marked. The backend sends the surrounding lines as the excerpt and the cited ones as `span.text`
// (refs._resolve_cell), after at most SPAN_CONTEXT_LINES of context.

/** The context lines the backend puts before a cited line (refs.SPAN_CONTEXT_LINES). */
const SPAN_CONTEXT_LINES = 2

/** Where the cited lines sit in the excerpt: its lines and the first and last index of the cited ones, the match
 * nearest where the backend put them when the same text repeats; null when the cited text is not in it. Pure. */
export function citedLines(excerpt: string, cited: string, line: number): { lines: string[]; from: number; to: number } | null {
  const lines = excerpt.split('\n')
  const want = cited.split('\n')
  if (!want.length || !want.some((w) => w.trim())) return null
  const expect = Math.min(Math.max(0, line - 1), SPAN_CONTEXT_LINES)
  let best = -1
  for (let i = 0; i + want.length <= lines.length; i++) {
    if (want.every((w, k) => lines[i + k] === w) && (best < 0 || Math.abs(i - expect) < Math.abs(best - expect))) best = i
  }
  return best < 0 ? null : { lines, from: best, to: best + want.length - 1 }
}

/** The span of `value` in a cited line, [start, end), matching a number whether or not either writes it with commas
 * ("12,266" in prose is 12266 in a printout); null when the line does not hold it. Pure. */
export function valueSpan(lineText: string, value: string): [number, number] | null {
  const v = value.trim()
  if (!v) return null
  if (!isPlainNumber(v)) {
    const at = lineText.indexOf(v)
    return at >= 0 ? [at, at + v.length] : null
  }
  const bare = v.replace(/,/g, '').replace(/%$/, '')
  // the line's whole numbers, each with its commas, compared as the value is, so 1248 is never found inside 12480
  for (const m of lineText.matchAll(/[-−]?[0-9][0-9,]*(?:\.[0-9]+)?%?/g)) {
    if (m[0].replace(/,/g, '').replace(/%$/, '') === bare) return [m.index ?? 0, (m.index ?? 0) + m[0].length]
  }
  return null
}

// --------------------------------------------------------------------------------------------------------- the DOM

const text = (el: Element): string => (el.textContent ?? '').trim()
/** A row label's name in a ref, when the table gives one apart from its text (canvas/FrameTable). */
const key = (el: Element | undefined): string | undefined => el?.getAttribute('data-label') ?? undefined

/** A drawn table read as a Grid, with each value's element beside it. */
export function readTable(table: HTMLTableElement): { grid: Grid; cells: HTMLTableCellElement[][]; rows: HTMLTableRowElement[] } {
  const trs = Array.from(table.rows)
  const head = trs[0] ? Array.from(trs[0].cells) : []
  const body = trs.slice(1).filter((tr) => Array.from(tr.cells).some((c) => c.tagName === 'TD'))
  const names = trs.slice(1).filter((tr) => !body.includes(tr))
  const corner = (head[0] ? text(head[0]) : '') || (names[0]?.cells[0] ? text(names[0].cells[0]) : '')
  const grid: Grid = { corner, cols: head.slice(1).map(text), rows: [] }
  const cells: HTMLTableCellElement[][] = []
  for (const tr of body) {
    const all = Array.from(tr.cells)
    const k = key(all[0])
    grid.rows.push({ label: all[0] ? text(all[0]) : '', ...(k != null ? { key: k } : {}), values: all.slice(1).map(text) })
    cells.push(all.slice(1))
  }
  return { grid, cells, rows: body }
}

/** The element of the cell `col` / `row` among the tables under `root` (those `selector` picks), in order, with its
 * row; null when none has it. */
export function findCell(root: ParentNode, col: string, row: string, selector = 'table'): { td: HTMLTableCellElement; tr: HTMLTableRowElement } | null {
  for (const table of Array.from(root.querySelectorAll<HTMLTableElement>(selector))) {
    const t = readTable(table)
    const at = locateCell(t.grid, col, row)
    if (at) return { td: t.cells[at.r][at.c], tr: t.rows[at.r] }
  }
  return null
}

/** The class a cited cell wears while it is pointed at (refchip.css). */
export const CITED = 'cite-cell'
/** The class a cited cell wears for a while after a click opened it. */
export const CITED_FLASH = 'cite-cell-flash'
const FLASH_MS = 2400

/** The zoom the element is drawn at (the canvas scales its plane), so a scroll offset can be read in its own px. */
const zoomOf = (el: HTMLElement): number => {
  const w = el.getBoundingClientRect().width
  return el.offsetWidth > 0 && w > 0 ? w / el.offsetWidth : 1
}

const scrolls = (el: HTMLElement): { x: boolean; y: boolean; fixed: boolean } => {
  const s = getComputedStyle(el)
  const open = (v: string) => v !== 'visible' && v !== 'clip'
  return { x: open(s.overflowX) && el.scrollWidth > el.clientWidth + 1, y: open(s.overflowY) && el.scrollHeight > el.clientHeight + 1, fixed: s.overflowX === 'hidden' && s.overflowY === 'hidden' }
}

/** Where a box was scrolled to before a cell was brought into view, and whether the analyst can scroll it back (a box
 * that clips with overflow hidden cannot be). */
export type Scrolled = { el: HTMLElement; left: number; top: number; fixed: boolean }

/**
 * Scroll every box between `el` and `stop` that cuts it off so `el` is centred where possible, innermost first; nothing
 * past `stop` moves. Returns the previous offsets.
 */
export function scrollWithin(el: HTMLElement, stop: HTMLElement): Scrolled[] {
  const before: Scrolled[] = []
  for (let box = el.parentElement; box && box !== stop.parentElement; box = box.parentElement) {
    const can = scrolls(box)
    if (!can.x && !can.y) continue
    const k = zoomOf(box)
    const b = box.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    // a box it already shows in whole stays where it is
    const x = can.x && (r.left < b.left || r.right > b.right)
    const y = can.y && (r.top < b.top || r.bottom > b.bottom)
    if (x || y) before.push({ el: box, left: box.scrollLeft, top: box.scrollTop, fixed: can.fixed })
    if (x) box.scrollLeft += (r.left + r.width / 2 - (b.left + b.width / 2)) / k
    if (y) box.scrollTop += (r.top + r.height / 2 - (b.top + b.height / 2)) / k
    if (box === stop) break
  }
  return before
}

/** Put the boxes back where they were; `fixedOnly` puts back only those the analyst could not scroll back. */
export const restoreScroll = (list: readonly Scrolled[], fixedOnly = false): void => {
  for (const s of [...list].reverse()) {
    if (fixedOnly && !s.fixed) continue
    s.el.scrollLeft = s.left
    s.el.scrollTop = s.top
  }
}

/** Whether `el` shows whole: inside the window and inside every box between it and `home` that clips it. */
export function visibleWithin(el: HTMLElement, home: HTMLElement): boolean {
  const r = el.getBoundingClientRect()
  if (r.width <= 0 || r.height <= 0) return false
  const inside = (b: { left: number; top: number; right: number; bottom: number }) => r.left >= b.left - 1 && r.right <= b.right + 1 && r.top >= b.top - 1 && r.bottom <= b.bottom + 1
  if (!inside({ left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight })) return false
  for (let box = el.parentElement; box && box !== home.parentElement; box = box.parentElement) {
    const s = getComputedStyle(box)
    if ((s.overflowX !== 'visible' || s.overflowY !== 'visible') && !inside(box.getBoundingClientRect())) return false
  }
  return true
}

/** Whether a cell shows: its row is not held back behind a table's row cap, and it has a box. */
export const cellShown = (hit: { td: HTMLElement; tr: HTMLTableRowElement }): boolean => !hit.tr.hidden && hit.td.getClientRects().length > 0

/**
 * Bring the cell `col` / `row` under `home` into view and flash it, expanding a capped table first. Resolves to the
 * cell, or null when no table under `home` has it.
 */
export async function revealCell(home: HTMLElement, col: string, row: string, selector = 'table'): Promise<HTMLTableCellElement | null> {
  let hit = findCell(home, col, row, selector)
  if (!hit) return null
  if (hit.tr.hidden) {
    const more = hit.tr.closest('.outputs-html-wrap')?.parentElement?.querySelector<HTMLButtonElement>('.outputs-showall')
    more?.click()
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    hit = findCell(home, col, row, selector)
    if (!hit) return null
  }
  scrollWithin(hit.td, home)
  const td = hit.td
  td.classList.remove(CITED_FLASH)
  void td.offsetWidth
  td.classList.add(CITED_FLASH)
  window.setTimeout(() => td.classList.remove(CITED_FLASH), FLASH_MS)
  return td
}
