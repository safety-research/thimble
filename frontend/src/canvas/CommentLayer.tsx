// The comments beside the cards, on the board's plane: each open comment (backend canvas_comments.py) whose check is on,
// or main's own, beside its card, aligned with the card's top or with the row of the plan step it is about
// (`[data-anchor="card:<id>#step-<n>"]`), outside the card's outermost frame, stacked so none overlap (layout.ts
// commentPlaces). As in the Report, each step or card a comment is on is highlighted in its check's color (its step's
// text, or the card's question) and no line joins them at rest; while a comment is hovered, has the keyboard's focus or
// is open, its highlight is stronger, as the Report's active comment's is, and one thin line runs from the card's right
// edge at that step to the comment alone. Matt 2026-10-09: "what about highlights, just like in the report?". Each is
// the comment card the Report's margin draws too (report/CommentCard.tsx): its check's name and its statement, its
// details on request, Ask, Know it and ✓ (Done), and a thread for Ask anchored to its card or step. A comment hides with
// its check, when its card is not drawn (a collapsed frame) or when the filters leave its card out. The box the
// comments cover goes to the canvas, whose Fit and minimap take it in.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { bus } from '../lib/bus'
import { track } from '../lib/telemetry'
import type { CanvasComment } from '../lib/types'
import { evidenceRefs, type CheckLook } from '../report/checkComments'
import { CommentCard } from '../report/CommentCard'
import { canvasCommentsApi, type ResolveHow } from '../report/commentsApi'
import { COMMENT_LIFT, COMMENT_STEP_LIFT, COMMENT_W, commentPlaces, extentOf, type Board, type CommentPlace, type CommentSpot, type Layout, type Rect } from './layout'

const REFETCH_DEBOUNCE_MS = 200

/** The workspace's open comments on the cards, read again when the stream says they or the cards changed. */
export function useCanvasComments(ws: string): { comments: CanvasComment[]; resolve: (c: CanvasComment, how: ResolveHow) => Promise<void> } {
  const [comments, setComments] = useState<CanvasComment[]>([])
  useEffect(() => {
    let live = true
    let timer: number | null = null
    const read = () =>
      canvasCommentsApi
        .list(ws)
        .then((l) => live && setComments(l))
        .catch(() => {
          /* the board stands without its comments */
        })
    const later = () => {
      if (timer != null) window.clearTimeout(timer)
      timer = window.setTimeout(() => void read(), REFETCH_DEBOUNCE_MS)
    }
    setComments([])
    void read()
    const offs = [bus.on('canvasComments', later), bus.on('cell', later), bus.on('wsStream', (e) => e.connected && later())]
    return () => {
      live = false
      if (timer != null) window.clearTimeout(timer)
      for (const off of offs) off()
    }
  }, [ws])
  const resolve = useCallback(
    async (c: CanvasComment, how: ResolveHow) => {
      setComments((cur) => cur.filter((x) => x.id !== c.id))
      try {
        setComments(await canvasCommentsApi.resolve(ws, c.id, how))
        track('ui-click', { target: c.ref, detail: { action: how === 'known' ? 'comment-know' : 'comment-resolve', check: c.check } })
      } catch (e) {
        bus.emit('toast', { text: `Could not resolve the comment. ${(e as Error).message}`, kind: 'error' })
        canvasCommentsApi.list(ws).then(setComments, () => undefined)
      }
    },
    [ws],
  )
  return { comments, resolve }
}

/** The comments the board shows: main's always, a check's while it is on, each on a card that is drawn and that the
 * filters keep. Pure. */
export function shownCanvasComments(comments: readonly CanvasComment[], on: ReadonlySet<string>, drawn: (card: string) => boolean, keep: ReadonlySet<string> | null): CanvasComment[] {
  return comments.filter((c) => (c.check == null || on.has(c.check)) && drawn(c.card) && (keep == null || keep.has(c.card)))
}

const esc = (s: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&'))

/** The row of the step a comment is on, as its card draws it; null for a comment on the whole card, or a step the card
 * does not draw. */
function rowOf(card: HTMLElement | undefined, c: CanvasComment): HTMLElement | null {
  if (!card || c.n == null) return null
  return card.querySelector<HTMLElement>(`[data-anchor="${esc(c.ref)}"]`) ?? card.querySelector<HTMLElement>(`[data-step="${esc(String(c.n))}"]`) ?? (c.step ? card.querySelector<HTMLElement>(`[data-step="${esc(c.step)}"]`) : null)
}

/** What a comment highlights on its card, as the Report highlights a passage's words: its step's text (the row itself
 * where a card draws its steps otherwise), else the card's question. */
function flagOf(card: HTMLElement | undefined, c: CanvasComment): HTMLElement | null {
  if (!card) return null
  const row = rowOf(card, c)
  if (row) return row.querySelector<HTMLElement>('.plan-line') ?? row
  return card.querySelector<HTMLElement>('.bcell-q-text') ?? card.querySelector<HTMLElement>('.bcell-q')
}

function unflag(el: HTMLElement) {
  el.classList.remove('wu-flag', 'wu-flag-active', 'ccm-flag')
  el.style.removeProperty('--flag')
}

/** How far below its card's top a comment points, in plane px: its step's row, when the card draws it, else the card's
 * top. */
function pointOf(card: HTMLElement | undefined, c: CanvasComment): number {
  const row = rowOf(card, c)
  if (!card || !row) return COMMENT_LIFT
  const box = card.getBoundingClientRect()
  const scale = card.offsetWidth ? box.width / card.offsetWidth : 1
  return Math.max(0, (row.getBoundingClientRect().top - box.top) / (scale || 1) - COMMENT_STEP_LIFT)
}

/** The line from a comment's card to the comment, on the plane: from the card's right edge, level with the step's first
 * line (or the card's question), to the comment's left edge, level with its header; straight when the comment stands
 * level with its step, else a curve that leaves and meets each end level. */
export function linePath(p: CommentPlace): string {
  const y0 = p.ay + 13
  const y1 = p.y + 13
  if (Math.abs(y1 - y0) < 1) return `M${p.ax} ${y0}H${p.x}`
  const k = Math.max(8, (p.x - p.ax) / 2)
  return `M${p.ax} ${y0}C${p.ax + k} ${y0} ${p.x - k} ${y1} ${p.x} ${y1}`
}

export interface CommentLayerProps {
  ws: string
  board: Board
  lay: Layout
  /** the comments to draw (shownCanvasComments) */
  comments: readonly CanvasComment[]
  look: CheckLook
  /** a card's element on the board, to find its step rows */
  cardEl: (id: string) => HTMLElement | undefined
  onResolve: (c: CanvasComment, how: ResolveHow) => Promise<void>
  /** a card's question, for the thread a reply opens */
  titleOf: (card: string) => string
  /** the box the placed comments cover on the plane, or null for none, whenever it changes: Fit and the minimap take it
   * in with the cards */
  onExtent?: (box: Rect | null) => void
}

export function CommentLayer({ ws, board, lay, comments, look, cardEl, onResolve, titleOf, onExtent }: CommentLayerProps) {
  const els = useRef(new Map<string, HTMLDivElement>())
  const extent = useRef<Rect | null>(null)
  const [places, setPlaces] = useState<Map<string, CommentPlace>>(new Map())
  const [active, setActive] = useState<string | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const [focused, setFocused] = useState<string | null>(null)
  useEffect(() => {
    if (active && !comments.some((c) => c.id === active)) setActive(null)
  }, [active, comments])
  // a field that held the focus goes when its comment is let go, with no blur to say so
  useEffect(() => {
    if (focused && !els.current.get(focused)?.contains(document.activeElement)) setFocused(null)
  })
  // the one comment whose place shows: the hovered one, else the one the keyboard is on, else the open one
  const hotId = [hovered, focused, active].find((id) => id != null && comments.some((c) => c.id === id)) ?? null
  const hot = hotId ? comments.find((c) => c.id === hotId) : undefined
  const hotColour = hot ? look.colour(hot.check) : ''

  // every step or card a shown comment is on is highlighted in its check's color, as the Report highlights a commented
  // passage (report.css .wu-flag: the color of the hot comment there, else of the first check in the pane's order), and
  // the hot comment's place more strongly (.wu-flag-active). The cards' elements are the board's, so the marks are set
  // on them here after every render, which follows the cards' own renders, and taken off what no longer has one
  const flagged = useRef(new Set<HTMLElement>())
  useEffect(() => {
    const on = new Map<HTMLElement, CanvasComment[]>()
    for (const c of comments) {
      const el = flagOf(cardEl(c.card), c)
      if (el) on.set(el, [...(on.get(el) ?? []), c])
    }
    for (const el of flagged.current) if (!on.has(el)) unflag(el)
    for (const [el, list] of on) {
      const lit = list.find((c) => c.id === hotId)
      const first = list.reduce((a, b) => (look.rank(b.check) < look.rank(a.check) ? b : a))
      el.classList.add('wu-flag', 'ccm-flag')
      el.classList.toggle('wu-flag-active', !!lit)
      el.style.setProperty('--flag', look.colour((lit ?? first).check))
    }
    flagged.current = new Set(on.keys())
  })
  useEffect(
    () => () => {
      for (const el of flagged.current) unflag(el)
    },
    [],
  )

  // a commented card's body that grows or shrinks moves the step rows its comments stand at (a plan's live rows
  // arriving, a done step opened), even in a card whose own height is set, and a comment whose details open or fold
  // moves the comments below it, so each change places them again
  const [, setMoved] = useState(0)
  const cardsKey = [...new Set(comments.map((c) => c.card))].join(' ')
  const idsKey = comments.map((c) => c.id).join(' ')
  useEffect(() => {
    if (!cardsKey || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setMoved((n) => n + 1))
    for (const id of cardsKey.split(' ')) {
      const body = cardEl(id)?.querySelector('[data-body]')
      if (body) ro.observe(body)
    }
    for (const el of els.current.values()) ro.observe(el)
    return () => ro.disconnect()
  }, [cardsKey, idsKey, cardEl])

  // placed after every render: the cards' heights, a step row's place and the comments' own heights all move them
  useLayoutEffect(() => {
    const spots: CommentSpot[] = []
    for (const c of comments) {
      const el = els.current.get(c.id)
      if (!el) continue
      spots.push({ id: c.id, card: c.card, dy: pointOf(cardEl(c.card), c), h: el.offsetHeight })
    }
    const next = commentPlaces(board, lay, spots)
    const same = (a: CommentPlace | undefined, b: CommentPlace) => !!a && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.ax - b.ax) < 0.5 && Math.abs(a.ay - b.ay) < 0.5
    setPlaces((prev) => (prev.size === next.size && [...next].every(([k, v]) => same(prev.get(k), v)) ? prev : next))
    const box = extentOf(spots.flatMap((sp) => (next.has(sp.id) ? [{ x: next.get(sp.id)!.x, y: next.get(sp.id)!.y, w: COMMENT_W, h: sp.h }] : [])))
    const was = extent.current
    if (box === was || (box && was && Math.abs(box.x - was.x) + Math.abs(box.y - was.y) + Math.abs(box.w - was.w) + Math.abs(box.h - was.h) < 1)) return
    extent.current = box
    onExtent?.(box)
  })

  // a click outside the active comment lets it go
  useEffect(() => {
    if (!active) return
    const onDown = (e: globalThis.MouseEvent) => {
      if (!(e.target as Element | null)?.closest?.(`[data-canvas-comment="${esc(active)}"]`)) setActive(null)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [active])

  if (!comments.length) return null
  return (
    <>
      <svg className="ccm-lines" aria-hidden="true">
        {hot && places.get(hot.id) && <path data-line={hot.id} d={linePath(places.get(hot.id)!)} style={{ stroke: hotColour }} />}
      </svg>
      {comments.map((c) => {
        const place = places.get(c.id)
        return (
          <CommentCard
            key={c.id}
            ws={ws}
            comment={{ id: c.id, check: c.check, author: c.author, text: c.text, details: c.details ?? '', evidence: evidenceRefs(c.evidence) }}
            look={look}
            active={active === c.id}
            className="ccm"
            style={{ left: place?.x ?? 0, top: place?.y ?? 0, width: COMMENT_W, visibility: place ? undefined : 'hidden' }}
            attrs={{ 'data-canvas-comment': c.id, 'data-comment-ref': c.ref }}
            onMouseDown={(e) => e.stopPropagation()}
            cardRef={(el) => {
              if (el) els.current.set(c.id, el)
              else els.current.delete(c.id)
            }}
            onActivate={() => setActive(c.id)}
            onHover={(on) => setHovered((cur) => (on ? c.id : cur === c.id ? null : cur))}
            onFocusIn={(on) => setFocused((cur) => (on ? c.id : cur === c.id ? null : cur))}
            onResolve={(how) => onResolve(c, how)}
            thread={{ anchor: c.ref, passage: titleOf(c.card), where: c.n != null ? `step ${c.n}` : undefined, surface: 'canvas' }}
          />
        )
      })}
    </>
  )
}
