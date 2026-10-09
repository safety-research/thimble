// The report's margin: a card for every comment the page shows (a check's, Claude's note, or the analyst's), aligned
// with its passage and stacked so no two meet (checkComments.ts stackCards). Each is the comment card the canvas draws
// too (CommentCard.tsx): its check's name and its statement, its details on request, and Ask, Know it and ✓, with a
// thread on the passage for Ask. A new comment from the toolbar is a card with a field until Enter stores it.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { TextArea } from '../components/Field'
import { bus } from '../lib/bus'
import { CommentCard } from './CommentCard'
import type { ResolveHow } from './commentsApi'
import { NOTE_COLOR, stackCards, type CheckLook, type DocComment } from './checkComments'

/** the room the margin takes beside the page's column: report.css `.wu-rail`, 228 wide with 12 before it and 16 after */
export const RAIL_ROOM = 228 + 12 + 16

/** the room between two stacked cards, and how far above its passage's first line a card's top sits */
const GAP = 8
const LIFT = 8
const DRAFT_ID = 'draft'

export interface MarginProps {
  ws: string
  slug: string
  comments: readonly DocComment[]
  /** each comment's check, its colour and name */
  look: CheckLook
  active: string | null
  onActivate: (id: string | null) => void
  onResolve: (comment: DocComment, how: ResolveHow) => Promise<void>
  /** the passage a new comment of the analyst's is being written on */
  draft: string | null
  onDraft: (sid: string, text: string) => Promise<void>
  onDraftCancel: () => void
  /** the page column, where the passages are */
  column: RefObject<HTMLElement | null>
  /** a passage's text, for the thread a reply opens */
  textOf: (sid: string) => string
}

const esc = (s: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&'))

/** A passage's element in the column: its `data-sid` mark, else, for a section heading no comment tints yet (the
 * decorations mark a heading only while it is tinted), its stored block. */
const passageEl = (col: HTMLElement, sid: string): Element | null =>
  col.querySelector(`[data-sid="${esc(sid)}"]`) ?? col.querySelector(`[data-anchor-cell][data-anchor$="#${esc(sid)}"]`)

export function Margin({ ws, slug, comments, look, active, onActivate, onResolve, draft, onDraft, onDraftCancel, column, textOf }: MarginProps) {
  const rail = useRef<HTMLDivElement | null>(null)
  const cards = useRef(new Map<string, HTMLDivElement>())
  const [tops, setTops] = useState<Map<string, number>>(new Map())
  const items: { id: string; sid: string }[] = [...comments.map((c) => ({ id: c.id, sid: c.sid })), ...(draft ? [{ id: DRAFT_ID, sid: draft }] : [])]
  const key = items.map((i) => `${i.id}@${i.sid}`).join(',') + `|${active}`

  const layout = useCallback(() => {
    const col = column.current
    const r = rail.current
    if (!col || !r) return
    const base = r.getBoundingClientRect().top
    const want: { id: string; top: number; height: number }[] = []
    for (const it of items) {
      const el = passageEl(col, it.sid)
      const card = cards.current.get(it.id)
      if (!el || !card) continue
      want.push({ id: it.id, top: el.getBoundingClientRect().top - base - LIFT, height: card.offsetHeight })
    }
    const next = stackCards(want, GAP, draft ? DRAFT_ID : active)
    setTops((prev) => (prev.size === next.size && [...next].every(([k, v]) => prev.get(k) === v) ? prev : next))
  }, [column, key]) // eslint-disable-line react-hooks/exhaustive-deps

  // placed after every render, and again whenever the column's text moves (an edit, a figure loading, a resize) or a
  // comment's Show more opens or Show less folds its details
  useLayoutEffect(() => {
    layout()
  })
  useLayoutEffect(() => {
    const col = column.current
    if (!col) return
    let frame = 0
    const later = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(layout)
    }
    const ro = new ResizeObserver(later)
    ro.observe(col)
    for (const card of cards.current.values()) ro.observe(card)
    const mo = new MutationObserver(later)
    mo.observe(col, { subtree: true, childList: true, characterData: true })
    return () => {
      window.cancelAnimationFrame(frame)
      ro.disconnect()
      mo.disconnect()
    }
  }, [column, layout])

  const setCard = (id: string) => (el: HTMLDivElement | null) => {
    if (el) cards.current.set(id, el)
    else cards.current.delete(id)
  }

  return (
    <div className="wu-rail" ref={rail} aria-label="Comments">
      {comments.map((c) => {
        const top = tops.get(c.id)
        return (
          <CommentCard
            key={c.id}
            ws={ws}
            comment={{ ...c, details: c.details ?? '', fixed: c.tag }}
            look={look}
            active={c.id === active}
            style={{ top: top ?? 0, visibility: top == null ? 'hidden' : undefined }}
            cardRef={setCard(c.id)}
            onActivate={() => onActivate(c.id)}
            onResolve={(how) => onResolve(c, how)}
            thread={{ anchor: `report:${slug}#${c.sid}`, passage: textOf(c.sid), surface: 'report' }}
          />
        )
      })}
      {draft && <DraftCard key={draft} top={tops.get(DRAFT_ID)} cardRef={setCard(DRAFT_ID)} onSave={(text) => onDraft(draft, text)} onCancel={onDraftCancel} />}
    </div>
  )
}

/** The analyst's new comment, at its passage until Enter stores it; Escape, or leaving it empty, drops it. */
function DraftCard({ top, cardRef, onSave, onCancel }: { top: number | undefined; cardRef: (el: HTMLDivElement | null) => void; onSave: (text: string) => Promise<void>; onCancel: () => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  // the field takes the caret once the card stands at its passage, without scrolling the page to it
  const field = useRef<HTMLTextAreaElement | null>(null)
  const placed = top != null
  useEffect(() => {
    if (placed) field.current?.focus({ preventScroll: true })
  }, [placed])
  const save = async () => {
    const t = text.trim()
    if (!t || busy) return
    setBusy(true)
    try {
      await onSave(t)
    } catch (e) {
      bus.emit('toast', { text: `Could not save the comment. ${(e as Error).message}`, kind: 'error' })
      setBusy(false)
    }
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation()
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void save()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }
  return (
    <div ref={cardRef} className="wu-cm wu-cm-active wu-cm-draft" style={{ top: top ?? 0, visibility: top == null ? 'hidden' : undefined }} onClick={(e) => e.stopPropagation()}>
      <div className="wu-cm-head">
        <span className="wu-cm-sq" style={{ background: NOTE_COLOR }} />
        <span className="wu-cm-name" style={{ color: NOTE_COLOR }}>
          You
        </span>
      </div>
      <div className="wu-cm-reply">
        <TextArea
          ref={field}
          bare
          block
          autoGrow
          rows={1}
          maxHeight={160}
          value={text}
          onChange={setText}
          onKeyDown={onKey}
          onBlur={() => {
            if (!text.trim() && !busy) onCancel()
          }}
          disabled={busy}
          aria-label="Comment"
        />
      </div>
    </div>
  )
}
