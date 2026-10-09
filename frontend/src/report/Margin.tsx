// The report's margin: a card for every comment the page shows (a check's, Claude's note, or the analyst's), aligned
// with its passage and stacked so no two meet (checkComments.ts stackCards). A click makes a card active and shows the
// reply field, whose text starts a thread on the passage with the comment as context; ✓ resolves a stored comment, and
// Know it resolves one that opens with a tag ("Heads up", "You should know"), which its check then never raises again.
// Such a comment shows Claude and its tag, its title in bold and the rest under it. A new comment from the toolbar is a
// card with a field until Enter stores it.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject } from 'react'
import { TextArea } from '../components/Field'
import { RefChip } from '../components/RefChip'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import { track } from '../lib/telemetry'
import type { ResolveHow } from './commentsApi'
import { commentName, knowable, noteParts, NOTE_COLOR, stackCards, type CheckLook, type DocComment } from './checkComments'
import { Glyph, IconButton } from './icons'

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

  // placed after every render, and again whenever the column's text moves: an edit, a figure loading, a resize
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
      {comments.map((c) => (
        <CommentCard key={c.id} ws={ws} slug={slug} comment={c} look={look} active={c.id === active} top={tops.get(c.id)} cardRef={setCard(c.id)} onActivate={() => onActivate(c.id)} onResolve={(how) => onResolve(c, how)} textOf={textOf} />
      ))}
      {draft && <DraftCard key={draft} top={tops.get(DRAFT_ID)} cardRef={setCard(DRAFT_ID)} onSave={(text) => onDraft(draft, text)} onCancel={onDraftCancel} />}
    </div>
  )
}

interface CardProps {
  ws: string
  slug: string
  comment: DocComment
  look: CheckLook
  active: boolean
  /** undefined until placed, or when its passage is not on the page */
  top: number | undefined
  cardRef: (el: HTMLDivElement | null) => void
  onActivate: () => void
  onResolve: (how: ResolveHow) => Promise<void>
  textOf: (sid: string) => string
}

function CommentCard({ ws, slug, comment, look, active, top, cardRef, onActivate, onResolve, textOf }: CardProps) {
  const [busy, setBusy] = useState(false)
  const note = comment.check == null
  const meta = comment.tag ? 'citation check' : note ? 'comment' : 'check'
  const parts = noteParts(comment)
  const act = (how: ResolveHow) => (e: MouseEvent) => {
    e.stopPropagation()
    setBusy(true)
    void onResolve(how).finally(() => setBusy(false))
  }
  return (
    <div
      ref={cardRef}
      className={`wu-cm${active ? ' wu-cm-active' : ''}`}
      style={{ top: top ?? 0, visibility: top == null ? 'hidden' : undefined }}
      onClick={onActivate}
      data-comment={comment.id}
    >
      <div className="wu-cm-head">
        <span className="wu-cm-sq" style={{ background: look.colour(comment.check) }} />
        <span className="wu-cm-name">{parts.tag ? 'Claude' : commentName(comment, look)}</span>
        {parts.tag ? (
          <span className="wu-cm-tag" data-tag={parts.tag}>
            {parts.tag}
          </span>
        ) : (
          <span className="wu-cm-meta">{meta}</span>
        )}
        {!comment.tag && knowable(comment) && (
          <button type="button" className="wu-cm-know" disabled={busy} onClick={act('known')}>
            Know it
          </button>
        )}
        {!comment.tag && (
          <IconButton label="Resolve" className="wu-cm-resolve" disabled={busy} onClick={act('done')}>
            <Glyph name="check" size={13} strokeWidth={2} />
          </IconButton>
        )}
      </div>
      {parts.title && <div className="wu-cm-title">{parts.title}</div>}
      {parts.body && <div className="wu-cm-text">{parts.body}</div>}
      {active && comment.evidence.length > 0 && (
        <div className="wu-cm-refs">
          {comment.evidence.map((r) => (
            <RefChip key={r} ref={r} workspace={ws} cite />
          ))}
        </div>
      )}
      {active && <Reply ws={ws} slug={slug} comment={comment} name={commentName(comment, look)} textOf={textOf} />}
    </div>
  )
}

/** The active card's field: its text goes to Thimble as the first message of a thread on the comment's passage. `name`
 * is the comment's check's, or Claude or You for a note. */
function Reply({ ws, slug, comment, name, textOf }: { ws: string; slug: string; comment: DocComment; name: string; textOf: (sid: string) => string }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const send = async () => {
    const msg = text.trim()
    if (!msg || busy) return
    setBusy(true)
    const anchor = `report:${slug}#${comment.sid}`
    const who = comment.check != null ? `The comment of the check “${name}”` : name === 'Claude' ? 'Claude’s note' : 'The analyst’s comment'
    try {
      // the reply goes with the thread, so no empty thread is left when no session listens
      const meta = await api.createThread(ws, { anchor, anchor_text: `${textOf(comment.sid)}\n\n${who}: ${comment.text}`, text: msg })
      track('thread-open', { target: anchor, detail: { from: 'report-comment', comment: comment.id } })
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
    <div className="wu-cm-reply" onClick={(e) => e.stopPropagation()}>
      <TextArea bare block autoGrow rows={1} maxHeight={120} value={text} onChange={setText} onKeyDown={onKey} disabled={busy} placeholder="Reply, or ask Thimble to fix…" aria-label="Reply" />
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
        <span className="wu-cm-name">You</span>
        <span className="wu-cm-meta">comment</span>
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
