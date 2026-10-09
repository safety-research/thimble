// The comments beside the cards, on the board's plane: each open comment (backend canvas_comments.py) whose check is on,
// or main's own, beside its card, aligned with the card's top or with the row of the plan step it is about
// (`[data-anchor="card:<id>#step-<n>"]`), outside the card's outermost frame, stacked so none overlap (layout.ts
// commentPlaces), with a hairline from the card's edge to it. A comment shows Claude and its tag (Heads up, You should
// know) or its check's name, its title in bold and one or two sentences. Done (✓) and Know it resolve it, which hides
// it. A click makes it active and shows a field whose text opens a thread on the card with the comment as context. A
// comment hides with its check, when its card is not drawn (a collapsed frame) or when the filters leave its card out.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { TextArea } from '../components/Field'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import { track } from '../lib/telemetry'
import type { CanvasComment } from '../lib/types'
import { knowable, noteParts, NOTE_COLOR, type CheckLook } from '../report/checkComments'
import { canvasCommentsApi, type ResolveHow } from '../report/commentsApi'
import { Glyph, IconButton } from '../report/icons'
import { COMMENT_LIFT, COMMENT_STEP_LIFT, COMMENT_W, commentPlaces, type Board, type CommentPlace, type CommentSpot, type Layout } from './layout'

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

/** How far below its card's top a comment points, in plane px: its step's row, when the card draws it, else the card's
 * top. */
function pointOf(card: HTMLElement | undefined, c: CanvasComment): number {
  if (!card || c.n == null) return COMMENT_LIFT
  const row = card.querySelector<HTMLElement>(`[data-anchor="${esc(c.ref)}"]`) ?? card.querySelector<HTMLElement>(`[data-step="${esc(String(c.n))}"]`) ?? (c.step ? card.querySelector<HTMLElement>(`[data-step="${esc(c.step)}"]`) : null)
  if (!row) return COMMENT_LIFT
  const box = card.getBoundingClientRect()
  const scale = card.offsetWidth ? box.width / card.offsetWidth : 1
  return Math.max(0, (row.getBoundingClientRect().top - box.top) / (scale || 1) - COMMENT_STEP_LIFT)
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
}

export function CommentLayer({ ws, board, lay, comments, look, cardEl, onResolve, titleOf }: CommentLayerProps) {
  const els = useRef(new Map<string, HTMLDivElement>())
  const [places, setPlaces] = useState<Map<string, CommentPlace>>(new Map())
  const [active, setActive] = useState<string | null>(null)
  useEffect(() => {
    if (active && !comments.some((c) => c.id === active)) setActive(null)
  }, [active, comments])

  // a commented card's body that grows or shrinks moves the step rows its comments stand at (a plan's live rows
  // arriving, a done step opened), even in a card whose own height is set, so each change places them again
  const [, setMoved] = useState(0)
  const cardsKey = [...new Set(comments.map((c) => c.card))].join(' ')
  useEffect(() => {
    if (!cardsKey || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setMoved((n) => n + 1))
    for (const id of cardsKey.split(' ')) {
      const body = cardEl(id)?.querySelector('[data-body]')
      if (body) ro.observe(body)
    }
    return () => ro.disconnect()
  }, [cardsKey, cardEl])

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
        {comments.map((c) => {
          const p = places.get(c.id)
          if (!p) return null
          const mid = p.x - 9
          const head = p.y + 13
          return <path key={c.id} d={`M${p.ax} ${p.ay + 13}H${mid}V${head}H${p.x}`} />
        })}
      </svg>
      {comments.map((c) => (
        <CommentCard
          key={c.id}
          ws={ws}
          comment={c}
          look={look}
          place={places.get(c.id)}
          active={active === c.id}
          cardRef={(el) => {
            if (el) els.current.set(c.id, el)
            else els.current.delete(c.id)
          }}
          onActivate={() => setActive(c.id)}
          onResolve={(how) => onResolve(c, how)}
          titleOf={titleOf}
        />
      ))}
    </>
  )
}

interface CardProps {
  ws: string
  comment: CanvasComment
  look: CheckLook
  place: CommentPlace | undefined
  active: boolean
  cardRef: (el: HTMLDivElement | null) => void
  onActivate: () => void
  onResolve: (how: ResolveHow) => Promise<void>
  titleOf: (card: string) => string
}

function CommentCard({ ws, comment, look, place, active, cardRef, onActivate, onResolve, titleOf }: CardProps) {
  const [busy, setBusy] = useState(false)
  const parts = noteParts(comment)
  const name = parts.tag || comment.check == null ? 'Claude' : look.name(comment.check)
  const colour = comment.check == null ? NOTE_COLOR : look.colour(comment.check)
  const act = (how: ResolveHow) => (e: MouseEvent) => {
    e.stopPropagation()
    setBusy(true)
    void onResolve(how).finally(() => setBusy(false))
  }
  return (
    <div
      ref={cardRef}
      className={`ccm${active ? ' is-active' : ''}`}
      style={{ left: place?.x ?? 0, top: place?.y ?? 0, width: COMMENT_W, visibility: place ? undefined : 'hidden' }}
      data-canvas-comment={comment.id}
      data-comment-ref={comment.ref}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={onActivate}
    >
      <div className="ccm-head">
        <span className="ccm-sq" style={{ background: colour }} />
        <span className="ccm-name">{name}</span>
        {parts.tag ? (
          <span className="ccm-tag" data-tag={parts.tag}>
            {parts.tag}
          </span>
        ) : comment.check == null ? null : (
          <span className="ccm-meta">check</span>
        )}
        {knowable(comment) && (
          <button type="button" className="ccm-know" disabled={busy} onClick={act('known')}>
            Know it
          </button>
        )}
        <IconButton label="Done" className="ccm-done" disabled={busy} onClick={act('done')}>
          <Glyph name="check" size={13} strokeWidth={2} />
        </IconButton>
      </div>
      {parts.title && <div className="ccm-title">{parts.title}</div>}
      {parts.body && <div className="ccm-text">{parts.body}</div>}
      {active && <Reply ws={ws} comment={comment} name={name} titleOf={titleOf} />}
    </div>
  )
}

/** The active comment's field: its text goes to Thimble as the first message of a thread on the comment's card or step. */
function Reply({ ws, comment, name, titleOf }: { ws: string; comment: CanvasComment; name: string; titleOf: (card: string) => string }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const field = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => field.current?.focus({ preventScroll: true }), [])
  const send = async () => {
    const msg = text.trim()
    if (!msg || busy) return
    setBusy(true)
    const anchor = `card:${comment.card}`
    const who = comment.check != null && !comment.tag ? `The comment of the check “${name}”` : 'Claude’s comment'
    const where = comment.n != null ? ` (on step ${comment.n})` : ''
    try {
      const meta = await api.createThread(ws, { anchor, anchor_text: `${titleOf(comment.card)}\n\n${who}${where}: ${comment.text}`, text: msg })
      track('thread-open', { target: comment.ref, detail: { from: 'canvas-comment', comment: comment.id } })
      bus.emit('openChat', { chatId: meta.id })
      setText('')
    } catch (e) {
      bus.emit('toast', { text: `Could not open a thread. ${(e as Error).message}`, kind: 'error' })
    } finally {
      setBusy(false)
    }
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation()
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }
  return (
    <div className="ccm-reply" onClick={(e) => e.stopPropagation()}>
      <TextArea ref={field} bare block autoGrow rows={1} maxHeight={120} value={text} onChange={setText} onKeyDown={onKey} disabled={busy} placeholder="Reply, or ask Thimble to fix…" aria-label="Reply" />
    </div>
  )
}
