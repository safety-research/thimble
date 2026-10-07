// The reader's two tracks at its right edge, after a music or video editor's navigator and zoom bar (ReaderTracks).
//
// The overview track, at the left, is the whole file: its lines top to bottom in one lane, each pixel row in the color
// of the Color by choice that most of its records take (a key's commonest value, a label's value most of the records
// there have), or, with Color by off or no choice to make, the file's density (each bin's bytes) in grey; never two
// colors side by side. A label that is on but is not the choice draws nothing on the tracks; at the overview's left the
// find's matches leave ticks in the ink, like cue points on a timeline, which say what is found on hover and go to the
// first match on a click (a marker lane of another kind is drawn in grey, never in a color). Over the lane, a dark
// frame exactly as wide as the track outlines what the reader shows; a drag of it scrubs the reader, a press elsewhere
// on the track sends the frame there and goes on scrubbing. Hovering the track shows, beside it, the first records at
// that point of the file (their index, who and when, their first lines), as a video scrubber's hover shows its frame,
// without scrolling.
//
// The zoomed track, at the outer edge, magnifies the frame: the stretch of the reader around what it shows, larger,
// each record a block of its height in its color, grey with Color by off, past what the reader shows faded. What the
// reader shows lies under a lens (a raised box of the paper, framed), and two lines join the frame's top and bottom on
// the overview to the lens's, so the lens reads as the frame magnified. The lens stands as far down the zoomed track
// as the frame stands down the overview (both as a scrollbar's thumb does), so the two move together: in the middle of
// the file the lens is in the middle, at its top and end the lens goes to the track's top and end. A click on a record
// scrolls it to the top of the reader; a drag or the wheel scrolls the reader.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type RefObject, type WheelEvent } from 'react'
import { createPortal } from 'react-dom'
import { Tip } from '../components/Tooltip'
import { useTheme } from '../lib/theme'
import type { Concept, LabelRuler } from '../lib/types'
import { classesOf, colourVar } from './labels'
import { laneAt, laneBoxes, nearestTick, type LaneGeometry, type RulerColumn, type RulerTick, type Shown } from './Ruler'

/** px: the overview's colored column, a marker lane and the gap after it, the zoomed track */
export const OVER_PX = 12
export const MARKER_PX = 3
const MARKER_GAP_PX = 1
export const ZOOM_PX = 20
/** px between the overview and the zoomed track, which the lines from the frame to the lens cross */
export const LINK_PX = 16
/** px the lens stands out past the part it shows at every side: its edge and a margin of the paper inside it */
export const LENS_OUT_PX = 3
/** px: the frame's least height on the overview */
export const FRAME_MIN_PX = 8
/** the grey of a marker's tick other than the find's: nothing but the Color by choice takes a color on the tracks */
const MARKER_INK = 'rgba(var(--ink-rgb), 0.45)'
/** a mark's least height, px */
const MIN_MARK_PX = 2
/** px either side of a marker within which the pointer is on it */
const HIT_PX = 3
/** px the pointer moves before a press becomes a drag */
const DRAG_PX = 3
/** ms the pointer rests on the overview before its records are asked for */
const PREVIEW_DELAY_MS = 90
/** how much of the reader the zoomed track spans: this many of its heights, what it shows in the middle */
export const ZOOM_SPAN = 5
/** the opacity of the colors past what the reader shows, on the zoomed track */
export const FADE = 0.28

/** What colors the overview: a key's most frequent value's rank per bin (each rank's color, and whether it is turned
 * off, which fades it), a label's records per value per bin (each pixel row in the value most of its records have,
 * its color, faded when it is turned off), or the file's density. */
export type OverviewPaint =
  | {
      kind: 'bins'
      at: readonly number[]
      colors: readonly (string | null)[]
      faded: readonly boolean[]
    }
  | {
      kind: 'counts'
      /** per value, its records in each bin, every value over the same bins */
      counts: readonly (readonly number[])[]
      colors: readonly string[]
      faded: readonly boolean[]
    }
  | { kind: 'density'; bytes: readonly number[] }
  | { kind: 'none' }

/** A record of the stretch the zoomed track shows: its line, its top and bottom in the reader's content, px, its color
 * and the colors of the labels' markers on it, per marker lane. */
export interface ZoomRecord {
  line: number
  top: number
  bottom: number
  color: string | null
  marks: readonly (string | null)[]
  /** what its hover says: its value of the choice, its labels' values */
  title: string
}

/** The stretch of the reader the zoomed track shows (`from` to `to`, px of its content), the part on screen and the
 * records in it. */
export interface ZoomView {
  from: number
  to: number
  viewTop: number
  viewBottom: number
  records: readonly ZoomRecord[]
}

/** A record as the hover preview shows it. */
export interface PreviewRecord {
  line: number
  who: string | null
  when: string | null
  text: string
  color: string | null
}

/** How far through the file the reader stands, 0 at its top to 1 at its end: its top through the part of the file it
 * can scroll over, as a scrollbar's thumb stands. The overview's frame and the zoomed track's lens both stand there.
 * Pure. */
export function followOf(view: { top: number; height: number }): number {
  const free = 1 - view.height
  return free > 0 ? Math.max(0, Math.min(1, view.top / free)) : 0
}

/** The stretch the zoomed track shows for a reader `h` px tall scrolled to `top` of `content` px, `f` through the file
 * (followOf): ZOOM_SPAN heights, with what the reader shows as far down the stretch as `f`, so that the lens moves
 * down the zoomed track as the frame moves down the overview. While the reader holds the file's first record (`start`)
 * or its last (`end`) the stretch stays inside the content at that end; while it holds the whole file the stretch is
 * at most the content. Pure. */
export function zoomWindow(top: number, h: number, content: number, f: number, start = true, end = true): [number, number] {
  const span = start && end ? Math.max(h, Math.min(content, h * ZOOM_SPAN)) : h * ZOOM_SPAN
  let from = top - Math.max(0, Math.min(1, f)) * (span - h)
  if (end) from = Math.min(from, content - span)
  if (start) from = Math.max(0, from)
  return [from, from + span]
}

/** The frame over the overview for what the reader shows, px of a track `px` tall: from its top, as tall as its share
 * of the file and at least FRAME_MIN_PX, kept on the track. Pure. */
export function frameOf(view: { top: number; height: number }, px: number): { top: number; height: number } {
  const height = Math.min(px, Math.max(FRAME_MIN_PX, view.height * px))
  const top = Math.max(0, Math.min(px - height, view.top * px))
  return { top, height }
}

/** The lens over what the reader shows on the zoomed track, px of it: the box LENS_OUT_PX outside the part shown (`top`
 * to `bottom`), so that its edge and its margin of the paper cover none of it. Pure. */
export const lensOf = (top: number, bottom: number): { top: number; height: number } => ({ top: top - LENS_OUT_PX, height: Math.max(2, bottom - top) + 2 * LENS_OUT_PX })

/** The two lines that join the overview's frame to the lens, across the LINK_PX between the tracks (x from the
 * overview's right edge to the lens's left), and the wedge between them, px of the tracks' height: the frame's top to
 * the lens's top, its bottom to the lens's bottom. Pure. */
export function linkOf(frame: { top: number; height: number }, lens: { top: number; height: number }): { top: [number, number, number, number]; bottom: [number, number, number, number]; points: string } {
  const x1 = LINK_PX - LENS_OUT_PX
  const top: [number, number, number, number] = [0, frame.top, x1, lens.top]
  const bottom: [number, number, number, number] = [0, frame.top + frame.height, x1, lens.top + lens.height]
  return { top, bottom, points: `${top[0]},${top[1]} ${top[2]},${top[3]} ${bottom[2]},${bottom[3]} ${bottom[0]},${bottom[1]}` }
}

/** Per device pixel row of a track `h` rows tall, the value most records in it have: of `counts` (per value, its
 * records in each bin, every value over the same bins), the one with the most records in the bins the row covers, the
 * first of those as many; -1 for a row whose bins hold none. Pure. */
export function majorityRows(counts: readonly (ArrayLike<number>)[], h: number): Int32Array {
  const out = new Int32Array(Math.max(0, h)).fill(-1)
  const bins = counts.length ? counts[0].length : 0
  if (!bins) return out
  for (let y = 0; y < h; y++) {
    const a = Math.min(bins - 1, Math.floor((y * bins) / h))
    const b = Math.min(bins, Math.max(a + 1, Math.floor(((y + 1) * bins) / h)))
    let best = -1
    let most = 0
    for (let v = 0; v < counts.length; v++) {
      let n = 0
      for (let i = a; i < b; i++) n += counts[v][i] || 0
      if (n > most) {
        most = n
        best = v
      }
    }
    out[y] = best
  }
  return out
}

/** The overview's paint for a label that is the Color by choice: per highlighted value of `k`, in its order, its
 * records in each bin of the ruler (its counts; 1 for a bin that holds the value when the ruler gives none), its color,
 * and whether it is turned off (`off`). Null when the ruler has nothing of the label. Pure. */
export function labelPaint(k: Pick<Concept, 'id' | 'labels' | 'classes'>, ruler: LabelRuler | null, off: ReadonlySet<string>): OverviewPaint | null {
  const got = ruler?.labels.find((l) => l.concept_id === k.id)
  if (!ruler || !got || ruler.bins <= 0) return null
  const lit = classesOf(k).filter((c) => c.highlight)
  const counts = lit.map((c) => {
    const row = new Array<number>(ruler.bins).fill(0)
    const at = got.bins[c.name] ?? []
    const n = got.counts?.[c.name]
    at.forEach((b, i) => {
      if (b >= 0 && b < ruler.bins) row[b] += n?.[i] ?? 1
    })
    return row
  })
  return { kind: 'counts', counts, colors: lit.map((c) => colourVar(c.color)), faded: lit.map((c) => off.has(c.name)) }
}

/** The line of a file of `total` lines at a fraction of it. Pure. */
export const lineAt = (f: number, total: number): number => Math.max(1, Math.min(total, Math.floor(Math.max(0, Math.min(1, f)) * total) + 1))

/** Per device pixel row of a track `h` rows tall, the bin of `bins` it shows. Pure. */
export const binOfRow = (y: number, h: number, bins: number): number => Math.max(0, Math.min(bins - 1, Math.floor(((y + 0.5) / h) * bins)))

const MARKER_LANES: LaneGeometry = {
  lane: MARKER_PX,
  gap: MARKER_GAP_PX,
  inset: 0,
}

/** The overview's width for `n` marker lanes, px. */
export const overviewWidth = (n: number): number => (n ? n * (MARKER_PX + MARKER_GAP_PX) + 1 : 0) + OVER_PX

/** Where a mark over `from`..`to` (lines, `from` exclusive) is drawn on a rail of `k` px per line `h` px tall. */
function drawnSpan(from: number, to: number, k: number, h: number): [number, number] {
  let y0 = from * k
  let y1 = to * k
  if (y1 - y0 < MIN_MARK_PX) {
    y0 = Math.max(0, Math.min(h - MIN_MARK_PX, (y0 + y1 - MIN_MARK_PX) / 2))
    y1 = y0 + MIN_MARK_PX
  }
  return [y0, y1]
}

/** The overview's canvas: the marker lanes, then the colored column. */
const OverviewCanvas = memo(function OverviewCanvas({ paint, markers }: { paint: OverviewPaint; markers: readonly RulerColumn[] }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState<[number, number]>([0, 0])
  const theme = useTheme().key
  useEffect(() => {
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
    el.style.width = `${el.width / dpr}px`
    el.style.height = `${el.height / dpr}px`
    ctx.clearRect(0, 0, el.width, el.height)
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
    const H = el.height
    // the markers: grey ticks, no lane drawn under them and no color of the label's (the find's matches in the ink)
    const boxes = laneBoxes(markers.length, MARKER_LANES, dpr)
    markers.forEach((col, i) => {
      const [x, cw] = boxes[i]
      const k = h / Math.max(1, col.total)
      ctx.fillStyle = colourOf(col.id === 'find' ? 'var(--text-primary)' : MARKER_INK)
      for (const t of col.ticks) {
        const [y0, y1] = drawnSpan(t.from - 1, t.to, k, h)
        const a = Math.round(y0 * dpr)
        ctx.fillRect(x, a, cw, Math.max(1, Math.round(y1 * dpr) - a))
      }
    })
    // the colored column
    const x0 = markers.length ? Math.round((markers.length * (MARKER_PX + MARKER_GAP_PX) + 1) * dpr) : 0
    const cw = el.width - x0
    ctx.fillStyle = colourOf('rgba(var(--ink-rgb), 0.05)')
    ctx.fillRect(x0, 0, cw, H)
    if (paint.kind === 'bins' && paint.at.length) {
      const bins = paint.at.length
      let runStart = 0
      let runColour: string | null = null
      let runAlpha = 1
      const flush = (end: number) => {
        if (runColour) {
          ctx.globalAlpha = runAlpha
          ctx.fillStyle = runColour
          ctx.fillRect(x0, runStart, cw, end - runStart)
          ctx.globalAlpha = 1
        }
      }
      for (let y = 0; y < H; y++) {
        const rank = paint.at[binOfRow(y, H, bins)]
        const c = rank >= 0 ? paint.colors[Math.min(rank, paint.colors.length - 1)] : null
        const colour = c ? colourOf(c) : null
        const alpha = rank >= 0 && paint.faded[Math.min(rank, paint.faded.length - 1)] ? 0.18 : 1
        if (colour !== runColour || alpha !== runAlpha) {
          flush(y)
          runStart = y
          runColour = colour
          runAlpha = alpha
        }
      }
      flush(H)
    } else if (paint.kind === 'counts' && paint.counts.length) {
      // each row in the one value most of its records have
      const at = majorityRows(paint.counts, H)
      let y = 0
      while (y < H) {
        const v = at[y]
        let end = y + 1
        while (end < H && at[end] === v) end++
        if (v >= 0) {
          ctx.globalAlpha = paint.faded[v] ? 0.18 : 1
          ctx.fillStyle = colourOf(paint.colors[v])
          ctx.fillRect(x0, y, cw, end - y)
        }
        y = end
      }
      ctx.globalAlpha = 1
    } else if (paint.kind === 'density' && paint.bytes.length) {
      const bins = paint.bytes.length
      const most = Math.max(1, ...paint.bytes)
      const ink = colourOf('var(--text-primary)')
      for (let y = 0; y < H; y++) {
        const b = paint.bytes[binOfRow(y, H, bins)]
        if (!b) continue
        ctx.globalAlpha = 0.08 + 0.42 * Math.sqrt(b / most)
        ctx.fillStyle = ink
        ctx.fillRect(x0, y, cw, 1)
      }
      ctx.globalAlpha = 1
    }
  }, [paint, markers, size, theme])
  return <canvas ref={ref} className="track-canvas" />
})

interface TracksProps {
  /** the file's lines */
  total: number | null
  view: Shown
  paint: OverviewPaint
  /** a lane each, in grey or for the find's matches the ink: the reader gives the find's matches alone */
  markers: readonly RulerColumn[]
  zoom: ZoomView | null
  onJump: (fraction: number) => void
  onSeek: (fraction: number, held: boolean) => void
  onWheel: (px: number) => void
  /** a record of the zoomed track clicked: scroll it to the top */
  onLine: (line: number) => void
  onMark: (column: string, tick: RulerTick) => void
  /** the first records at a line of the file, for the hover preview */
  preview?: (line: number) => Promise<PreviewRecord[]>
}

/** What a marker's hover says: the label's name, and its value when the label has more than one. */
export const markerText = (col: RulerColumn, tick: RulerTick): string => (col.valued && tick.value ? `${col.name}: ${tick.value}` : col.name)

export function ReaderTracks({ total, view, paint, markers, zoom, onJump, onSeek, onWheel, onLine, onMark, preview }: TracksProps) {
  const over = useRef<HTMLDivElement>(null)
  const zoomEl = useRef<HTMLDivElement>(null)
  const [px, setPx] = useState(0)
  useEffect(() => {
    const el = over.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setPx(el.clientHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const n = markers.length
  const lanesPx = n ? n * (MARKER_PX + MARKER_GAP_PX) + 1 : 0
  const sorted = useMemo(() => markers.map((c) => [...c.ticks].sort((a, b) => a.from - b.from)), [markers])

  // ---- the frame and its drag
  const frame = frameOf(view, px)
  const [drag, setDrag] = useState<{ top: number; held: boolean } | null>(null)
  const grab = useRef<{
    dy: number
    y0: number
    moved: boolean
    top: number
    onFrame: boolean
  } | null>(null)
  const raf = useRef<number | null>(null)
  const latest = useRef({ frame, px, onSeek })
  latest.current = { frame, px, onSeek }
  const yIn = (e: { clientY: number }) => e.clientY - (over.current?.getBoundingClientRect().top ?? 0)
  const seekTop = (top: number, held: boolean) => {
    const { px: p, onSeek: seek } = latest.current
    seek(p > 0 ? Math.max(0, Math.min(1, top / p)) : 0, held)
  }
  const room = () => Math.max(0, latest.current.px - latest.current.frame.height)
  const markerAt = (e: { clientX: number; clientY: number }): { col: RulerColumn; tick: RulerTick } | null => {
    const el = over.current
    if (!el || !n) return null
    const r = el.getBoundingClientRect()
    const x = e.clientX - r.left
    if (x > lanesPx || r.height <= 0) return null
    const i = laneAt(x, MARKER_LANES, n)
    const col = markers[i]
    const k = col.total / r.height
    const tick = nearestTick(sorted[i], (e.clientY - r.top) * k, (HIT_PX + MIN_MARK_PX / 2) * k)
    return tick ? { col, tick } : null
  }
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    clearPreview()
    const hit = markerAt(e)
    if (hit) return onMark(hit.col.id, hit.tick)
    const y = yIn(e)
    const onFrame = y >= frame.top && y <= frame.top + frame.height
    const top = onFrame ? frame.top : Math.max(0, Math.min(room(), y - frame.height / 2))
    grab.current = { dy: y - top, y0: e.clientY, moved: false, top, onFrame }
    e.currentTarget.setPointerCapture?.(e.pointerId)
    if (!onFrame) {
      setDrag({ top, held: true })
      seekTop(top, true)
    }
  }
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const g = grab.current
    if (!g) return hover(e)
    if (!g.moved && Math.abs(e.clientY - g.y0) < DRAG_PX) return
    g.moved = true
    g.top = Math.max(0, Math.min(room(), yIn(e) - g.dy))
    setDrag({ top: g.top, held: true })
    if (raf.current == null)
      raf.current = requestAnimationFrame(() => {
        raf.current = null
        if (grab.current) seekTop(grab.current.top, true)
      })
  }
  const onUp = () => {
    const g = grab.current
    grab.current = null
    if (!g) return
    if (raf.current != null) cancelAnimationFrame(raf.current)
    raf.current = null
    if (g.moved || !g.onFrame) {
      setDrag({ top: g.top, held: false })
      seekTop(g.top, false)
    }
  }
  useEffect(() => {
    if (!drag || drag.held) return
    const t = window.setTimeout(() => setDrag(null), 400)
    return () => window.clearTimeout(t)
  }, [drag])
  useEffect(() => {
    setDrag((d) => (d && !d.held ? null : d))
  }, [view.top, view.height])
  useEffect(
    () => () => {
      if (raf.current != null) cancelAnimationFrame(raf.current)
    },
    [],
  )
  const wheel = (e: WheelEvent<HTMLDivElement>) => onWheel(e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * Math.max(1, px) : e.deltaY)

  // ---- the hover: a marker's name, else the records at that point
  const [tip, setTip] = useState<{ text: string; y: number } | null>(null)
  const [shown, setShown] = useState<{
    y: number
    line: number
    records: PreviewRecord[] | null
  } | null>(null)
  const timer = useRef<number | null>(null)
  const asked = useRef(0)
  const cache = useRef(new Map<number, Promise<PreviewRecord[]>>())
  useEffect(() => cache.current.clear(), [preview])
  const clearPreview = useCallback(() => {
    if (timer.current != null) window.clearTimeout(timer.current)
    timer.current = null
    asked.current++
    setShown(null)
  }, [])
  const hover = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch') return
    const hit = markerAt(e)
    if (hit) {
      clearPreview()
      return setTip({ text: markerText(hit.col, hit.tick), y: e.clientY })
    }
    setTip(null)
    if (!preview || !total || px <= 0) return
    const line = lineAt(yIn(e) / px, total)
    setShown((s) => (s ? { ...s, y: e.clientY } : s))
    if (timer.current != null) window.clearTimeout(timer.current)
    const y = e.clientY
    const ask = ++asked.current
    timer.current = window.setTimeout(() => {
      timer.current = null
      let p = cache.current.get(line)
      if (!p) {
        p = preview(line).catch(() => [])
        cache.current.set(line, p)
      }
      setShown((s) => ({
        y: s?.y ?? y,
        line,
        records: s?.line === line ? s.records : null,
      }))
      void p.then((records) => ask === asked.current && setShown((s) => (s ? { ...s, line, records } : s)))
    }, PREVIEW_DELAY_MS)
  }
  const leave = () => {
    setTip(null)
    clearPreview()
  }
  useEffect(() => () => clearPreview(), [clearPreview])
  const tipPlace = useCallback(
    (w: number, h: number) => {
      const r = over.current?.parentElement?.getBoundingClientRect()
      const y = tip?.y ?? 0
      return {
        left: Math.max(8, (r?.left ?? 0) - 8 - w),
        top: Math.max(8, Math.min(window.innerHeight - 8 - h, y - h / 2)),
      }
    },
    [tip?.y],
  )

  // ---- the zoomed track
  const [zpx, setZpx] = useState(0)
  useEffect(() => {
    const el = zoomEl.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setZpx(el.clientHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const zgrab = useRef<{
    y: number
    moved: boolean
    line: number | null
  } | null>(null)
  const scale = zoom && zpx > 0 ? (zoom.to - zoom.from) / zpx : 1
  const zoomLine = (e: { target: EventTarget }) => {
    const el = (e.target as HTMLElement).closest?.('[data-line]') as HTMLElement | null
    return el ? Number(el.dataset.line) : null
  }
  const onZDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    zgrab.current = { y: e.clientY, moved: false, line: zoomLine(e) }
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }
  const onZMove = (e: PointerEvent<HTMLDivElement>) => {
    const g = zgrab.current
    if (!g) return
    const dy = e.clientY - g.y
    if (!g.moved && Math.abs(dy) < DRAG_PX) return
    g.moved = true
    g.y = e.clientY
    onWheel(dy * scale)
  }
  const onZUp = () => {
    const g = zgrab.current
    zgrab.current = null
    if (g && !g.moved && g.line != null) onLine(g.line)
  }
  const zy = (v: number) => (zoom && zpx > 0 ? ((v - zoom.from) / Math.max(1, zoom.to - zoom.from)) * zpx : 0)
  const zLanes = zoom?.records.find((r) => r.marks.length)?.marks.length ?? 0
  // a record's block, in its color or grey, with a grey tick at its left for each marker lane that marks it
  const blocks = (layer: 'faded' | 'shown') =>
    zoom?.records.map((r) => {
      const top = zy(r.top)
      const h = Math.max(1, zy(r.bottom) - top - 1)
      return (
        <i key={r.line} className={'track-rec' + (r.color ? '' : ' plain')} data-line={r.line} title={layer === 'shown' ? r.title : undefined} style={{ top, height: h, ...(r.color ? { background: r.color } : {}) } as CSSProperties}>
          {r.marks.map((m, i) => (m ? <b key={i} style={{ left: i * (MARKER_PX + MARKER_GAP_PX) }} /> : null))}
        </i>
      )
    })
  const vTop = zoom ? zy(zoom.viewTop) : 0
  const vH = zoom ? Math.max(2, zy(zoom.viewBottom) - vTop) : 0
  const lens = lensOf(vTop, vTop + vH)
  const frameTop = drag ? drag.top : frame.top
  const link = zoom && px > 0 ? linkOf({ top: frameTop, height: frame.height }, lens) : null
  return (
    <div className="tracks" data-drag={drag?.held || undefined} onWheel={wheel} aria-hidden>
      <div ref={over} className="track track-over" style={{ width: lanesPx + OVER_PX }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onPointerLeave={leave}>
        <OverviewCanvas paint={paint} markers={markers} />
        <div className="track-frame-over" style={{ transform: `translateY(${frameTop}px)`, height: frame.height }} />
      </div>
      <svg className="track-link" width={LINK_PX}>
        {link && (
          <>
            <polygon points={link.points} />
            <line data-edge="top" x1={link.top[0]} y1={link.top[1]} x2={link.top[2]} y2={link.top[3]} />
            <line data-edge="bottom" x1={link.bottom[0]} y1={link.bottom[1]} x2={link.bottom[2]} y2={link.bottom[3]} />
          </>
        )}
      </svg>
      <div ref={zoomEl} className="track track-zoom" style={{ width: ZOOM_PX + (zLanes ? zLanes * (MARKER_PX + MARKER_GAP_PX) : 0) }} onPointerDown={onZDown} onPointerMove={onZMove} onPointerUp={onZUp} onPointerCancel={onZUp}>
        {zoom && (
          <>
            <div className="track-zoom-faded" style={{ opacity: FADE }}>
              {blocks('faded')}
            </div>
            <div className="track-lens" style={{ top: lens.top, height: lens.height }} />
            <div className="track-zoom-shown" style={{ top: vTop, height: vH }}>
              <div style={{ position: 'absolute', left: 0, right: 0, top: -vTop }}>{blocks('shown')}</div>
            </div>
          </>
        )}
      </div>
      {tip && <Tip text={tip.text} place={tipPlace} className="reader-ruler-tip" />}
      {shown && <Preview at={shown} anchor={over} />}
    </div>
  )
}

/** The hover preview: the records at the point of the file under the pointer, beside the tracks. */
function Preview({ at, anchor }: { at: { y: number; line: number; records: PreviewRecord[] | null }; anchor: RefObject<HTMLDivElement | null> }) {
  const el = useRef<HTMLDivElement>(null)
  const [h, setH] = useState(0)
  useLayoutEffect(() => setH(el.current?.offsetHeight ?? 0), [at.records])
  const r = anchor.current?.parentElement?.getBoundingClientRect()
  const top = Math.max(8, Math.min(window.innerHeight - 8 - h, at.y - h / 2))
  const right = r ? window.innerWidth - r.left + 8 : 60
  return createPortal(
    <div ref={el} className="track-preview overlay" style={{ top, right }} role="tooltip">
      {at.records == null ? (
        <div className="track-preview-rec">
          <div className="track-preview-head mono">{at.line.toLocaleString()}</div>
        </div>
      ) : (
        at.records.map((p) => (
          <div key={p.line} className="track-preview-rec" style={p.color ? ({ '--c': p.color } as CSSProperties) : undefined}>
            <div className="track-preview-head mono">
              <span className="track-preview-line">{p.line.toLocaleString()}</span>
              {[p.who, p.when].filter(Boolean).join(' · ')}
            </div>
            <div className="track-preview-text">{p.text}</div>
          </div>
        ))
      )}
    </div>,
    document.body,
  )
}
