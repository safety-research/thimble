// One comment as the Report's margin (Margin.tsx) and the canvas (canvas/CommentLayer.tsx) draw it, the same on both:
// its check's name in the check's color beside the color square, then its statement. Show more under the statement
// opens its details, whose citations show as chips, and Show less folds them. A click makes it active, which opens its
// details and a field whose text asks Thimble about it in a thread anchored to the comment's passage, card or step,
// with the comment's id and words; Ask does the same and puts the caret in the field. On hover, Ask and Know it (a check's comment, which its check then never raises
// again) stand before ✓ (Done); Know it and Done resolve the comment, which hides it. The canvas hears when the pointer
// or the keyboard's focus comes onto a card, to show where its comment points (CommentLayer.tsx).
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react'
import { ChatMarkdown, ChipContext } from '../chat/markdown'
import { TextArea } from '../components/Field'
import { RefChip } from '../components/RefChip'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import { track } from '../lib/telemetry'
import { commentName, CLAUDE_AUTHOR, extraEvidence, type CheckLook } from './checkComments'
import type { ResolveHow } from './commentsApi'
import { noteText } from './NoteText'
import { Glyph, IconButton } from './icons'

const NO_REFS: ReadonlySet<string> = new Set()

/** What a comment card reads of a comment, on either surface. */
export interface CommentView {
  id: string
  /** the check whose run left it; null for Claude's note and the analyst's own */
  check: string | null
  author: string
  /** the statement, shown first */
  text: string
  /** what supports it, shown on request: markdown whose citations show as chips */
  details: string
  /** the refs it cites */
  evidence: readonly string[]
  /** the citation check's tag on a sentence, which is no stored comment: nothing to resolve */
  fixed?: boolean
}

/** Where the thread Ask opens is anchored, and what it shows of the place. */
export interface CommentThread {
  /** the comment's passage, card or step, as a ref */
  anchor: string
  /** the passage's words, or the card's question */
  passage: string
  /** where on it the comment stands, such as "step 2" */
  where?: string
  /** the surface the comment is on */
  surface: 'report' | 'canvas'
}

export interface CommentCardProps {
  ws: string
  comment: CommentView
  look: Pick<CheckLook, 'colour' | 'name'>
  active: boolean
  onActivate: () => void
  onResolve: (how: ResolveHow) => Promise<void>
  thread: CommentThread
  cardRef?: (el: HTMLDivElement | null) => void
  /** the surface's own class, which places the card */
  className?: string
  style?: CSSProperties
  /** the surface's own data attributes */
  attrs?: Record<string, string>
  onMouseDown?: (e: MouseEvent) => void
  /** the pointer came onto the card (true) or left it (false) */
  onHover?: (on: boolean) => void
  /** the keyboard brought the focus into the card (true), or the focus left it (false) */
  onFocusIn?: (on: boolean) => void
}

/** Whether the focus came to `el` from the keyboard (a click on a button gives it no :focus-visible). */
function keyboardFocus(el: Element): boolean {
  try {
    return el.matches(':focus-visible')
  } catch {
    return false
  }
}

/** The words the thread's first lines show of the comment: who left it, its id, where, its statement and details. */
export function threadText(c: CommentView, name: string, thread: CommentThread): string {
  const who = c.check != null ? `The comment ${c.id} of the check “${name}”` : c.author === CLAUDE_AUTHOR ? `Claude’s comment ${c.id}` : `The analyst’s comment ${c.id}`
  const where = thread.where ? ` (on ${thread.where})` : ''
  const said = [c.text, c.details].filter((s) => s.trim()).join('\n\n')
  return `${thread.passage ? `${thread.passage}\n\n` : ''}${who}${where}: ${said}`
}

export function CommentCard({ ws, comment, look, active, onActivate, onResolve, thread, cardRef, className, style, attrs, onMouseDown, onHover, onFocusIn }: CommentCardProps) {
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [asking, setAsking] = useState(0)
  const name = commentName(comment, look)
  const colour = look.colour(comment.check)
  const extra = extraEvidence(comment.evidence, comment.details)
  const more = !!comment.details.trim() || extra.length > 0
  // a comment let go folds its details again; one opened by Show more alone stays open
  const wasActive = useRef(active)
  useEffect(() => {
    if (wasActive.current && !active) setOpen(false)
    wasActive.current = active
  }, [active])
  const act = (how: ResolveHow) => (e: MouseEvent) => {
    e.stopPropagation()
    setBusy(true)
    void onResolve(how).finally(() => setBusy(false))
  }
  const activate = () => {
    if (!active) setOpen(true)
    onActivate()
  }
  const ask = (e: MouseEvent) => {
    e.stopPropagation()
    if (!active) setOpen(true)
    onActivate()
    setAsking((n) => n + 1)
  }
  return (
    <div
      ref={cardRef}
      className={`wu-cm${active ? ' wu-cm-active' : ''}${className ? ` ${className}` : ''}`}
      style={style}
      onClick={activate}
      onMouseDown={onMouseDown}
      onMouseEnter={onHover && (() => onHover(true))}
      onMouseLeave={onHover && (() => onHover(false))}
      onFocus={onFocusIn && ((e) => keyboardFocus(e.target) && onFocusIn(true))}
      onBlur={onFocusIn && ((e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && onFocusIn(false))}
      data-comment={comment.id}
      {...attrs}
    >
      <div className="wu-cm-head">
        <span className="wu-cm-sq" style={{ background: colour }} />
        <span className="wu-cm-name" style={{ color: colour }}>
          {name}
        </span>
        <span className="wu-cm-tools">
          <span className="wu-cm-menu">
            <button type="button" className="wu-cm-act wu-cm-ask" onClick={ask}>
              Ask
            </button>
            {comment.check != null && !comment.fixed && (
              <button type="button" className="wu-cm-act wu-cm-know" disabled={busy} onClick={act('known')}>
                Know it
              </button>
            )}
          </span>
          {!comment.fixed && (
            <IconButton label="Done" className="wu-cm-resolve" disabled={busy} onClick={act('done')}>
              <Glyph name="check" size={13} strokeWidth={2} />
            </IconButton>
          )}
        </span>
      </div>
      <div className="wu-cm-text wu-cm-statement">{noteText(comment.text)}</div>
      {open && more && (
        <div className="wu-cm-details">
          {comment.details.trim() && (
            <ChipContext.Provider value={{ workspace: ws, broken: NO_REFS }}>
              <div className="wu-cm-md chat-text">
                <ChatMarkdown text={comment.details} />
              </div>
            </ChipContext.Provider>
          )}
          {extra.length > 0 && (
            <div className="wu-cm-refs">
              {extra.map((r) => (
                <RefChip key={r} ref={r} workspace={ws} cite />
              ))}
            </div>
          )}
        </div>
      )}
      {more && (
        <button
          type="button"
          className="wu-cm-more"
          aria-expanded={open}
          onClick={(e) => {
            e.stopPropagation()
            setOpen((o) => !o)
          }}
        >
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
      {active && <Reply ws={ws} comment={comment} name={name} thread={thread} focus={asking} />}
    </div>
  )
}

/** The active card's field: its text goes to Thimble as the first message of a thread anchored to the comment. `focus`
 * changes when Ask is pressed, which puts the caret in it. */
function Reply({ ws, comment, name, thread, focus }: { ws: string; comment: CommentView; name: string; thread: CommentThread; focus: number }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const field = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => {
    if (focus) field.current?.focus({ preventScroll: true })
  }, [focus])
  const send = async () => {
    const msg = text.trim()
    if (!msg || busy) return
    setBusy(true)
    try {
      // the question goes with the thread, so no empty thread is left when no session listens
      const meta = await api.createThread(ws, { anchor: thread.anchor, anchor_text: threadText(comment, name, thread), surface: thread.surface, element: 'comment', text: msg, ...(comment.fixed ? {} : { comment: comment.id }) })
      track('thread-open', { target: thread.anchor, detail: { from: `${thread.surface}-comment`, comment: comment.id } })
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
      <TextArea ref={field} bare block autoGrow rows={1} maxHeight={120} value={text} onChange={setText} onKeyDown={onKey} disabled={busy} placeholder="Reply, or ask Thimble to fix…" aria-label="Reply" />
    </div>
  )
}
