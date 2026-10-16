// A check's comment on a passage of Claude's answer, under the answer in main's chat (chat/answerComments.ts): the
// check's name in its colour, the comment, its details on request, and Done, which dismisses it (its tint goes).
import { useState, type CSSProperties } from 'react'
import { Button } from '../components/Button'
import { bus } from '../lib/bus'
import { tintOf, type AnswerComment } from './answerComments'
import { RefText } from './markdown'

export function AnswerCommentCard({ comment, ws, onDone, onClose }: { comment: AnswerComment; ws: string; onDone: (id: string) => Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  const done = async () => {
    setBusy(true)
    try {
      await onDone(comment.id)
      onClose()
    } catch (e) {
      bus.emit('toast', { text: `Could not dismiss the comment: ${(e as Error).message}`, kind: 'error' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="answer-comment" role="note" data-comment={comment.id} data-check={comment.check} style={{ '--tint': tintOf(comment) } as CSSProperties}>
      <div className="answer-comment-head">
        <span className="answer-comment-swatch" aria-hidden="true" />
        <span className="answer-comment-check">{comment.check_name}</span>
        <span className="card-foot-spacer" />
        <Button variant="icon" size="sm" icon="x" title="Close" aria-label="Close" onClick={onClose} />
      </div>
      <p className="answer-comment-text">{comment.text}</p>
      {comment.details ? (
        <details className="answer-comment-details">
          <summary>Details</summary>
          <RefText text={comment.details} workspace={ws} />
        </details>
      ) : null}
      <div className="answer-comment-acts">
        <Button size="sm" variant="secondary" busy={busy} className="answer-comment-done" onClick={() => void done()}>
          Done
        </Button>
      </div>
    </div>
  )
}
