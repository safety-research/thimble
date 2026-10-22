// The comments of the shared Labels and Comments sidebar (LabelsSidebar.tsx): every open comment the checks (and
// main's and the analyst's notes) left on the cards and in the report. A comment's row says where it is, as a link that
// goes there (a card, or the passage in the report), its passage, its statement and, a click away, its details. Apply
// sends the comment to main in the chat as the analyst's message (bus openChat with `send`, the composer's own path),
// so Claude makes the change there; Go to it opens the card or the passage; Done resolves it, as the comment's check
// mark does where it stands.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useCanvasComments } from '../canvas/CommentLayer'
import { Button } from '../components/Button'
import { docsApi } from '../lib/api'
import { bus } from '../lib/bus'
import { teleport } from '../lib/teleport'
import type { WriteupComment } from '../lib/types'
import { commentsApi } from '../report/commentsApi'

const REPORT = 'report'

/** One open comment, from the cards or the report. */
export interface CommentItem {
  id: string
  surface: 'canvas' | 'report'
  check: string | null
  author: string
  text: string
  details: string
  /** the card's or the passage's ref, which Go to it opens */
  ref: string
  /** where it stands, in words: "card abc · step 2", "the report" */
  where: string
  /** the passage's words, for a comment in the report */
  quote?: string | null
}

/** The message Apply sends to main: which comment, where, and what it says. Pure. */
export function applyText(c: CommentItem, name: string): string {
  const who = c.check != null ? `the check “${name}”` : c.author === 'claude' ? 'your own note' : 'my note'
  const at = c.surface === 'report' ? `in the report${c.quote ? ` at “${c.quote}”` : ''} (${c.ref})` : `on ${c.ref}`
  const said = [c.text.trim(), c.details.trim()].filter(Boolean).join('\n\n')
  return `Apply this comment of ${who} ${at}: ${said}`
}

/** The open comments of the report, read again when the report changes. */
function useReportComments(ws: string): { comments: WriteupComment[]; reload: () => void } {
  const [comments, setComments] = useState<WriteupComment[]>([])
  const reload = useCallback(() => {
    docsApi
      .document(ws, REPORT)
      .then((d) => setComments(((d as { comments?: WriteupComment[] }).comments ?? []).filter((c) => c.status === 'open')))
      .catch(() => setComments([]))
  }, [ws])
  useEffect(() => {
    reload()
    return bus.on('report', (e) => e.slug === REPORT && reload())
  }, [reload])
  return { comments, reload }
}

/** Every open comment, on the cards and in the report, with what Done needs. */
export function useCommentItems(ws: string) {
  const cards = useCanvasComments(ws)
  const report = useReportComments(ws)
  const items = useMemo<CommentItem[]>(
    () => [
      ...cards.comments.map((c) => ({
        id: c.id,
        surface: 'canvas' as const,
        check: c.check,
        author: c.author,
        text: c.text,
        details: c.details,
        ref: `card:${c.card}`,
        where: `card ${c.card}${c.n != null ? ` · step ${c.n}` : ''}`,
      })),
      ...report.comments.map((c) => ({
        id: c.id,
        surface: 'report' as const,
        check: c.check ?? null,
        author: c.author,
        text: c.text,
        details: String((c as { details?: string }).details ?? ''),
        ref: `report:${REPORT}#${c.sentence_id}`,
        where: 'the report',
        quote: c.quote ?? null,
      })),
    ],
    [cards.comments, report.comments],
  )
  return { items, cards, report }
}

/** The open comments with Done: on a card it resolves the card's comment, in the report the passage's. */
export function useComments(ws: string) {
  const { items, cards, report } = useCommentItems(ws)
  const done = (c: CommentItem) => {
    if (c.surface === 'canvas') {
      const found = cards.comments.find((x) => x.id === c.id)
      if (found) void cards.resolve(found)
      return
    }
    commentsApi
      .resolve(ws, REPORT, c.id)
      .then(() => report.reload())
      .catch((e: Error) => bus.emit('toast', { text: `Could not resolve the comment. ${e.message}`, kind: 'error' }))
  }
  return { items, done }
}

/** One comment in its category's list: where it is, as a link that goes there, its passage, its statement and details,
 * and Apply · Go to it · Done. `name` is its category's, which Apply's message names. */
export function CommentRow({ item: c, name, onDone }: { item: CommentItem; name: string; onDone: () => void }) {
  const [open, setOpen] = useState(false)
  // the chat's own send path: it opens main (and the chat column, when folded) and posts the message there
  const apply = () => bus.emit('openChat', { chatId: 'main', send: applyText(c, name) })
  const go = () => teleport(c.ref)
  return (
    <div className="lside-comment" data-comment={c.id} data-surface={c.surface}>
      <button type="button" className="lside-comment-where" onClick={go} title="Go to it">
        {c.where}
      </button>
      {c.quote && <p className="lside-comment-quote">{`“${c.quote}”`}</p>}
      <p className="lside-comment-text">{c.text}</p>
      {c.details.trim() && (
        <>
          {open && <p className="lside-comment-details">{c.details}</p>}
          <button type="button" className="lside-link" onClick={() => setOpen(!open)}>
            {open ? 'Show less' : 'Show more'}
          </button>
        </>
      )}
      <div className="lside-comment-acts">
        <Button variant="primary" size="sm" onClick={apply} title="Send this comment to Claude in the chat, to make the change">
          Apply
        </Button>
        <Button variant="ghost" size="sm" onClick={go}>
          Go to it
        </Button>
        <Button variant="ghost" size="sm" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  )
}
