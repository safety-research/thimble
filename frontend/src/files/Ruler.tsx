// The overview ruler and scrollbar beside the reader (ReaderRuler) and beside the report (PageRuler).
//
// One rail or two (needsDetail). While the scrollbar's track can draw every mark apart from its neighbours, the track
// holds the lanes under a thumb that frames the span on screen. Past that, at its left a lane per label that is on (an
// empty one for a label with no rows in the file, so lane N is label N), plus a lane for the find's matches, each
// covering the whole file (GET /labels/ruler with the file cut into RULER_BINS), drawn on a canvas. At its right the
// scrollbar, whose thumb holds the same lanes for the records on screen. A drag, a press on the track or a wheel scrolls
// the reader; a click on a mark goes to the first record it stands for.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent, type RefObject, type WheelEvent } from 'react'
import { flushSync } from 'react-dom'
import { Tip } from '../components/Tooltip'
import { labelApi } from '../lib/api'
import { bus } from '../lib/bus'
import { useTheme } from '../lib/theme'
import type { Concept, LabelRuler } from '../lib/types'
import { classesOf, colourVar, marksOf } from './labels'

/** the bins the file is cut into for the label lanes (the server's most) */
export const RULER_BINS = 2000
/** an overview lane's width and the gap between lanes, px */
const LANE_PX = 5
const LANE_GAP_PX = 1
/** a lane's width inside the thumb, the gap between them, and the thumb's inset and border together, px */
const ZOOM_LANE_PX = 7
const ZOOM_GAP_PX = 2
const ZOOM_EDGE_PX = 3
/** the scrollbar's width while there are no lanes */
const PLAIN_BAR_PX = 10
/** the thumb's least height with lanes in it, and without */
export const THUMB_MIN_PX = 96
const PLAIN_THUMB_MIN_PX = 32
/** a mark's least height on the overview, px */
const MIN_MARK_PX = 2
/** the least gap between two marks of a lane that the eye still sees as a gap, px */
const MIN_GAP_PX = 1
/** the band's least height on the overview, px */
const MIN_BAND_PX = 3
/** px either side of a mark within which the pointer is on it */
const HIT_PX = 3
/** px the pointer moves on the thumb before a press becomes a drag */
const DRAG_PX = 3
/** ms the pointer rests on a mark before the record it stands for is looked up */
const NAME_DELAY_MS = 120
/** ms a released thumb stays where it was dropped while the reader catches up */
const SETTLE_MS = 400

/** A mark on a lane: the lines it stands for, `from` to `to`, and the value it shows. */
export interface RulerTick {
  from: number
  to: number
  colour: string
  /** the label's value the mark shows */
  value?: string
}

export interface RulerColumn {
  id: string
  /** what the lane is named in a mark's tooltip */
  name: string
  /** a mark's tooltip names its value too (a label of more than two values) */
  valued?: boolean
  /** the file's lines */
  total: number
  /** in the order they are drawn: a later mark draws over an earlier one */
  ticks: RulerTick[]
}

/** A record on screen: its line, and its top and bottom as fractions of the reader's height (below 0 or past 1 for a
 * record that runs past an edge). */
export interface Seen {
  line: number
  top: number
  bottom: number
}

/** Where the reader stands in the file: its top and height as fractions of the file's lines, and the records on
 * screen. */
export interface Shown {
  top: number
  height: number
  seen: Seen[]
}

/** A lane's mark inside the thumb: a record on screen the lane marks, or with `hit` one place of a find's match in it
 * (`top` then its middle). */
export interface LensTick {
  line: number
  top: number
  bottom: number
  colour: string
  hit?: boolean
}

/** The lines of `total` in bin `b` of `bins`, the server's binning (labels_store.line_bins): line l falls in bin
 * ⌊(l − 1) · bins / total⌋, and the last bin takes every line after. */
export function binLines(b: number, bins: number, total: number): [number, number] {
  const lo = Math.ceil((b * total) / bins) + 1
  const hi = b >= bins - 1 ? total : Math.ceil(((b + 1) * total) / bins)
  return [lo, hi]
}

/** The label lanes, one per label that is on in the order of `on`, so lane N is label N: a mark per bin that holds a
 * highlighted value; for a label over files, one mark over the whole file (`fileOf`). */
export function rulerColumns(on: readonly Concept[], ruler: LabelRuler | null, fileOf?: (conceptId: string) => Readonly<Record<string, number>> | undefined): RulerColumn[] {
  if (!ruler || ruler.total <= 0) return []
  const out: RulerColumn[] = []
  for (const k of on) {
    const classes = classesOf(k)
    if (marksOf(k) === 'file') {
      const counts = fileOf?.(k.id)
      const c = classes.find((x) => x.highlight && (counts?.[x.name] ?? 0) > 0)
      out.push({ id: k.id, name: k.name, valued: true, total: ruler.total, ticks: c ? [{ from: 1, to: ruler.total, colour: colourVar(c.color), value: c.name }] : [] })
      continue
    }
    const got = ruler.labels.find((l) => l.concept_id === k.id)
    if (!got) {
      out.push({ id: k.id, name: k.name, total: ruler.total, ticks: [] })
      continue
    }
    const ticks: RulerTick[] = []
    for (const c of classes) {
      if (!c.highlight) continue
      const colour = colourVar(c.color)
      for (const b of got.bins[c.name] ?? []) {
        const [from, to] = binLines(b, ruler.bins, ruler.total)
        if (to >= from) ticks.push({ from, to, colour, value: c.name })
      }
    }
    out.push({ id: k.id, name: k.name, valued: classes.length > 2, total: ruler.total, ticks })
  }
  return out
}

/** The colour of the find's marks, in ink as the find's highlight is. */
export const FIND_MARK = 'var(--text-primary)'

/** The find's lane: a mark on each matching line of the `total`. */
export function findColumn(lines: readonly number[], total: number, text: string): RulerColumn {
  return { id: 'find', name: `“${text}”`, total, ticks: lines.map((l) => ({ from: l, to: l, colour: FIND_MARK })) }
}

/** Where the thumb stands in a track `trackPx` tall, px: as tall as the share of the file the reader shows, at least
 * `minPx`, and as far through the room below it as the reader's top is through the part of the file it can scroll
 * over. */
export function thumbPlace(view: { top: number; height: number }, trackPx: number, minPx: number): { top: number; height: number } {
  const height = Math.max(0, Math.min(trackPx, Math.max(minPx, view.height * trackPx)))
  const free = 1 - view.height
  const p = free > 0 ? Math.max(0, Math.min(1, view.top / free)) : 0
  return { top: p * (trackPx - height), height }
}

/** The reader's top, a fraction of the file, for the thumb's top at `top` px: the inverse of thumbPlace. */
export function viewTopAt(top: number, thumbPx: number, trackPx: number, viewHeight: number): number {
  const room = trackPx - thumbPx
  return room > 0 ? Math.max(0, Math.min(1, top / room)) * Math.max(0, 1 - viewHeight) : 0
}

/** The mark of `ticks` (sorted by their lines) nearest `at` lines into the file, within `tol` lines of it, a mark
 * standing for the lines from `from − 1` to `to`; of marks as near, the last. */
export function nearestTick(ticks: readonly RulerTick[], at: number, tol: number): RulerTick | null {
  let lo = 0
  let hi = ticks.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (ticks[mid].to < at - tol) lo = mid + 1
    else hi = mid
  }
  let best: RulerTick | null = null
  let bestD = Infinity
  for (let i = lo; i < ticks.length && ticks[i].from - 1 <= at + tol; i++) {
    const t = ticks[i]
    const d = at < t.from - 1 ? t.from - 1 - at : at > t.to ? at - t.to : 0
    if (d <= tol && d <= bestD) {
      best = t
      bestD = d
    }
  }
  return best
}

/** Where a mark over `from`..`to` (lines, `from` exclusive) is drawn on a rail of `k` px per line `h` px tall: its own
 * span, or MIN_MARK_PX centred on it when that is shorter, kept on the rail. */
function drawnSpan(from: number, to: number, k: number, h: number): [number, number] {
  let y0 = from * k
  let y1 = to * k
  if (y1 - y0 < MIN_MARK_PX) {
    y0 = Math.max(0, Math.min(h - MIN_MARK_PX, (y0 + y1 - MIN_MARK_PX) / 2))
    y1 = y0 + MIN_MARK_PX
  }
  return [y0, y1]
}

/** Whether the ruler needs its second rail, the overview beside a scrollbar whose thumb magnifies what is on screen.
 * One rail is enough while the track, `trackPx` tall, still tells every mark from its neighbours: in each lane the
 * runs of marks (marks of one colour that touch or overlap make one run), each drawn at least MIN_MARK_PX tall, stand
 * at least MIN_GAP_PX apart where their lines are apart, and do not cover each other where they touch. Once two would merge on
 * the rail, the eye can no longer tell them apart there and the thumb's lens is what shows them. Lanes with no marks, or
 * marks far apart, need one rail at any length. */
export function needsDetail(columns: readonly RulerColumn[], trackPx: number): boolean {
  if (trackPx <= 0) return false
  for (const col of columns) {
    if (col.ticks.length < 2) continue
    const k = trackPx / Math.max(1, col.total)
    const ticks = [...col.ticks].sort((a, b) => a.from - b.from || a.to - b.to)
    const runs: [number, number, string][] = []
    for (const t of ticks) {
      const last = runs[runs.length - 1]
      if (last && last[2] === t.colour && t.from - 1 <= last[1]) last[1] = Math.max(last[1], t.to)
      else runs.push([t.from - 1, t.to, t.colour])
    }
    let end = -Infinity
    let endPx = -Infinity
    for (const [from, to] of runs) {
      const [y0, y1] = drawnSpan(from, to, k, trackPx)
      // runs apart in lines must stay apart on the rail, runs that touch must not cover each other; runs whose lines
      // overlap (two values in one bin) overlap on either rail
      if (from > end ? y0 - endPx < MIN_GAP_PX : from === end && y0 - endPx < -1e-9) return true
      end = Math.max(end, to)
      endPx = Math.max(endPx, y1)
    }
  }
  return false
}

/** A lane geometry: each lane's width, the gap between lanes and the inset before the first, css px. */
export interface LaneGeometry {
  lane: number
  gap: number
  inset: number
}
/** the overview beside the scrollbar, and the lanes in the track while it is the one rail */
const OVERVIEW_LANES: LaneGeometry = { lane: LANE_PX, gap: LANE_GAP_PX, inset: 0 }
const TRACK_LANES: LaneGeometry = { lane: ZOOM_LANE_PX, gap: ZOOM_GAP_PX, inset: ZOOM_EDGE_PX }

/** The `n` lanes' left edges and widths in device pixels at `dpr`: every lane the same whole number of pixels wide and
 * a whole number of pixels from the last, so that each of a lane's marks, and its stripe, stand in one column. */
export function laneBoxes(n: number, g: LaneGeometry, dpr: number): [number, number][] {
  const w = Math.max(1, Math.round(g.lane * dpr))
  const pitch = Math.max(w + 1, Math.round((g.lane + g.gap) * dpr))
  const x0 = Math.round(g.inset * dpr)
  return Array.from({ length: n }, (_, i) => [x0 + i * pitch, w])
}

/** The lane under a point `x` css px from the lanes' left edge, clamped to the `n` lanes. */
export function laneAt(x: number, g: LaneGeometry, n: number): number {
  return Math.max(0, Math.min(n - 1, Math.floor((x - g.inset + g.gap / 2) / (g.lane + g.gap))))
}

/** The widths of the overview's lanes together and of the scrollbar, px, for `n` lanes. */
export function rulerWidths(n: number): { lanes: number; bar: number } {
  if (!n) return { lanes: 0, bar: PLAIN_BAR_PX }
  return { lanes: n * LANE_PX + (n - 1) * LANE_GAP_PX, bar: n * ZOOM_LANE_PX + (n - 1) * ZOOM_GAP_PX + 2 * ZOOM_EDGE_PX }
}

export function useRuler(ws: string, path: string): LabelRuler | null {
  const [ruler, setRuler] = useState<LabelRuler | null>(null)
  useEffect(() => {
    let alive = true
    let timer: number | null = null
    const read = () =>
      labelApi
        .ruler(ws, path, RULER_BINS)
        .then((r) => alive && setRuler(r))
        .catch(() => alive && setRuler(null))
    void read()
    const off = bus.on('concepts', () => {
      if (timer != null) window.clearTimeout(timer)
      timer = window.setTimeout(() => void read(), 300)
    })
    return () => {
      alive = false
      off()
      if (timer != null) window.clearTimeout(timer)
    }
  }, [ws, path])
  return ruler
}

/** The lanes, their stripes and their marks, on a canvas the size of its box, laid out in whole device pixels
 * (laneBoxes) and drawn at the canvas's own resolution, so that no mark is resampled off its column. */
const Marks = memo(function Marks({ columns, geometry }: { columns: RulerColumn[]; geometry: LaneGeometry }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState<[number, number]>([0, 0])
  const theme = useTheme().key
  useEffect(() => {
    // the box the canvas fills: the canvas's own size is set from its pixels below
    const el = ref.current?.parentElement
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setSize([el.clientWidth, el.clientHeight]))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useLayoutEffect(() => {
    const el = ref.current
    const [w, h] = size
    const ctx = el && w > 0 && h > 0 ? el.getContext('2d') : null
    if (!el || !ctx) return
    const dpr = window.devicePixelRatio || 1
    el.width = Math.ceil(w * dpr)
    el.height = Math.ceil(h * dpr)
    // the canvas's box is its pixels at dpr, so the browser draws them 1:1
    el.style.width = `${el.width / dpr}px`
    el.style.height = `${el.height / dpr}px`
    ctx.clearRect(0, 0, el.width, el.height)
    // the colours are tokens, each read once per draw through the canvas's own style
    const colours = new Map<string, string>()
    const colourOf = (c: string) => {
      let v = colours.get(c)
      if (v == null) {
        el.style.color = c
        v = getComputedStyle(el).color
        colours.set(c, v)
      }
      return v
    }
    const boxes = laneBoxes(columns.length, geometry, dpr)
    ctx.fillStyle = colourOf('rgba(var(--ink-rgb), 0.035)')
    for (const [x, cw] of boxes) ctx.fillRect(x, 0, cw, el.height)
    columns.forEach((col, i) => {
      const [x, cw] = boxes[i]
      const k = h / Math.max(1, col.total)
      for (const t of col.ticks) {
        const [y0, y1] = drawnSpan(t.from - 1, t.to, k, h)
        const a = Math.round(y0 * dpr)
        ctx.fillStyle = colourOf(t.colour)
        ctx.fillRect(x, a, cw, Math.max(1, Math.round(y1 * dpr) - a))
      }
    })
  }, [columns, geometry, size, theme])
  return <canvas ref={ref} className="reader-ruler-marks" />
})

interface Hover {
  col: RulerColumn
  tick: RulerTick
  /** the pointer's height when it came onto the mark, px in the viewport */
  y: number
  /** the record the mark stands for, once known */
  line: number | null
}

/** A mark's tooltip in the reader: the record it stands for (its lines until that is known), the lane and the value. */
export function markText(col: RulerColumn, tick: RulerTick, line: number | null): string {
  const where = line != null ? `Line ${line.toLocaleString()}` : `Lines ${tick.from.toLocaleString()}–${tick.to.toLocaleString()}`
  return `${where} · ${col.name}${col.valued && tick.value ? `: ${tick.value}` : ''}`
}

interface ReaderRulerProps {
  columns: RulerColumn[]
  /** where the reader stands and the records on screen */
  view: Shown
  /** per lane, its marks inside the thumb */
  lens: ReadonlyMap<string, readonly LensTick[]>
  /** a click on the overview off the marks, at a fraction of the file */
  onJump: (fraction: number) => void
  /** a click on a mark */
  onMark: (column: string, tick: RulerTick) => void
  /** the record a mark stands for, which its tooltip names */
  lineOf?: (column: string, tick: RulerTick) => Promise<number | null>
  /** a click on a record's mark inside the thumb */
  onLine: (line: number) => void
  /** the thumb dragged or its track pressed: the reader's top as a fraction of the file; `held` false on release */
  onSeek: (fraction: number, held: boolean) => void
  /** a wheel over the ruler, px down */
  onWheel: (px: number) => void
  /** a mark's tooltip, markText by default */
  tipOf?: (col: RulerColumn, tick: RulerTick, line: number | null) => string
}

export function ReaderRuler({ columns, view, lens, onJump, onMark, lineOf, onLine, onSeek, onWheel, tipOf = markText }: ReaderRulerProps) {
  const n = columns.length
  const widths = rulerWidths(n)
  const over = useRef<HTMLDivElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  const zoom = useRef<HTMLDivElement>(null)
  const [trackPx, setTrackPx] = useState(0)
  useEffect(() => {
    const el = bar.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setTrackPx(el.clientHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const double = n > 0 && needsDetail(columns, trackPx)
  const geometry = double ? OVERVIEW_LANES : TRACK_LANES
  const place = thumbPlace(view, trackPx, double ? THUMB_MIN_PX : PLAIN_THUMB_MIN_PX)
  const [drag, setDrag] = useState<{ top: number; held: boolean } | null>(null)
  const latest = useRef({ view, place, trackPx, onSeek })
  latest.current = { view, place, trackPx, onSeek }

  // ---- the scrollbar
  const grab = useRef<{ dy: number; y0: number; moved: boolean; top: number } | null>(null)
  const frame = useRef<number | null>(null)
  const seekTo = (top: number, held: boolean) => {
    const { view: v, place: p, trackPx: t, onSeek: seek } = latest.current
    seek(viewTopAt(top, p.height, t, v.height), held)
  }
  const trackTop = (e: { clientY: number }) => e.clientY - (bar.current?.getBoundingClientRect().top ?? 0)
  const room = () => Math.max(0, latest.current.trackPx - latest.current.place.height)
  /** the line of the record whose mark inside the thumb is under the pointer */
  const lensAt = (e: { clientX: number; clientY: number }): number | null => {
    const el = zoom.current
    if (!el || !double) return null
    const r = el.getBoundingClientRect()
    const col = columns[Math.floor(((e.clientX - r.left) / Math.max(1, r.width)) * n)]
    if (!col || r.height <= 0) return null
    const f = (e.clientY - r.top) / r.height
    const tol = HIT_PX / r.height
    return (lens.get(col.id) ?? []).find((t) => f >= t.top - tol && f <= (t.hit ? t.top : t.bottom) + tol)?.line ?? null
  }
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const y = trackTop(e)
    const onThumb = y >= place.top && y <= place.top + place.height
    // one rail: a press on a mark off the thumb goes to the mark
    const hit = !double && !onThumb ? markAt(e) : null
    if (hit) return onMark(hit.col.id, hit.tick)
    const top = onThumb ? place.top : Math.max(0, Math.min(room(), y - place.height / 2))
    grab.current = { dy: y - top, y0: e.clientY, moved: !onThumb, top }
    e.currentTarget.setPointerCapture?.(e.pointerId)
    if (!onThumb) {
      setDrag({ top, held: true })
      seekTo(top, true)
    }
  }
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const g = grab.current
    if (!g) {
      if (!double) onOverMove(e)
      return
    }
    if (!g.moved && Math.abs(e.clientY - g.y0) < DRAG_PX) return
    g.moved = true
    g.top = Math.max(0, Math.min(room(), trackTop(e) - g.dy))
    setDrag({ top: g.top, held: true })
    if (frame.current == null)
      frame.current = requestAnimationFrame(() => {
        frame.current = null
        if (grab.current) seekTo(grab.current.top, true)
      })
  }
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    const g = grab.current
    grab.current = null
    if (!g) return
    if (frame.current != null) cancelAnimationFrame(frame.current)
    frame.current = null
    if (g.moved) {
      setDrag({ top: g.top, held: false })
      seekTo(g.top, false)
      return
    }
    // a press on the thumb that did not move is a click, which goes to the record whose mark it is on
    if (!double) {
      const hit = markAt(e)
      if (hit) onMark(hit.col.id, hit.tick)
      return
    }
    const line = lensAt(e)
    if (line != null) onLine(line)
  }
  // a released thumb stays where it was dropped until the reader has moved there
  useEffect(() => {
    if (!drag || drag.held) return
    const t = window.setTimeout(() => setDrag(null), SETTLE_MS)
    return () => window.clearTimeout(t)
  }, [drag])
  useEffect(() => {
    setDrag((d) => (d && !d.held ? null : d))
  }, [view.top, view.height])
  useEffect(() => () => {
    if (frame.current != null) cancelAnimationFrame(frame.current)
  }, [])
  const wheel = (e: WheelEvent<HTMLDivElement>) => onWheel(e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * Math.max(1, trackPx) : e.deltaY)

  // ---- the overview
  const sorted = useMemo(() => columns.map((c) => [...c.ticks].sort((a, b) => a.from - b.from)), [columns])
  const markAt = (e: { clientX: number; clientY: number }): { col: RulerColumn; tick: RulerTick } | null => {
    const el = double ? over.current : bar.current
    if (!el || !n) return null
    const r = el.getBoundingClientRect()
    if (r.height <= 0) return null
    const i = laneAt(e.clientX - r.left, geometry, n)
    const col = columns[i]
    const k = col.total / r.height
    const tick = nearestTick(sorted[i], (e.clientY - r.top) * k, (HIT_PX + MIN_MARK_PX / 2) * k)
    return tick ? { col, tick } : null
  }
  const [hover, setHover] = useState<Hover | null>(null)
  const nameTimer = useRef<number | null>(null)
  const clearName = () => {
    if (nameTimer.current != null) window.clearTimeout(nameTimer.current)
    nameTimer.current = null
  }
  useEffect(() => clearName, [])
  useEffect(() => {
    clearName()
    setHover(null)
  }, [columns])
  const onOverMove = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch') return
    const hit = markAt(e)
    if (hover && hit && hover.tick === hit.tick) return
    clearName()
    if (!hit) return setHover(null)
    const exact = hit.tick.from === hit.tick.to ? hit.tick.from : null
    setHover({ ...hit, y: e.clientY, line: exact })
    if (exact == null && lineOf) {
      const { col, tick } = hit
      nameTimer.current = window.setTimeout(() => {
        void lineOf(col.id, tick).then((line) => line != null && setHover((h) => (h && h.tick === tick ? { ...h, line } : h)))
      }, NAME_DELAY_MS)
    }
  }
  const onOverLeave = () => {
    clearName()
    setHover(null)
  }
  const onOverClick = (e: MouseEvent<HTMLDivElement>) => {
    const hit = markAt(e)
    if (hit) return onMark(hit.col.id, hit.tick)
    const r = e.currentTarget.getBoundingClientRect()
    onJump(Math.max(0, Math.min(1, (e.clientY - r.top) / Math.max(1, r.height))))
  }
  const hoverY = hover?.y
  const tipPlace = useCallback(
    (w: number, h: number) => {
      const r = (over.current ?? bar.current)?.getBoundingClientRect()
      const y = hoverY ?? 0
      return { left: Math.max(8, (r?.left ?? 0) - 8 - w), top: Math.max(8, Math.min(window.innerHeight - 8 - h, y - h / 2)) }
    },
    [hoverY],
  )

  const bandTop = Math.max(0, Math.min(1, view.top)) * trackPx
  const bandH = Math.min(Math.max(0, trackPx - bandTop), Math.max(MIN_BAND_PX, view.height * trackPx))
  const thumbTop = drag ? drag.top : place.top
  return (
    <div className="reader-ruler" data-drag={drag?.held || undefined} onWheel={wheel} aria-hidden>
      {double && (
        <div ref={over} className="reader-ruler-lanes" style={{ width: widths.lanes }} onPointerMove={onOverMove} onPointerLeave={onOverLeave} onClick={onOverClick}>
          <Marks columns={columns} geometry={geometry} />
          <div className="reader-ruler-band" style={{ transform: `translateY(${bandTop}px)`, height: bandH }} />
        </div>
      )}
      <div ref={bar} className="reader-ruler-bar" data-rails={double ? 2 : 1} style={{ width: widths.bar }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onPointerLeave={double ? undefined : onOverLeave}>
        {n > 0 && !double && <Marks columns={columns} geometry={geometry} />}
        <div className={'reader-ruler-thumb' + (double ? '' : n ? ' finder' : ' plain')} style={{ transform: `translateY(${thumbTop}px)`, height: place.height }}>
          {double && (
            <div ref={zoom} className="reader-ruler-zoom">
              {columns.map((c) => (
                <div key={c.id} className="reader-ruler-zl" data-col={c.id}>
                  {lens.get(c.id)?.map((t, i) => (
                    <i
                      key={`${t.line}.${i}`}
                      className={t.hit ? 'hit' : undefined}
                      data-line={t.line}
                      style={{ top: `${t.top * 100}%`, height: t.hit ? undefined : `calc(${(t.bottom - t.top) * 100}% - 1px)`, background: t.colour } as CSSProperties}
                    />
                  ))}
                </div>
              ))}
              <div className="reader-ruler-seps">
                {view.seen.slice(1).map((s) => (
                  <i key={s.line} style={{ top: `${s.top * 100}%` }} />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
      {hover && <Tip text={tipOf(hover.col, hover.tick, hover.line)} place={tipPlace} className="reader-ruler-tip" />}
    </div>
  )
}

interface PageRulerProps {
  /** the element that scrolls the page */
  scroller: RefObject<HTMLElement | null>
  /** lanes whose lines are the page's pixels from its top, `total` its scroll height */
  columns: RulerColumn[]
  /** a click off the marks, at a fraction of the page */
  onJump: (fraction: number) => void
  /** a click on a mark, or on its part on screen inside the thumb */
  onMark: (column: string, tick: RulerTick) => void
  tipOf?: (col: RulerColumn, tick: RulerTick) => string
}

/** ReaderRuler beside a page that scrolls as one element. It reads the page's scroll itself and draws it in the same
 * frame, so a scroll renders the ruler alone; inside the thumb each mark shows where its passage stands on screen. */
export function PageRuler({ scroller, columns, onJump, onMark, tipOf }: PageRulerProps) {
  const [view, setView] = useState<Shown & { px: number; at: number }>({ top: 0, height: 1, seen: [], px: 0, at: 0 })
  useEffect(() => {
    const box = scroller.current
    if (!box) return
    const read = () => {
      const total = Math.max(1, box.scrollHeight)
      const top = box.scrollTop / total
      const height = box.clientHeight / total
      setView((v) => (v.top === top && v.height === height && v.px === box.clientHeight ? v : { top, height, seen: [], px: box.clientHeight, at: box.scrollTop }))
    }
    const onScroll = () => flushSync(read)
    read()
    box.addEventListener('scroll', onScroll, { passive: true })
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(read) : null
    ro?.observe(box)
    for (const c of Array.from(box.children)) ro?.observe(c)
    return () => {
      box.removeEventListener('scroll', onScroll)
      ro?.disconnect()
    }
  }, [scroller])
  const lens = useMemo(() => {
    const out = new Map<string, LensTick[]>()
    if (view.px <= 0) return out
    for (const col of columns) {
      const ticks: LensTick[] = []
      for (const t of col.ticks) {
        const top = (t.from - 1 - view.at) / view.px
        const bottom = (t.to - view.at) / view.px
        if (bottom > 0 && top < 1) ticks.push({ line: t.from, top, bottom, colour: t.colour })
      }
      out.set(col.id, ticks)
    }
    return out
  }, [columns, view])
  const onLine = (line: number) => {
    for (const col of columns) {
      const tick = col.ticks.find((t) => t.from === line)
      if (tick) return onMark(col.id, tick)
    }
  }
  const seek = (f: number) => {
    const box = scroller.current
    if (box) box.scrollTop = f * box.scrollHeight
  }
  const wheel = (px: number) => {
    const box = scroller.current
    if (box) box.scrollTop += px
  }
  return <ReaderRuler columns={columns} view={view} lens={lens} onJump={onJump} onMark={onMark} onLine={onLine} onSeek={seek} onWheel={wheel} tipOf={tipOf} />
}
