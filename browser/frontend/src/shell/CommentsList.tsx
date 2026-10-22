// The Comments list of the right sidebar (LabelsSidebar.tsx), next to the Labels: every open comment the checks (and
// main's notes) left on the cards and in the report, in one place. A row is a comment: its check's color and name,
// where it is (a card, or the report), its statement and, a click away, its details. Apply sends the comment to main
// in the chat as the analyst's message (bus openChat with `send`, the composer's own path), so Claude makes the change there; Go to it opens the card or the passage;
// Done resolves it, as the comment's ✓ does where it stands. The checks themselves, with their switches, stay in the
// canvas's Comments menu and the report's Comments pane.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useCanvasComments } from '../canvas/CommentLayer'
import { Button } from '../components/Button'
import { docsApi } from '../lib/api'
import { bus } from '../lib/bus'
import { teleport } from '../lib/teleport'
import type { WriteupComment } from '../lib/types'
import { useChecks } from '../report/Checks'
import { checkLook, commentName } from '../report/checkComments'
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

export function CommentsList({ ws }: { ws: string }) {
  const checks = useChecks(ws)
  const look = useMemo(() => checkLook(checks.list), [checks.list])
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
  if (!items.length) return <p className="lside-none">No open comments.</p>
  return (
    <>
      {items.map((c) => (
        <CommentRow key={`${c.surface}:${c.id}`} item={c} name={commentName(c, look)} color={look.colour(c.check)} onDone={() => done(c)} />
      ))}
    </>
  )
}

function CommentRow({ item: c, name, color, onDone }: { item: CommentItem; name: string; color: string; onDone: () => void }) {
  const [open, setOpen] = useState(false)
  // the chat's own send path: it opens main (and the chat column, when folded) and posts the message there
  const apply = () => bus.emit('openChat', { chatId: 'main', send: applyText(c, name) })
  return (
    <div className="lside-row lside-comment" data-comment={c.id} data-surface={c.surface}>
      <div className="lside-row-head">
        <span className="lside-swatch" style={{ '--sw': color } as React.CSSProperties} aria-hidden="true" />
        <span className="lside-name">{name}</span>
        <span className="lside-found-where">{c.where}</span>
      </div>
      {c.quote && <p className="lside-comment-quote">{`“${c.quote}”`}</p>}
      <p className="lside-question lside-comment-text">{c.text}</p>
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
        <Button variant="ghost" size="sm" onClick={() => teleport(c.ref)}>
          Go to it
        </Button>
        <Button variant="ghost" size="sm" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  )
}
