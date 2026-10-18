// A check's comment on a passage of Claude's answer, under the answer in main's chat (chat/answerComments.ts). It is
// the comment card the canvas and the Report's margin draw (report/CommentCard.tsx), in the chat's column instead of
// placed beside a card: its check's name in its color beside the color square, the comment, Show more for its
// details, and ✓, which dismisses it (its tint goes). A click on the card makes it active, as on the canvas: its
// details open with a field that asks Thimble about it in a thread anchored to the passage; a click outside lets it go.
import { useEffect, useMemo, useRef, useState } from 'react'
import { bus } from '../lib/bus'
import { CommentCard, type CommentView } from '../report/CommentCard'
import { plainQuote, tintOf, type AnswerComment } from './answerComments'

export function AnswerCommentCard({ comment, ws, onDone, onClose }: { comment: AnswerComment; ws: string; onDone: (id: string) => Promise<void>; onClose: () => void }) {
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
      bus.emit('toast', { text: `Could not dismiss the comment: ${(e as Error).message}`, kind: 'error' })
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
      thread={{ anchor: comment.ref, passage: plainQuote(comment.quote), surface: 'chat' }}
      className="answer-cm"
      cardRef={(node) => void (el.current = node)}
      attrs={{ role: 'note', 'data-check': comment.check }}
    />
  )
}
