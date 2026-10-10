// The ruler beside the report (PageRuler, over ReaderRuler), and what Files' reader takes from it: the label lanes'
// marks over a file (rulerColumns, useRuler), the find's lane, the lanes' geometry and the thumb's place.
//
// One strip at every length: the scrollbar's track holds a lane per column (the report's checks), each covering the
// whole page, drawn on a canvas, under a thumb that frames the span on screen; with no lane it is a plain scrollbar. A
// drag, a press on the track or a wheel scrolls the page; a click on a mark goes to it. Where the page is long enough
// that the strip draws it at a small part of its size, resting on the strip opens the loupe beside it (Loupe.tsx): a
// line per passage around the pointer (a heading, a paragraph, a list item), a cell per lane in its check's color where
// the check comments on it, and the start of its text; those on screen tinted. A click on a line goes to its passage.
// Elsewhere a mark names its passage on hover, on one line: its cells and the start of its text.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent, type RefObject, type WheelEvent } from 'react'
import { flushSync } from 'react-dom'
import { Tip } from '../components/Tooltip'
import { labelApi } from '../lib/api'
import { bus } from '../lib/bus'
import { useTheme } from '../lib/theme'
import type { Concept, LabelRuler } from '../lib/types'
import { classesOf, colourVar, marksOf } from './labels'
import { loupeHeight, LOUPE_ROWS, RowLine, rowKey, useLoupe, type LoupeCell, type LoupeRow } from './Loupe'

/** the bins the file is cut into for the label lanes (the server's most) */
export const RULER_BINS = 2000
/** the scrollbar's width while there are no lanes */
const PLAIN_BAR_PX = 10
/** the thumb's least height */
const THUMB_MIN_PX = 32
/** a mark's least height on the strip, px */
const MIN_MARK_PX = 2
/** px either side of a mark within which the pointer is on it */
const HIT_PX = 3
/** px the pointer moves on the thumb before a press becomes a drag */
const DRAG_PX = 3
/** ms a released thumb stays where it was dropped while the page catches up */
const SETTLE_MS = 400
/** the loupe opens on a page where LOUPE_SCREENS screens of it at the loupe's height are LOUPE_GAIN times the strip's
 * size or more */
const LOUPE_SCREENS = 2
const LOUPE_GAIN = 2
/** px of the page from a passage's top that a click on it in the loupe brings to the top half of the screen at most */
const PASSAGE_LEAD_PX = 24

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

/** The colour of the find's marks, in the accent as the find's highlight is. */
export const FIND_MARK = 'var(--text-accent)'

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

/** A lane geometry: each lane's width, the gap between lanes and the inset before the first, css px. */
export interface LaneGeometry {
  lane: number
  gap: number
  inset: number
}
/** the lanes in the scrollbar's track: the report's ruler and Files' strip */
export const TRACK_LANES: LaneGeometry = { lane: 7, gap: 2, inset: 3 }

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

/** The scrollbar's width for `n` lanes, px. */
export const rulerWidth = (n: number): number => (n ? n * TRACK_LANES.lane + (n - 1) * TRACK_LANES.gap + 2 * TRACK_LANES.inset : PLAIN_BAR_PX)

/** Where the labels' values fall on the file, asked only while `on` (some label is on: with none the ruler draws no
 * lane, and the route would count the file's lines for nothing). */
export function useRuler(ws: string, path: string, on = true): LabelRuler | null {
  const [ruler, setRuler] = useState<LabelRuler | null>(null)
  useEffect(() => {
    if (!on) return
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
  }, [ws, path, on])
  return ruler
}

/** The lanes, their stripes and their marks, on a canvas the size of its box, laid out in whole device pixels
 * (laneBoxes) and drawn at the canvas's own resolution, so that no mark is resampled off its column. */
const Marks = memo(function Marks({ columns }: { columns: RulerColumn[] }) {
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
    const boxes = laneBoxes(columns.length, TRACK_LANES, dpr)
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
  }, [columns, size, theme])
  return <canvas ref={ref} className="reader-ruler-marks" />
})

/** A mark's tooltip in the reader: the record it stands for (its lines until that is known), the lane and the value. */
export function markText(col: RulerColumn, tick: RulerTick, line: number | null): string {
  const where = line != null ? `Line ${line}` : `Lines ${tick.from}–${tick.to}`
  return `${where} · ${col.name}${col.valued && tick.value ? `: ${tick.value}` : ''}`
}

/** Whether the loupe opens beside a ruler `trackPx` tall over a page of `total` px, `screen` px of which are on screen:
 * on a page where LOUPE_SCREENS screens of it, at the loupe's height, are drawn LOUPE_GAIN times the strip's size or
 * more; never on a page that short, or with none. Pure. */
export function pageLoupe(total: number, trackPx: number, screen: number): boolean {
  const span = LOUPE_SCREENS * screen
  if (total <= 0 || trackPx <= 0 || span <= 0 || span >= total) return false
  return loupeHeight(LOUPE_ROWS) / span >= LOUPE_GAIN * (trackPx / total)
}

/** A passage of the page (a heading, a paragraph, a list item): its top and bottom, px of the page from its top, its
 * text, and whether it is a heading. In reading order, their tops never going up. */
export interface Passage {
  top: number
  bottom: number
  text: string
  heading?: boolean
}

/** The passage unit at `y` px of a page `total` px tall, the passages' tops `tops`: passage i from its top to the next
 * one's (the last to the page's end), fractions between; 0 above the first. Pure. */
export function passageAt(tops: readonly number[], y: number, total: number): number {
  const n = tops.length
  if (!n || y <= tops[0]) return 0
  let lo = 0
  let hi = n - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (tops[mid] <= y) lo = mid
    else hi = mid - 1
  }
  const next = lo + 1 < n ? tops[lo + 1] : Math.max(total, tops[lo])
  return lo + (next > tops[lo] ? Math.min(1, (y - tops[lo]) / (next - tops[lo])) : 0)
}

/** The page's px at passage unit `u`: passageAt's inverse. Pure. */
export function passagePx(tops: readonly number[], u: number, total: number): number {
  const n = tops.length
  if (!n) return 0
  const i = Math.max(0, Math.min(n - 1, Math.floor(u)))
  const next = i + 1 < n ? tops[i + 1] : Math.max(total, tops[i])
  return tops[i] + Math.max(0, Math.min(1, u - i)) * (next - tops[i])
}

/** Per passage, a cell per lane: the color of the lane's first mark over the passage (a mark over the px `from − 1` to
 * `to`), null where none is. Pure. */
export function passageCells(passages: readonly Passage[], columns: readonly RulerColumn[]): (LoupeCell | null)[][] {
  return passages.map((p) =>
    columns.map((col) => {
      const t = col.ticks.find((k) => k.from - 1 < p.bottom - 0.5 && k.to > p.top + 0.5)
      return t ? { colour: t.colour } : null
    }),
  )
}

interface Hover {
  col: RulerColumn
  tick: RulerTick
  /** the pointer's height when it came onto the mark, px in the viewport */
  y: number
}

interface ReaderRulerProps {
  columns: RulerColumn[]
  /** where the page stands: its top and height as fractions of it */
  view: { top: number; height: number }
  /** a click on the strip off the marks, at a fraction of the page */
  onJump: (fraction: number) => void
  /** a click on a mark */
  onMark: (column: string, tick: RulerTick) => void
  /** the thumb dragged or its track pressed: the page's top as a fraction of it; `held` false on release */
  onSeek: (fraction: number, held: boolean) => void
  /** a wheel over the ruler, px down */
  onWheel: (px: number) => void
  /** a mark's tooltip where no passage is known, markText by default */
  tipOf?: (col: RulerColumn, tick: RulerTick, line: number | null) => string
  /** the page's passages, a line each in the loupe; a mark's tooltip names the passage it is on */
  passages?: readonly Passage[]
}

const NO_PASSAGES: readonly Passage[] = []

export function ReaderRuler({ columns, view, onJump, onMark, onSeek, onWheel, tipOf = markText, passages = NO_PASSAGES }: ReaderRulerProps) {
  const n = columns.length
  const root = useRef<HTMLDivElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  const [trackPx, setTrackPx] = useState(0)
  useEffect(() => {
    const el = bar.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setTrackPx(el.clientHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const place = thumbPlace(view, trackPx, THUMB_MIN_PX)
  const [drag, setDrag] = useState<{ top: number; held: boolean } | null>(null)
  const latest = useRef({ view, place, trackPx, onSeek, onJump })
  latest.current = { view, place, trackPx, onSeek, onJump }
  const sorted = useMemo(() => columns.map((c) => [...c.ticks].sort((a, b) => a.from - b.from)), [columns])
  const total = columns[0]?.total ?? 0
  const thumbTop = drag ? drag.top : place.top

  // ---- the loupe, a line per passage, on a page long enough
  const tops = useMemo(() => passages.map((p) => p.top), [passages])
  const cells = useMemo(() => passageCells(passages, columns), [passages, columns])
  const rowOf = (i: number): LoupeRow => ({ num: null, cells: cells[i] ?? [], who: null, text: passages[i]?.text ?? '', heading: passages[i]?.heading })
  const P = passages.length
  const hasLoupe = n > 0 && P > 0 && pageLoupe(total, trackPx, view.height * total)
  const unitOf = (y: number) => passageAt(tops, y, total)
  const loupe = useLoupe({
    strip: bar,
    bounds: root,
    total: P,
    rows: hasLoupe ? Math.min(LOUPE_ROWS, P) : 0,
    numbered: false,
    pxOf: (u) => (total > 0 ? (passagePx(tops, u, total) / total) * latest.current.trackPx : 0),
    unitAt: (y) => (total > 0 ? unitOf(Math.max(0, Math.min(total, (y / Math.max(1, latest.current.trackPx)) * total))) : 0),
    thumbMid: () => (drag$.current ? drag$.current.top : latest.current.place.top) + latest.current.place.height / 2,
    view: () => [unitOf(latest.current.view.top * total), unitOf((latest.current.view.top + latest.current.view.height) * total)],
    // where a drag holds the thumb, ahead of the page
    center: () => {
      const { view: v, place: p, trackPx: t } = latest.current
      const top = drag$.current ? viewTopAt(drag$.current.top, p.height, t, v.height) : v.top
      return unitOf((top + v.height / 2) * total)
    },
    rowsAt: (start, k) => Array.from({ length: Math.max(0, Math.min(P, start + k) - start) }, (_, j) => rowOf(start + j)),
    // to the passage: its middle, or for a passage taller than half the screen its top near the screen's top
    act: (i) => {
      const p = passages[i]
      if (!p || total <= 0) return
      const screen = latest.current.view.height * total
      latest.current.onJump(Math.min((p.top + p.bottom) / 2, p.top + screen / 2 - PASSAGE_LEAD_PX) / total)
    },
    wheel: (px) => onWheel(px),
  })
  const drag$ = useRef(drag)
  drag$.current = drag
  const loupe$ = useRef(loupe)
  loupe$.current = loupe
  // an open loupe follows the page as it scrolls and the thumb as it is dragged
  useLayoutEffect(() => loupe$.current.moved(), [view.top, view.height, drag])
  useEffect(() => loupe$.current.refresh(), [columns, passages])

  // ---- the scrollbar
  const grab = useRef<{ dy: number; y0: number; moved: boolean; top: number; touch?: boolean } | null>(null)
  const frame = useRef<number | null>(null)
  const seekTo = (top: number, held: boolean) => {
    const { view: v, place: p, trackPx: t, onSeek: seek } = latest.current
    seek(viewTopAt(top, p.height, t, v.height), held)
  }
  const trackTop = (e: { clientY: number }) => e.clientY - (bar.current?.getBoundingClientRect().top ?? 0)
  const room = () => Math.max(0, latest.current.trackPx - latest.current.place.height)
  const markAt = (e: { clientX: number; clientY: number }): { col: RulerColumn; tick: RulerTick } | null => {
    const el = bar.current
    if (!el || !n) return null
    const r = el.getBoundingClientRect()
    if (r.height <= 0) return null
    const i = laneAt(e.clientX - r.left, TRACK_LANES, n)
    const col = columns[i]
    const k = col.total / r.height
    const tick = nearestTick(sorted[i], (e.clientY - r.top) * k, (HIT_PX + MIN_MARK_PX / 2) * k)
    return tick ? { col, tick } : null
  }
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    setHover(null)
    const y = trackTop(e)
    const onThumb = y >= place.top && y <= place.top + place.height
    // a press on a mark off the thumb goes to the mark
    const hit = !onThumb ? markAt(e) : null
    if (hit) return onMark(hit.col.id, hit.tick)
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId)
    } catch {
      /* a pointer the browser no longer tracks: the drag goes on while it stays over the ruler */
    }
    // a touch off the thumb scrubs with the loupe
    if (e.pointerType === 'touch' && !onThumb && hasLoupe) {
      grab.current = { dy: 0, y0: e.clientY, moved: false, top: place.top, touch: true }
      loupe.touchStart(e)
      return
    }
    const top = onThumb ? place.top : Math.max(0, Math.min(room(), y - place.height / 2))
    grab.current = { dy: y - top, y0: e.clientY, moved: !onThumb, top }
    loupe.thumb()
    if (!onThumb) {
      setDrag({ top, held: true })
      seekTo(top, true)
    }
  }
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const g = grab.current
    if (!g) return hoverAt(e)
    if (g.touch) return loupe.touchMove(e)
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
    if (g.touch) {
      // let go, the page goes to where the loupe's line was
      const u = loupe.touchEnd()
      if (u != null && total > 0) onJump(Math.max(0, Math.min(1, u / total)))
      return
    }
    if (e.pointerType === 'touch') loupe.close()
    if (g.moved) {
      setDrag({ top: g.top, held: false })
      seekTo(g.top, false)
      return
    }
    // a press on the thumb that did not move is a click, which goes to the mark it is on
    const hit = markAt(e)
    if (hit) onMark(hit.col.id, hit.tick)
  }
  // a released thumb stays where it was dropped until the page has moved there
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
  const wheel = (e: WheelEvent<HTMLDivElement>) => {
    // a real scroll: an open loupe follows the scroll position
    loupe.wheel()
    onWheel(e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * Math.max(1, trackPx) : e.deltaY)
  }

  // ---- the hover: the loupe follows the pointer; on a page it does not open for, the passage a mark is on
  const [hover, setHover] = useState<Hover | null>(null)
  useEffect(() => setHover(null), [columns])
  const hoverAt = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch') return
    if (hasLoupe) return loupe.move(e)
    const hit = markAt(e)
    if (hover && hit && hover.tick === hit.tick) return
    setHover(hit ? { ...hit, y: e.clientY } : null)
  }
  const onLeave = (e: PointerEvent<HTMLDivElement>) => {
    setHover(null)
    loupe.leave(e)
  }
  /** the passage a hovered mark is on, by its middle */
  const hoverRow = useMemo(() => {
    if (!hover || !P) return null
    const t = hover.tick
    const i = Math.floor(passageAt(tops, (t.from - 1 + t.to) / 2, total))
    const p = passages[i]
    return p && t.from - 1 < p.bottom - 0.5 && t.to > p.top + 0.5 ? rowOf(i) : null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hover, passages, tops, total, cells])
  const hoverY = hover?.y
  const tipPlace = useCallback(
    (w: number, h: number) => {
      const r = bar.current?.getBoundingClientRect()
      const y = hoverY ?? 0
      return { left: Math.max(8, (r?.left ?? 0) - 8 - w), top: Math.max(8, Math.min(window.innerHeight - 8 - h, y - h / 2)) }
    },
    [hoverY],
  )
  return (
    <div ref={root} className="reader-ruler" data-drag={drag?.held || undefined} onWheel={wheel} aria-hidden>
      <div ref={bar} className="reader-ruler-bar" style={{ width: rulerWidth(n) }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onPointerEnter={(e) => loupe.enter(e)} onPointerLeave={onLeave}>
        {n > 0 && <Marks columns={columns} />}
        <div className={'reader-ruler-thumb' + (n ? ' finder' : ' plain')} style={{ transform: `translateY(${thumbTop}px)`, height: place.height }} />
      </div>
      <div ref={loupe.bracket} className="loupe-bracket" />
      {loupe.element}
      {hover && (hoverRow ? (
        <Tip text={rowKey(hoverRow)} place={tipPlace} className="tip-one reader-ruler-tip">
          <RowLine row={hoverRow} />
        </Tip>
      ) : (
        <Tip text={tipOf(hover.col, hover.tick, null)} place={tipPlace} className="reader-ruler-tip" />
      ))}
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
  /** a click on a mark */
  onMark: (column: string, tick: RulerTick) => void
  tipOf?: (col: RulerColumn, tick: RulerTick) => string
  /** the page's passages, px from its top, as ReaderRuler's */
  passages?: readonly Passage[]
}

/** ReaderRuler beside a page that scrolls as one element. It reads the page's scroll itself and draws it in the same
 * frame, so a scroll renders the ruler alone. */
export function PageRuler({ scroller, columns, onJump, onMark, tipOf, passages }: PageRulerProps) {
  const [view, setView] = useState<{ top: number; height: number; px: number }>({ top: 0, height: 1, px: 0 })
  useEffect(() => {
    const box = scroller.current
    if (!box) return
    const read = () => {
      const total = Math.max(1, box.scrollHeight)
      const top = box.scrollTop / total
      const height = box.clientHeight / total
      setView((v) => (v.top === top && v.height === height && v.px === box.clientHeight ? v : { top, height, px: box.clientHeight }))
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
  const seek = (f: number) => {
    const box = scroller.current
    if (box) box.scrollTop = f * box.scrollHeight
  }
  const wheel = (px: number) => {
    const box = scroller.current
    if (box) box.scrollTop += px
  }
  return <ReaderRuler columns={columns} view={view} onJump={onJump} onMark={onMark} onSeek={seek} onWheel={wheel} tipOf={tipOf} passages={passages} />
}
