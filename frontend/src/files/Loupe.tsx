// The loupe beside a ruler's one strip: Files' reader (Tracks.tsx ReaderTracks) and the Report (Ruler.tsx ReaderRuler).
//
// The strip draws the whole file in the scrollbar's track at every length, with a thumb over what is on screen. Where it
// can no longer tell the records apart, resting the pointer on it for LOUPE_REST_MS opens the loupe beside it: the
// records around the pointer at a few px each, a lane per lane of the strip, the line every 10 records, the records on
// screen tinted with a bar beside them, and beside the strip a bracket over the stretch the loupe shows. The loupe follows
// the pointer along the strip. When the reader scrolls (the wheel, the keys, a jump, a drag of the thumb) it moves to the
// thumb and shows the records around what is on screen. Moved into, it holds still: hovering a record names it in
// thimble's tooltip, a click goes there, and the wheel scrolls the reader while the loupe keeps its place and its records
// follow. On a touch screen a press on the strip opens it, a drag scrubs, and the release goes there.
//
// The host draws the strip and says what the loupe shows (LoupeSource); useLoupe draws the loupe on a canvas in the
// frame the host calls it in, so that it follows a scroll without a render.
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Tip } from '../components/Tooltip'
import { useTheme } from '../lib/theme'

/** ms the pointer is on the strip before the loupe opens */
export const LOUPE_REST_MS = 250
/** px: the loupe's records together, at most */
export const LOUPE_PX = 216
/** px a record takes in the loupe, at the least */
export const LOUPE_ROW_PX = 3
/** px a record takes in the loupe, at the most */
const LOUPE_ROW_MAX_PX = 6
/** px of the loupe's paper above and below its records */
export const LOUPE_PAD_PX = 8
/** px: a lane's width and the gap after it, as the strip's */
export const LOUPE_LANE_PX = 7
export const LOUPE_GAP_PX = 2
/** px between the loupe and the strip, which the pointer crosses into it */
export const LOUPE_OFF_PX = 8
/** px: the loupe's paper left of the line numbers, and right of the lanes */
const EDGE_PX = 8
/** px from the line numbers' right edge to the bar over what is on screen, and from it to the lanes */
const NUM_GAP_PX = 8
const BAR_GAP_PX = 4
/** px the loupe stays inside the box it opens over */
const INSET_PX = 4
/** px: the bracket's width, beside the strip on the loupe's side */
const BRACKET_PX = 4

/** A mark in a lane of the loupe: the units from `from` (exclusive) to `to`, its colour; `faded` while only the strip's
 * own resolution is known there. */
export interface LoupeMark {
  from: number
  to: number
  colour: string
  faded?: boolean
}

export interface LoupeLane {
  marks: readonly LoupeMark[]
}

/** What the pointer is on in a held loupe: the units it spans (boxed), its tooltip, and the click's action. */
export interface LoupePick {
  from: number
  to: number
  text: string
  act: () => void
}

/** What the host gives the loupe, read each time it draws. Units are the strip's: a file's lines from 0 (a record on
 * line l is the units l − 1 to l), or a page's px. */
export interface LoupeSource {
  /** the strip, whose left edge the loupe opens beside and whose top `unitAt`, `pxOf` and `thumbMid` measure from */
  strip: RefObject<HTMLElement | null>
  /** the box the loupe stays within, top to bottom */
  bounds: RefObject<HTMLElement | null>
  total: number
  /** the units the loupe shows, 0 for no loupe (the strip tells every record apart) */
  units: number
  /** px a unit takes in the loupe */
  rowPx: number
  /** units are records: on whole units, numbered every 10, a line of the paper between them */
  records: boolean
  /** a unit's place on the strip, px from its top, and the unit at a place */
  pxOf: (unit: number) => number
  unitAt: (px: number) => number
  /** the middle of the thumb, px from the strip's top */
  thumbMid: () => number
  /** the units on screen */
  view: () => readonly [number, number]
  /** the unit the thumb stands for, which the loupe shows around once the reader scrolls: where a drag holds it, ahead
   * of the reader; the middle of what is on screen by default */
  center?: () => number
  /** the loupe's lanes for the units from `start` to `start + units` */
  lanes: (start: number, units: number) => readonly LoupeLane[]
  /** what is at a unit in a lane of a held loupe (null for a point left of the lanes) */
  pick: (unit: number, lane: number | null) => LoupePick | null
  /** the wheel over a held loupe, px down */
  wheel: (px: number) => void
}

/** The units a loupe shows for records on a strip `px` tall over `total` of them, and the px each takes: none while the
 * strip draws each LOUPE_ROW_PX tall or taller, else LOUPE_PX of them at twice the strip's size, LOUPE_ROW_PX to
 * LOUPE_ROW_MAX_PX each. Pure. */
export function recordLoupe(total: number, px: number): { units: number; rowPx: number } {
  if (total <= 0 || px <= 0) return { units: 0, rowPx: LOUPE_ROW_PX }
  const k = px / total
  if (k >= LOUPE_ROW_PX) return { units: 0, rowPx: LOUPE_ROW_PX }
  const rowPx = Math.max(LOUPE_ROW_PX, Math.min(LOUPE_ROW_MAX_PX, Math.ceil(2 * k)))
  return { units: Math.min(total, Math.floor(LOUPE_PX / rowPx)), rowPx }
}

/** The first unit a loupe of `units` shows around `center`, kept within `total`, on a whole unit for records. Pure. */
export function loupeStart(center: number, total: number, units: number, records: boolean): number {
  const s = records ? Math.round(center) - Math.floor(units / 2) : center - units / 2
  return Math.max(0, Math.min(Math.max(0, total - units), s))
}

/** The loupe's top, px in the viewport, for its middle at `y`, kept within `lo` to `hi`. Pure. */
export const loupeTop = (y: number, height: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi - height, y - height / 2))

/** The bracket on a strip `h` px tall over the stretch from `top` to `bottom` px: at least `min` px tall, centred on the
 * stretch, kept on the strip. Pure. */
export function bracketOf(top: number, bottom: number, h: number, min = 4): { top: number; height: number } {
  const height = Math.max(min, bottom - top)
  return { top: Math.max(0, Math.min(h - height, (top + bottom) / 2 - height / 2)), height }
}

/** The loupe's layout in css px for `lanes` lanes, `units` of `rowPx` each, and line numbers `numW` px wide (0 without):
 * where the numbers end, where the bar over what is on screen and the lanes start, and its size. Pure. */
export function loupeLayout(lanes: number, units: number, rowPx: number, numW: number): { numX: number; barX: number; laneX: number; width: number; height: number } {
  const numX = EDGE_PX + numW
  const barX = numW ? numX + NUM_GAP_PX : EDGE_PX
  const laneX = barX + 2 + BAR_GAP_PX
  const n = Math.max(1, lanes)
  return { numX, barX, laneX, width: laneX + n * LOUPE_LANE_PX + (n - 1) * LOUPE_GAP_PX + EDGE_PX, height: units * rowPx + 2 * LOUPE_PAD_PX }
}

/** The lane under a point `x` css px from the loupe's left edge, null left of the lanes. Pure. */
export function loupeLaneAt(x: number, laneX: number, lanes: number): number | null {
  if (x < laneX - LOUPE_GAP_PX) return null
  return Math.max(0, Math.min(Math.max(0, lanes - 1), Math.floor((x - laneX + LOUPE_GAP_PX / 2) / (LOUPE_LANE_PX + LOUPE_GAP_PX))))
}

const fmt = (n: number) => Math.round(n).toLocaleString('en-US')

interface State {
  open: boolean
  frozen: boolean
  /** what the loupe shows around: the pointer on the strip, or what is on screen once the reader scrolls */
  anchor: 'pointer' | 'view'
  /** the unit under the pointer, and the first unit shown */
  c: number
  start: number
  timer: number
  /** the pointer's last height on the strip, px in the viewport */
  lastY: number
  /** the units on screen when last drawn, to tell a scroll */
  seen: readonly [number, number] | null
  /** the pointer in a held loupe, px in the viewport */
  at: { x: number; y: number } | null
  pick: LoupePick | null
  tip: { text: string; y: number } | null
  /** the thumb's middle when last drawn at it */
  thumb: number
}

export interface Loupe {
  /** the loupe and its tooltip, for the host to render anywhere (they portal to the body) */
  element: ReactNode
  /** the bracket the host puts beside its strip, in the same positioned box */
  bracket: RefObject<HTMLDivElement | null>
  enter: (e: { clientY: number; pointerType?: string }) => void
  move: (e: { clientY: number; pointerType?: string }) => void
  leave: (e: { relatedTarget: EventTarget | null }) => void
  /** the host's place changed (a scroll, a drag, a jump): an open loupe goes to the thumb once the reader has moved */
  moved: () => void
  /** a press on the thumb: the loupe opens at it */
  thumb: () => void
  /** a touch press on the strip, its drag, and its release, which gives the unit under the loupe's line */
  touchStart: (e: { clientY: number }) => void
  touchMove: (e: { clientY: number }) => void
  touchEnd: () => number | null
  /** draw again, the host's lanes having changed */
  refresh: () => void
  close: () => void
  isOpen: () => boolean
}

/** The loupe beside the strip `source` describes (see the top of this file). */
export function useLoupe(source: LoupeSource): Loupe {
  const src = useRef(source)
  src.current = source
  const box = useRef<HTMLDivElement>(null)
  const cv = useRef<HTMLCanvasElement>(null)
  const bracket = useRef<HTMLDivElement>(null)
  const theme = useTheme().key
  const theme$ = useRef(theme)
  theme$.current = theme
  const colours = useRef(new Map<string, string>())
  const font = useRef({ key: '', family: 'monospace', numW: 0 })
  const s = useRef<State>({ open: false, frozen: false, anchor: 'pointer', c: 0, start: 0, timer: 0, lastY: 0, seen: null, at: null, pick: null, tip: null, thumb: NaN })
  const [tip, setTip] = useState<{ text: string; y: number } | null>(null)

  const colourOf = (c: string): string => {
    const el = cv.current
    if (!el) return c
    let v = colours.current.get(c)
    if (v == null) {
      el.style.color = c
      v = getComputedStyle(el).color
      colours.current.set(c, v)
    }
    return v
  }
  const height = () => src.current.units * src.current.rowPx + 2 * LOUPE_PAD_PX
  /** Where the strip and the box the loupe stays within stand, read once per draw before anything is written, so that
   * a draw in the reader's scroll frame lays the page out once. */
  const measure = () => {
    const strip = src.current.strip.current
    if (!strip) return null
    const r = strip.getBoundingClientRect()
    const b = src.current.bounds.current?.getBoundingClientRect() ?? r
    return { left: r.left, top: r.top, lo: b.top + INSET_PX, hi: b.bottom - INSET_PX, offL: strip.offsetLeft, offT: strip.offsetTop, w: strip.offsetWidth, h: strip.clientHeight }
  }
  const written = useRef({ right: '', top: '', bracket: '' })
  /** The loupe's middle at `y`, px in the viewport, beside the strip. */
  const place = (y: number, g = measure()) => {
    const el = box.current
    if (!el || !g) return
    const right = `${window.innerWidth - g.left}px`
    const top = `${loupeTop(y, height(), g.lo, g.hi)}px`
    if (written.current.right !== right) el.style.right = written.current.right = right
    if (written.current.top !== top) el.style.top = written.current.top = top
  }
  const stripTop = () => src.current.strip.current?.getBoundingClientRect().top ?? 0
  const aim = (unit: number) => {
    const { total, units, records } = src.current
    const S = s.current
    S.c = Math.max(0, Math.min(total - 1e-6, unit))
    S.start = loupeStart(S.c, total, units, records)
  }
  const aimView = () => {
    const [a, b] = src.current.view()
    aim(src.current.center?.() ?? (a + b) / 2)
  }
  const showTip = (t: { text: string; y: number } | null) => {
    const S = s.current
    if (S.tip === t || (S.tip && t && S.tip.text === t.text && S.tip.y === t.y)) return
    S.tip = t
    setTip(t)
  }

  const draw = () => {
    const S = s.current
    const el = cv.current
    const ctx = el?.getContext('2d')
    if (!S.open || !el || !ctx) return
    const { units, rowPx, records, total } = src.current
    const G = measure()
    if (S.anchor === 'view') {
      aimView()
      if (!S.frozen && G) place(G.top + src.current.thumbMid(), G)
    }
    const lanes = src.current.lanes(S.start, units)
    const view = src.current.view()
    S.seen = view
    const dpr = window.devicePixelRatio || 1
    // the numbers' type and width, read once per theme and length
    const key = `${theme$.current}|${total}`
    if (font.current.key !== key) {
      const family = getComputedStyle(el).fontFamily || 'monospace'
      ctx.font = `10px ${family}`
      font.current = { key, family, numW: Math.ceil(ctx.measureText(fmt(total)).width) }
    }
    const { family } = font.current
    const numW = records ? font.current.numW : 0
    const L = loupeLayout(lanes.length, units, rowPx, numW)
    const w = Math.ceil(L.width * dpr)
    const h = Math.ceil(L.height * dpr)
    if (el.width !== w || el.height !== h) {
      el.width = w
      el.height = h
      el.style.width = `${w / dpr}px`
      el.style.height = `${h / dpr}px`
    }
    // the pointer in a held loupe: the record or mark under it
    let pick: LoupePick | null = null
    if (S.frozen && S.at) {
      const r = el.getBoundingClientRect()
      const u = S.start + (S.at.y - r.top - LOUPE_PAD_PX) / rowPx
      if (u >= S.start && u < Math.min(total, S.start + units)) pick = src.current.pick(u, loupeLaneAt(S.at.x - r.left, L.laneX, lanes.length))
    }
    S.pick = pick
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, L.width, L.height)
    ctx.font = `10px ${family}`
    const rows = units * rowPx
    const top = LOUPE_PAD_PX
    const yOf = (u: number) => top + (u - S.start) * rowPx
    const clampY = (y: number) => Math.max(top, Math.min(top + rows, y))
    const n = Math.max(1, lanes.length)
    const lanesW = n * LOUPE_LANE_PX + (n - 1) * LOUPE_GAP_PX
    const laneLeft = (i: number) => L.laneX + i * (LOUPE_LANE_PX + LOUPE_GAP_PX)
    ctx.fillStyle = colourOf('rgba(var(--ink-rgb), 0.04)')
    for (let i = 0; i < n; i++) ctx.fillRect(laneLeft(i), top, LOUPE_LANE_PX, rows)
    // the records on screen, tinted across the lanes
    const a = clampY(yOf(view[0]))
    const b = clampY(yOf(view[1]))
    if (b - a > 0.5) {
      ctx.fillStyle = colourOf('rgba(var(--ink-rgb), 0.07)')
      ctx.fillRect(L.laneX - 2, a, lanesW + 4, b - a)
    }
    lanes.forEach((lane, i) => {
      const x = laneLeft(i)
      for (const m of lane.marks) {
        let y0 = yOf(m.from)
        let y1 = yOf(m.to)
        // a line of the paper between records, and between marks, once they are tall enough to keep one
        if (records ? rowPx >= 3 : y1 - y0 >= 3) y1 -= 1
        if (!records && y1 - y0 < 2) {
          const mid = (y0 + y1) / 2
          y0 = mid - 1
          y1 = mid + 1
        }
        y0 = clampY(y0)
        y1 = clampY(y1)
        if (y1 - y0 <= 0) continue
        ctx.globalAlpha = m.faded ? 0.35 : 1
        ctx.fillStyle = colourOf(m.colour)
        ctx.fillRect(x, y0, LOUPE_LANE_PX, y1 - y0)
      }
    })
    ctx.globalAlpha = 1
    // the line every 10 records
    if (records) {
      ctx.fillStyle = colourOf('var(--text-tertiary)')
      ctx.textAlign = 'right'
      ctx.textBaseline = 'middle'
      const last = Math.min(total, S.start + units)
      for (let line = Math.ceil((S.start + 1) / 10) * 10; line <= last; line += 10) {
        const y = yOf(line - 0.5)
        ctx.fillText(fmt(line), L.numX, y)
        ctx.fillRect(L.numX + 2, y - 0.5, 4, 1)
      }
    }
    // the bar beside what is on screen
    if (b - a > 0.5) {
      ctx.fillStyle = colourOf('rgba(var(--ink-rgb), 0.55)')
      ctx.fillRect(L.barX, a, 2, b - a)
    }
    if (!S.frozen && S.anchor === 'pointer') {
      // the line at the pointer's place
      ctx.fillStyle = colourOf('rgba(var(--ink-rgb), 0.8)')
      ctx.fillRect(L.laneX - 3, Math.round(yOf(S.c) * dpr) / dpr - 0.5, lanesW + 6, 1)
    } else if (pick) {
      ctx.strokeStyle = colourOf('rgba(var(--ink-rgb), 0.85)')
      ctx.lineWidth = 1
      ctx.strokeRect(L.laneX - 2.5, yOf(pick.from) - 1.5, lanesW + 5, Math.max(1, (pick.to - pick.from) * rowPx) + 2)
    }
    // the bracket beside the strip over the stretch the loupe shows
    const br = bracket.current
    if (br && G) {
      const g = bracketOf(src.current.pxOf(S.start), src.current.pxOf(Math.min(total, S.start + units)), G.h)
      const at = `${G.offL}|${G.offT + g.top}|${g.height}`
      if (written.current.bracket !== at) {
        written.current.bracket = at
        br.style.left = `${G.offL - BRACKET_PX - 1}px`
        br.style.transform = `translateY(${G.offT + g.top}px)`
        br.style.height = `${g.height}px`
      }
      if (!('open' in br.dataset)) br.dataset.open = ''
    }
    showTip(pick && S.at ? { text: pick.text, y: S.at.y } : null)
  }

  const show = (frozen: boolean) => {
    const S = s.current
    S.open = true
    S.frozen = frozen
    const el = box.current
    if (!el) return
    el.dataset.open = ''
    if (frozen) el.dataset.frozen = ''
    else delete el.dataset.frozen
  }
  const openAt = (y: number) => {
    const S = s.current
    if (!src.current.units) return
    S.anchor = 'pointer'
    S.at = null
    show(false)
    S.seen = src.current.view()
    aim(src.current.unitAt(y - stripTop()))
    place(y)
    draw()
  }
  const openAtView = () => {
    const S = s.current
    if (!src.current.units) return
    S.anchor = 'view'
    S.at = null
    show(false)
    draw()
  }
  const close = useCallback(() => {
    const S = s.current
    window.clearTimeout(S.timer)
    S.timer = 0
    S.open = false
    S.frozen = false
    S.at = null
    S.pick = null
    const el = box.current
    if (el) {
      delete el.dataset.open
      delete el.dataset.frozen
    }
    if (bracket.current) delete bracket.current.dataset.open
    if (S.tip) {
      S.tip = null
      setTip(null)
    }
  }, [])

  // a theme's colours, read again; a loupe that can no longer open closes
  useEffect(() => {
    colours.current.clear()
    draw()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme])
  useEffect(() => {
    if (!source.units) close()
  }, [source.units, close])
  useEffect(() => close, [close])
  // the wheel over the loupe scrolls the reader
  useEffect(() => {
    const el = box.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      src.current.wheel(e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * window.innerHeight : e.deltaY)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const onBoxMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const S = s.current
    if (!S.frozen) return
    S.at = { x: e.clientX, y: e.clientY }
    draw()
  }
  const onBoxLeave = (e: ReactPointerEvent<HTMLDivElement>) => {
    const strip = src.current.strip.current
    if (strip && e.relatedTarget instanceof Node && strip.contains(e.relatedTarget)) return
    close()
  }
  const onBoxClick = () => {
    const S = s.current
    if (S.frozen && S.pick) S.pick.act()
  }
  const tipY = tip?.y
  const tipPlace = useCallback(
    (w: number, h: number) => {
      const r = box.current?.firstElementChild?.getBoundingClientRect()
      return { left: Math.max(8, (r?.left ?? 0) - 8 - w), top: Math.max(8, Math.min(window.innerHeight - 8 - h, (tipY ?? 0) - h / 2)) }
    },
    [tipY],
  )

  const element = (
    <>
      {createPortal(
        <div ref={box} className="loupe" style={{ paddingRight: LOUPE_OFF_PX }} onPointerMove={onBoxMove} onPointerLeave={onBoxLeave} onClick={onBoxClick} aria-hidden>
          <div className="loupe-box overlay">
            <canvas ref={cv} />
          </div>
        </div>,
        document.body,
      )}
      {tip && <Tip text={tip.text} place={tipPlace} className="tip-lines loupe-tip" />}
    </>
  )

  return {
    element,
    bracket,
    enter: (e) => {
      if (e.pointerType === 'touch' || !src.current.units) return
      const S = s.current
      S.lastY = e.clientY
      if (S.open) {
        // back from the loupe: it follows the pointer again
        S.frozen = false
        S.at = null
        if (box.current) delete box.current.dataset.frozen
        S.anchor = 'pointer'
        aim(src.current.unitAt(e.clientY - stripTop()))
        place(e.clientY)
        draw()
        return
      }
      window.clearTimeout(S.timer)
      S.timer = window.setTimeout(() => {
        S.timer = 0
        openAt(S.lastY)
      }, LOUPE_REST_MS)
    },
    move: (e) => {
      if (e.pointerType === 'touch') return
      const S = s.current
      S.lastY = e.clientY
      if (!S.open || S.frozen) return
      S.anchor = 'pointer'
      aim(src.current.unitAt(e.clientY - stripTop()))
      place(e.clientY)
      draw()
    },
    leave: (e) => {
      const S = s.current
      window.clearTimeout(S.timer)
      S.timer = 0
      if (S.open && box.current && e.relatedTarget instanceof Node && box.current.contains(e.relatedTarget)) {
        S.frozen = true
        box.current.dataset.frozen = ''
        draw()
        return
      }
      close()
    },
    moved: () => {
      const S = s.current
      if (!S.open) return
      const v = src.current.view()
      const scrolled = !S.seen || Math.abs(v[0] - S.seen[0]) > 1e-9 || Math.abs(v[1] - S.seen[1]) > 1e-9
      const thumb = src.current.thumbMid()
      // drawn again only when the reader or the thumb moved: the host calls this each frame it draws
      if (!scrolled && S.anchor === 'view' && thumb === S.thumb) return
      if (scrolled && S.seen) S.anchor = 'view'
      S.thumb = thumb
      if (S.anchor === 'view') draw()
    },
    thumb: () => {
      window.clearTimeout(s.current.timer)
      s.current.timer = 0
      openAtView()
    },
    touchStart: (e) => openAt(e.clientY),
    touchMove: (e) => {
      const S = s.current
      if (!S.open) return
      S.anchor = 'pointer'
      aim(src.current.unitAt(e.clientY - stripTop()))
      place(e.clientY)
      draw()
    },
    touchEnd: () => {
      const S = s.current
      const u = S.open ? S.c : null
      close()
      return u
    },
    refresh: () => draw(),
    close,
    isOpen: () => s.current.open,
  }
}
