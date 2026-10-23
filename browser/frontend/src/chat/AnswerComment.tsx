// A check's comment on a passage of Claude's answer in main's chat (chat/answerComments.ts). It is the comment card the
// canvas and the report's margin draw (report/CommentCard.tsx): its check's name in its color beside the color square,
// the comment, Show more for its details, and ✓, which resolves it (its tint goes). A click on the card makes it active,
// as on the canvas: its details open with a field that asks Claude about it in a thread anchored to the answer; a click
// outside lets it go.
//
// It opens as a popover beside its passage: to the right of the chat's column, over the canvas, its top on the
// passage's line (components/RefChip placeBeside, the citation label's placing), so a comment on a long answer reads
// where its words are. It follows the passage while the chat scrolls and hides while the passage is out of view. Esc or
// a press outside it closes it; a press on a tinted passage leaves the toggle to the passage's own click.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { placeBeside } from '../components/RefChip'
import { bus } from '../lib/bus'
import { CommentCard, type CommentView } from '../report/CommentCard'
import { plainQuote, tintOf, type AnswerComment } from './answerComments'

interface CardProps {
  comment: AnswerComment
  ws: string
  anchor: string
  onDone: (id: string) => Promise<void>
  onClose: () => void
}

export function AnswerCommentCard({ comment, ws, anchor, onDone, onClose }: CardProps) {
  const [active, setActive] = useState(false)
  const el = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!active) return
    const onDown = (e: MouseEvent) => {
      if (!el.current?.contains(e.target as Node | null)) setActive(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [active])
  const look = useMemo(() => ({ colour: () => tintOf(comment), name: () => comment.check_name || comment.check }), [comment])
  const view = useMemo<CommentView>(() => ({ id: comment.id, check: comment.check, author: '', text: comment.text, details: comment.details ?? '', evidence: [] }), [comment])
  const resolve = async () => {
    try {
      await onDone(comment.id)
      onClose()
    } catch (e) {
      bus.emit('toast', { text: `Could not resolve the comment. ${(e as Error).message}`, kind: 'error' })
    }
  }
  return (
    <CommentCard
      ws={ws}
      comment={view}
      look={look}
      active={active}
      onActivate={() => setActive(true)}
      onResolve={resolve}
      thread={{ anchor, passage: plainQuote(comment.quote), surface: 'chat' }}
      className="answer-cm"
      cardRef={(node) => void (el.current = node)}
      attrs={{ role: 'note', 'data-check': comment.check, 'data-answer-comment': comment.id }}
    />
  )
}

/** The tinted pieces of comment `id`'s passage in the chat, in order (the first carries its anchor). */
function piecesOf(id: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('mark.answer-tint[data-answer-comment]')].filter((m) => m.dataset.answerComment === id)
}

/** The comment card as a popover beside its passage, portaled to the body. */
export function AnswerCommentPop(props: CardProps) {
  const { comment, onClose } = props
  const popEl = useRef<HTMLDivElement | null>(null)
  const close = useRef(onClose)
  close.current = onClose

  useLayoutEffect(() => {
    const el = popEl.current
    if (!el) return
    const place = () => {
      const pieces = piecesOf(comment.id)
      const first = pieces[0]
      if (!first) return
      const rect = first.getBoundingClientRect()
      const last = pieces[pieces.length - 1].getBoundingClientRect()
      const column = (first.closest('.chat') ?? first.closest('.chat-text') ?? first).getBoundingClientRect()
      const bounds = first.closest('.chat-list')?.getBoundingClientRect() ?? column
      // a passage scrolled out of the list hides its comment, unless the analyst is typing in it
      const gone = last.bottom < bounds.top || rect.top > bounds.bottom
      el.style.visibility = gone && !el.contains(document.activeElement) ? 'hidden' : ''
      placeBeside(el, rect, column, bounds)
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place)
    ro?.observe(el)
    const flow = piecesOf(comment.id)[0]?.closest('.chat-flow')
    if (flow) ro?.observe(flow)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
      ro?.disconnect()
    }
  }, [comment.id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close.current()
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null
      if (popEl.current?.contains(t)) return
      // a press on a tinted passage: its click opens that comment, or closes this one when it is its own; a press on a
      // citation's words in it opens the citation, which this comment makes way for
      if (t?.closest?.('mark.answer-tint[data-answer-comment]') && !t.closest('.mark-words')) return
      close.current()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [])

  return createPortal(
    <div ref={popEl} className="answer-cm-pop" role="dialog" aria-label="Comment" data-answer-comment-pop={comment.id} style={{ position: 'fixed', left: 0, top: 0 }}>
      <AnswerCommentCard {...props} />
    </div>,
    document.body,
  )
}
