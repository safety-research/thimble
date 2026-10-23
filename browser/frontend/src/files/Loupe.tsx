// The loupe beside a ruler's one strip: Files' reader (Tracks.tsx ReaderTracks) and the Report (Ruler.tsx ReaderRuler).
//
// The strip draws the whole file in the scrollbar's track at every length, with a thumb over what is on screen. Where it
// can no longer tell the records apart, resting the pointer on it for LOUPE_REST_MS opens the loupe beside it: a short
// list, a line per record (a file's record, a report's passage), each its whole number, a small cell per lane of the
// strip in the record's color, its metadata (such as its time and who said it) in the quiet gray and the start of its
// text in the ink, the text alone giving up room; the record under the pointer darker, those on screen lightly tinted;
// and beside the strip a bracket over the stretch the list shows.
//
// What the list shows follows one of three anchors (anchorAfter): 'pointer', the records around the pointer while it
// moves along the strip; 'view', those around the scroll position, only after a real scroll (the wheel over the strip
// or the loupe, a drag of the thumb); 'fixed', what it shows, once the pointer moves into it or clicks in it, so that its
// rows stay under the pointer. The reader's place changing never changes the anchor: a browser rounds scroll positions,
// so a loupe that told a scroll from them jumped back to the thumb. In the loupe a click goes to the record under the
// pointer and leaves the rows where they are, and the wheel scrolls the reader while the loupe keeps its place and its
// rows follow. On a touch screen a press on the strip opens it, a drag scrubs, and the release goes there.
//
// The host draws the strip and says what the loupe shows (LoupeSource); useLoupe writes the rows into the page in the
// frame the host calls it in, so that it follows a scroll without a render.
import { useCallback, useEffect, useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useTheme } from '../lib/theme'

/** ms the pointer is on the strip before the loupe opens */
export const LOUPE_REST_MS = 250
/** the loupe's rows at most, and px each */
export const LOUPE_ROWS = 17
export const LOUPE_ROW_PX = 16
/** px of the loupe's paper above and below its rows */
export const LOUPE_PAD_PX = 4
/** px between the loupe and the strip, which the pointer crosses into it */
export const LOUPE_OFF_PX = 8
/** px a record takes on the strip below which the strip cannot tell the records apart, and the loupe opens */
export const TELL_APART_PX = 3
/** px: the loupe's width at the least and at the most, and the room it leaves beside it */
const MIN_W = 200
const MAX_W = 320
const ROOM_PX = 24
/** px the loupe stays inside the box it opens over */
const INSET_PX = 4
/** px: the bracket's width, beside the strip on the loupe's side */
const BRACKET_PX = 4
/** the characters of a record's text the loupe writes; its row cuts the rest with an ellipsis */
const TEXT_CHARS = 200
/** the characters of each of a record's metadata the loupe writes, cut with an ellipsis */
const META_CHARS = 32

/** A cell of a row: a lane's color for the record; `faded` while only the strip's color for its stretch is known. */
export interface LoupeCell {
  colour: string
  faded?: boolean
}

/** A record as a row of the loupe and a one-line tooltip show it: its number (none in the report), a cell per lane of
 * the strip (null for none), its metadata (such as its time and who said it, in the quiet gray before the text) and
 * the start of its text. */
export interface LoupeRow {
  num: string | null
  cells: readonly (LoupeCell | null)[]
  meta: readonly string[]
  text: string
  /** a heading of the report, its text in the heavier weight */
  heading?: boolean
}

/** What the loupe follows: the pointer on the strip, the scroll position, or what it shows. */
export type LoupeAnchor = 'pointer' | 'view' | 'fixed'
/** What moves the loupe: the pointer along the strip, a wheel over the strip or the loupe, a drag of the thumb, the
 * pointer into the loupe, a click in it, or the reader's place changing by itself. */
export type LoupeEvent = 'strip' | 'wheel' | 'thumb' | 'into' | 'click' | 'scroll'

/** The anchor after an event: the pointer along the strip follows the pointer; a wheel or a drag of the thumb, the
 * scroll position; the pointer into the loupe or a click in it keeps what it shows; the reader's place changing by
 * itself keeps the anchor it had. Pure. */
export function anchorAfter(anchor: LoupeAnchor, ev: LoupeEvent): LoupeAnchor {
  if (ev === 'strip') return 'pointer'
  if (ev === 'wheel' || ev === 'thumb') return 'view'
  if (ev === 'into' || ev === 'click') return 'fixed'
  return anchor
}

/** What the host gives the loupe, read each time it draws. Units are records from 0 (record i is the unit i to i + 1),
 * fractions of them between. */
export interface LoupeSource {
  /** the strip, whose left edge the loupe opens beside and whose top `unitAt`, `pxOf` and `thumbMid` measure from */
  strip: RefObject<HTMLElement | null>
  /** the box the loupe stays within, top to bottom; its parent's left edge is as far left as the loupe reaches */
  bounds: RefObject<HTMLElement | null>
  /** the records */
  total: number
  /** the rows the loupe shows, 0 for no loupe (the strip tells every record apart) */
  rows: number
  /** the rows carry numbers (a file's lines), as wide as the widest */
  numbered: boolean
  /** a unit's place on the strip, px from its top, and the unit at a place */
  pxOf: (unit: number) => number
  unitAt: (px: number) => number
  /** the middle of the thumb, px from the strip's top */
  thumbMid: () => number
  /** the units on screen */
  view: () => readonly [number, number]
  /** the unit the thumb stands for, which the loupe shows around after a scroll: where a drag holds it, ahead of the
   * reader; the middle of what is on screen by default */
  center?: () => number
  /** the rows for records `start` to `start + n` */
  rowsAt: (start: number, n: number) => readonly LoupeRow[]
  /** a click on record `i` in the loupe */
  act: (i: number) => void
  /** the wheel over the loupe, px down */
  wheel: (px: number) => void
}

/** The rows a loupe shows over `total` records on a strip `px` tall: none while the strip draws each TELL_APART_PX tall
 * or taller, else LOUPE_ROWS (all of them for fewer). Pure. */
export function recordLoupe(total: number, px: number): number {
  if (total <= 0 || px <= 0 || px / total >= TELL_APART_PX) return 0
  return Math.min(total, LOUPE_ROWS)
}

/** The first record a loupe of `rows` shows around the unit `center`: its record in the middle row, kept within
 * `total`. Pure. */
export function loupeStart(center: number, total: number, rows: number): number {
  return Math.max(0, Math.min(Math.max(0, total - rows), Math.floor(center) - Math.floor(rows / 2)))
}

/** The loupe's height for `rows` rows, px: the rows, the paper above and below them, its 1 px edge. Pure. */
export const loupeHeight = (rows: number): number => rows * LOUPE_ROW_PX + 2 * LOUPE_PAD_PX + 2

/** The loupe's width, px, with `room` px beside the strip: what that leaves, MIN_W to MAX_W. Pure. */
export const loupeWidth = (room: number): number => Math.max(MIN_W, Math.min(MAX_W, room - ROOM_PX))

/** The loupe's top, px in the viewport, for its middle at `y`, kept within `lo` to `hi`. Pure. */
export const loupeTop = (y: number, height: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi - height, y - height / 2))

/** Whether record `i` is on screen, for the units `view` on screen. Pure. */
export const onScreen = (i: number, view: readonly [number, number]): boolean => i + 1 > view[0] && i < view[1]

/** The bracket on a strip `h` px tall over the stretch from `top` to `bottom` px: at least `min` px tall, centred on the
 * stretch, kept on the strip. Pure. */
export function bracketOf(top: number, bottom: number, h: number, min = 4): { top: number; height: number } {
  const height = Math.max(min, bottom - top)
  return { top: Math.max(0, Math.min(h - height, (top + bottom) / 2 - height / 2)), height }
}

/** A record's text on one line: its spaces as one, cut to `max` characters with an ellipsis. Pure. */
export function oneLine(text: string, max = TEXT_CHARS): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** A record as a one-line tooltip shows it: its number, a cell per lane that colors it, its metadata and the start of
 * its text (components/Tooltip Tip's content, in `.tip-one`). */
export function RowLine({ row }: { row: LoupeRow }) {
  const cells = row.cells.filter((c): c is LoupeCell => !!c)
  return (
    <>
      {row.num != null && <span className="tip-n">{row.num}</span>}
      {cells.length > 0 && (
        <span className="tip-c">
          {cells.map((c, i) => (
            <i key={i} style={{ background: c.colour, opacity: c.faded ? 0.35 : undefined }} />
          ))}
        </span>
      )}
      <span className={'tip-t' + (row.heading ? ' heading' : '')}>
        {row.meta.map((m, i) => (
          <span key={i} className="tip-m">
            {oneLine(m, META_CHARS)}
          </span>
        ))}
        {oneLine(row.text)}
      </span>
    </>
  )
}

/** What a one-line tooltip says, as text: what keys its layout. Pure. */
export const rowKey = (row: LoupeRow): string => [row.num, row.cells.map((c) => (c ? c.colour + (c.faded ? '~' : '') : '')).join(','), row.meta.join('\u0001'), oneLine(row.text)].join('|')

interface State {
  open: boolean
  /** the pointer is in the loupe */
  frozen: boolean
  anchor: LoupeAnchor
  /** the unit under the pointer, and the first record shown */
  c: number
  start: number
  timer: number
  /** the pointer's last height on the strip, px in the viewport */
  lastY: number
  /** the row under the pointer in the loupe */
  hover: number | null
  /** where the strip and the box stand, read on a pointer's move and reused as the reader scrolls */
  g: Geometry | null
}

interface Geometry {
  left: number
  top: number
  lo: number
  hi: number
  room: number
  offL: number
  offT: number
  h: number
}

export interface Loupe {
  /** the loupe, for the host to render anywhere (it portals to the body) */
  element: ReactNode
  /** the bracket the host puts beside its strip, in the same positioned box */
  bracket: RefObject<HTMLDivElement | null>
  enter: (e: { clientY: number; pointerType?: string }) => void
  move: (e: { clientY: number; pointerType?: string }) => void
  leave: (e: { relatedTarget: EventTarget | null }) => void
  /** the wheel over the strip: an open loupe follows the scroll position */
  wheel: () => void
  /** the host's place changed (a scroll, a drag, a jump): an open loupe draws again, its anchor kept */
  moved: () => void
  /** a press on the thumb or a drag of it: the loupe opens at it and follows the scroll position */
  thumb: () => void
  /** a touch press on the strip, its drag, and its release, which gives the record under the loupe's line */
  touchStart: (e: { clientY: number }) => void
  touchMove: (e: { clientY: number }) => void
  touchEnd: () => number | null
  /** draw again, the host's records having changed */
  refresh: () => void
  close: () => void
  isOpen: () => boolean
}

/** a line number as the loupe writes it: plain, as the reader writes its line numbers */
const fmt = (n: number) => String(Math.round(n))
const CELL_CLASS = 'loupe-cell'

/** One row's element: its number, its cells, and its metadata and text, in that order. */
function rowEl(k: number): HTMLDivElement {
  const el = document.createElement('div')
  el.className = 'loupe-row'
  el.dataset.k = String(k)
  for (const cls of ['loupe-n', 'loupe-c', 'loupe-t']) {
    const s = document.createElement('span')
    s.className = cls
    el.appendChild(s)
  }
  return el
}

/** Write a row into its element. */
function writeRow(el: HTMLElement, row: LoupeRow) {
  const [n, c, t] = el.children as unknown as HTMLElement[]
  n.textContent = row.num ?? ''
  while (c.children.length < row.cells.length) {
    const i = document.createElement('i')
    i.className = CELL_CLASS
    c.appendChild(i)
  }
  while (c.children.length > row.cells.length) c.lastChild?.remove()
  row.cells.forEach((cell, j) => {
    const i = c.children[j] as HTMLElement
    i.style.background = cell ? cell.colour : ''
    i.classList.toggle('faded', !!cell?.faded)
  })
  const parts: (Node | string)[] = row.meta.map((m) => {
    const s = document.createElement('span')
    s.className = 'loupe-m'
    s.textContent = oneLine(m, META_CHARS)
    return s
  })
  parts.push(oneLine(row.text))
  t.replaceChildren(...parts)
  el.classList.toggle('heading', !!row.heading)
}

const sigOf = (row: LoupeRow) => rowKey(row) + (row.heading ? '|h' : '')

/** The loupe beside the strip `source` describes (see the top of this file). */
export function useLoupe(source: LoupeSource): Loupe {
  const src = useRef(source)
  src.current = source
  const box = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const bracket = useRef<HTMLDivElement>(null)
  const theme = useTheme().key
  const s = useRef<State>({ open: false, frozen: false, anchor: 'pointer', c: 0, start: 0, timer: 0, lastY: 0, hover: null, g: null })
  /** what is written in the page, so that a draw writes only what changed */
  const written = useRef({ right: '', top: '', width: '', num: '', bracket: '', rows: [] as { sig: string; cls: string }[] })
  const numW = useRef({ key: '', px: 0 })

  /** Where the strip and the box the loupe stays within stand, read before anything is written. */
  const measure = (): Geometry | null => {
    const strip = src.current.strip.current
    if (!strip) return null
    const r = strip.getBoundingClientRect()
    const bounds = src.current.bounds.current
    const b = bounds?.getBoundingClientRect() ?? r
    const edge = bounds?.parentElement?.getBoundingClientRect().left ?? 0
    // the room beside the strip: to the left edge of the box's parent (the reader, the report), and on the screen
    const room = Math.min(r.left - edge, r.left - INSET_PX + ROOM_PX) - LOUPE_OFF_PX
    const g = { left: r.left, top: r.top, lo: b.top + INSET_PX, hi: b.bottom - INSET_PX, room, offL: strip.offsetLeft, offT: strip.offsetTop, h: strip.clientHeight }
    s.current.g = g
    return g
  }
  const rows = () => Math.min(src.current.rows, src.current.total)
  /** The loupe's middle at `y`, px in the viewport, beside the strip. */
  const place = (y: number, g: Geometry | null) => {
    const el = box.current
    if (!el || !g) return
    const w = written.current
    const right = `${window.innerWidth - g.left}px`
    const top = `${loupeTop(y, loupeHeight(rows()), g.lo, g.hi)}px`
    const width = `${loupeWidth(g.room)}px`
    if (w.right !== right) el.style.right = w.right = right
    if (w.top !== top) el.style.top = w.top = top
    if (w.width !== width && list.current) list.current.style.width = w.width = width
  }
  const aim = (unit: number) => {
    const { total } = src.current
    const S = s.current
    S.c = Math.max(0, Math.min(total - 1e-6, unit))
    S.start = loupeStart(S.c, total, rows())
  }
  const aimPointer = (y: number, g: Geometry | null) => aim(src.current.unitAt(y - (g?.top ?? 0)))
  const aimView = () => {
    const [a, b] = src.current.view()
    aim(src.current.center?.() ?? (a + b) / 2)
  }

  const draw = (g: Geometry | null = s.current.g) => {
    const S = s.current
    const el = list.current
    if (!S.open || !el) return
    const { total, numbered } = src.current
    if (S.anchor === 'view') {
      aimView()
      if (!S.frozen && g) place(g.top + src.current.thumbMid(), g)
    }
    const n = rows()
    const w = written.current
    // the numbers' column, as wide as the widest number, read once per theme and length
    const key = numbered ? `${theme}|${total}` : 'none'
    if (numW.current.key !== key) {
      let px = 2
      if (numbered) {
        const ctx = document.createElement('canvas').getContext('2d')
        const family = getComputedStyle(el).getPropertyValue('--font-mono').trim() || 'monospace'
        if (ctx) {
          ctx.font = `10.5px ${family}`
          px = Math.ceil(ctx.measureText(fmt(total)).width) + 10
        }
      }
      numW.current = { key, px }
    }
    const num = `${numW.current.px}px`
    if (w.num !== num) el.style.setProperty('--loupe-num', (w.num = num))
    while (el.children.length < n) el.appendChild(rowEl(el.children.length))
    while (el.children.length > n) el.lastChild?.remove()
    w.rows.length = Math.min(w.rows.length, n)
    const view = src.current.view()
    const at = S.frozen ? (S.hover == null ? -1 : S.start + S.hover) : S.anchor === 'pointer' ? Math.floor(S.c) : -1
    const list$ = src.current.rowsAt(S.start, n)
    for (let k = 0; k < n; k++) {
      const i = S.start + k
      const row = list$[k]
      const rel = el.children[k] as HTMLElement
      const was = w.rows[k] ?? { sig: '', cls: '' }
      const sig = row ? sigOf(row) : ''
      if (sig !== was.sig) {
        if (row) writeRow(rel, row)
        else writeRow(rel, { num: null, cells: [], meta: [], text: '' })
      }
      const seen = onScreen(i, view)
      const cls = `${seen ? 's' : ''}${i === at ? 'a' : ''}`
      if (cls !== was.cls) {
        rel.classList.toggle('seen', seen)
        rel.classList.toggle('at', i === at)
      }
      w.rows[k] = { sig, cls }
    }
    // the bracket beside the strip over the stretch the loupe shows
    const br = bracket.current
    if (br && g) {
      const b = bracketOf(src.current.pxOf(S.start), src.current.pxOf(Math.min(total, S.start + n)), g.h)
      const pos = `${g.offL}|${g.offT + b.top}|${b.height}`
      if (w.bracket !== pos) {
        w.bracket = pos
        br.style.left = `${g.offL - BRACKET_PX - 1}px`
        br.style.transform = `translateY(${g.offT + b.top}px)`
        br.style.height = `${b.height}px`
      }
      if (!('open' in br.dataset)) br.dataset.open = ''
    }
  }

  const setFrozen = (frozen: boolean) => {
    const S = s.current
    S.frozen = frozen
    if (!frozen) S.hover = null
    const el = box.current
    if (!el) return
    if (frozen) el.dataset.frozen = ''
    else delete el.dataset.frozen
  }
  const show = (anchor: LoupeAnchor) => {
    const S = s.current
    S.open = true
    S.anchor = anchor
    setFrozen(false)
    box.current?.setAttribute('data-open', '')
  }
  const openAt = (y: number) => {
    if (!rows()) return
    show('pointer')
    const g = measure()
    aimPointer(y, g)
    place(y, g)
    draw(g)
  }
  const openAtView = () => {
    if (!rows()) return
    show('view')
    draw(measure())
  }
  const close = useCallback(() => {
    const S = s.current
    window.clearTimeout(S.timer)
    S.timer = 0
    S.open = false
    S.frozen = false
    S.hover = null
    const el = box.current
    if (el) {
      delete el.dataset.open
      delete el.dataset.frozen
    }
    if (bracket.current) delete bracket.current.dataset.open
  }, [])

  // a theme's number width, read again; a loupe that can no longer open closes
  useEffect(() => {
    numW.current.key = ''
    draw()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme])
  useEffect(() => {
    if (!source.rows) close()
  }, [source.rows, close])
  useEffect(() => close, [close])
  // the wheel over the loupe scrolls the reader, and the rows follow the scroll position while the loupe keeps its
  // place; the event stops here, so that the host's own wheel (an ancestor in React's tree) does not scroll it again
  useEffect(() => {
    const el = box.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const S = s.current
      if (S.open) S.anchor = anchorAfter(S.anchor, 'wheel')
      src.current.wheel(e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * window.innerHeight : e.deltaY)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const rowAt = (e: { target: EventTarget | null }): number | null => {
    const row = (e.target as Element | null)?.closest?.('.loupe-row') as HTMLElement | null
    return row?.dataset.k != null ? Number(row.dataset.k) : null
  }
  const onBoxMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const S = s.current
    if (!S.frozen) return
    const k = rowAt(e)
    if (k === S.hover) return
    S.hover = k
    draw()
  }
  const onBoxLeave = (e: ReactPointerEvent<HTMLDivElement>) => {
    const strip = src.current.strip.current
    if (strip && e.relatedTarget instanceof Node && strip.contains(e.relatedTarget)) return
    close()
  }
  const onBoxClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const S = s.current
    if (!S.open || !S.frozen) return
    const k = rowAt(e)
    if (k == null) return
    S.anchor = anchorAfter(S.anchor, 'click')
    src.current.act(S.start + k)
  }

  const element = createPortal(
    <div ref={box} className="loupe" style={{ paddingRight: LOUPE_OFF_PX }} onPointerMove={onBoxMove} onPointerLeave={onBoxLeave} onClick={onBoxClick} aria-hidden>
      <div ref={list} className="loupe-box overlay" />
    </div>,
    document.body,
  )

  return {
    element,
    bracket,
    enter: (e) => {
      if (e.pointerType === 'touch' || !rows()) return
      const S = s.current
      S.lastY = e.clientY
      if (S.open) {
        // back from the loupe: it follows the pointer again
        setFrozen(false)
        S.anchor = anchorAfter(S.anchor, 'strip')
        const g = measure()
        aimPointer(e.clientY, g)
        place(e.clientY, g)
        draw(g)
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
      // a move that did not move (one a browser sends as the page scrolls under a still pointer) leaves the anchor
      if (e.clientY === S.lastY) return
      S.lastY = e.clientY
      if (!S.open || S.frozen) return
      S.anchor = anchorAfter(S.anchor, 'strip')
      const g = measure()
      aimPointer(e.clientY, g)
      place(e.clientY, g)
      draw(g)
    },
    leave: (e) => {
      const S = s.current
      window.clearTimeout(S.timer)
      S.timer = 0
      if (S.open && box.current && e.relatedTarget instanceof Node && box.current.contains(e.relatedTarget)) {
        setFrozen(true)
        S.anchor = anchorAfter(S.anchor, 'into')
        draw()
        return
      }
      close()
    },
    wheel: () => {
      const S = s.current
      if (S.open) S.anchor = anchorAfter(S.anchor, 'wheel')
    },
    moved: () => {
      const S = s.current
      if (!S.open) return
      S.anchor = anchorAfter(S.anchor, 'scroll')
      draw()
    },
    thumb: () => {
      const S = s.current
      window.clearTimeout(S.timer)
      S.timer = 0
      if (S.open) {
        S.anchor = anchorAfter(S.anchor, 'thumb')
        draw(measure())
      } else openAtView()
    },
    touchStart: (e) => openAt(e.clientY),
    touchMove: (e) => {
      const S = s.current
      if (!S.open) return
      S.anchor = anchorAfter(S.anchor, 'strip')
      const g = S.g ?? measure()
      aimPointer(e.clientY, g)
      place(e.clientY, g)
      draw(g)
    },
    touchEnd: () => {
      const S = s.current
      const u = S.open ? Math.floor(S.c) : null
      close()
      return u
    },
    refresh: () => draw(),
    close,
    isOpen: () => s.current.open,
  }
}
