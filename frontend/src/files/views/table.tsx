// The Table view: one row per record, one column per field, offered when the records are flat objects that share
// their keys, and for a CSV or TSV file, whose first line names the columns. Columns are ordered by how many records
// carry them; records that read as posts lead with author, time and body. Every cell is one line cut with an ellipsis.
// The labels that are on tint rows and highlight marked texts in cells (a cell starts a little before its first mark
// when the mark would fall past what it shows), and the pinned line-number column holds a slot per label that is on,
// under the label's mark (LabelMark). Only rows near the view are drawn, with spacer rows for the rest; hidden width
// holders in the header keep column widths stable.
import { Fragment, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import { Tipped } from '../../components/Tooltip'
import { api } from '../../lib/api'
import type { SourceKind, SourceRecord } from '../../lib/types'
import { cellFill, laneTags, markSegments, type SpanMark } from '../labels'
import { ReaderLabelsContext, useMarksAt } from '../marks'
import { LabelMark } from '../LabelMark'
import { findQuote } from '../../lib/quoteFind'
import { cellTitle, compact, isJsonlFile, isTargetLine, LANE_GLYPH_PX, SpanEl, useTarget, type Target, type ViewDef, type ViewProps } from './common'
import { messageKeys, stamp, transcriptScore } from './transcript'

const MAX_COLS = 40
const CELL_MAX = 140
const TITLE_MAX = 2000
const ISO_TS = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/
/** a mark that starts past this many characters moves the cell's start to just before it */
const MARK_LEAD = 12
/** the widths a cell's one line is cut at, in characters (files.css .reader-table-clip) */
const CLIP_CHARS = 20
const CLIP_TEXT_CHARS = 44
/** rows drawn past each edge of the view */
const OVERSCAN = 20
/** the drawn rows start and end on multiples of this, so a scroll draws again only when it crosses one */
const STEP = 10
/** rows drawn while the view has no size (a hidden tab, the first render) */
const FIRST_ROWS = 60
/** a row's height in px until one is measured */
const ROW_H = 28

/** The union of the records' keys, most frequent first, ties in first-seen order, capped at MAX_COLS. */
export function columnsOf(records: SourceRecord[]): string[] {
  return rankKeys(records.map((r) => r.record)).slice(0, MAX_COLS)
}

/** The columns in the order the table shows them: a post's author, time and body first when the records read as posts
 * (the keys the Transcript view shows), then the rest in columnsOf's order. */
export function orderColumns(cols: string[], sample: unknown[]): string[] {
  if (transcriptScore(sample) < 0.9) return cols
  const keys = messageKeys(sample)
  const lead = [keys.author, keys.time, keys.body].filter((k): k is string => !!k && cols.includes(k))
  return [...lead, ...cols.filter((c) => !lead.includes(c))]
}

/** The columns holding a long text (over 40 characters, or a line break) or a nested value that compacts past 40 in any
 * record: their cells cut at one width. */
function wideColumns(records: SourceRecord[], cols: string[]): Set<string> {
  const out = new Set<string>()
  for (const rec of records) {
    const r = rec.record
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue
    for (const c of cols) {
      const v = (r as Record<string, unknown>)[c]
      if (typeof v === 'string' && (v.length > 40 || v.includes('\n'))) out.add(c)
      else if (v && typeof v === 'object' && compact(v, 41).length > 41) out.add(c)
    }
  }
  return out
}

function rankKeys(objs: unknown[]): string[] {
  const count = new Map<string, number>()
  for (const r of objs) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue
    for (const k of Object.keys(r)) count.set(k, (count.get(k) ?? 0) + 1)
  }
  const keys = [...count.keys()]
  return keys.map((k, i) => [k, i] as const).sort((a, b) => count.get(b[0])! - count.get(a[0])! || a[1] - b[1]).map(([k]) => k)
}

/** A value as its cell shows it: an ISO time as the Transcript head writes it, a list or an object compacted. */
function cell(v: unknown): string {
  if (v === null) return 'null'
  if (v === undefined) return ''
  if (typeof v === 'string') return ISO_TS.test(v) ? stamp(v) : v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return compact(v, CELL_MAX)
}

/** The whole value for the cell's title, when the cell may not show all of it. */
function titleOf(v: unknown): string | undefined {
  if (v == null || typeof v === 'number' || typeof v === 'boolean') return undefined
  const s = typeof v === 'string' ? v : JSON.stringify(v) ?? ''
  if (s.length <= 16) return undefined
  return s.length > TITLE_MAX ? s.slice(0, TITLE_MAX) + '…' : s
}

const isMonoVal = (v: unknown) => v == null || typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && ISO_TS.test(v))
const cellClass = (v: unknown, wide: boolean) => (isMonoVal(v) ? 'reader-table-cell mono' : wide ? 'reader-table-cell text' : 'reader-table-cell short')

const WS_RUN = /[ \t\n\r]+/g
const WS_ENDS = /^ | $/g
const collapsed = (s: string) => s.replace(WS_RUN, ' ').replace(WS_ENDS, '').length

/** How many characters of `text` a cell's one line shows, at most `cap`: a run of white space shows as one space and
 * none shows at either end. */
export function shownChars(text: string, cap: number): number {
  const head = text.length > cap * 4 ? text.slice(0, cap * 4) : text
  const n = collapsed(head)
  return Math.min(cap, n >= cap || head === text ? n : collapsed(text))
}

/** Per column, the most characters a cell of it shows among the records: [its mono cells', its other cells'], since a
 * mono cell's characters are wider (the .mono class's size). The header cell holds both widths. */
export function columnChars(records: SourceRecord[], cols: string[], wide: Set<string>): [number, number][] {
  const out = cols.map((): [number, number] => [0, 0])
  for (const rec of records) {
    const r = rec.record
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue
    for (let i = 0; i < cols.length; i++) {
      const v = (r as Record<string, unknown>)[cols[i]]
      if (v === undefined) continue
      const mono = isMonoVal(v)
      const n = shownChars(cell(v), mono || !wide.has(cols[i]) ? CLIP_CHARS : CLIP_TEXT_CHARS)
      const w = out[i]
      if (mono) w[0] = Math.max(w[0], n)
      else w[1] = Math.max(w[1], n)
    }
  }
  return out
}

/** The cell of the target's record that holds the words a span ref quotes, and where they sit in its text: its
 * column (null for a record drawn as one cell), else null. Pure. */
export function citedCell(records: SourceRecord[], cols: string[], target: Target | null): { line: number; col: string | null; at: [number, number] } | null {
  if (!target || target.start == null || target.end == null || target.end <= target.start) return null
  const rec = records[indexOfLine(records, target.line)]
  if (!rec || rec.line !== target.line) return null
  const quote = rec.blocks?.[target.block ?? 0]?.text?.slice(target.start, target.end) ?? ''
  if (!quote.trim()) return null
  const r = rec.record
  if (!r || typeof r !== 'object' || Array.isArray(r)) {
    const at = findQuote(cell(r), quote)
    return at ? { line: rec.line, col: null, at } : null
  }
  for (const c of cols) {
    const at = findQuote(cell((r as Record<string, unknown>)[c]), quote)
    if (at) return { line: rec.line, col: c, at }
  }
  return null
}

/** The first index of the records (in the order of their lines) whose line is at least `line`. */
function indexOfLine(records: SourceRecord[], line: number): number {
  let lo = 0
  let hi = records.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (records[mid].line < line) lo = mid + 1
    else hi = mid
  }
  return lo
}

function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY
    if (o === 'auto' || o === 'scroll') return p
  }
  return null
}

interface Drawn {
  from: number
  to: number
  /** the heights of the rows left out above and below the drawn ones, in px */
  above: number
  below: number
}

/**
 * The records to draw, `from` up to `to`: those in and near the view of the table's scroll container. The range is
 * kept as record lines so pages added or cut leave the same records drawn; the rows around `focus` are drawn the first
 * time it is asked for, so the view can scroll to it.
 */
function useDrawnRows(rootRef: RefObject<HTMLElement | null>, bodyRef: RefObject<HTMLTableSectionElement | null>, records: SourceRecord[], focus: { key: string; line: number } | null): Drawn {
  const [rowH, setRowH] = useState(ROW_H)
  const [lines, setLines] = useState<[number, number] | null>(null)
  const scroller = useRef<HTMLElement | null>(null)
  const latest = useRef({ records, rowH, lines })
  latest.current = { records, rowH, lines }
  const focused = useRef<string | null>(null)
  const drewFocus = useRef<string | null>(null)
  const placed = useRef(false)

  const fromView = (): [number, number] | null => {
    const { records: recs, rowH: h } = latest.current
    const el = scroller.current
    const body = bodyRef.current
    if (!el || !body || !recs.length || el.clientHeight <= 0) return null
    const above = el.getBoundingClientRect().top - body.getBoundingClientRect().top
    const first = Math.floor(above / h) - OVERSCAN
    const last = Math.ceil((above + el.clientHeight) / h) + OVERSCAN
    const from = Math.min(recs.length - 1, Math.max(0, Math.floor(first / STEP) * STEP))
    const to = Math.max(from + 1, Math.min(recs.length, Math.ceil(last / STEP) * STEP))
    return [recs[from].line, recs[to - 1].line]
  }
  const sync = (flush: boolean, widen = false) => {
    const view = fromView()
    const cur = latest.current.lines
    const next: [number, number] | null = view && widen && cur ? [Math.min(cur[0], view[0]), Math.max(cur[1], view[1])] : view
    if (!next || (cur && cur[0] === next[0] && cur[1] === next[1])) return
    latest.current.lines = next
    if (flush) flushSync(() => setLines(next))
    else setLines(next)
  }

  useLayoutEffect(() => {
    const el = scrollParent(rootRef.current)
    scroller.current = el
    if (!el) return
    // drawn in the same task as the scroll, so the rows are there before the frame is painted; a resize draws them in
    // the next render, since rows drawn inside the observer's callback change the layout it is reporting
    const onScroll = () => sync(true)
    el.addEventListener('scroll', onScroll, { passive: true })
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => sync(false)) : null
    ro?.observe(el)
    return () => {
      el.removeEventListener('scroll', onScroll)
      ro?.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootRef])

  // A row's height is the median of the drawn rows', since a glyph from a fallback font can make one row a little
  // taller. While no rows are placed they are read from the view here; after new records they are widened to the view,
  // which the reader may not have scrolled yet after a page added above: the scroll it makes narrows them again.
  const seen = useRef(records)
  useLayoutEffect(() => {
    const drawn = bodyRef.current?.querySelectorAll<HTMLElement>(':scope > .reader-table-row')
    let moved = false
    if (drawn && drawn.length) {
      const hs = Array.from(drawn, (r) => r.getBoundingClientRect().height).sort((a, b) => a - b)
      const h = hs[hs.length >> 1]
      if (h > 0 && Math.abs(h - latest.current.rowH) > 0.01) {
        latest.current.rowH = h
        setRowH(h)
        moved = true
      }
    }
    if (moved || !placed.current) sync(false)
    else if (seen.current !== latest.current.records) sync(false, true)
    seen.current = latest.current.records
  })

  useEffect(() => {
    if (drewFocus.current) focused.current = drewFocus.current
  })

  const n = records.length
  let from = lines ? indexOfLine(records, lines[0]) : 0
  let to = lines ? indexOfLine(records, lines[1] + 1) : 0
  placed.current = to > from
  if (!placed.current) {
    from = 0
    to = Math.min(n, FIRST_ROWS)
  }
  drewFocus.current = null
  if (focus && focus.key !== focused.current) {
    const i = indexOfLine(records, focus.line)
    if (i < n && records[i].line === focus.line) {
      if (i < from || i >= to) {
        from = Math.max(0, i - OVERSCAN)
        to = Math.min(n, i + OVERSCAN + 1)
      }
      drewFocus.current = focus.key
    }
  }
  return { from, to, above: from * rowH, below: (n - to) * rowH }
}

const DELIMITED = /\.(csv|tsv)$/i

/** The lines of a CSV or TSV file as its records' cells. In CSV a quoted cell may hold the delimiter, doubled quotes and
 * line breaks, so a line that ends inside one goes on in the next line; a record is keyed by its first line. A TSV line
 * is one record, its cells split at tabs with no quoting. Pure. */
export function splitDelimited(lines: { line: number; text: string }[], sep: string): { line: number; cells: string[] }[] {
  if (sep === '\t') return lines.map(({ line, text }) => ({ line, cells: text.split('\t') }))
  const out: { line: number; cells: string[] }[] = []
  let first = 0
  let last = -1
  let cells: string[] = []
  let cur = ''
  let quoted = false
  const end = () => {
    cells.push(cur)
    out.push({ line: first, cells })
  }
  for (const { line, text } of lines) {
    if (quoted && line === last + 1) cur += '\n'
    else {
      if (quoted) end()
      first = line
      cells = []
      cur = ''
      quoted = false
    }
    last = line
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]
      if (quoted) {
        if (ch !== '"') cur += ch
        else if (text[i + 1] === '"') cur += text[++i]
        else quoted = false
      } else if (ch === '"' && cur === '') quoted = true
      else if (ch === sep) {
        cells.push(cur)
        cur = ''
      } else cur += ch
    }
    if (!quoted) end()
  }
  if (quoted) end()
  return out
}

const lineText = (rec: SourceRecord | undefined): string | null => (rec && typeof rec.record?.text === 'string' ? rec.record.text : null)

/** A CSV or TSV file's records as objects keyed by its first line, which is read on its own when the page does not
 * hold it; the first line itself is no row. Any other file's records as they are. */
export function useDelimited(workspace: string, path: string, records: SourceRecord[]): SourceRecord[] {
  const delimited = DELIMITED.test(path)
  const sep = /\.tsv$/i.test(path) ? '\t' : ','
  const first = records[0]?.line === 1 ? lineText(records[0]) : null
  const [header, setHeader] = useState<string[] | null>(null)
  useEffect(() => {
    if (!delimited) return
    const cellsOf = (t: string) => splitDelimited([{ line: 1, text: t }], sep)[0]?.cells ?? []
    if (first != null) return setHeader(cellsOf(first))
    let alive = true
    api
      .source(workspace, path, 1, 1)
      .then((p) => {
        const t = lineText(p.records[0])
        if (alive && t != null) setHeader(cellsOf(t))
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [workspace, path, delimited, first, sep])
  return useMemo(() => {
    if (!delimited || !header) return records
    const name = (i: number) => header[i]?.trim() || `column ${i + 1}`
    const byLine = new Map(records.map((r) => [r.line, r]))
    const lines = records.filter((r) => r.line > 1).map((r) => ({ line: r.line, text: lineText(r) ?? '' }))
    return splitDelimited(lines, sep).map(({ line, cells }) => ({ ...byLine.get(line)!, record: Object.fromEntries(cells.map((v, i) => [name(i), v])) }))
  }, [records, header, delimited, sep])
}

/** The number each row of a CSV or TSV file shown here is cited by (`<path>#row=<n>`), by the line it starts on, as the
 * server counts rows (a cell may hold line breaks); empty for any other file and until the answer comes. */
function useRowNumbers(workspace: string, path: string, records: SourceRecord[]): Map<number, number> {
  const delimited = DELIMITED.test(path)
  const a = records[0]?.line ?? 0
  const b = records[records.length - 1]?.line ?? 0
  const [rows, setRows] = useState<Map<number, number>>(() => new Map())
  useEffect(() => {
    if (!delimited || !a || b < a) return
    let alive = true
    api
      .csvRows(workspace, path, a, b)
      .then((r) => alive && setRows(new Map(r.rows)))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [workspace, path, delimited, a, b])
  return rows
}

export function Table({ workspace, path, page, targetRef }: ViewProps) {
  const records = useDelimited(workspace, path, page.records)
  const rowOf = useRowNumbers(workspace, path, records)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const bodyRef = useRef<HTMLTableSectionElement | null>(null)
  const { target, hit } = useTarget(targetRef, path, rootRef, [records])
  const sample = useMemo(() => records.slice(0, 20).map((r) => r.record), [records])
  const cols = useMemo(() => orderColumns(columnsOf(records), sample), [records, sample])
  const wide = useMemo(() => wideColumns(records, cols), [records, cols])
  const chars = useMemo(() => columnChars(records, cols, wide), [records, cols, wide])
  const lanes = useContext(ReaderLabelsContext)?.lanes
  const tags = useMemo(() => laneTags(lanes ?? []), [lanes])
  const n = tags.length
  const focus = useMemo(() => (target && targetRef ? { key: targetRef, line: target.line } : null), [target, targetRef])
  const cited = useMemo(() => citedCell(records, cols, target), [records, cols, target])
  const drawn = useDrawnRows(rootRef, bodyRef, records, focus)
  const digits = String(records[records.length - 1]?.line ?? 0).length
  // on each dots element, not on the table: a custom property set on the table would restyle every cell when a label
  // is turned on or off
  const dotsStyle = useMemo(() => ({ '--dots': n }) as CSSProperties, [n])
  const pad = (h: number) => (
    <tr className="reader-table-pad" aria-hidden>
      <td colSpan={cols.length + 1} style={{ height: h }} />
    </tr>
  )
  return (
    <div className="reader-table-view" ref={rootRef}>
      <table className="reader-table">
        <thead>
          <tr>
            <th className="reader-table-gutter">
              {n > 0 && (
                <span className="reader-table-dots" style={dotsStyle}>
                  {tags.map((t) => (
                    <Tipped key={t.id} text={t.name} className="reader-table-tag">
                      <LabelMark multi={t.multi} colour={t.colour} on glyph={LANE_GLYPH_PX} n={t.n} />
                    </Tipped>
                  ))}
                </span>
              )}
              #
              <span className="reader-table-size mono">
                {n > 0 && <span className="reader-table-dots" style={dotsStyle} />}
                <span className="reader-table-digits" style={{ width: `${digits}ch` }} />
              </span>
            </th>
            {cols.map((c, i) => (
              <th key={c}>
                {c}
                <span className="reader-table-size mono" style={{ width: `${chars[i][0]}ch` }} />
                <span className="reader-table-size" style={{ width: `${chars[i][1]}ch` }} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody ref={bodyRef}>
          {drawn.above > 0 && pad(drawn.above)}
          {records.slice(drawn.from, drawn.to).map((rec) => (
            <TableRow key={rec.line} path={path} rec={rec} row={rowOf.get(rec.line)} cols={cols} wide={wide} dots={n} target={isTargetLine(target, rec.line)} hit={hit && isTargetLine(target, rec.line)} cited={cited?.line === rec.line ? cited : null} />
          ))}
          {drawn.below > 0 && pad(drawn.below)}
        </tbody>
      </table>
    </div>
  )
}

/** `dots` is how many labels are on: the row's dots take room for that many. `row` is a CSV row's number, which its
 * citation names; any other record is cited by its line. `target`: a followed ref names the row; `cited`: the cell
 * holding the words it quotes. */
const TableRow = memo(function TableRow({ path, rec, row, cols, wide, dots, target, hit, cited }: { path: string; rec: SourceRecord; row?: number; cols: string[]; wide: Set<string>; dots: number; target: boolean; hit: boolean; cited: { col: string | null; at: [number, number] } | null }) {
  const r = rec.record
  const obj = r && typeof r === 'object' && !Array.isArray(r) ? (r as Record<string, unknown>) : null
  const marks = useMarksAt(path, rec.line)
  const focus = useContext(ReaderLabelsContext)?.focus
  const tint = focus === undefined ? marks.lit[0] : marks.lit.find((l) => l.concept === focus)
  return (
    <tr className={['reader-card', 'reader-table-row', target && 'reader-target', hit && 'reader-hit', tint && 'has-tint'].filter(Boolean).join(' ')} style={tint ? ({ '--tint': tint.colour } as CSSProperties) : undefined} data-anchor={row ? `${path}#row=${row}` : `${path}#L${rec.line}`} data-line={rec.line}>
      <td className="reader-table-gutter mono">
        {dots > 0 && (
          <span className="reader-table-dots" style={{ '--dots': dots } as CSSProperties}>
            {marks.cells.map((c) =>
              c.values.length ? (
                <span key={c.id} className="reader-table-dot" style={{ background: cellFill(c.values) }} title={cellTitle(c)} />
              ) : (
                <span key={c.id} className="reader-table-dot is-empty" />
              ),
            )}
          </span>
        )}
        {rec.line}
      </td>
      {obj ? (
        cols.map((c) => {
          const v = obj[c]
          const quoted = cited && cited.col === c ? cited.at : null
          return (
            <td key={c} className={cellClass(v, wide.has(c)) + (quoted ? ' cited' : '')} title={titleOf(v)}>
              <span className="reader-table-clip">{quoted ? <Quoted text={cell(v)} at={quoted} spans={marks.spans} /> : <Marked text={cell(v)} spans={marks.spans} />}</span>
            </td>
          )
        })
      ) : (
        <td className={'reader-table-cell mono' + (cited ? ' cited' : '')} colSpan={cols.length} title={titleOf(r)}>
          <span className="reader-table-clip">{cited ? <Quoted text={cell(r)} at={cited.at} spans={marks.spans} /> : <Marked text={cell(r)} spans={marks.spans} />}</span>
        </td>
      )}
    </tr>
  )
})

/** How many characters of a cell's text are drawn: more than its one line shows, so the line ends in an ellipsis as it
 * would with the whole text, without laying out the rest of a long text. */
const DRAWN_CHARS = 200
const RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/

/** Where a cell stops drawing `text` that it shows from `from`: DRAWN_CHARS on, else at the end when those characters
 * would not fill the line once their white space collapses, or hold right-to-left script, whose order on the line
 * depends on the characters after it. */
function drawnEnd(text: string, from: number): number {
  const end = from + DRAWN_CHARS
  if (end >= text.length) return text.length
  const part = text.slice(from, end)
  return collapsed(part) > CLIP_TEXT_CHARS && !RTL.test(part) ? end : text.length
}

/** A cell's text with the spans the labels that are on mark; when the first mark starts past MARK_LEAD characters the
 * text starts at the word before it, after an ellipsis, so the one line the cell shows holds the mark. */
function Marked({ text, spans }: { text: string; spans: SpanMark[] }) {
  if (!spans.length) return <>{text.slice(0, drawnEnd(text, 0))}</>
  const segs = markSegments(text, spans)
  const first = segs.find((g) => g.mark)
  let cut = 0
  if (first && first.start > MARK_LEAD) {
    const space = text.slice(first.start - MARK_LEAD, first.start).trimEnd().search(/\s\S*$/)
    cut = space >= 0 ? first.start - MARK_LEAD + space + 1 : first.start
  }
  const stop = drawnEnd(text, cut)
  return (
    <>
      {cut > 0 && '…'}
      {segs.map((g, i) => {
        const end = g.start + g.text.length
        if (end <= cut || g.start >= stop) return null
        const t = g.start < cut || end > stop ? text.slice(Math.max(g.start, cut), Math.min(end, stop)) : g.text
        return g.mark ? (
          <SpanEl key={i} seg={{ ...g, text: t }}>
            {t}
          </SpanEl>
        ) : (
          t
        )
      })}
    </>
  )
}

/** characters of a cited cell's text shown before the quoted words, from a word's start */
const QUOTE_LEAD = 60
/** characters shown after them, which the cell's few lines may cut */
const QUOTE_TAIL = 240

/** A cited cell's text around the words a followed ref quotes, the words highlighted (.hl) and the spans the labels
 * that are on mark kept: from a word a little before them, after an ellipsis, so its few lines hold them. */
function Quoted({ text, at, spans }: { text: string; at: [number, number]; spans: SpanMark[] }) {
  const [a, b] = at
  let from = 0
  if (a > QUOTE_LEAD) {
    const space = text.slice(a - QUOTE_LEAD, a).search(/\s/)
    from = a - QUOTE_LEAD + (space >= 0 ? space + 1 : 0)
  }
  const to = Math.min(text.length, b + QUOTE_TAIL)
  const segs = markSegments(text, spans)
  const piece = (lo: number, hi: number) =>
    segs.map((g, i) => {
      const s = Math.max(g.start, lo)
      const e = Math.min(g.start + g.text.length, hi)
      if (s >= e) return null
      const t = text.slice(s, e)
      return g.mark ? (
        <SpanEl key={i} seg={{ ...g, text: t }}>
          {t}
        </SpanEl>
      ) : (
        <Fragment key={i}>{t}</Fragment>
      )
    })
  return (
    <>
      {from > 0 && '…'}
      {piece(from, a)}
      <span className="hl">{piece(a, b)}</span>
      {piece(b, to)}
      {to < text.length && '…'}
    </>
  )
}

const isScalar = (v: unknown) => v == null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'

/** the score of records that are objects but not flat (a widely shared key holding objects, mostly nested values, more
 * keys than columns, or few keys in common): Table is offered, under Raw's 0.1 */
export const OBJECTS_SCORE = 0.05

/**
 * How well the sample reads as a table: every record a plain object, keys within the column cap, values mostly
 * scalars, and no widely shared key mostly holding objects. Uniform records (fill >= 0.7) score 0.85; records sharing
 * a spine of keys (fill >= 0.4, at least two keys in every record) score 0.7; any other records that are all objects
 * OBJECTS_SCORE, whose nested values the cells show compacted; else 0.
 */
export function tableScore(sample: any[]): number {
  if (!sample.length) return 0
  const objs = sample.filter((r) => r && typeof r === 'object' && !Array.isArray(r))
  if (objs.length < sample.length) return 0
  const count = new Map<string, number>()
  const nested = new Map<string, number>()
  let present = 0
  let scalars = 0
  for (const o of objs) {
    for (const [k, v] of Object.entries(o)) {
      count.set(k, (count.get(k) ?? 0) + 1)
      present++
      if (isScalar(v)) scalars++
      else if (!Array.isArray(v)) nested.set(k, (nested.get(k) ?? 0) + 1)
    }
  }
  if (count.size === 0 || present === 0) return 0
  if (count.size > MAX_COLS || scalars / present < 0.5) return OBJECTS_SCORE
  for (const [k, n] of count) if (n * 2 >= objs.length && (nested.get(k) ?? 0) * 2 >= n) return OBJECTS_SCORE
  const fill = present / (objs.length * count.size)
  let shared = 0
  for (const n of count.values()) if (n === objs.length) shared++
  if (fill >= 0.7) return 0.85
  if (fill >= 0.4 && shared >= 2) return 0.7
  return OBJECTS_SCORE
}

function match(path: string, kind: SourceKind, sample: any[]): number {
  if (DELIMITED.test(path)) return 0.85
  return isJsonlFile(path, kind) ? tableScore(sample) : 0
}

const def: ViewDef = { type: 'table', title: 'Table', match, component: Table }
export default def
