// The Table view: one row per record, one column per field, offered when the records are flat objects that share
// their keys. Columns are ordered by how many records carry them; records that read as posts lead with author, time
// and body. Every cell is one line cut with an ellipsis. The labels that are on tint rows and highlight marked texts in
// cells (a cell starts a little before its first mark when the mark would fall past what it shows), and the pinned
// line-number column holds a slot per label that is on, under the label's mark (LabelMark). Only rows near the view are
// drawn, with spacer rows for the rest; hidden width holders in the header keep column widths stable.
import { memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import { Tipped } from '../../components/Tooltip'
import type { SourceKind, SourceRecord } from '../../lib/types'
import { cellFill, laneTags, markSegments, type SpanMark } from '../labels'
import { ReaderLabelsContext, useMarksAt } from '../marks'
import { LabelMark } from '../LabelMark'
import { cellTitle, compact, isJsonlFile, isTargetLine, LANE_GLYPH_PX, SpanEl, useTarget, type ViewDef, type ViewProps } from './common'
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

/** The columns holding a long text (over 40 characters, or a line break) in any record: their cells cut at one width. */
function wideColumns(records: SourceRecord[], cols: string[]): Set<string> {
  const out = new Set<string>()
  for (const rec of records) {
    const r = rec.record
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue
    for (const c of cols) {
      const v = (r as Record<string, unknown>)[c]
      if (typeof v === 'string' && (v.length > 40 || v.includes('\n'))) out.add(c)
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
    // drawn in the same task as the scroll, so the rows are there before the frame is painted
    const onScroll = () => sync(true)
    el.addEventListener('scroll', onScroll, { passive: true })
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onScroll) : null
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

export function Table({ path, page, targetRef }: ViewProps) {
  const records = page.records
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
            <TableRow key={rec.line} path={path} rec={rec} cols={cols} wide={wide} dots={n} hit={hit && isTargetLine(target, rec.line)} />
          ))}
          {drawn.below > 0 && pad(drawn.below)}
        </tbody>
      </table>
    </div>
  )
}

/** `dots` is how many labels are on: the row's dots take room for that many. */
const TableRow = memo(function TableRow({ path, rec, cols, wide, dots, hit }: { path: string; rec: SourceRecord; cols: string[]; wide: Set<string>; dots: number; hit: boolean }) {
  const r = rec.record
  const obj = r && typeof r === 'object' && !Array.isArray(r) ? (r as Record<string, unknown>) : null
  const marks = useMarksAt(path, rec.line)
  const focus = useContext(ReaderLabelsContext)?.focus
  const tint = focus === undefined ? marks.lit[0] : marks.lit.find((l) => l.concept === focus)
  return (
    <tr className={['reader-card', 'reader-table-row', hit && 'reader-hit', tint && 'has-tint'].filter(Boolean).join(' ')} style={tint ? ({ '--tint': tint.colour } as CSSProperties) : undefined} data-anchor={`${path}#L${rec.line}`} data-line={rec.line}>
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
          return (
            <td key={c} className={cellClass(v, wide.has(c))} title={titleOf(v)}>
              <span className="reader-table-clip">
                <Marked text={cell(v)} spans={marks.spans} />
              </span>
            </td>
          )
        })
      ) : (
        <td className="reader-table-cell mono" colSpan={cols.length} title={titleOf(r)}>
          <span className="reader-table-clip">
            <Marked text={cell(r)} spans={marks.spans} />
          </span>
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

const isScalar = (v: unknown) => v == null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'

/**
 * How well the sample reads as a table: every record a plain object, keys within the column cap, values mostly
 * scalars, and no widely shared key mostly holding objects. Uniform records (fill >= 0.7) score 0.85; records sharing
 * a spine of keys (fill >= 0.4, at least two keys in every record) score 0.7; anything else 0.
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
  if (count.size === 0 || count.size > MAX_COLS || present === 0) return 0
  if (scalars / present < 0.5) return 0
  for (const [k, n] of count) if (n * 2 >= objs.length && (nested.get(k) ?? 0) * 2 >= n) return 0
  const fill = present / (objs.length * count.size)
  let shared = 0
  for (const n of count.values()) if (n === objs.length) shared++
  if (fill >= 0.7) return 0.85
  if (fill >= 0.4 && shared >= 2) return 0.7
  return 0
}

function match(path: string, kind: SourceKind, sample: any[]): number {
  return isJsonlFile(path, kind) ? tableScore(sample) : 0
}

const def: ViewDef = { type: 'table', title: 'Table', match, component: Table }
export default def
