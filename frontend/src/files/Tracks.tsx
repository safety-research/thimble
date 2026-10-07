// The reader's two tracks at its right edge, after a music or video editor's navigator and zoom bar (ReaderTracks).
//
// The overview track, at the left, is the whole file: its lines top to bottom in one lane, each pixel row in the color
// of the Color by choice that most of its records take (a key's commonest value, a label's value most of the records
// there have), or, with Color by off or no choice to make, the file's density (each bin's bytes) in grey; never two
// colors side by side. A label that is on but is not the choice draws nothing on the tracks; at the overview's left the
// find's matches leave ticks in the ink, like cue points on a timeline, which say what is found on hover and go to the
// first match on a click (a marker lane of another kind is drawn in grey, never in a color). Over the lane, a dark
// frame exactly as wide as the track outlines what the reader shows; a drag of it scrubs the reader, a click elsewhere
// on the track sends the frame there, and a drag from there scrubs on (a press moves nothing until the pointer has moved
// DRAG_PX or let go). A click within SNAP_PX of a thin patch of a color (THIN_PX tall at most, a lone record of a value
// that the overview shows) snaps to it: the reader goes to the patch's first record and chooses it as the find does.
// Hovering the track shows, beside it, the first records at that point of the file (their index, who and when, their
// first lines), as a video scrubber's hover shows its frame, without scrolling. A jump of the reader (a click, the find)
// makes the tracks glide to its new place.
//
// The zoomed track, at the outer edge, magnifies the frame: the stretch of the reader around what it shows, larger,
// each record a block of its height in its color, grey with Color by off, past what the reader shows faded. What the
// reader shows lies under a lens (a raised box of the paper, framed), and two lines join the frame's top and bottom on
// the overview to the lens's, so the lens reads as the frame magnified. The lens stands as far down the zoomed track
// as the frame stands down the overview (both as a scrollbar's thumb does), so the two move together: in the middle of
// the file the lens is in the middle, at its top and end the lens goes to the track's top and end. A drag on the
// zoomed track scrolls the reader at its scale, as a scrollbar's thumb: the lens follows the pointer over the records,
// which hold still, and a pixel of the track is a few of the reader; a press off the lens brings the lens's middle
// there first. Let go, the lens glides back to where the frame puts it. The wheel over either track scrolls the reader.
//
// The reader publishes where it stands each frame it scrolls (PlaceFeed), and one animation frame moves the frame, the
// lens, the zoomed track's records and the lines between them, with transforms alone: nothing renders in React while
// the reader scrolls or a drag moves. While they move they stand where they are computed; once still, every edge goes
// onto the device's pixel grid.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type RefObject, type WheelEvent } from 'react'
import { createPortal } from 'react-dom'
import { Tip } from '../components/Tooltip'
import { useTheme } from '../lib/theme'
import type { Concept, LabelRuler } from '../lib/types'
import { classesOf, colourVar } from './labels'
import { laneAt, laneBoxes, nearestTick, type LaneGeometry, type RulerColumn, type RulerTick } from './Ruler'

/** px: the overview's colored column, a marker lane and the gap after it, the zoomed track */
export const OVER_PX = 12
export const MARKER_PX = 3
const MARKER_GAP_PX = 1
export const ZOOM_PX = 20
/** px between the overview and the zoomed track, which the lines from the frame to the lens cross */
export const LINK_PX = 16
/** px the lens stands out past the part it shows at every side: its edge and a margin of the paper inside it */
export const LENS_OUT_PX = 3
/** px: the lens's corners; the lines from the frame meet its left edge where the corners' curves end */
export const LENS_RADIUS_PX = 4
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

/** A record the zoomed track draws: its line, its top and bottom in the reader's content, px, its color
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

/** The frame over the overview for what the reader shows, px of a track `px` tall: as tall as its share of the file
 * and at least FRAME_MIN_PX, as far down the room the track leaves it as the reader is through the file (followOf), as
 * a scrollbar's thumb stands, so that the frame at the track's end is the file's end. Pure. */
export function frameOf(view: { top: number; height: number }, px: number): { top: number; height: number } {
  const height = Math.min(px, Math.max(FRAME_MIN_PX, view.height * px))
  return { top: followOf(view) * Math.max(0, px - height), height }
}

/** Where the reader stands, as it measures it each frame it moves: the share of the file above its top and the share
 * it shows (as Shown), and px of its body: how far it is scrolled, its height and its content's height, and whether the
 * content holds the file's first record and its last. */
export interface TrackPlace {
  top: number
  height: number
  scroll: number
  h: number
  content: number
  start: boolean
  end: boolean
}

const samePlace = (a: TrackPlace, b: TrackPlace) => a.top === b.top && a.height === b.height && a.scroll === b.scroll && a.h === b.h && a.content === b.content && a.start === b.start && a.end === b.end

/** A record the reader draws, px of its content. */
export interface DrawnRecord {
  line: number
  top: number
  bottom: number
}

const sameRecords = (x: readonly DrawnRecord[] | null, y: readonly DrawnRecord[] | null) => x === y || (!!x && !!y && x.length === y.length && x.every((r, i) => r.line === y[i].line && r.top === y[i].top && r.bottom === y[i].bottom))

/** The reader's place and the records around it, as it publishes them each frame it scrolls: the tracks draw the place
 * in the same frame with transforms alone, and render again only when the records change, so that a scroll renders
 * nothing of the reader in React. */
export class PlaceFeed {
  place: TrackPlace = { top: 0, height: 1, scroll: 0, h: 0, content: 0, start: true, end: true }
  records: readonly DrawnRecord[] | null = null
  private heard = new Set<() => void>()
  private heardRecords = new Set<() => void>()
  set(p: TrackPlace): void {
    if (samePlace(p, this.place)) return
    this.place = p
    this.heard.forEach((f) => f())
  }
  setRecords(r: readonly DrawnRecord[] | null): void {
    if (sameRecords(r, this.records)) return
    this.records = r
    this.heardRecords.forEach((f) => f())
  }
  on(f: () => void): () => void {
    this.heard.add(f)
    return () => {
      this.heard.delete(f)
    }
  }
  onRecords(f: () => void): () => void {
    this.heardRecords.add(f)
    return () => {
      this.heardRecords.delete(f)
    }
  }
}

/** Where the tracks stand for a place: the frame's top and height on an overview `px` tall, how far through the file
 * that is (`f`, as followOf), and on a zoomed track `zpx` tall its scale (`k`, track px per px of the content), the
 * content at its top (`from`) and the part shown (`vTop`, `vH`). A drag of the frame holds it at `frame` px, and the
 * part shown then stands as far down the zoomed track as the frame stands down the overview, wherever the reader has
 * got to yet; a drag on the zoomed track holds the part shown at `lens` px, and the content moves under it. Otherwise
 * the zoomed track shows zoomWindow's stretch. Pure. */
export interface TrackGeom {
  frameTop: number
  frameH: number
  f: number
  k: number
  from: number
  vTop: number
  vH: number
}

export function trackGeom(p: TrackPlace, px: number, zpx: number, frame: number | null, lens: number | null): TrackGeom {
  const frameH = Math.min(px, Math.max(FRAME_MIN_PX, p.height * px))
  const room = Math.max(0, px - frameH)
  const f = frame != null ? (room > 0 ? Math.max(0, Math.min(1, frame / room)) : 0) : followOf(p)
  const span = p.start && p.end ? Math.max(p.h, Math.min(p.content, p.h * ZOOM_SPAN)) : p.h * ZOOM_SPAN
  const k = span > 0 && zpx > 0 ? zpx / span : 0
  const vH = p.h * k
  let vTop: number
  if (lens != null) vTop = Math.max(0, Math.min(Math.max(0, zpx - vH), lens))
  else if (frame != null) vTop = f * Math.max(0, zpx - vH)
  else vTop = (p.scroll - zoomWindow(p.scroll, p.h, p.content, f, p.start, p.end)[0]) * k
  return { frameTop: f * room, frameH, f, k, from: p.scroll - (k > 0 ? vTop / k : 0), vTop, vH }
}

/** A length in css px moved onto the device's pixel grid at `dpr`, so that an edge there is drawn sharp. Pure. */
export const snap = (v: number, dpr: number): number => Math.round(v * dpr) / dpr

/** The lens over what the reader shows on the zoomed track, px of it: the box LENS_OUT_PX outside the part shown (`top`
 * to `bottom`), so that its edge and its margin of the paper cover none of it. Pure. */
export const lensOf = (top: number, bottom: number): { top: number; height: number } => ({ top: top - LENS_OUT_PX, height: Math.max(2, bottom - top) + 2 * LENS_OUT_PX })

/** The two 1px lines that join the overview's frame to the lens, across the LINK_PX between the tracks, and the wedge
 * between them, px from the overview's right edge and the tracks' top: from the frame's top right corner to the lens's
 * left edge where its top corner's curve ends, and from the frame's bottom right corner to where its bottom corner's
 * curve begins. At a `dpr` where a 1px line is an odd number of device pixels wide, each line's ends move half a device
 * pixel into the frame's and the lens's edges, so that the line lies on whole device pixels there; the wedge reaches
 * the edges themselves. Pure. */
export function linkOf(frame: { top: number; height: number }, lens: { top: number; height: number }, dpr = 1): { top: [number, number, number, number]; bottom: [number, number, number, number]; points: string } {
  const x1 = LINK_PX - LENS_OUT_PX
  const o = Math.round(dpr) % 2 === 1 ? 0.5 / dpr : 0
  const r = Math.min(LENS_RADIUS_PX, lens.height / 2)
  const x0 = o ? -o : 0
  const top: [number, number, number, number] = [x0, frame.top + o, x1 + o, lens.top + r]
  const bottom: [number, number, number, number] = [x0, frame.top + frame.height - o, x1 + o, lens.top + lens.height - r]
  return { top, bottom, points: `0,${frame.top} ${x1},${lens.top + r} ${x1},${lens.top + lens.height - r} 0,${frame.top + frame.height}` }
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

/** px either side of a click on the overview within which it snaps to a thin patch of color, and the most a patch may
 * be tall to be thin: a click in a taller patch goes where it is clicked */
export const SNAP_PX = 4
export const THIN_PX = 8

/** Per device pixel row of an overview `rows` tall, the value its paint colors the row in (a key's rank, a label's
 * value), as the overview draws it; -1 for a row in no value, in grey or in a value turned off. Pure. */
export function rowValues(paint: OverviewPaint, rows: number): Int32Array {
  const out = new Int32Array(Math.max(0, rows)).fill(-1)
  if (paint.kind === 'bins' && paint.at.length) {
    for (let y = 0; y < rows; y++) {
      const r = paint.at[binOfRow(y, rows, paint.at.length)]
      if (r >= 0 && paint.colors[Math.min(r, paint.colors.length - 1)] && !paint.faded[Math.min(r, paint.faded.length - 1)]) out[y] = r
    }
  } else if (paint.kind === 'counts' && paint.counts.length) {
    const at = majorityRows(paint.counts, rows)
    for (let y = 0; y < rows; y++) if (at[y] >= 0 && !paint.faded[at[y]]) out[y] = at[y]
  }
  return out
}

/** The patch of color a click at device row `y` of an overview snaps to: of `values` (rowValues), the runs of rows in
 * one value at most `thin` rows tall that come within `reach` rows of the click, the nearest (the upper on a tie), as
 * its first row and its value. Null when none does: a click in a taller patch, or far from any, goes where it is.
 * Pure. */
export function snapPatch(values: ArrayLike<number>, y: number, reach: number, thin: number): { row: number; value: number } | null {
  const n = values.length
  if (!n) return null
  const at = Math.max(0, Math.min(n - 1, Math.floor(y)))
  let best: { row: number; value: number } | null = null
  let bestD = Infinity
  let r = Math.max(0, at - reach)
  // from the start of the run the window's first row stands in
  while (r > 0 && values[r] >= 0 && values[r - 1] === values[r]) r--
  while (r < n && r <= at + reach) {
    const v = values[r]
    let end = r + 1
    while (end < n && values[end] === v) end++
    if (v >= 0 && end - r <= thin) {
      const d = at < r ? r - at : at >= end ? at - end + 1 : 0
      if (d <= reach && d < bestD) {
        best = { row: r, value: v }
        bestD = d
      }
    }
    r = end
  }
  return best
}

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
  /** where the reader stands, which it publishes each frame it moves */
  feed: PlaceFeed
  paint: OverviewPaint
  /** a lane each, in grey or for the find's matches the ink: the reader gives the find's matches alone */
  markers: readonly RulerColumn[]
  /** a record's color on the zoomed track and what its hover says */
  colorOf?: (line: number) => { color: string | null; title: string }
  onJump: (fraction: number) => void
  /** a click on the overview snapped to a patch of color: go to the first record in `value` (a key's rank, a label's
   * value, as the paint gives them) on lines `from` to `to`, where the patch starts */
  onSnap?: (from: number, to: number, value: number) => void
  /** the fraction of the file at the reader's top to go to; `held` while the pointer still holds the frame */
  onSeek: (fraction: number, held: boolean) => void
  /** scroll the reader by `px`; how far it went */
  onScrollBy: (px: number) => number
  onMark: (column: string, tick: RulerTick) => void
  /** the first records at a line of the file, for the hover preview */
  preview?: (line: number) => Promise<PreviewRecord[]>
}

/** What a marker's hover says: the label's name, and its value when the label has more than one. */
export const markerText = (col: RulerColumn, tick: RulerTick): string => (col.valued && tick.value ? `${col.name}: ${tick.value}` : col.name)

/** ms the tracks take to go from where a drag left them to where the reader stands */
const GLIDE_MS = 160
/** ms the tracks stay still before every edge on them goes onto the device's pixel grid */
const SETTLE_MS = 60
/** ms a released frame waits for the reader to move before it goes where the reader stands */
const RELEASE_MS = 400
/** px the frame moves at once, with nothing held, past which the tracks glide to the reader's new place */
const JUMP_PX = 12
const ease = (t: number) => 1 - Math.pow(1 - Math.max(0, Math.min(1, t)), 3)

/** The parts the tracks' animation frame moves: what it wrote last, so that it writes only what changed. */
interface Written {
  frameTop: number
  frameH: number
  vTop: number
  vH: number
  layer: number
}

export function ReaderTracks({ total, feed, paint, markers, colorOf, onSnap, onSeek, onScrollBy, onMark, preview }: TracksProps) {
  const over = useRef<HTMLDivElement>(null)
  const zoomEl = useRef<HTMLDivElement>(null)
  const frameEl = useRef<HTMLDivElement>(null)
  const lensEl = useRef<HTMLDivElement>(null)
  const fadedEl = useRef<HTMLDivElement>(null)
  const shownEl = useRef<HTMLDivElement>(null)
  const shownInner = useRef<HTMLDivElement>(null)
  const wedge = useRef<SVGPolygonElement>(null)
  const topLine = useRef<SVGLineElement>(null)
  const bottomLine = useRef<SVGLineElement>(null)
  const [px, setPx] = useState(0)
  const [zpx, setZpx] = useState(0)
  useEffect(() => {
    const el = over.current
    const z = zoomEl.current
    if (!el || !z || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      setPx(el.clientHeight)
      setZpx(z.clientHeight)
    })
    ro.observe(el)
    ro.observe(z)
    return () => ro.disconnect()
  }, [])
  const n = markers.length
  const lanesPx = n ? n * (MARKER_PX + MARKER_GAP_PX) + 1 : 0
  const sorted = useMemo(() => markers.map((c) => [...c.ticks].sort((a, b) => a.from - b.from)), [markers])
  // the records around the reader's place that the zoomed track draws, as the reader last published them
  const [drawn, setDrawn] = useState(feed.records)
  useEffect(() => {
    setDrawn(feed.records)
    return feed.onRecords(() => setDrawn(feed.records))
  }, [feed])
  const records = useMemo<ZoomRecord[] | null>(() => drawn?.map((r) => ({ ...r, ...(colorOf ? colorOf(r.line) : { color: null, title: '' }), marks: [] })) ?? null, [drawn, colorOf])
  // what the zoomed track draws at: track px per px of the reader's content, as the place last gave it
  const [scale, setScale] = useState(0)
  const [dragging, setDragging] = useState<'frame' | 'zoom' | null>(null)

  // ---- one animation frame moves the frame, the lens, the zoomed track's records and the lines between them, with
  // transforms only. While anything moves they stand where they are computed; once still, every edge goes onto the
  // device's pixel grid.
  const m = useRef({
    raf: 0,
    /** the frame's top on the overview while a drag of it holds it, px */
    frame: null as number | null,
    /** a released frame waits for the reader to move from the place it had then */
    release: null as { at: number; place: TrackPlace } | null,
    /** the top of the part shown on the zoomed track while a drag on it holds it, px */
    lens: null as number | null,
    /** from where the tracks glide to the reader's place, after a hold ends */
    glide: null as { at: number; frame: number; vTop: number } | null,
    /** the held frame moved since the reader was last asked to go there */
    seek: false,
    /** px of the zoomed track the pointer moved since the reader last scrolled for it */
    pull: 0,
    /** px the reader scrolled for the zoomed track since the place was last published */
    adj: 0,
    /** inside a call to the reader, which may publish its place at once: that waits for the next frame */
    busy: false,
    /** the share of the file above the reader's top when last drawn, to tell a jump from a scroll */
    top: null as number | null,
    /** the geometry last drawn, and whether on the pixel grid */
    drawn: null as TrackGeom | null,
    written: null as Written | null,
    snapped: false,
    movedAt: 0,
  })
  const px$ = useRef(0)
  const zpx$ = useRef(0)
  const scale$ = useRef(0)
  px$.current = px
  zpx$.current = zpx
  scale$.current = scale
  const calls = useRef({ onSeek, onScrollBy })
  calls.current = { onSeek, onScrollBy }
  const hasZoom = records != null

  const write = (g: TrackGeom, grid: boolean) => {
    const dpr = window.devicePixelRatio || 1
    const q = (v: number) => (grid ? snap(v, dpr) : v)
    const w = m.current.written
    const frameTop = q(g.frameTop)
    const frameH = q(g.frameH)
    const fr = frameEl.current
    if (fr) {
      if (!w || w.frameTop !== frameTop) fr.style.transform = `translateY(${frameTop}px)`
      if (!w || w.frameH !== frameH) fr.style.height = `${frameH}px`
    }
    const vTop = q(g.vTop)
    const vH = Math.max(2, q(g.vTop + g.vH) - vTop)
    // the records stand at their place in the reader's content, at the scale they were drawn at
    const k = scale$.current || g.k
    const layer = q(-g.from * k)
    const lens = lensOf(vTop, vTop + vH)
    if (hasZoom) {
      const le = lensEl.current
      if (le && (!w || w.vTop !== vTop || w.vH !== vH)) {
        le.style.transform = `translateY(${lens.top}px)`
        le.style.height = `${lens.height}px`
      }
      if (fadedEl.current && (!w || w.layer !== layer)) fadedEl.current.style.transform = `translateY(${layer}px)`
      const se = shownEl.current
      if (se && (!w || w.vTop !== vTop || w.vH !== vH)) {
        se.style.transform = `translateY(${vTop}px)`
        se.style.height = `${vH}px`
      }
      if (shownInner.current && (!w || w.layer !== layer || w.vTop !== vTop)) shownInner.current.style.transform = `translateY(${layer - vTop}px)`
      const link = linkOf({ top: frameTop, height: frameH }, lens, dpr)
      const set = (el: SVGLineElement | null, v: readonly number[]) => {
        if (!el) return
        el.setAttribute('x1', String(v[0]))
        el.setAttribute('y1', String(v[1]))
        el.setAttribute('x2', String(v[2]))
        el.setAttribute('y2', String(v[3]))
      }
      if (!w || w.frameTop !== frameTop || w.frameH !== frameH || w.vTop !== vTop || w.vH !== vH) {
        wedge.current?.setAttribute('points', link.points)
        set(topLine.current, link.top)
        set(bottomLine.current, link.bottom)
      }
    }
    m.current.written = { frameTop, frameH, vTop, vH, layer }
  }

  /** Compute and draw this frame's geometry; whether the tracks still move. `quiet` (drawn as the reader publishes its
   * place, inside its own frame) asks nothing of the reader. */
  const draw = (now: number, quiet = false): boolean => {
    const s = m.current
    const P = px$.current
    const Z = zpx$.current
    const place = feed.place
    if (P <= 0) return false
    // a drag on the zoomed track: the reader scrolls by what the pointer moved, at the zoomed track's scale, and the
    // part shown moves on the track by as much as the reader went
    if (!quiet && s.pull && s.lens != null) {
      const k = s.drawn?.k || trackGeom(place, P, Z, null, null).k
      if (k > 0) {
        s.busy = true
        const went = calls.current.onScrollBy(s.pull / k)
        s.busy = false
        // a reader that publishes its place at once has counted the scroll there already
        if (feed.place === place) s.adj += went
        s.lens += went * k
      }
      s.pull = 0
    }
    // a released frame goes where the reader stands once the reader has moved, or after a while
    if (s.release && (place !== s.release.place || now - s.release.at > RELEASE_MS)) {
      if (s.drawn) s.glide = { at: now, frame: s.drawn.frameTop, vTop: s.drawn.vTop }
      s.frame = null
      s.release = null
    }
    const now$ = feed.place
    const p = s.adj ? { ...now$, scroll: now$.scroll + s.adj } : now$
    const g = trackGeom(p, P, Z, s.frame, s.lens)
    if (s.lens != null) s.lens = g.vTop
    if (!quiet && s.seek && s.frame != null) {
      s.seek = false
      s.busy = true
      calls.current.onSeek(g.f * Math.max(0, 1 - now$.height), true)
      s.busy = false
    }
    // a jump of the reader (a click, the find, a link) with nothing held, past twice what it shows of the file at once
    // where a scroll goes by frames: the tracks glide there
    const d0 = s.drawn
    const jumped = s.top != null && Math.abs(now$.top - s.top) > 2 * now$.height
    s.top = now$.top
    if (jumped && !s.glide && s.frame == null && s.lens == null && d0 && Math.abs(d0.frameTop - g.frameTop) > JUMP_PX) s.glide = { at: now, frame: d0.frameTop, vTop: d0.vTop }
    let shown = g
    if (s.glide) {
      const e = ease((now - s.glide.at) / GLIDE_MS)
      if (e >= 1) s.glide = null
      else {
        const vTop = g.vTop + (s.glide.vTop - g.vTop) * (1 - e)
        shown = { ...g, frameTop: g.frameTop + (s.glide.frame - g.frameTop) * (1 - e), vTop, from: p.scroll - (g.k > 0 ? vTop / g.k : 0) }
      }
    }
    const k = shown.k
    if (k > 0 && Math.abs(k - scale$.current) > 1e-9 * Math.max(1, k)) setScale(k)
    const d = s.drawn
    const moved = !d || Math.abs(d.frameTop - shown.frameTop) > 1e-3 || Math.abs(d.frameH - shown.frameH) > 1e-3 || Math.abs(d.vTop - shown.vTop) > 1e-3 || Math.abs(d.vH - shown.vH) > 1e-3 || Math.abs(d.from * d.k - shown.from * shown.k) > 1e-3
    if (moved) s.movedAt = now
    const still = !moved && !s.glide && s.frame == null && s.lens == null && now - s.movedAt >= SETTLE_MS
    if (moved || (still && !s.snapped)) write(shown, still)
    s.drawn = shown
    s.snapped = still
    return !still
  }
  const draw$ = useRef(draw)
  draw$.current = draw
  const kick = useCallback(() => {
    const s = m.current
    if (s.raf) return
    const tick = (now: number) => {
      s.raf = 0
      if (draw$.current(now)) s.raf = requestAnimationFrame(tick)
    }
    s.raf = requestAnimationFrame(tick)
  }, [])
  useEffect(
    () =>
      feed.on(() => {
        // the place measured now holds every scroll the zoomed track asked for; drawn in the frame the reader scrolled in
        m.current.adj = 0
        if (!m.current.busy) draw$.current(performance.now(), true)
        kick()
      }),
    [feed, kick],
  )
  // drawn again at once when what is drawn changes size or scale, so that nothing stands a frame out of place
  useLayoutEffect(() => {
    const s = m.current
    s.written = null
    s.drawn = null
    draw$.current(performance.now())
    kick()
  }, [px, zpx, scale, records, kick])
  useEffect(
    () => () => {
      if (m.current.raf) cancelAnimationFrame(m.current.raf)
    },
    [],
  )

  // ---- the frame and its drag
  const grab = useRef<{ dy: number; y0: number; moved: boolean; onFrame: boolean } | null>(null)
  const yIn = (e: { clientY: number }) => e.clientY - (over.current?.getBoundingClientRect().top ?? 0)
  const geom = () => m.current.drawn ?? trackGeom(feed.place, px$.current, zpx$.current, null, null)
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
  const capture = (e: PointerEvent<HTMLDivElement>) => {
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId)
    } catch {
      /* a pointer the browser no longer tracks: the drag goes on while it stays over the track */
    }
  }
  /** Hold the frame with its top at `top`, px of the overview, and ask the reader to go there. */
  const holdFrame = (top: number) => {
    const s = m.current
    const g = geom()
    s.frame = Math.max(0, Math.min(Math.max(0, px$.current - g.frameH), top))
    s.release = null
    s.glide = null
    s.seek = true
    kick()
  }
  /** Let the frame go where it is held: the reader goes there for good, and the frame stays until it has. */
  const letGo = () => {
    const s = m.current
    if (s.frame == null) return
    s.seek = false
    const g = trackGeom(feed.place, px$.current, zpx$.current, s.frame, null)
    calls.current.onSeek(g.f * Math.max(0, 1 - feed.place.height), false)
    s.release = { at: performance.now(), place: feed.place }
    kick()
  }
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    clearPreview()
    const hit = markerAt(e)
    if (hit) return onMark(hit.col.id, hit.tick)
    const y = yIn(e)
    const g = geom()
    const onFrame = y >= g.frameTop && y <= g.frameTop + g.frameH
    grab.current = { dy: onFrame ? y - g.frameTop : g.frameH / 2, y0: e.clientY, moved: false, onFrame }
    capture(e)
  }
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const g = grab.current
    if (!g) return hover(e)
    if (!g.moved && Math.abs(e.clientY - g.y0) < DRAG_PX) return
    if (!g.moved) {
      g.moved = true
      setDragging('frame')
    }
    holdFrame(yIn(e) - g.dy)
  }
  /** A click within SNAP_PX of a thin patch of color (THIN_PX at most): the reader goes to the patch's first record.
   * Whether it snapped. */
  const snapAt = (e: { clientY: number }): boolean => {
    if (!onSnap || !total || px <= 0) return false
    const dpr = window.devicePixelRatio || 1
    const rows = Math.ceil(px * dpr)
    const hit = snapPatch(rowValues(paint, rows), yIn(e) * dpr, Math.round(SNAP_PX * dpr), Math.round(THIN_PX * dpr))
    if (!hit) return false
    const from = Math.max(1, Math.min(total, Math.floor((hit.row / rows) * total) + 1))
    onSnap(from, Math.max(from, Math.min(total, Math.floor(((hit.row + 1) / rows) * total))), hit.value)
    return true
  }
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    const g = grab.current
    grab.current = null
    if (!g) return
    setDragging(null)
    // a click near a patch of color goes to its first record; elsewhere off the frame it sends the frame there, its
    // middle under the pointer
    if (!g.moved) {
      if (snapAt(e) || g.onFrame) return
      const geo = geom()
      const room = Math.max(0, px$.current - geo.frameH)
      const f = room > 0 ? Math.max(0, Math.min(1, (yIn(e) - g.dy) / room)) : 0
      return calls.current.onSeek(f * Math.max(0, 1 - feed.place.height), false)
    }
    letGo()
  }
  const wheel = (e: WheelEvent<HTMLDivElement>) => {
    calls.current.onScrollBy(e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * Math.max(1, px) : e.deltaY)
  }

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

  // ---- the zoomed track: a drag scrolls the reader at its scale, as a scrollbar's thumb does; a press off the lens
  // brings the lens there first
  const zgrab = useRef<{ y0: number; last: number; moved: boolean } | null>(null)
  const zy = (e: { clientY: number }) => e.clientY - (zoomEl.current?.getBoundingClientRect().top ?? 0)
  const onZDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const s = m.current
    const g = geom()
    const y = zy(e)
    zgrab.current = { y0: e.clientY, last: y, moved: false }
    s.lens = g.vTop
    s.glide = null
    // off the lens: the lens's middle comes under the pointer
    if (y < g.vTop - LENS_OUT_PX || y > g.vTop + g.vH + LENS_OUT_PX) s.pull += y - (g.vTop + g.vH / 2)
    setDragging('zoom')
    capture(e)
    kick()
  }
  const onZMove = (e: PointerEvent<HTMLDivElement>) => {
    const g = zgrab.current
    if (!g) return
    if (!g.moved && Math.abs(e.clientY - g.y0) < DRAG_PX) return
    g.moved = true
    const y = zy(e)
    m.current.pull += y - g.last
    g.last = y
    kick()
  }
  const onZUp = () => {
    const g = zgrab.current
    zgrab.current = null
    if (!g) return
    setDragging(null)
    const s = m.current
    if (s.drawn) s.glide = { at: performance.now(), frame: s.drawn.frameTop, vTop: s.drawn.vTop }
    s.lens = null
    kick()
  }

  // every edge on the tracks stands on the device's pixel grid once they are still
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
  const zLanes = records?.find((r) => r.marks.length)?.marks.length ?? 0
  // a record's block, in its color or grey, with a grey tick at its left for each marker lane that marks it, at its
  // place in the reader's content at the zoomed track's scale
  const blocks = useMemo(
    () =>
      (layer: 'faded' | 'shown') =>
        records?.map((r) => {
          const top = snap(r.top * scale, dpr)
          const h = Math.max(1 / dpr, snap(r.bottom * scale, dpr) - top - 1)
          return (
            <i key={r.line} className={'track-rec' + (r.color ? '' : ' plain')} data-line={r.line} title={layer === 'shown' ? r.title : undefined} style={{ top, height: h, ...(r.color ? { background: r.color } : {}) } as CSSProperties}>
              {r.marks.map((mk, i) => (mk ? <b key={i} style={{ left: i * (MARKER_PX + MARKER_GAP_PX) }} /> : null))}
            </i>
          )
        }),
    [records, scale, dpr],
  )
  const faded = useMemo(() => blocks('faded'), [blocks])
  const full = useMemo(() => blocks('shown'), [blocks])
  return (
    <div className="tracks" data-drag={dragging ?? undefined} onWheel={wheel} aria-hidden>
      <div ref={over} className="track track-over" style={{ width: lanesPx + OVER_PX }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onPointerLeave={leave}>
        <OverviewCanvas paint={paint} markers={markers} />
        <div ref={frameEl} className="track-frame-over" />
      </div>
      <svg className="track-link" width={LINK_PX}>
        {hasZoom && px > 0 && (
          <>
            <polygon ref={wedge} />
            <line ref={topLine} data-edge="top" />
            <line ref={bottomLine} data-edge="bottom" />
          </>
        )}
      </svg>
      <div ref={zoomEl} className="track track-zoom" style={{ width: ZOOM_PX + (zLanes ? zLanes * (MARKER_PX + MARKER_GAP_PX) : 0) }} onPointerDown={onZDown} onPointerMove={onZMove} onPointerUp={onZUp} onPointerCancel={onZUp}>
        {hasZoom && (
          <>
            <div className="track-zoom-faded" style={{ opacity: FADE }}>
              <div ref={fadedEl} className="track-zoom-layer">
                {faded}
              </div>
            </div>
            <div ref={lensEl} className="track-lens" style={{ borderRadius: LENS_RADIUS_PX }} />
            <div ref={shownEl} className="track-zoom-shown">
              <div ref={shownInner} className="track-zoom-layer">
                {full}
              </div>
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
