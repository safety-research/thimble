// Renderings for a card that carries a dataset instead of code: a timeline (events down a time axis), a diagram (nodes
// in layers by dependency) and a custom card (a sandboxed iframe sized to its content). The spec and layouts are pure.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useTheme } from '../lib/theme'
import type { GraphDataset, TimelineDataset } from '../lib/types'
import { frameStyle, frameTokens, useFrameFonts, withFrameStyle } from '../lib/frame'
import { useVisibleSize } from '../lib/visibleSize'

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export function asTimeline(dataset: unknown): (TimelineDataset & { spacing?: 'even' }) | null {
  if (!isObj(dataset) || !Array.isArray(dataset.events)) return null
  const events = (dataset.events as unknown[]).filter(isObj).filter((e) => 'label' in e || 'time' in e) as TimelineDataset['events']
  // thimble.timeline(spacing="even") (backend kernel_thimble): the rows at an equal distance
  return dataset.spacing === 'even' ? { events, spacing: 'even' } : { events }
}

export function asGraph(dataset: unknown): GraphDataset | null {
  if (!isObj(dataset) || !Array.isArray(dataset.nodes)) return null
  const nodes = (dataset.nodes as unknown[]).map((n) => (isObj(n) ? n : { id: String(n) })).filter((n) => n.id != null) as GraphDataset['nodes']
  const edges = (Array.isArray(dataset.edges) ? (dataset.edges as unknown[]).filter(isObj) : []) as GraphDataset['edges']
  return { nodes, edges }
}

const timeKey = (t: unknown): number => {
  if (typeof t === 'number') return t
  const n = Date.parse(String(t ?? ''))
  return Number.isNaN(n) ? Number.POSITIVE_INFINITY : n
}

export function sortedEvents(events: TimelineDataset['events']): TimelineDataset['events'] {
  return [...events].sort((a, b) => timeKey(a.time) - timeKey(b.time))
}

// ---- the timeline: a list of events down a time axis ----

const MAX_EVENTS = 60

/** How the times read: dates, numbers, or the labels in order. */
export function timeAxisType(events: readonly { time?: unknown }[]): 'temporal' | 'quantitative' | 'ordinal' {
  const times = events.map((e) => e.time).filter((t) => t != null && t !== '')
  if (!times.length) return 'ordinal'
  if (times.every((t) => typeof t === 'number')) return 'quantitative'
  if (times.every((t) => typeof t === 'string' && !Number.isNaN(Date.parse(t)))) return 'temporal'
  return 'ordinal'
}

const TWO_DAYS_MS = 2 * 24 * 3600 * 1000

/** The format of the times, from their span: the time of day when they fall within two days, else the date. Clock
 * times (thimble.timeline's "01:03") arrive as times on one day. */
export function timeFormat(events: readonly { time?: unknown }[]): string {
  const ts = events.map((e) => timeKey(e.time)).filter((t) => Number.isFinite(t))
  return ts.length && Math.max(...ts) - Math.min(...ts) < TWO_DAYS_MS ? '%H:%M' : '%b %d'
}

/** Where each event sits along the span, 0 to 1: dates and numbers by value, anything else by order. */
export function timeFractions(events: readonly { time?: unknown }[], type: 'temporal' | 'quantitative' | 'ordinal'): number[] {
  const n = events.length
  const byOrder = (i: number) => (n > 1 ? i / (n - 1) : 0.5)
  if (type === 'ordinal') return events.map((_, i) => byOrder(i))
  const ts = events.map((e) => timeKey(e.time))
  const finite = ts.filter((t) => Number.isFinite(t))
  const min = Math.min(...finite)
  const max = Math.max(...finite)
  return ts.map((t, i) => (!Number.isFinite(t) ? byOrder(i) : max > min ? (t - min) / (max - min) : 0.5))
}

/** the month of the day thimble.timeline reads clock times on (backend kernel_thimble.CLOCK_DAY, 2000-01-01) */
const CLOCK_MONTH = '2000-01-'
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
// an ISO date or date-time as written: its wall-clock parts are shown as they are, whatever zone it names, so a time
// the data gives in UTC reads as the data and the takeaway give it
const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/

/** One time as the list shows it, in `format` (timeFormat's), with its seconds when `seconds`, and with its date as
 * well when `withDate` (events days apart that share a day). A number reads as itself, other text as written. */
export function timeText(t: unknown, format: string, seconds = false, withDate = false): string {
  if (typeof t === 'number') return t.toLocaleString()
  const str = String(t ?? '')
  const m = ISO.exec(str)
  let parts: { mo: number; d: number; h: number; mi: number; s: number; timed: boolean } | null = null
  if (m) parts = { mo: +m[2] - 1, d: +m[3], h: +(m[4] ?? 0), mi: +(m[5] ?? 0), s: +(m[6] ?? 0), timed: m[4] != null }
  else if (!Number.isNaN(Date.parse(str))) {
    const dt = new Date(Date.parse(str))
    parts = { mo: dt.getMonth(), d: dt.getDate(), h: dt.getHours(), mi: dt.getMinutes(), s: dt.getSeconds(), timed: true }
  }
  if (!parts) return str
  const two = (n: number) => String(n).padStart(2, '0')
  const clock = `${two(parts.h)}:${two(parts.mi)}${seconds ? `:${two(parts.s)}` : ''}`
  const date = `${MONTHS[parts.mo]} ${parts.d}`
  if (format === '%H:%M') return parts.timed ? clock : date
  return withDate && parts.timed ? `${date} ${clock}` : date
}

/** One event as the list draws it: its time (and end), lane, label, the gap above it in px (growing with the time since
 * the event before), and `brk`, the wait's length when it is a break (timelineBreaks), '' otherwise. */
export interface TimelineRow {
  time: string
  end: string
  lane: string
  label: string
  gap: number
  brk: string
}

/** the least gap between two rows, and the most one gap may take */
const ROW_GAP_MIN = 2
const ROW_GAP_MAX = 28
/** the room the gaps share in all, px per event, up to a ceiling: a long wait between two events reads as a longer gap */
const GAP_PER_EVENT = 8
const GAP_TOTAL_MAX = 120
/** A wait is a break when it is at least BREAK_TIMES the median wait and at least BREAK_SHARE of the whole span. */
const BREAK_TIMES = 4
const BREAK_SHARE = 0.15

/**
 * Which waits of a timeline are breaks, by the index of the event after each. `ts` are the events' times in order, as
 * numbers (ms for dates); fewer than three waits have no break. Pure.
 */
export function timelineBreaks(ts: readonly number[]): Set<number> {
  const waits = ts.slice(1).map((t, i) => t - ts[i])
  const known = waits.filter((w) => Number.isFinite(w) && w > 0).sort((a, b) => a - b)
  const out = new Set<number>()
  if (known.length < 3) return out
  const median = known[Math.floor((known.length - 1) / 2)]
  const finite = ts.filter((t) => Number.isFinite(t))
  const span = Math.max(...finite) - Math.min(...finite)
  waits.forEach((w, i) => {
    if (Number.isFinite(w) && w >= BREAK_TIMES * median && w >= BREAK_SHARE * span) out.add(i + 1)
  })
  return out
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** A wait as its break names it: for dates (ms) in seconds, minutes, hours, days, months or years, the first unit that
 * gives a short whole number; for numbers, the difference. */
export function waitText(ms: number, type: 'temporal' | 'quantitative'): string {
  if (type === 'quantitative') return `+${ms.toLocaleString()}`
  const unit = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`
  if (ms < MINUTE) return unit(Math.round(ms / 1000), 's', 's')
  if (ms < 90 * MINUTE) return unit(Math.round(ms / MINUTE), 'min', 'min')
  if (ms < 36 * HOUR) return unit(Math.round(ms / HOUR), 'h', 'h')
  if (ms < 60 * DAY) return unit(Math.round(ms / DAY), 'day')
  if (ms < 730 * DAY) return unit(Math.round(ms / (30.44 * DAY)), 'month')
  return unit(Math.round(ms / (365.25 * DAY)), 'year')
}

/**
 * The rows of a timeline: the events in time order (at most MAX_EVENTS), each time formatted for the span, and a gap
 * above each that grows with the time since the one before. A break (timelineBreaks) is named in `brk` and left out of
 * the spacing; with `even` every gap is the least one and nothing is a break. Pure.
 */
export function timelineRows(events: TimelineDataset['events'], even = false): TimelineRow[] {
  const sorted = sortedEvents(events).slice(0, MAX_EVENTS)
  const type = timeAxisType(sorted)
  const format = type === 'temporal' ? timeFormat(sorted) : ''
  const plain = sorted.map((e) => timeText(e.time, format))
  // two events that read the same time take the finer form, and so does every other time, so the column reads one way
  const finer = type === 'temporal' && new Set(plain).size < plain.length
  const seconds = finer && format === '%H:%M'
  const withDate = finer && format !== '%H:%M'
  const clock = sorted.map((e, i) => (finer ? timeText(e.time, format, seconds, withDate) : plain[i]))
  // times of day across midnight: the first time of each day carries its date, so the change of day is not lost
  // (clock times that thimble.timeline put on its day, 2000-01-01, count their days instead of naming a date)
  const onClockDay = sorted.every((e) => typeof e.time === 'string' && e.time.startsWith(CLOCK_MONTH))
  const days = sorted.map((e) => (format !== '%H:%M' ? '' : onClockDay ? `day ${Number(String(e.time).slice(8, 10))}` : timeText(e.time, '%b %d')))
  const newDay = new Set(days).size > 1
  const times = clock.map((t, i) => (newDay && (i === 0 || days[i] !== days[i - 1]) ? `${days[i]} ${t}` : t))
  const spaced = type !== 'ordinal' && !even
  const ts = sorted.map((e) => timeKey(e.time))
  const breaks = spaced ? timelineBreaks(ts) : new Set<number>()
  // the gaps share the budget in proportion to the waits that are not breaks
  const waits = ts.map((t, i) => (i === 0 || breaks.has(i) || !Number.isFinite(t) || !Number.isFinite(ts[i - 1]) ? 0 : Math.max(0, t - ts[i - 1])))
  const spread = waits.reduce((a, w) => a + w, 0)
  const budget = Math.min(GAP_TOTAL_MAX, GAP_PER_EVENT * sorted.length)
  return sorted.map((e, i) => ({
    time: times[i],
    end: e.end != null && e.end !== '' && e.end !== e.time ? timeText(e.end, format, seconds, withDate) : '',
    lane: e.lane != null ? String(e.lane) : '',
    label: String(e.label ?? ''),
    gap: i === 0 ? 0 : !spaced || breaks.has(i) || spread <= 0 ? ROW_GAP_MIN : Math.round(Math.min(ROW_GAP_MAX, ROW_GAP_MIN + (budget * waits[i]) / spread)),
    brk: breaks.has(i) ? waitText(ts[i] - ts[i - 1], type === 'quantitative' ? 'quantitative' : 'temporal') : '',
  }))
}

/**
 * A timeline: the events down a time axis, one to a row, the time at the left, a dot on the axis, the label at the
 * right. A break is a short dashed stretch of the axis with the wait's length beside it.
 */
export function Timeline({ dataset }: { dataset: TimelineDataset & { spacing?: 'even' }; fitWidth?: number }) {
  const even = dataset.spacing === 'even'
  const rows = useMemo(() => timelineRows(dataset.events, even), [dataset.events, even])
  if (!rows.length) return null
  const timeW = Math.max(...rows.map((r) => Math.max(r.time.length + (r.end ? r.end.length + 1 : 0), r.brk.length)))
  return (
    <div className="canvas-timeline" data-body="" data-settled="true">
      <ol className="canvas-tl" style={{ '--tl-time': `${timeW}ch` } as CSSProperties}>
        {rows.flatMap((r, i) => [
          ...(r.brk
            ? [
                <li key={`b${i}`} className="canvas-tl-break" aria-label={`${r.brk} later`}>
                  <span className="canvas-tl-wait">{r.brk}</span>
                </li>,
              ]
            : []),
          <li
            key={i}
            data-part=""
            className={rows[i + 1]?.brk ? 'canvas-tl-row canvas-tl-before-break' : 'canvas-tl-row'}
            style={rows[i + 1]?.gap && !rows[i + 1].brk ? { paddingBottom: rows[i + 1].gap } : undefined}
          >
            <span className="canvas-tl-time">{r.end ? `${r.time}–${r.end}` : r.time}</span>
            <span className="canvas-tl-dot" aria-hidden="true" />
            <span className="canvas-tl-label">
              {r.lane ? <span className="canvas-tl-lane">{r.lane}</span> : null}
              {r.label}
            </span>
          </li>,
        ])}
      </ol>
      {dataset.events.length > MAX_EVENTS && <div className="dim canvas-viz-more">{dataset.events.length - MAX_EVENTS} more events</div>}
    </div>
  )
}

// ---- the diagram: nodes in layers by dependency, top to bottom, edges with their labels or numbered notes ----

const MAX_NODES = 40
const MAX_EDGES = 80

export interface DiagramEdgeIn {
  source: string
  target: string
  label: string
}

/** An edge's ends and label, whichever field names the dataset used (`source`/`target` or `from`/`to`). */
export function edgeOf(e: Record<string, unknown>): DiagramEdgeIn | null {
  const source = e.source ?? e.from
  const target = e.target ?? e.to
  if (source == null || target == null) return null
  const label = e.label ?? e.weight
  return { source: String(source), target: String(target), label: label == null ? '' : String(label) }
}

/**
 * Nodes in layers by dependency: a node with no incoming edge sits in layer 0, every other one layer past its
 * furthest predecessor. A cycle is broken at the node with the fewest unplaced predecessors.
 */
export function layerGraph(ids: readonly string[], edges: readonly DiagramEdgeIn[]): Map<string, number> {
  const known = new Set(ids)
  const preds = new Map<string, Set<string>>(ids.map((id) => [id, new Set<string>()]))
  for (const e of edges) if (known.has(e.source) && known.has(e.target) && e.source !== e.target) preds.get(e.target)!.add(e.source)
  const layer = new Map<string, number>()
  const left = new Set(ids)
  while (left.size) {
    let placed = 0
    for (const id of Array.from(left)) {
      const ps = Array.from(preds.get(id)!)
      if (ps.every((p) => layer.has(p))) {
        layer.set(id, ps.reduce((m, p) => Math.max(m, layer.get(p)! + 1), 0))
        left.delete(id)
        placed++
      }
    }
    if (placed) continue
    // a cycle: place the node with the fewest unplaced predecessors, past the ones already placed
    const pick = Array.from(left).sort((a, b) => Array.from(preds.get(a)!).filter((p) => !layer.has(p)).length - Array.from(preds.get(b)!).filter((p) => !layer.has(p)).length)[0]
    layer.set(pick, Array.from(preds.get(pick)!).reduce((m, p) => (layer.has(p) ? Math.max(m, layer.get(p)! + 1) : m), 0))
    left.delete(pick)
  }
  return layer
}

export interface DiagramNode {
  id: string
  /** the node's name as given, and its detail (the lines after the name, or the node's `detail`) */
  label: string
  detail: string
  layer: number
  x: number
  y: number
  w: number
  h: number
  /** the name and the detail wrapped to the box */
  lines: string[]
  detailLines: string[]
}
export interface DiagramEdge {
  source: string
  target: string
  label: string
  path: string
  /** the points the path runs through, its curves as short straight steps (for placing labels clear of it) */
  line: { x: number; y: number }[]
  /** where the label (or its number) sits */
  lx: number
  ly: number
  /** the label is written on the edge; otherwise the edge carries the number `n` of a note under the drawing */
  inline: boolean
  n?: number
  /** the edge points back up the rows: it is drawn from its target down to its source, the arrow at its start */
  rev: boolean
}
/** A long edge label, written under the drawing with its number and the two nodes it joins. */
export interface DiagramNote {
  n: number
  source: string
  target: string
  label: string
}
export interface DiagramLayout {
  nodes: DiagramNode[]
  edges: DiagramEdge[]
  notes: DiagramNote[]
  width: number
  height: number
}

/** the px of one character: a name in mono 11, a detail and an edge label in mono 10 */
const NAME_CW = 6.6
const DETAIL_CW = 6
const LABEL_CW = 6
const NAME_LINE = 15
const DETAIL_LINE = 13
const NODE_PAD_X = 10
const NODE_PAD_Y = 7
/** a name wraps near this many characters, over at most NAME_LINES lines; a detail near DETAIL_CHARS over DETAIL_LINES */
const NAME_CHARS = 24
const NAME_LINES = 3
const DETAIL_CHARS = 32
const DETAIL_LINES = 3
const NODE_W_MIN = 56
const NODE_W_MAX = 240
/** a node narrowed to fit its row keeps this width at least; a row that still does not fit scrolls */
const NODE_W_FLOOR = 100
/** a row whose nodes would come out narrower than this (a name of about 15 characters to a line) is spread over two */
const NODE_W_ROOMY = 120
const GAP_X = 28
/** the gap between two nodes of a row that is short of room closes to this before its nodes narrow */
const GAP_X_MIN = 12
const LAYER_GAP = 46
const LAYER_GAP_BARE = 30
/** a long edge's point in a layer it passes through */
const DUMMY_W = 10
/** an edge label up to this many characters is written on the edge; a longer one is a numbered note under the drawing */
const INLINE_CHARS = 36
const LABEL_H = 14
const MARK_R = 8

/** A node's name as a note names it: without a closing parenthesis's aside, cut at NOTE_NAME characters. */
const NOTE_NAME = 28
const shortName = (name: string): string => {
  const bare = name.replace(/\s*\([^()]*\)\s*$/, '').trim() || name
  return bare.length > NOTE_NAME ? bare.slice(0, NOTE_NAME - 1).trimEnd() + '…' : bare
}

const nodeLabel = (n: GraphDataset['nodes'][number]) => (n.label != null && n.label !== '' ? String(n.label) : String(n.id))

/** Words wrapped into lines of about `chars` characters, a word longer than that broken; past `max` lines the last one
 * ends in an ellipsis. */
export function wrapWords(text: string, chars: number, max: number): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    let cur = ''
    for (let w of para.split(/\s+/).filter(Boolean)) {
      while (w.length > chars) {
        if (cur) {
          out.push(cur)
          cur = ''
        }
        // a long word (a path, a file name) breaks after a slash, a dot, a dash or an underscore where one falls in reach
        const cut = Math.max(...['/', '.', '-', '_'].map((c) => w.lastIndexOf(c, chars - 1)))
        const at = cut >= Math.floor(chars / 3) ? cut + 1 : chars
        out.push(w.slice(0, at))
        w = w.slice(at)
      }
      if (cur && cur.length + 1 + w.length > chars) {
        out.push(cur)
        cur = w
      } else cur = cur ? `${cur} ${w}` : w
    }
    if (cur) out.push(cur)
  }
  if (out.length <= max) return out
  const kept = out.slice(0, max)
  const last = kept[max - 1]
  kept[max - 1] = (last.length >= chars ? last.slice(0, chars - 1).trimEnd() : last) + '…'
  return kept
}

type Box = { x0: number; y0: number; x1: number; y1: number }
type Pt = { x: number; y: number }
const hits = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1
/** the points an edge's line keeps per curve between two rows, close enough that a label's box cannot fall between two */
const LINE_STEPS = 16
/** Whether a polyline runs through a box: a point of it inside, or one of its segments across one of the box's sides. */
const lineHits = (line: readonly Pt[], b: Box): boolean => {
  const inside = (p: Pt) => p.x > b.x0 && p.x < b.x1 && p.y > b.y0 && p.y < b.y1
  const sides: [Pt, Pt][] = [
    [{ x: b.x0, y: b.y0 }, { x: b.x1, y: b.y0 }],
    [{ x: b.x1, y: b.y0 }, { x: b.x1, y: b.y1 }],
    [{ x: b.x1, y: b.y1 }, { x: b.x0, y: b.y1 }],
    [{ x: b.x0, y: b.y1 }, { x: b.x0, y: b.y0 }],
  ]
  for (let i = 0; i < line.length; i++) {
    if (inside(line[i])) return true
    if (i > 0 && sides.some(([p, q]) => segmentsCross(line[i - 1], line[i], p, q))) return true
  }
  return false
}
/** Whether two segments cross at a point inside both (touching or running along each other is no crossing). */
export const segmentsCross = (a: Pt, b: Pt, c: Pt, d: Pt): boolean => {
  const side = (p: Pt, q: Pt, r: Pt) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x))
  return side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0
}

/** Lefts for a row of boxes of widths `w`, in order, each as near its wanted centre as the gaps allow, inside [0, room]. */
function placeRow(w: readonly number[], want: readonly number[], room: number, gap: number): number[] {
  const x = w.map((wi, i) => want[i] - wi / 2)
  for (let i = 0; i < x.length; i++) x[i] = Math.max(x[i], i ? x[i - 1] + w[i - 1] + gap : 0)
  for (let i = x.length - 1; i >= 0; i--) x[i] = Math.min(x[i], i < x.length - 1 ? x[i + 1] - gap - w[i] : room - w[i])
  for (let i = 0; i < x.length; i++) x[i] = Math.max(x[i], i ? x[i - 1] + w[i - 1] + gap : 0)
  return x
}

/**
 * Spread a row too wide for the room over more rows, a group of siblings (nodes with the same parents) at a time,
 * keeping groups with onward edges first. A group too wide by itself is cut into even parts. Nodes below a moved one
 * move down after it, so every edge still points down. Changes `layer` in place.
 */
export function spreadRows(layer: Map<string, number>, ids: readonly string[], edges: readonly DiagramEdgeIn[], roomyW: (id: string) => number, room: number): void {
  if (!Number.isFinite(room)) return
  const next = new Map<string, string[]>()
  const prev = new Map<string, string[]>()
  for (const e of edges) {
    next.set(e.source, [...(next.get(e.source) ?? []), e.target])
    prev.set(e.target, [...(prev.get(e.target) ?? []), e.source])
  }
  const push = (id: string, seen: Set<string>) => {
    if (seen.has(id)) return
    seen.add(id)
    layer.set(id, layer.get(id)! + 1)
    for (const t of next.get(id) ?? []) if (layer.get(t)! <= layer.get(id)! && layer.get(t)! >= layer.get(id)! - 1) push(t, seen)
  }
  const width = (row: readonly string[]) => row.reduce((a, id) => a + roomyW(id), 0) + Math.max(0, row.length - 1) * GAP_X_MIN
  const onward = (id: string) => (next.get(id) ?? []).length > 0
  for (let guard = 0; guard < 4 * ids.length; guard++) {
    const depth = Math.max(0, ...Array.from(layer.values()))
    let moved = false
    for (let l = 0; l <= depth && !moved; l++) {
      const row = ids.filter((id) => layer.get(id) === l)
      if (row.length < 2 || width(row) <= room) continue
      const groups = new Map<string, string[]>()
      for (const id of row) {
        const key = (prev.get(id) ?? []).filter((p) => layer.get(p)! < l).sort().join('\u0000')
        groups.set(key, [...(groups.get(key) ?? []), id])
      }
      const gs = Array.from(groups.values())
      let stay: string[]
      if (gs.length > 1) {
        // from the middle group outward, so the edges down to the groups that move pass the row on both sides of it
        const mid = (gs.length - 1) / 2
        const order = gs
          .map((g, i) => ({ g, i, leafy: g.some(onward) ? 0 : 1 }))
          .sort((a, b) => a.leafy - b.leafy || Math.abs(a.i - mid) - Math.abs(b.i - mid) || a.i - b.i)
        stay = []
        for (const { g } of order) if (!stay.length || width([...stay, ...g]) <= room) stay.push(...g)
      } else {
        const parts = Math.ceil(width(row) / room)
        stay = [...row.filter(onward), ...row.filter((id) => !onward(id))].slice(0, Math.max(1, Math.ceil(row.length / parts)))
      }
      row.filter((id) => !stay.includes(id)).forEach((id) => push(id, new Set()))
      moved = true
    }
    if (!moved) return
  }
}

export interface DiagramLayoutOptions {
  /** the room the diagram has, px: a row of nodes wider than it narrows its nodes (their names wrap onto more lines) down
   * to a floor, and only a row that fits at none of these is wider than the room */
  width?: number
}

/**
 * A diagram laid out top to bottom, a layer of nodes to a row (layerGraph), for the width of a card: each node a box
 * with its name wrapped and its detail under it, rows ordered to cross few edges. An edge runs from its source's bottom
 * to its target's top through a point in each row it passes; a short label is written on the edge, a long one becomes
 * a numbered note under the drawing. Pure.
 */
export function diagramLayout(g: GraphDataset, opts: DiagramLayoutOptions = {}): DiagramLayout {
  const nodesIn = g.nodes.slice(0, MAX_NODES)
  const ids = nodesIn.map((n) => String(n.id))
  const known = new Set(ids)
  const edgesIn = g.edges
    .slice(0, MAX_EDGES)
    .map(edgeOf)
    .filter((e): e is DiagramEdgeIn => !!e && known.has(e.source) && known.has(e.target) && e.source !== e.target)
  const layer = layerGraph(ids, edgesIn)
  const room = opts.width && Number.isFinite(opts.width) && opts.width > 0 ? opts.width : Infinity

  // the boxes: the name wrapped, the detail under it
  const info = new Map<string, { label: string; detail: string }>()
  for (const n of nodesIn) {
    const raw = nodeLabel(n)
    const nl = raw.indexOf('\n')
    const name = (nl < 0 ? raw : raw.slice(0, nl)).trim() || String(n.id)
    const more = [nl < 0 ? '' : raw.slice(nl + 1), typeof n.detail === 'string' ? n.detail : typeof n.description === 'string' ? n.description : '']
    info.set(String(n.id), { label: name, detail: more.filter(Boolean).join('\n').replace(/\n\s*\n/g, '\n').trim() })
  }
  const boxOf = (id: string, width?: number) => {
    const { label, detail } = info.get(id)!
    const nameChars = width ? Math.max(6, Math.floor((width - 2 * NODE_PAD_X) / NAME_CW)) : NAME_CHARS
    const detailChars = width ? Math.max(8, Math.floor((width - 2 * NODE_PAD_X) / DETAIL_CW)) : DETAIL_CHARS
    const lines = wrapWords(label, nameChars, width ? NAME_LINES + 1 : NAME_LINES)
    const detailLines = detail ? wrapWords(detail, detailChars, DETAIL_LINES) : []
    const natural = Math.max(...lines.map((l) => l.length * NAME_CW), ...detailLines.map((l) => l.length * DETAIL_CW)) + 2 * NODE_PAD_X
    const w = width ?? Math.min(NODE_W_MAX, Math.max(NODE_W_MIN, Math.ceil(natural)))
    const h = 2 * NODE_PAD_Y + lines.length * NAME_LINE + (detailLines.length ? 3 + detailLines.length * DETAIL_LINE : 0)
    return { lines, detailLines, w, h }
  }
  const box = new Map(ids.map((id) => [id, boxOf(id)] as const))
  spreadRows(layer, ids, edgesIn, (id) => Math.min(box.get(id)!.w, NODE_W_ROOMY), room)

  // the rows, with a point for each edge in every row it passes through
  // an edge between two rows runs down from the upper node to the lower one; one that points back up is drawn the same
  // way with its arrow at the upper end
  type Run = { e: DiagramEdgeIn; top: string; bottom: string; rev: boolean }
  const runs: Run[] = edgesIn
    .filter((e) => layer.get(e.target)! !== layer.get(e.source)!)
    .map((e) => (layer.get(e.target)! > layer.get(e.source)! ? { e, top: e.source, bottom: e.target, rev: false } : { e, top: e.target, bottom: e.source, rev: true }))
  const runOf = new Map(runs.map((r) => [r.e, r] as const))
  const depth = Math.max(0, ...Array.from(layer.values()))
  const rows: string[][] = Array.from({ length: depth + 1 }, () => [])
  for (const id of ids) rows[layer.get(id)!].push(id)
  const chain = new Map<DiagramEdgeIn, string[]>()
  const up = new Map<string, string[]>()
  const down = new Map<string, string[]>()
  const link = (a: string, b: string) => {
    if (!(down.get(a) ?? []).includes(b)) down.set(a, [...(down.get(a) ?? []), b])
    if (!(up.get(b) ?? []).includes(a)) up.set(b, [...(up.get(b) ?? []), a])
  }
  runs.forEach(({ e, top, bottom, rev }) => {
    const pts = [top]
    for (let l = layer.get(top)! + 1; l < layer.get(bottom)!; l++) {
      // the edges from one node that pass a row share one point in it, so they run down as one line and part above their
      // targets' row
      const d = `\u0000${top}\u0000${rev ? 'up' : 'down'}\u0000${l}`
      if (!rows[l].includes(d)) rows[l].push(d)
      pts.push(d)
    }
    pts.push(bottom)
    for (let i = 1; i < pts.length; i++) link(pts[i - 1], pts[i])
    chain.set(e, pts)
  })
  const wOf = (id: string) => (id.startsWith('\u0000') ? DUMMY_W : box.get(id)!.w)

  // the order within each row: the mean place of each node's neighbours in the row above, then below, a few times over
  const rank = new Map<string, number>()
  const setRanks = () => rows.forEach((r) => r.forEach((id, i) => rank.set(id, i)))
  setRanks()
  const sweep = (l: number, from: Map<string, string[]>) => {
    const key = (id: string) => {
      const ns = from.get(id) ?? []
      return ns.length ? ns.reduce((a, n) => a + rank.get(n)!, 0) / ns.length : rank.get(id)!
    }
    rows[l] = rows[l].map((id) => [id, key(id)] as const).sort((a, b) => a[1] - b[1]).map(([id]) => id)
    rows[l].forEach((id, i) => rank.set(id, i))
  }
  for (let it = 0; it < 4; it++) {
    for (let l = 1; l <= depth; l++) sweep(l, up)
    for (let l = depth - 1; l >= 0; l--) sweep(l, down)
  }
  // then two neighbours in a row trade places wherever that crosses fewer edges with the rows above and below, which
  // the means above leave undone when two nodes tie
  const crossings = (l: number): number => {
    if (l < 0 || l >= depth) return 0
    const es: [number, number][] = []
    for (const id of rows[l]) for (const d of down.get(id) ?? []) es.push([rank.get(id)!, rank.get(d)!])
    let n = 0
    for (let i = 0; i < es.length; i++) for (let j = i + 1; j < es.length; j++) if ((es[i][0] - es[j][0]) * (es[i][1] - es[j][1]) < 0) n++
    return n
  }
  for (let pass = 0, better = true; better && pass < 8; pass++) {
    better = false
    for (let l = 0; l <= depth; l++) {
      const r = rows[l]
      for (let i = 0; i + 1 < r.length; i++) {
        const before = crossings(l - 1) + crossings(l)
        ;[r[i], r[i + 1]] = [r[i + 1], r[i]]
        rank.set(r[i], i)
        rank.set(r[i + 1], i + 1)
        if (crossings(l - 1) + crossings(l) < before) better = true
        else {
          ;[r[i], r[i + 1]] = [r[i + 1], r[i]]
          rank.set(r[i], i)
          rank.set(r[i + 1], i + 1)
        }
      }
    }
  }

  // the width: a row wider than the room closes its gaps, then narrows its nodes, down to a floor
  const gapOf = rows.map(() => GAP_X)
  rows.forEach((r, l) => {
    const real = r.filter((id) => !id.startsWith('\u0000'))
    const dummies = (r.length - real.length) * DUMMY_W
    const sum = real.reduce((a, id) => a + box.get(id)!.w, 0)
    if ((r.length - 1) * GAP_X + dummies + sum <= room || !real.length) return
    gapOf[l] = r.length > 1 ? Math.max(GAP_X_MIN, Math.floor((room - dummies - sum) / (r.length - 1))) : GAP_X
    const fixed = (r.length - 1) * gapOf[l] + dummies
    if (fixed + sum <= room) return
    // one share k of every node's width, with the nodes that would go below their floor held at it and k found again
    // for the rest, so the row comes out at the room's width
    const floorOf = (id: string) => Math.min(box.get(id)!.w, NODE_W_FLOOR)
    const held = new Set<string>()
    let k = 1
    for (let pass = 0; pass < real.length; pass++) {
      const free = real.filter((id) => !held.has(id))
      const freeSum = free.reduce((a, id) => a + box.get(id)!.w, 0)
      const heldSum = real.filter((id) => held.has(id)).reduce((a, id) => a + floorOf(id), 0)
      k = freeSum > 0 ? Math.max(0, room - fixed - heldSum) / freeSum : 1
      const under = free.filter((id) => box.get(id)!.w * k < floorOf(id))
      if (!under.length) break
      under.forEach((id) => held.add(id))
    }
    for (const id of real) {
      const w = box.get(id)!.w
      const next = held.has(id) ? floorOf(id) : Math.floor(w * k)
      if (next < w) box.set(id, boxOf(id, next))
    }
  })
  const rowWidth = (r: string[], l: number) => r.reduce((a, id) => a + wOf(id), 0) + Math.max(0, r.length - 1) * gapOf[l]
  const inner = Math.max(...rows.map((r, l) => rowWidth(r, l)), 1)
  const W = Number.isFinite(room) ? Math.max(room, inner) : inner

  // the rows' heights and tops
  const rowH = rows.map((r) => Math.max(DUMMY_W, ...r.filter((id) => !id.startsWith('\u0000')).map((id) => box.get(id)!.h)))
  // the gap under a row has room for labels only when an edge leaving the row carries one
  const labelled = new Set(edgesIn.filter((e) => e.label.trim()).map((e) => layer.get(e.source)!))
  const rowY: number[] = []
  rowH.reduce((y, h, l) => ((rowY[l] = y), y + h + (labelled.has(l) ? LAYER_GAP : LAYER_GAP_BARE)), 0)

  // the places: each row centred, then each node drawn toward the nodes it joins above, then below
  const cx = new Map<string, number>()
  rows.forEach((r, l) => {
    let x = (W - rowWidth(r, l)) / 2
    for (const id of r) {
      cx.set(id, x + wOf(id) / 2)
      x += wOf(id) + gapOf[l]
    }
  })
  const pull = (l: number, from: Map<string, string[]>) => {
    const r = rows[l]
    const want = r.map((id) => {
      const ns = from.get(id) ?? []
      return ns.length ? ns.reduce((a, n) => a + cx.get(n)!, 0) / ns.length : cx.get(id)!
    })
    const xs = placeRow(r.map(wOf), want, W, gapOf[l])
    r.forEach((id, i) => cx.set(id, xs[i] + wOf(id) / 2))
  }
  for (let it = 0; it < 2; it++) {
    for (let l = 1; l <= depth; l++) pull(l, up)
    for (let l = depth - 1; l >= 0; l--) pull(l, down)
  }
  // the drawing as a whole in the middle of the room, where the pulls may have drawn it to one side
  const lefts = rows.flatMap((r) => r.map((id) => cx.get(id)! - wOf(id) / 2))
  const rights = rows.flatMap((r) => r.map((id) => cx.get(id)! + wOf(id) / 2))
  const shift = (W - (Math.max(...rights) - Math.min(...lefts))) / 2 - Math.min(...lefts)
  for (const [id, x] of cx) cx.set(id, x + shift)

  const nodes: DiagramNode[] = ids.map((id) => {
    const b = box.get(id)!
    const l = layer.get(id)!
    const { label, detail } = info.get(id)!
    return { id, label, detail, layer: l, x: r1(cx.get(id)! - b.w / 2), y: rowY[l] + (rowH[l] - b.h) / 2, w: b.w, h: b.h, lines: b.lines, detailLines: b.detailLines }
  })
  const at = new Map(nodes.map((n) => [n.id, n] as const))
  const taken: Box[] = nodes.map((n) => ({ x0: n.x - 2, y0: n.y - 2, x1: n.x + n.w + 2, y1: n.y + n.h + 2 }))

  // the ports: each edge leaves its source's bottom and enters its target's top at its own point, ordered by where it
  // goes, so edges out of one node fan out; edges that share a point in the next row share their port too
  const outPort = new Map<DiagramEdgeIn, number>()
  const inPort = new Map<DiagramEdgeIn, number>()
  const ports = (es: DiagramEdgeIn[], n: DiagramNode, hop: (e: DiagramEdgeIn) => string, set: Map<DiagramEdgeIn, number>) => {
    const key = (e: DiagramEdgeIn) => (hop(e).startsWith('\u0000') ? hop(e) : e)
    const keys = [...new Set(es.map(key))].sort((a, b) => cx.get(typeof a === 'string' ? a : hop(a))! - cx.get(typeof b === 'string' ? b : hop(b))!)
    for (const e of es) set.set(e, n.x + (n.w * (keys.indexOf(key(e)) + 1)) / (keys.length + 1))
  }
  for (const n of nodes) {
    ports(runs.filter((r) => r.top === n.id).map((r) => r.e), n, (e) => chain.get(e)![1], outPort)
    ports(runs.filter((r) => r.bottom === n.id).map((r) => r.e), n, (e) => chain.get(e)!.at(-2)!, inPort)
  }

  // each edge's path, the points it runs through (a polyline close to its curves) and where a label may sit along it
  const drawn = edgesIn.map((e) => {
    const run = runOf.get(e)
    const rev = !!run?.rev
    const a = at.get(run ? run.top : e.source)!
    const b = at.get(run ? run.bottom : e.target)!
    let path: string
    const line: Pt[] = []
    // where a label may sit along the edge, best first
    let spots: Pt[]
    const pts = chain.get(e)
    if (pts) {
      const P = pts.map((id, i) => {
        if (i === 0) return { x: outPort.get(e)!, top: a.y + a.h, bottom: a.y + a.h }
        if (i === pts.length - 1) return { x: inPort.get(e)!, top: b.y, bottom: b.y }
        const l = a.layer + i
        return { x: cx.get(id)!, top: rowY[l], bottom: rowY[l] + rowH[l] }
      })
      path = `M${r1(P[0].x)} ${r1(P[0].bottom)}`
      line.push({ x: P[0].x, y: P[0].bottom })
      for (let i = 1; i < P.length; i++) {
        const y0 = P[i - 1].bottom
        const y1 = P[i].top
        const dy = (y1 - y0) / 2
        path += ` C${r1(P[i - 1].x)} ${r1(y0 + dy)}, ${r1(P[i].x)} ${r1(y1 - dy)}, ${r1(P[i].x)} ${r1(y1)}`
        for (let k = 1; k <= LINE_STEPS; k++) {
          const t = k / LINE_STEPS
          line.push({ x: bezierAt(P[i - 1].x, P[i - 1].x, P[i].x, P[i].x, t), y: bezierAt(y0, y0 + dy, y1 - dy, y1, t) })
        }
        if (P[i].bottom > P[i].top) {
          path += ` L${r1(P[i].x)} ${r1(P[i].bottom)}`
          line.push({ x: P[i].x, y: P[i].bottom })
        }
      }
      // the gap below the source first, then the rest, each at its middle and a little up or down it
      spots = []
      for (let i = 1; i < P.length; i++) {
        const y0 = P[i - 1].bottom
        const y1 = P[i].top
        for (const t of [0.5, 0.3, 0.7]) spots.push({ x: bezierAt(P[i - 1].x, P[i - 1].x, P[i].x, P[i].x, t), y: bezierAt(y0, y0 + (y1 - y0) / 2, y1 - (y1 - y0) / 2, y1, t) })
      }
    } else {
      // along its row: from the side of one box to the facing side of the other
      const leftToRight = b.x > a.x
      const x0 = leftToRight ? a.x + a.w : a.x
      const x1 = leftToRight ? b.x : b.x + b.w
      const y = a.y + a.h / 2
      path = `M${r1(x0)} ${r1(y)} L${r1(x1)} ${r1(y + 0.01)}`
      line.push({ x: x0, y }, { x: x1, y })
      spots = [{ x: (x0 + x1) / 2, y: y - LABEL_H / 2 - 2 }]
    }
    return { e, rev, path, line, spots }
  })
  // a label's box is clear where no box, no other label and no other edge's line runs under it, so it is read as its
  // own edge's; where no spot is that clear, one clear of the boxes and the labels does
  const clearOf = (bx: Box, own: Pt[], strict: boolean) =>
    !taken.some((t) => hits(t, bx)) && (!strict || !drawn.some((d) => d.line !== own && lineHits(d.line, bx)))
  const notes: DiagramNote[] = []
  const edges: DiagramEdge[] = drawn.map(({ e, rev, path, line, spots }) => {
    const label = e.label.trim()
    if (!label) return { source: e.source, target: e.target, label: '', path, line, lx: spots[0].x, ly: spots[0].y, inline: true, rev }
    // written on the edge when it is short and a spot along the edge is clear
    if (label.length <= INLINE_CHARS) {
      const half = (label.length * LABEL_CW) / 2 + 4
      // on the edge, else beside it at the right or the left, the line running past the label's end
      const beside = [0, half + 3, -half - 3]
      for (const strict of [true, false])
        for (const dx of beside)
          for (const s of spots) {
            const x = s.x + dx
            const bx = { x0: x - half, y0: s.y - LABEL_H / 2, x1: x + half, y1: s.y + LABEL_H / 2 }
            if (bx.x0 < 0 || bx.x1 > W || !clearOf(bx, line, strict)) continue
            taken.push(bx)
            return { source: e.source, target: e.target, label, path, line, lx: r1(x), ly: r1(s.y), inline: true, rev }
          }
    }
    // else a number on the edge and the label in a note under the drawing
    const n = notes.length + 1
    notes.push({ n, source: shortName(info.get(e.source)!.label), target: shortName(info.get(e.target)!.label), label })
    const ring = (s: Pt): Box => ({ x0: s.x - MARK_R, y0: s.y - MARK_R, x1: s.x + MARK_R, y1: s.y + MARK_R })
    const spot = spots.find((s) => clearOf(ring(s), line, true)) ?? spots.find((s) => clearOf(ring(s), line, false)) ?? spots[0]
    taken.push(ring(spot))
    return { source: e.source, target: e.target, label, path, line, lx: r1(spot.x), ly: r1(spot.y), inline: false, n, rev }
  })
  const height = rowY[depth] + rowH[depth]
  return { nodes, edges, notes, width: W, height }
}

const r1 = (n: number) => Math.round(n * 10) / 10
/** one coordinate of a cubic bezier at t */
const bezierAt = (p0: number, p1: number, p2: number, p3: number, t: number): number => {
  const u = 1 - t
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3
}

const DIAGRAM_PAD = 8

export function Diagram({ dataset, fitWidth }: { dataset: GraphDataset; fitWidth?: number }) {
  // laid out for the width its box has (at most the room its caller names); a row that cannot fit even at its floor
  // scrolls, with a fade at the right edge
  const wrap = useRef<HTMLDivElement>(null)
  const { width: boxW } = useVisibleSize(wrap)
  const roomW = boxW > 0 ? Math.min(boxW, fitWidth && fitWidth > 0 ? fitWidth : boxW) : fitWidth
  const lay = useMemo(() => diagramLayout(dataset, { width: roomW && roomW > 0 ? roomW - 2 * DIAGRAM_PAD : undefined }), [dataset, roomW])
  const [box, setBox] = useState<HTMLDivElement | null>(null)
  const [more, setMore] = useState(false)
  useLayoutEffect(() => {
    if (!box) return
    const check = () => setMore(box.scrollWidth - box.scrollLeft > box.clientWidth + 1)
    check()
    box.addEventListener('scroll', check, { passive: true })
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(check) : null
    ro?.observe(box)
    return () => {
      box.removeEventListener('scroll', check)
      ro?.disconnect()
    }
  }, [box, lay])
  if (!lay.nodes.length) return null
  const pad = DIAGRAM_PAD
  // the text a ⌘-click on a node or an edge quotes (pointer/parts.ts); an edge's line, its label and its number quote the same
  const names = new Map(lay.nodes.map((n) => [n.id, n.label]))
  const nodeText = (n: DiagramNode) => [n.label, n.detail].filter(Boolean).join(': ')
  const edgeText = (e: DiagramEdge) => `${names.get(e.source) ?? e.source} → ${names.get(e.target) ?? e.target}${e.label ? `: ${e.label}` : ''}`
  const w = lay.width + 2 * pad
  const h = lay.height + 2 * pad
  return (
    <div className="canvas-diagram-wrap" ref={wrap} data-body="" data-settled={boxW > 0 ? 'true' : 'false'}>
      <div className={more ? 'canvas-diagram canvas-diagram-overflow' : 'canvas-diagram'} ref={setBox}>
        <svg className="canvas-diagram-svg" width={r1(w)} height={r1(h)} viewBox={`${-pad} ${-pad} ${w} ${h}`} role="img" aria-label={`${lay.nodes.length} nodes, ${lay.edges.length} edges`}>
          <defs>
            <marker id="canvas-diagram-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0.5L7.5 4L0 7.5z" />
            </marker>
          </defs>
          {lay.edges.map((e, i) => (
            <g key={i} className="canvas-diagram-edge" data-part="" data-part-text={edgeText(e)}>
              {e.rev ? <path d={e.path} markerStart="url(#canvas-diagram-arrow)" /> : <path d={e.path} markerEnd="url(#canvas-diagram-arrow)" />}
            </g>
          ))}
          {lay.nodes.map((n) => (
            <g key={n.id} className="canvas-diagram-node" transform={`translate(${r1(n.x)} ${r1(n.y)})`} data-part="" data-part-text={nodeText(n)}>
              <rect width={n.w} height={n.h} rx={6} />
              {(n.lines.join(' ') !== n.label || n.detailLines.join(' ') !== n.detail.replace(/\s+/g, ' ')) && <title>{[n.label, n.detail].filter(Boolean).join('\n')}</title>}
              <text className="canvas-diagram-name" textAnchor="middle">
                {n.lines.map((l, i) => (
                  <tspan key={i} x={n.w / 2} y={NODE_PAD_Y + (i + 1) * NAME_LINE - 4}>
                    {l}
                  </tspan>
                ))}
              </text>
              {n.detailLines.length > 0 && (
                <text className="canvas-diagram-detail" textAnchor="middle">
                  {n.detailLines.map((l, i) => (
                    <tspan key={i} x={n.w / 2} y={NODE_PAD_Y + n.lines.length * NAME_LINE + 3 + (i + 1) * DETAIL_LINE - 3}>
                      {l}
                    </tspan>
                  ))}
                </text>
              )}
            </g>
          ))}
          {lay.edges.map((e, i) =>
            !e.label ? null : e.inline ? (
              <g key={i} data-part="" data-part-text={edgeText(e)}>
                <rect className="canvas-diagram-label-bg" x={r1(e.lx - (e.label.length * LABEL_CW) / 2 - 3)} y={r1(e.ly - LABEL_H / 2)} width={r1(e.label.length * LABEL_CW + 6)} height={LABEL_H} rx={3} />
                <text className="canvas-diagram-label" x={e.lx} y={e.ly} textAnchor="middle" dominantBaseline="central">
                  {e.label}
                </text>
              </g>
            ) : (
              <g key={i} className="canvas-diagram-mark" transform={`translate(${e.lx} ${e.ly})`} data-part="" data-part-text={edgeText(e)}>
                <circle r={MARK_R} />
                <text textAnchor="middle" dominantBaseline="central">
                  {e.n}
                </text>
              </g>
            ),
          )}
        </svg>
      </div>
      {lay.notes.length > 0 && (
        <ol className="canvas-diagram-notes">
          {lay.notes.map((n) => (
            <li key={n.n} data-part="" data-part-text={`${n.source} → ${n.target}: ${n.label}`}>
              <span className="canvas-diagram-note-n">{n.n}</span>
              {/* the edge's own label first, then the edge it belongs to, so the two do not read as one phrase */}
              <span>
                {n.label}{' '}
                <span className="canvas-diagram-note-ends">
                  ({n.source} → {n.target})
                </span>
              </span>
            </li>
          ))}
        </ol>
      )}
      {(dataset.nodes.length > MAX_NODES || dataset.edges.length > MAX_EDGES) && (
        <div className="dim canvas-viz-more">
          {dataset.nodes.length > MAX_NODES ? `${dataset.nodes.length - MAX_NODES} more nodes` : ''}
          {dataset.nodes.length > MAX_NODES && dataset.edges.length > MAX_EDGES ? ', ' : ''}
          {dataset.edges.length > MAX_EDGES ? `${dataset.edges.length - MAX_EDGES} more edges` : ''}
        </div>
      )}
    </div>
  )
}

// ---- a custom card: html in a sandboxed iframe sized to its content ----

export const SIZE_MESSAGE = 'thimble:size'
const SIZER = `<script>(function(){var b=document.body;function s(){var c=getComputedStyle(b);parent.postMessage({type:${JSON.stringify(SIZE_MESSAGE)},height:b.offsetHeight+parseFloat(c.marginTop)+parseFloat(c.marginBottom)},'*')}addEventListener('load',s);if(window.ResizeObserver)new ResizeObserver(s).observe(b);s()})()</script>`
export const CUSTOM_MIN_H = 40
export const CUSTOM_MAX_H = 1200

/** The html with a script that reports the body's height to the parent frame, before `</body>` when there is one. */
export function withSizer(html: string): string {
  const at = html.search(/<\/body\s*>/i)
  return at >= 0 ? html.slice(0, at) + SIZER + html.slice(at) : html + SIZER
}

export { frameStyle, withFrameStyle } from '../lib/frame'

export const clampCustomHeight = (h: number): number => Math.min(CUSTOM_MAX_H, Math.max(CUSTOM_MIN_H, Math.ceil(h)))

/** the tallest a custom card's page may grow when opened whole */
export const CUSTOM_OPEN_MAX_H = 8000

/** A custom card's page in a sandboxed frame, as tall as its content up to CUSTOM_MAX_H; taller pages fade out with a
 * Show all under them. */
export function CustomFrame({ html, title, height }: { html: string; title: string; height?: number }) {
  const ref = useRef<HTMLIFrameElement>(null)
  const [full, setFull] = useState(() => Math.max(CUSTOM_MIN_H, Math.ceil(typeof height === 'number' ? height : 160)))
  const [open, setOpen] = useState(false)
  // drawn once the page has loaded and said its height, for the card harness
  const [sized, setSized] = useState(false)
  const { resolved, key } = useTheme()
  const fonts = useFrameFonts()
  // the tokens are read at embed time, once per theme. It waits for the page's fonts, so the page is drawn once
  const doc = useMemo(() => (fonts == null ? null : withFrameStyle(withSizer(html), frameStyle(resolved, frameTokens(), fonts))), [html, resolved, key, fonts]) // key: the tokens are read again when the paper or the accent changes
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!ref.current || e.source !== ref.current.contentWindow) return
      const d = e.data as { type?: unknown; height?: unknown }
      if (d && d.type === SIZE_MESSAGE && typeof d.height === 'number' && Number.isFinite(d.height)) {
        setFull(Math.min(CUSTOM_OPEN_MAX_H, Math.max(CUSTOM_MIN_H, Math.ceil(d.height))))
        setSized(true)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])
  const capped = full > CUSTOM_MAX_H
  const h = open ? full : clampCustomHeight(full)
  return (
    <div className={`canvas-card-frame${capped && !open ? ' is-clipped' : ''}`} data-body="" data-settled={sized ? 'true' : 'false'}>
      {doc != null && <iframe ref={ref} className="canvas-card-html" sandbox="allow-scripts" srcDoc={doc} title={title || 'custom'} style={{ height: h }} />}
      {capped && (
        <button type="button" className="bcell-more" onMouseDown={(e) => e.stopPropagation()} onClick={() => setOpen((v) => !v)}>
          {open ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  )
}

/** The rendering for a data card's dataset by kind; a shape the kind does not expect is shown as text. */
export function DatasetView({ kind, dataset, fitWidth }: { kind: string; dataset: unknown; fitWidth?: number }) {
  // the shapes are read once per dataset so the renderings below keep one identity across renders
  const timeline = useMemo(() => (kind === 'timeline' ? asTimeline(dataset) : null), [kind, dataset])
  const graph = useMemo(() => (kind === 'diagram' ? asGraph(dataset) : null), [kind, dataset])
  if (timeline) return <Timeline dataset={timeline} fitWidth={fitWidth} />
  if (graph) return <Diagram dataset={graph} fitWidth={fitWidth} />
  let text = ''
  try {
    text = JSON.stringify(dataset, null, 1)
  } catch {
    text = String(dataset)
  }
  return <pre className="canvas-card-codeblock mono">{text.slice(0, 4000)}</pre>
}
