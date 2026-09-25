// How a table a card's code printed (pandas' to_html) is drawn (components/Outputs' Html): pandas' default row numbers
// and an index-only header row are hidden; prose columns wrap while ids, names and numbers stay on one line in mono;
// whole numbers of four digits or more take thousands separators, except in columns of years or ids.
//
// Only the drawn table changes. The backend reads value citations from the stored html (cite.py), and lib/tableCell
// reads cells by their labels, so hidden labels stay in the DOM and index and header cells are never rewritten.

/** Whether the row labels are pandas' default index: 0, 1, 2 ... in order. */
export function isRangeIndex(labels: readonly string[]): boolean {
  return labels.length > 0 && labels.every((l, i) => l.trim() === String(i))
}

const INTEGER = /^[-−]?\d+$/
/** A whole number written with thousands separators ("13339" -> "13,339"); any other text is returned as it is. */
export function groupDigits(text: string): string {
  const t = text.trim()
  if (!INTEGER.test(t)) return text
  const neg = /^[-−]/.test(t)
  const digits = neg ? t.slice(1) : t
  if (digits.length < 4) return text
  return (neg ? t[0] : '') + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

// a header that is the name of an id or a year (not a count of them, such as "PRs merged"): its numbers are names,
// not amounts, so they keep their digits as written
const ID_HEADER = /^(?:#|.*\bids?|(?:pr|issue|pull request)(?: ?(?:#|no\.?|number))?|number|no\.?|years?|line|seq|index|port|version|rev(?:ision)?|pk|key|zip|code)$/i
const YEAR_MIN = 1900
const YEAR_MAX = 2100

/** Whether a column's whole numbers take thousands separators: not when its header names ids or years, and not when
 * every whole number in it is a year (1900 to 2100). */
export function groupsDigits(header: string, values: readonly string[]): boolean {
  if (ID_HEADER.test(header.replace(/[_-]/g, ' ').trim())) return false
  const ints = values.map((v) => v.trim()).filter((v) => INTEGER.test(v))
  if (!ints.length) return false
  const years = ints.every((v) => {
    const n = Number(v.replace('−', '-'))
    return n >= YEAR_MIN && n <= YEAR_MAX
  })
  return !years
}

/** the length from which a cell with spaces reads as prose, and the spaces it needs */
const PROSE_CHARS = 32
const PROSE_SPACES = 4
/** Whether a cell's text is prose (a sentence or a description) that wraps, rather than an id, a name or a number
 * that stays on one line. */
export function isProse(text: string): boolean {
  const t = text.trim()
  return t.length >= PROSE_CHARS && (t.match(/\s+/g)?.length ?? 0) >= PROSE_SPACES
}

const cellText = (el: Element): string => (el.textContent ?? '').trim()
/** a row label longer than this, written as prose, wraps */
const LONG_LABEL = 56

/** The classes a drawn table is tidied with (outputs.css). */
export const TABLE_CLS = { rangeIndex: 'outputs-rangeindex', nameRow: 'outputs-namerow', prose: 'outputs-prose', numHead: 'outputs-numhead' } as const

/**
 * Tidy one drawn table in place: hide pandas' default row numbers and an index-only header row, mark prose cells to
 * wrap, and group the digits of whole numbers. Idempotent.
 */
export function tidyTable(table: HTMLTableElement): void {
  const rows = Array.from(table.rows)
  if (!rows.length) return
  const body = rows.filter((tr) => Array.from(tr.cells).some((c) => c.tagName === 'TD'))
  const head = rows.filter((tr) => !body.includes(tr))
  // pandas' default index: every body row starts with one <th> reading 0, 1, 2 ...
  const labels = body.map((tr) => (tr.cells[0]?.tagName === 'TH' && tr.cells[1]?.tagName !== 'TH' ? cellText(tr.cells[0]) : '\u0000'))
  const range = isRangeIndex(labels)
  table.classList.toggle(TABLE_CLS.rangeIndex, range)
  // a header row after the first that holds only the index's names (one per index level, the rest of its cells empty)
  const levels = Math.max(1, body[0] ? Array.from(body[0].cells).findIndex((c) => c.tagName === 'TD') : 1)
  for (const tr of head.slice(1)) {
    const cells = Array.from(tr.cells)
    const names = cells.slice(0, levels)
    if (cells.length <= levels || names.some((c) => c.tagName !== 'TH') || !cells.slice(levels).every((c) => !cellText(c))) continue
    tr.classList.add(TABLE_CLS.nameRow)
    // the index stays: its names head its columns, in place of pandas' columns name or an empty corner
    const corners = head[0] ? Array.from(head[0].cells).slice(0, levels) : []
    if (range || corners.length < levels) continue
    corners.forEach((corner, i) => {
      if (corner.tagName !== 'TH' || corner.colSpan > 1 || corner.getAttribute('data-was') != null) return
      corner.setAttribute('data-was', corner.textContent ?? '')
      corner.textContent = cellText(names[i])
    })
  }
  // the columns: a header per value position (the first header row's cells after the corner, when it has no spans)
  const top = head[0] ? Array.from(head[0].cells) : []
  const spans = top.some((c) => c.colSpan > 1)
  const leadTh = (tr: HTMLTableRowElement) => Array.from(tr.cells).findIndex((c) => c.tagName === 'TD')
  const columns = new Map<number, HTMLTableCellElement[]>()
  for (const tr of body) {
    Array.from(tr.cells)
      .slice(Math.max(0, leadTh(tr)))
      .forEach((td, i) => {
        if (td.tagName !== 'TD') return
        columns.set(i, [...(columns.get(i) ?? []), td as HTMLTableCellElement])
      })
  }
  // a row label as long as a sentence wraps in its column; a name of a few words (a run, a file) stays on its line
  for (const tr of body) for (const th of Array.from(tr.cells).filter((c) => c.tagName === 'TH')) th.classList.toggle(TABLE_CLS.prose, cellText(th).length > LONG_LABEL && isProse(cellText(th)))
  // a column that holds prose reads as prose in every text cell, so one column never mixes two faces
  for (const tds of columns.values()) {
    const prose = tds.some((td) => isProse(cellText(td)))
    for (const td of tds) td.classList.toggle(TABLE_CLS.prose, prose && !td.classList.contains('outputs-num'))
  }
  // the first header row holds one corner cell per index level, then one cell per column
  const lead = body[0] ? Math.max(0, leadTh(body[0])) : 0
  const headerOf = (i: number): string => (!spans && top.length === lead + columns.size ? cellText(top[lead + i]) : '')
  for (const [i, tds] of columns) {
    // a column of numbers has its header over the numbers, at the right
    const head = !spans && top.length === lead + columns.size ? top[lead + i] : null
    const filled = tds.filter((td) => cellText(td))
    head?.classList.toggle(TABLE_CLS.numHead, filled.length > 0 && filled.every((td) => td.classList.contains('outputs-num')))
    // only a cell whose content is plain text is rewritten, so a link or markup in it is left as it is
    const plain = tds.filter((td) => td.childElementCount === 0)
    if (!groupsDigits(headerOf(i), plain.map((td) => td.getAttribute('data-raw') ?? cellText(td)))) continue
    for (const td of plain) {
      const raw = td.getAttribute('data-raw') ?? cellText(td)
      const grouped = groupDigits(raw)
      if (grouped === raw) continue
      td.setAttribute('data-raw', raw)
      td.textContent = grouped
    }
  }
}
