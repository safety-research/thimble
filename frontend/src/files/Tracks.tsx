// The reader's strip at its right edge: the scrollbar's track drawn as the whole file, with a loupe on rest
// (ReaderTracks).
//
// The strip is one track at every length, its lanes the scrollbar's (TRACK_LANES: 7 px lanes 2 px apart, 3 px in from
// its edges): at its left a lane for the find's matches, accent ticks like cue points on a timeline, which go to the
// first match on a click (a marker lane of another kind is drawn in grey, never in a color); then a lane for Color by's
// first choice, each pixel row in the color that most of its records take (a key's commonest value, a label's value most
// of the records there have), never two colors side by side, and a lane in its own colors for each other choice. With
// Color by off and no find the strip is a plain scrollbar. Over the lanes a thumb frames what the reader shows; a drag
// of it scrubs the reader, a click elsewhere on the track sends the thumb there, and a drag from there scrubs on (a
// press moves nothing until the pointer has moved DRAG_PX or let go). A click within SNAP_PX of a thin patch of a color
// (THIN_PX tall at most, a lone record of a value that the strip shows) snaps to it: the reader goes to the patch's
// first record and chooses it as the find does. A jump of the reader (a click, the find) makes the thumb glide to its new
// place. The wheel over the strip scrolls the reader.
//
// Where the strip draws a record shorter than TELL_APART_PX, resting on it opens the loupe beside it (Loupe.tsx): a
// line per record around the pointer, its line number, a cell per lane of the strip in the record's own color, and the
// start of its text (for a transcript, who said it, then the start of the message); the record under the pointer
// darker, those the reader shows tinted, and a bracket beside the strip over the stretch it shows. It follows the
// pointer along the strip, and the scroll position after the wheel over the strip or a drag of the thumb; moved into,
// it holds still, goes to a record on a click, its rows staying where they are, and scrolls the reader on the wheel, its
// rows following. On a touch screen a press on the strip opens it, a drag scrubs and the release goes there. A strip
// that tells every record apart names the record under the pointer on rest instead, on one line: its number, its
// cells, the start of its text.
//
// The reader publishes where it stands each frame it scrolls (PlaceFeed), and one animation frame moves the thumb (and
// an open loupe) with transforms alone: nothing renders in React while the reader scrolls or a drag moves. While it
// moves it stands where it is computed; once still, its edges go onto the device's pixel grid.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent, type WheelEvent } from 'react'
import { Tip } from '../components/Tooltip'
import { useTheme } from '../lib/theme'
import type { Concept, LabelRuler } from '../lib/types'
import { classesOf, colourVar } from './labels'
import { recordLoupe, RowLine, rowKey, useLoupe, type LoupeCell, type LoupeRow } from './Loupe'
import { laneAt, laneBoxes, nearestTick, TRACK_LANES, type RulerColumn, type RulerTick } from './Ruler'

/** px: the strip's width with no lane (a plain scrollbar) */
export const PLAIN_PX = 10
/** px: the thumb's least height over lanes, and on a plain scrollbar */
export const FRAME_MIN_PX = 14
export const PLAIN_FRAME_MIN_PX = 32
/** the grey of a marker's tick other than the find's: only the Color by choice and the find take a color on the strip */
const MARKER_INK = 'rgba(var(--ink-rgb), 0.45)'
/** the find's ticks, in the accent as the find's highlight is, as text so they read on the track on every paper */
const FIND_INK = 'var(--text-accent)'
/** a mark's least height, px */
const MIN_MARK_PX = 2
/** px either side of a marker within which the pointer is on it */
const HIT_PX = 3
/** px the pointer moves before a press becomes a drag */
const DRAG_PX = 3
/** ms the pointer rests on a strip that tells every record apart before the record under it is named */
const NAME_DELAY_MS = 120
/** the records the loupe reads at once, on lines CHUNK apart; how many reads at once, and how many it keeps */
const CHUNK = 100
const CHUNKS_FLYING = 2
const CHUNKS_KEPT = 64

/** What colors a lane of the strip: a key's most frequent value's rank per bin (each rank's color, and whether it is
 * turned off, which leaves its rows without color, as its records are), a label's records per value per bin (each pixel
 * row in the value most of its records have, in its color, none when it is turned off), or the file's density. */
export type OverviewPaint =
  | {
      kind: 'bins'
      at: readonly number[]
      colors: readonly (string | null)[]
      off: readonly boolean[]
    }
  | {
      kind: 'counts'
      /** per value, its records in each bin, every value over the same bins */
      counts: readonly (readonly number[])[]
      colors: readonly string[]
      off: readonly boolean[]
    }
  | { kind: 'density'; bytes: readonly number[] }
  | { kind: 'none' }

/** A record as the loupe and a record's tooltip show it: its line, per color lane its color (null for none), who said
 * it and the start of its text. */
export interface LoupeRecord {
  line: number
  lanes: readonly (string | null)[]
  who: string | null
  text: string
}

/** A record as a preview of it says: who and when, the start of its text, its color. */
export interface PreviewRecord {
  line: number
  who: string | null
  when: string | null
  text: string
  color: string | null
}

/** How far through the file the reader stands, 0 at its top to 1 at its end: its top through the part of the file it
 * can scroll over, as a scrollbar's thumb stands. Pure. */
export function followOf(view: { top: number; height: number }): number {
  const free = 1 - view.height
  return free > 0 ? Math.max(0, Math.min(1, view.top / free)) : 0
}

/** The thumb over the strip for what the reader shows, px of a track `px` tall: as tall as its share of the file and at
 * least `min`, as far down the room the track leaves it as the reader is through the file (followOf), as a scrollbar's
 * thumb stands, so that the thumb at the track's end is the file's end. Pure. */
export function frameOf(view: { top: number; height: number }, px: number, min = FRAME_MIN_PX): { top: number; height: number } {
  const height = Math.min(px, Math.max(min, view.height * px))
  return { top: followOf(view) * Math.max(0, px - height), height }
}

/** Where the reader stands, as it measures it each frame it moves: the share of the file above its top and the share
 * it shows (as Shown), and px of its body: how far it is scrolled, its height and its content's height, and whether the
 * content holds the file's first record and its last. `span` is the share of the file a body's height holds on average
 * over the records loaded (`height` when not given). */
export interface TrackPlace {
  top: number
  height: number
  scroll: number
  h: number
  content: number
  start: boolean
  end: boolean
  span?: number
}

const samePlace = (a: TrackPlace, b: TrackPlace) => a.top === b.top && a.height === b.height && a.scroll === b.scroll && a.h === b.h && a.content === b.content && a.start === b.start && a.end === b.end && a.span === b.span

/** The reader's place, as it publishes it each frame it scrolls: the strip draws it in the same frame with transforms
 * alone, so that a scroll renders nothing of the reader in React. */
export class PlaceFeed {
  place: TrackPlace = { top: 0, height: 1, scroll: 0, h: 0, content: 0, start: true, end: true }
  private heard = new Set<() => void>()
  set(p: TrackPlace): void {
    if (samePlace(p, this.place)) return
    this.place = p
    this.heard.forEach((f) => f())
  }
  on(f: () => void): () => void {
    this.heard.add(f)
    return () => {
      this.heard.delete(f)
    }
  }
}

/** Where the thumb stands for a place on a strip `px` tall: its top and height, and how far through the file that is
 * (`f`, as followOf). A drag holds its top at `frame` px, wherever the reader has got to yet. Pure. */
export function frameGeom(p: { top: number; height: number }, px: number, frame: number | null, min = FRAME_MIN_PX): { frameTop: number; frameH: number; f: number } {
  const frameH = Math.min(px, Math.max(min, p.height * px))
  const room = Math.max(0, px - frameH)
  const f = frame != null ? (room > 0 ? Math.max(0, Math.min(1, frame / room)) : 0) : followOf(p)
  return { frameTop: f * room, frameH, f }
}
type FrameGeom = ReturnType<typeof frameGeom>

/** A length in css px moved onto the device's pixel grid at `dpr`, so that an edge there is drawn sharp. Pure. */
export const snap = (v: number, dpr: number): number => Math.round(v * dpr) / dpr

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

/** The strip's paint for a label that is a Color by choice: per highlighted value of `k`, in its order, its records in
 * each bin of the ruler (its counts; 1 for a bin that holds the value when the ruler gives none), its color, and whether
 * it is turned off (`off`). Null when the ruler has nothing of the label. Pure. */
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
  return { kind: 'counts', counts, colors: lit.map((c) => colourVar(c.color)), off: lit.map((c) => off.has(c.name)) }
}

/** The color a paint gives the bin line `line` of `total` falls in, as the strip draws it: a key's rank's, a label's
 * value most records there have; null for none, a value turned off, or a paint of no colors. What the loupe shows of a
 * record until its own value is read. Pure. */
export function paintAt(p: OverviewPaint, line: number, total: number): string | null {
  const binOf = (bins: number) => Math.max(0, Math.min(bins - 1, Math.floor(((line - 1) / Math.max(1, total)) * bins)))
  if (p.kind === 'bins' && p.at.length) {
    const r = p.at[binOf(p.at.length)]
    if (r < 0 || p.off[Math.min(r, p.off.length - 1)]) return null
    return p.colors[Math.min(r, p.colors.length - 1)] ?? null
  }
  if (p.kind === 'counts' && p.counts.length && p.counts[0].length) {
    const b = binOf(p.counts[0].length)
    let best = -1
    let most = 0
    p.counts.forEach((c, v) => {
      if ((c[b] || 0) > most) {
        most = c[b]
        best = v
      }
    })
    return best >= 0 && !p.off[best] ? p.colors[best] : null
  }
  return null
}

/** The line of a file of `total` lines at a fraction of it. Pure. */
export const lineAt = (f: number, total: number): number => Math.max(1, Math.min(total, Math.floor(Math.max(0, Math.min(1, f)) * total) + 1))

/** Per device pixel row of a track `h` rows tall, the bin of `bins` it shows. Pure. */
export const binOfRow = (y: number, h: number, bins: number): number => Math.max(0, Math.min(bins - 1, Math.floor(((y + 0.5) / h) * bins)))

/** px either side of a click on the strip within which it snaps to a thin patch of color, and the most a patch may be
 * tall to be thin: a click in a taller patch goes where it is clicked */
export const SNAP_PX = 4
export const THIN_PX = 8

/** Per device pixel row of a strip `rows` tall, the value its paint colors the row in (a key's rank, a label's value),
 * as the strip draws it; -1 for a row in no value, in grey or in a value turned off. Pure. */
export function rowValues(paint: OverviewPaint, rows: number): Int32Array {
  const out = new Int32Array(Math.max(0, rows)).fill(-1)
  if (paint.kind === 'bins' && paint.at.length) {
    for (let y = 0; y < rows; y++) {
      const r = paint.at[binOfRow(y, rows, paint.at.length)]
      if (r >= 0 && paint.colors[Math.min(r, paint.colors.length - 1)] && !paint.off[Math.min(r, paint.off.length - 1)]) out[y] = r
    }
  } else if (paint.kind === 'counts' && paint.counts.length) {
    const at = majorityRows(paint.counts, rows)
    for (let y = 0; y < rows; y++) if (at[y] >= 0 && !paint.off[at[y]]) out[y] = at[y]
  }
  return out
}

/** The patch of color a click at device row `y` of a strip snaps to: of `values` (rowValues), the runs of rows in one
 * value at most `thin` rows tall that come within `reach` rows of the click, the nearest (the upper on a tie), as its
 * first row and its value. Null when none does: a click in a taller patch, or far from any, goes where it is. Pure. */
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

/** The strip's width for `n` lanes (markers and colors together), px: the scrollbar's lanes, or a plain scrollbar. */
export const stripWidth = (n: number): number => (n ? n * TRACK_LANES.lane + (n - 1) * TRACK_LANES.gap + 2 * TRACK_LANES.inset : PLAIN_PX)

/** The lanes of colors the strip draws for a paint and the other choices' lanes: none with Color by off. */
export const colorLanes = (paint: OverviewPaint, lanes: number): number => (paint.kind === 'none' && !lanes ? 0 : 1 + lanes)

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

/** One lane of colors drawn from its paint, `x0` to `x0 + cw` device px of a canvas `H` device rows tall: each row in
 * its value's color (none when the value is turned off, as its records have none), or the file's density in the ink. A
 * run of rows in one color shorter than `min` rows (a lone record of a value) is drawn `min` rows tall, centred on its
 * place, over its neighbours, so that the eye finds it. */
function paintLane(ctx: CanvasRenderingContext2D, paint: OverviewPaint, x0: number, cw: number, H: number, min: number, colourOf: (c: string) => string) {
  const runs: [number, number, string][] = []
  if (paint.kind === 'bins' && paint.at.length) {
    const bins = paint.at.length
    let runStart = 0
    let runColour: string | null = null
    for (let y = 0; y <= H; y++) {
      let colour: string | null = null
      if (y < H) {
        const rank = paint.at[binOfRow(y, H, bins)]
        const c = rank >= 0 && !paint.off[Math.min(rank, paint.off.length - 1)] ? paint.colors[Math.min(rank, paint.colors.length - 1)] : null
        colour = c ? colourOf(c) : null
      }
      if (colour !== runColour || y === H) {
        if (runColour) runs.push([runStart, y, runColour])
        runStart = y
        runColour = colour
      }
    }
  } else if (paint.kind === 'counts' && paint.counts.length) {
    // each row in the one value most of its records have
    const at = majorityRows(paint.counts, H)
    let y = 0
    while (y < H) {
      const v = at[y]
      let end = y + 1
      while (end < H && at[end] === v) end++
      if (v >= 0 && !paint.off[v]) runs.push([y, end, colourOf(paint.colors[v])])
      y = end
    }
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
  // the runs as they stand, then the short ones at `min` rows over them
  for (const [a, b, c] of runs) {
    if (b - a < min) continue
    ctx.fillStyle = c
    ctx.fillRect(x0, a, cw, b - a)
  }
  for (const [a, b, c] of runs) {
    if (b - a >= min) continue
    const y = Math.max(0, Math.min(H - min, Math.round((a + b - min) / 2)))
    ctx.fillStyle = c
    ctx.fillRect(x0, y, cw, min)
  }
}

/** The strip's canvas: the marker lanes, then a lane of colors for Color by's first choice and one for each other
 * choice, each on its stripe, in whole device pixels (laneBoxes). */
const StripCanvas = memo(function StripCanvas({ paints, markers }: { paints: readonly OverviewPaint[]; markers: readonly RulerColumn[] }) {
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
    const boxes = laneBoxes(markers.length + paints.length, TRACK_LANES, dpr)
    ctx.fillStyle = colourOf('rgba(var(--ink-rgb), 0.035)')
    for (const [x, cw] of boxes) ctx.fillRect(x, 0, cw, H)
    // the markers: ticks in the accent for the find's matches, grey for another kind, no color of a label's
    markers.forEach((col, i) => {
      const [x, cw] = boxes[i]
      const k = h / Math.max(1, col.total)
      ctx.fillStyle = colourOf(col.id === 'find' ? FIND_INK : MARKER_INK)
      for (const t of col.ticks) {
        const [y0, y1] = drawnSpan(t.from - 1, t.to, k, h)
        const a = Math.round(y0 * dpr)
        ctx.fillRect(x, a, cw, Math.max(1, Math.round(y1 * dpr) - a))
      }
    })
    paints.forEach((p, i) => {
      const [x, cw] = boxes[markers.length + i]
      paintLane(ctx, p, x, cw, H, Math.max(1, Math.round(MIN_MARK_PX * dpr)), colourOf)
    })
  }, [paints, markers, size, theme])
  return <canvas ref={ref} className="track-canvas" />
})

/** A lane of the strip for a choice of Color by past the first: its records in its own colors; `id` the choice's
 * (colorChoice choiceId). */
export interface TrackLane {
  id: string
  name: string
  paint: OverviewPaint
}

const NO_LANES: readonly TrackLane[] = []

interface TracksProps {
  /** the file's lines */
  total: number | null
  /** where the reader stands, which it publishes each frame it moves */
  feed: PlaceFeed
  paint: OverviewPaint
  /** what the first lane of colors shows, which a record's tooltip names */
  paintName?: string
  /** a lane beside it for each other choice of Color by, in its own colors */
  lanes?: readonly TrackLane[]
  /** a lane each, in grey or for the find's matches the accent: the reader gives the find's matches alone */
  markers: readonly RulerColumn[]
  onJump?: (fraction: number) => void
  /** a click on the strip snapped to a patch of color: go to the first record in `value` (a key's rank, a label's
   * value, as the paint gives them) on lines `from` to `to`, where the patch starts; `lane` the choice's id for the lane
   * of a choice past the first, null for the first's */
  onSnap?: (from: number, to: number, value: number, lane: string | null) => void
  /** the fraction of the file at the reader's top to go to; `held` while the pointer still holds the thumb */
  onSeek: (fraction: number, held: boolean) => void
  /** scroll the reader by `px`; how far it went */
  onScrollBy: (px: number) => number
  onMark: (column: string, tick: RulerTick) => void
  /** go to a line and choose its record, as the find does: a click in the loupe, a touch let go */
  onLine?: (line: number) => void
  /** the records on lines `from` to `to` as the loupe and a record's tooltip show them */
  records?: (from: number, to: number) => Promise<LoupeRecord[]>
}

/** The marks of `ticks` (sorted by their lines) on lines `a` to `b`, from the first that ends at `a` or after. Pure. */
export function ticksIn(ticks: readonly RulerTick[], a: number, b: number): RulerTick[] {
  let lo = 0
  let hi = ticks.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (ticks[mid].to < a) lo = mid + 1
    else hi = mid
  }
  const out: RulerTick[] = []
  for (let i = lo; i < ticks.length && ticks[i].from <= b; i++) if (ticks[i].to >= a) out.push(ticks[i])
  return out
}

/** A record as a row of the loupe and its one-line tooltip: its line; a cell per marker lane (its ink where the line
 * holds a mark, `marked`), then per color lane the record's own color once it is read, the strip's color for its
 * stretch, faded, while it is not (`rec` undefined), and none once read without one; who said it and the start of its
 * text. Pure. */
export function recordRow(line: number, total: number, rec: LoupeRecord | null | undefined, marked: readonly (string | null)[], paints: readonly OverviewPaint[]): LoupeRow {
  const cells: (LoupeCell | null)[] = marked.map((c) => (c ? { colour: c } : null))
  paints.forEach((p, j) => {
    if (rec === undefined) {
      const c = paintAt(p, line, total)
      cells.push(c ? { colour: c, faded: true } : null)
    } else {
      const c = rec?.lanes[j]
      cells.push(c ? { colour: c } : null)
    }
  })
  return { num: String(line), cells, who: rec?.who ?? null, text: rec?.text ?? '' }
}

/** ms the thumb takes to go from where a drag left it to where the reader stands */
const GLIDE_MS = 160
/** ms the thumb stays still before its edges go onto the device's pixel grid */
const SETTLE_MS = 60
/** ms a released thumb waits for the reader to move before it goes where the reader stands */
const RELEASE_MS = 400
/** px the thumb moves at once, with nothing held, past which it glides to the reader's new place */
const JUMP_PX = 12
const ease = (t: number) => 1 - Math.pow(1 - Math.max(0, Math.min(1, t)), 3)

type Chunk = ReadonlyMap<number, LoupeRecord> | 'asked' | 'failed'

export function ReaderTracks({ total, feed, paint, paintName, lanes = NO_LANES, markers, onSnap, onSeek, onScrollBy, onMark, onLine, records }: TracksProps) {
  const root = useRef<HTMLDivElement>(null)
  const over = useRef<HTMLDivElement>(null)
  const frameEl = useRef<HTMLDivElement>(null)
  const [px, setPx] = useState(0)
  useEffect(() => {
    const el = over.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setPx(el.clientHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const n = markers.length
  const lanePaints = useMemo(() => lanes.map((l) => l.paint), [lanes])
  const colorN = colorLanes(paint, lanes.length)
  const paints = useMemo(() => (colorN ? [paint, ...lanePaints] : []), [colorN, paint, lanePaints])
  const laneCount = n + colorN
  const minFrame = laneCount ? FRAME_MIN_PX : PLAIN_FRAME_MIN_PX
  const sorted = useMemo(() => markers.map((c) => [...c.ticks].sort((a, b) => a.from - b.from)), [markers])
  const [dragging, setDragging] = useState(false)

  // ---- one animation frame moves the thumb, with transforms only. While it moves it stands where it is computed;
  // once still, its edges go onto the device's pixel grid.
  const m = useRef({
    raf: 0,
    /** the thumb's top while a drag of it holds it, px */
    frame: null as number | null,
    /** a released thumb waits for the reader to move from the place it had then */
    release: null as { at: number; place: TrackPlace } | null,
    /** from where the thumb glides to the reader's place, after a hold ends */
    glide: null as { at: number; frame: number } | null,
    /** the held thumb moved since the reader was last asked to go there */
    seek: false,
    /** inside a call to the reader, which may publish its place at once: that waits for the next frame */
    busy: false,
    /** the share of the file above the reader's top when last drawn, to tell a jump from a scroll */
    top: null as number | null,
    /** the geometry last drawn, and whether on the pixel grid */
    drawn: null as FrameGeom | null,
    written: null as { top: number; h: number } | null,
    snapped: false,
    movedAt: 0,
  })
  const px$ = useRef(0)
  px$.current = px
  const min$ = useRef(minFrame)
  min$.current = minFrame
  const calls = useRef({ onSeek, onScrollBy })
  calls.current = { onSeek, onScrollBy }

  const write = (g: FrameGeom, grid: boolean) => {
    const dpr = window.devicePixelRatio || 1
    const q = (v: number) => (grid ? snap(v, dpr) : v)
    const w = m.current.written
    const top = q(g.frameTop)
    const h = q(g.frameH)
    const fr = frameEl.current
    if (fr) {
      if (!w || w.top !== top) fr.style.transform = `translateY(${top}px)`
      if (!w || w.h !== h) fr.style.height = `${h}px`
    }
    m.current.written = { top, h }
  }

  /** Compute and draw this frame's thumb; whether it still moves. `quiet` (drawn as the reader publishes its place,
   * inside its own frame) asks nothing of the reader. */
  const draw = (now: number, quiet = false): boolean => {
    const s = m.current
    const P = px$.current
    const place = feed.place
    if (P <= 0) return false
    // a released thumb goes where the reader stands once the reader has moved, or after a while
    if (s.release && (place !== s.release.place || now - s.release.at > RELEASE_MS)) {
      if (s.drawn) s.glide = { at: now, frame: s.drawn.frameTop }
      s.frame = null
      s.release = null
    }
    const g = frameGeom(place, P, s.frame, min$.current)
    if (!quiet && s.seek && s.frame != null) {
      s.seek = false
      s.busy = true
      calls.current.onSeek(g.f * Math.max(0, 1 - place.height), true)
      s.busy = false
    }
    // a jump of the reader (a click, the find, a link) with nothing held, past twice what it shows of the file at once
    // where a scroll goes by frames: the thumb glides there
    const d0 = s.drawn
    const jumped = s.top != null && Math.abs(place.top - s.top) > 2 * place.height
    s.top = place.top
    if (jumped && !s.glide && s.frame == null && d0 && Math.abs(d0.frameTop - g.frameTop) > JUMP_PX) s.glide = { at: now, frame: d0.frameTop }
    let shown = g
    if (s.glide) {
      const e = ease((now - s.glide.at) / GLIDE_MS)
      if (e >= 1) s.glide = null
      else shown = { ...g, frameTop: g.frameTop + (s.glide.frame - g.frameTop) * (1 - e) }
    }
    const d = s.drawn
    const moved = !d || Math.abs(d.frameTop - shown.frameTop) > 1e-3 || Math.abs(d.frameH - shown.frameH) > 1e-3
    if (moved) s.movedAt = now
    const still = !moved && !s.glide && s.frame == null && now - s.movedAt >= SETTLE_MS
    if (moved || (still && !s.snapped)) write(shown, still)
    s.drawn = shown
    s.snapped = still
    // an open loupe follows the reader, and the thumb as it glides
    loupe$.current?.moved()
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
        if (!m.current.busy) draw$.current(performance.now(), true)
        kick()
      }),
    [feed, kick],
  )
  // drawn again at once when the strip changes size, so that nothing stands a frame out of place
  useLayoutEffect(() => {
    const s = m.current
    s.written = null
    s.drawn = null
    draw$.current(performance.now())
    kick()
  }, [px, minFrame, kick])
  useEffect(
    () => () => {
      if (m.current.raf) cancelAnimationFrame(m.current.raf)
    },
    [],
  )

  // ---- the records the loupe and a record's tooltip read, CHUNK lines at a time, kept per source
  const chunks = useRef<{ src: TracksProps['records']; map: Map<number, Chunk>; flying: number }>({ src: records, map: new Map(), flying: 0 })
  if (chunks.current.src !== records) chunks.current = { src: records, map: new Map(), flying: 0 }
  const heard = useRef<() => void>(() => {})
  /** The records of lines `a` to `b` that are read, asking for those that are not (a few reads at a time). */
  const recordsIn = (a: number, b: number): ((line: number) => LoupeRecord | null | undefined) => {
    const c = chunks.current
    const T = total ?? 0
    if (c.src && T > 0) {
      for (let k = Math.floor((a - 1) / CHUNK); k <= Math.floor((b - 1) / CHUNK); k++) {
        if (c.map.has(k) || c.flying >= CHUNKS_FLYING) continue
        c.map.set(k, 'asked')
        c.flying++
        const read = c.src
        read(k * CHUNK + 1, Math.min(T, (k + 1) * CHUNK))
          .then((list) => {
            if (chunks.current !== c) return
            c.map.delete(k)
            c.map.set(k, new Map(list.map((r) => [r.line, r])))
            // the oldest dropped past CHUNKS_KEPT
            for (const key of c.map.keys()) {
              if (c.map.size <= CHUNKS_KEPT) break
              if (c.map.get(key) !== 'asked') c.map.delete(key)
            }
          })
          .catch(() => chunks.current === c && c.map.set(k, 'failed'))
          .finally(() => {
            c.flying--
            if (chunks.current === c) heard.current()
          })
      }
    }
    return (line: number) => {
      const got = c.map.get(Math.floor((line - 1) / CHUNK))
      return got && typeof got !== 'string' ? (got.get(line) ?? null) : got === 'failed' ? null : undefined
    }
  }
  /** Per marker lane, its ink where `line` holds a mark of it (the find's in the accent, another kind's in grey). */
  const markedOn = (line: number): (string | null)[] => markers.map((col, i) => (ticksIn(sorted[i], line, line).length ? (col.id === 'find' ? FIND_INK : MARKER_INK) : null))
  /** The rows of lines `a` to `b`, as the loupe and a record's tooltip show them. */
  const rowsOf = (a: number, b: number): LoupeRow[] => {
    const got = recordsIn(a, b)
    const out: LoupeRow[] = []
    for (let line = a; line <= b; line++) out.push(recordRow(line, total ?? 0, got(line), markedOn(line), paints))
    return out
  }

  // ---- the loupe
  const T = total ?? 0
  const rows = records ? recordLoupe(T, px) : 0
  const loupe = useLoupe({
    strip: over,
    bounds: root,
    total: T,
    rows,
    numbered: true,
    pxOf: (u) => (T > 0 ? (u / T) * px$.current : 0),
    unitAt: (y) => (T > 0 ? Math.max(0, Math.min(T, (y / Math.max(1, px$.current)) * T)) : 0),
    thumbMid: () => {
      const d = m.current.drawn
      return d ? d.frameTop + d.frameH / 2 : 0
    },
    view: () => [feed.place.top * T, (feed.place.top + feed.place.height) * T],
    // the unit the thumb stands for as drawn: where a drag holds it or a glide has got to, the reader's place otherwise
    center: () => {
      const d = m.current.drawn
      const h = feed.place.height
      if (!d) return (feed.place.top + h / 2) * T
      const room = px$.current - d.frameH
      return ((room > 0 ? Math.max(0, Math.min(1, d.frameTop / room)) : 0) * Math.max(0, 1 - h) + h / 2) * T
    },
    rowsAt: (start, k) => rowsOf(start + 1, Math.min(T, start + k)),
    act: (i) => onLine?.(Math.max(1, Math.min(T, i + 1))),
    wheel: (d) => calls.current.onScrollBy(d),
  })
  const loupe$ = useRef<typeof loupe | null>(null)
  loupe$.current = loupe
  useEffect(() => loupe$.current?.refresh(), [paints, markers, records])

  // ---- a record named on rest, where the strip tells every record apart
  const [tip, setTip] = useState<{ row: LoupeRow; y: number } | null>(null)
  const named = useRef<{ line: number; y: number } | null>(null)
  const nameTimer = useRef(0)
  const nameAt = () => {
    const at = named.current
    if (!at || !T) return
    setTip({ row: rowsOf(at.line, at.line)[0], y: at.y })
  }
  heard.current = () => {
    loupe$.current?.refresh()
    if (named.current) nameAt()
  }
  const unname = () => {
    window.clearTimeout(nameTimer.current)
    named.current = null
    setTip(null)
  }
  useEffect(() => () => window.clearTimeout(nameTimer.current), [])

  // ---- the thumb and its drag
  const grab = useRef<{ dy: number; y0: number; moved: boolean; onFrame: boolean; touch?: boolean } | null>(null)
  const yIn = (e: { clientY: number }) => e.clientY - (over.current?.getBoundingClientRect().top ?? 0)
  const geom = () => m.current.drawn ?? frameGeom(feed.place, px$.current, null, min$.current)
  const markerAt = (e: { clientX: number; clientY: number }): { col: RulerColumn; tick: RulerTick } | null => {
    const el = over.current
    if (!el || !n) return null
    const r = el.getBoundingClientRect()
    if (r.height <= 0) return null
    const i = laneAt(e.clientX - r.left, TRACK_LANES, laneCount)
    if (i >= n) return null
    const col = markers[i]
    const k = col.total / r.height
    const tick = nearestTick(sorted[i], (e.clientY - r.top) * k, (HIT_PX + MIN_MARK_PX / 2) * k)
    return tick ? { col, tick } : null
  }
  const capture = (e: PointerEvent<HTMLDivElement>) => {
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId)
    } catch {
      /* a pointer the browser no longer tracks: the drag goes on while it stays over the strip */
    }
  }
  /** Hold the thumb with its top at `top`, px of the strip, and ask the reader to go there. */
  const holdFrame = (top: number) => {
    const s = m.current
    const g = geom()
    s.frame = Math.max(0, Math.min(Math.max(0, px$.current - g.frameH), top))
    s.release = null
    s.glide = null
    s.seek = true
    kick()
  }
  /** Let the thumb go where it is held: the reader goes there for good, and the thumb stays until it has. */
  const letGo = () => {
    const s = m.current
    if (s.frame == null) return
    s.seek = false
    const g = frameGeom(feed.place, px$.current, s.frame, min$.current)
    calls.current.onSeek(g.f * Math.max(0, 1 - feed.place.height), false)
    s.release = { at: performance.now(), place: feed.place }
    kick()
  }
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    unname()
    const hit = markerAt(e)
    if (hit) return onMark(hit.col.id, hit.tick)
    const y = yIn(e)
    const g = geom()
    const onFrame = y >= g.frameTop && y <= g.frameTop + g.frameH
    capture(e)
    // a touch off the thumb scrubs with the loupe, where the strip has one
    if (e.pointerType === 'touch' && !onFrame && rows) {
      grab.current = { dy: 0, y0: e.clientY, moved: false, onFrame: false, touch: true }
      loupe.touchStart(e)
      return
    }
    // the thumb held: the loupe at it
    if (onFrame) loupe.thumb()
    grab.current = { dy: onFrame ? y - g.frameTop : g.frameH / 2, y0: e.clientY, moved: false, onFrame }
  }
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const g = grab.current
    if (!g) return hover(e)
    if (g.touch) return loupe.touchMove(e)
    if (!g.moved && Math.abs(e.clientY - g.y0) < DRAG_PX) return
    if (!g.moved) {
      g.moved = true
      setDragging(true)
      if (!g.onFrame) loupe.thumb()
    }
    holdFrame(yIn(e) - g.dy)
  }
  /** A click within SNAP_PX of a thin patch of color (THIN_PX at most): the reader goes to the patch's first record.
   * Whether it snapped. */
  const snapAt = (e: { clientX: number; clientY: number }): boolean => {
    if (!onSnap || !total || px <= 0 || !colorN) return false
    const dpr = window.devicePixelRatio || 1
    const rows = Math.ceil(px * dpr)
    // the lane clicked: the choice's, or another's
    const lane = Math.max(0, laneAt(e.clientX - (over.current?.getBoundingClientRect().left ?? 0), TRACK_LANES, laneCount) - n)
    const hit = snapPatch(rowValues(lane ? lanes[lane - 1].paint : paint, rows), yIn(e) * dpr, Math.round(SNAP_PX * dpr), Math.round(THIN_PX * dpr))
    if (!hit) return false
    const from = Math.max(1, Math.min(total, Math.floor((hit.row / rows) * total) + 1))
    onSnap(from, Math.max(from, Math.min(total, Math.floor(((hit.row + 1) / rows) * total))), hit.value, lane ? lanes[lane - 1].id : null)
    return true
  }
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    const g = grab.current
    grab.current = null
    if (!g) return
    if (g.touch) {
      // let go, the reader goes to the record under the loupe's line
      const u = loupe.touchEnd()
      if (u != null && T > 0) onLine?.(Math.max(1, Math.min(T, Math.floor(u) + 1)))
      return
    }
    setDragging(false)
    if (e.pointerType === 'touch') loupe.close()
    // a click near a patch of color goes to its first record; elsewhere off the thumb it sends the thumb there, its
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
    // a real scroll: an open loupe follows the scroll position
    loupe.wheel()
    calls.current.onScrollBy(e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * Math.max(1, px) : e.deltaY)
  }

  // ---- the hover: the loupe follows the pointer; where the strip has none, the record of a marker under the pointer at
  // once, else the record there on rest
  const hover = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch') return
    if (rows) return loupe.move(e)
    const hit = markerAt(e)
    window.clearTimeout(nameTimer.current)
    if (hit && T) {
      const line = Math.max(1, Math.min(T, hit.tick.from))
      if (named.current?.line !== line) {
        named.current = { line, y: e.clientY }
        nameAt()
      }
      return
    }
    if (!records || !T || px <= 0) return setTip(null)
    const line = lineAt(yIn(e) / px, T)
    const y = e.clientY
    if (named.current?.line === line) return
    setTip((t) => (t ? { ...t, y } : t))
    nameTimer.current = window.setTimeout(() => {
      named.current = { line, y }
      nameAt()
    }, NAME_DELAY_MS)
  }
  const enter = (e: PointerEvent<HTMLDivElement>) => loupe.enter(e)
  const leave = (e: PointerEvent<HTMLDivElement>) => {
    unname()
    loupe.leave(e)
  }
  const tipY = tip?.y
  const tipPlace = useCallback(
    (w: number, h: number) => {
      const r = root.current?.getBoundingClientRect()
      const y = tipY ?? 0
      return { left: Math.max(8, (r?.left ?? 0) - 8 - w), top: Math.max(8, Math.min(window.innerHeight - 8 - h, y - h / 2)) }
    },
    [tipY],
  )

  const names = [paintName ?? '', ...lanes.map((l) => l.name)]
  return (
    <div ref={root} className="tracks" data-drag={dragging || undefined} onWheel={wheel} aria-hidden>
      <div ref={over} className={'track track-over' + (laneCount ? '' : ' plain')} style={{ width: stripWidth(laneCount) }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onPointerEnter={enter} onPointerLeave={leave}>
        {laneCount > 0 && <StripCanvas paints={paints} markers={markers} />}
        {colorN > 1 && names.map((name, i) => <span key={i} className="track-lane" data-name={name || undefined} style={{ left: TRACK_LANES.inset + (n + i) * (TRACK_LANES.lane + TRACK_LANES.gap), width: TRACK_LANES.lane }} />)}
        <div ref={frameEl} className="track-frame-over" />
      </div>
      <div ref={loupe.bracket} className="loupe-bracket" />
      {loupe.element}
      {tip && (
        <Tip text={rowKey(tip.row)} place={tipPlace} className="tip-one reader-ruler-tip">
          <RowLine row={tip.row} />
        </Tip>
      )}
    </div>
  )
}
