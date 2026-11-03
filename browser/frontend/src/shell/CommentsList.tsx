// The comments of the shared Labels and Comments sidebar (LabelsSidebar.tsx): every open comment the checks (and
// main's and the analyst's notes) left on the cards and in the documents, and the checks' comments on Claude's answers in
// the chat (chat/answerComments.ts). The documents are the written ones, whose check runs the sidebar shows too
// (report/docTypes.ts): the report, a case file, a document of the analyst's own, a page. Once more than one document
// has comments, each comment names its document, as the runs on several documents do. A comment's row says where it is,
// as a link that goes there (a card, or the passage in its document), its passage, its statement and, a click away, its
// details. Apply sends the comment to main in the chat as the analyst's message (bus openChat with `send`, the
// composer's own path), so Claude makes the change there; Go to it opens the card or the passage; Done resolves it, as
// the comment's check mark does where it stands.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useCanvasComments } from '../canvas/CommentLayer'
import { plainQuote, useAnswerComments } from '../chat/answerComments'
import { Button } from '../components/Button'
import { docsApi } from '../lib/api'
import { bus } from '../lib/bus'
import { teleport } from '../lib/teleport'
import type { AnyDoc, WriteupComment } from '../lib/types'
import { commentsApi } from '../report/commentsApi'
import { useDocTypes, writtenDocs } from '../report/docTypes'
import { docLabel, SLUG } from '../report/model'

/** One open comment, from the cards, a document or Claude's answers in the chat. */
export interface CommentItem {
  id: string
  surface: 'canvas' | 'report' | 'chat'
  check: string | null
  author: string
  text: string
  details: string
  /** the card's or the passage's ref, which Go to it opens */
  ref: string
  /** where it stands, in words: "card abc · step 2", "the report", a document's name */
  where: string
  /** the passage's words, for a comment in a document or on an answer */
  quote?: string | null
  /** for a comment in a document: the document's slug, and its name as its tab spells it */
  doc?: { slug: string; name: string }
}

/** The message Apply sends to main: which comment, where, and what it says. Pure. */
export function applyText(c: CommentItem, name: string): string {
  const who = c.check != null ? `the check “${name}”` : c.author === 'claude' ? 'your own note' : 'my note'
  const doc = c.doc && c.doc.slug !== SLUG ? `the ${c.doc.name}` : 'the report'
  const at =
    c.surface === 'report' ? `in ${doc}${c.quote ? ` at “${c.quote}”` : ''} (${c.ref})` : c.surface === 'chat' ? `on your answer${c.quote ? ` at “${c.quote}”` : ''}` : `on ${c.ref}`
  const said = [c.text.trim(), c.details.trim()].filter(Boolean).join('\n\n')
  return `Apply this comment of ${who} ${at}: ${said}`
}

const openOf = (d: AnyDoc | undefined): WriteupComment[] => (d?.comments ?? []).filter((c) => c.status === 'open')

/** The open comments of the written documents, in the type bar's order, each read again when its document changes: the
 * report's from the first render, as before the types are known; `put` sets a document's from the document a request
 * answered. */
function useDocComments(ws: string) {
  const types = useDocTypes(ws)
  // the documents read, as one key, so that the types read again with the same documents written read none of them
  const key = [...new Set([SLUG, ...(types ? writtenDocs(types) : [])])].join(' ')
  const [read, setRead] = useState<{ ws: string; by: Record<string, WriteupComment[]> }>({ ws, by: {} })
  const put = useCallback((slug: string, d: AnyDoc | undefined) => setRead((r) => ({ ws, by: { ...(r.ws === ws ? r.by : {}), [slug]: openOf(d) } })), [ws])
  useEffect(() => {
    let live = true
    const slugs = key.split(' ')
    const load = (slug: string) =>
      docsApi
        .document(ws, slug)
        .then((d) => live && put(slug, d))
        .catch(() => live && put(slug, undefined))
    slugs.forEach((slug) => void load(slug))
    const off = bus.on('report', (e) => slugs.includes(e.slug) && void load(e.slug))
    return () => {
      live = false
      off()
    }
  }, [ws, key, put])
  const docs = useMemo(() => key.split(' ').map((slug) => ({ slug, name: docLabel(slug, types), comments: (read.ws === ws && read.by[slug]) || [] })), [key, types, read, ws])
  return { docs, put }
}

/** Every open comment, on the cards, in the documents and on Claude's answers, with what Done needs. */
export function useCommentItems(ws: string) {
  const cards = useCanvasComments(ws)
  const docs = useDocComments(ws)
  const answers = useAnswerComments(ws)
  const items = useMemo<CommentItem[]>(() => {
    // the report's comments say "the report" while it alone has any; else each names its document
    const named = docs.docs.filter((d) => d.comments.length).length > 1
    return [
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
      ...docs.docs.flatMap(({ slug, name, comments }) =>
        comments.map((c) => ({
          id: c.id,
          surface: 'report' as const,
          check: c.check ?? null,
          author: c.author,
          text: c.text,
          details: String(c.details ?? ''),
          ref: `report:${slug}#${c.sentence_id}`,
          where: slug === SLUG && !named ? 'the report' : name,
          quote: c.quote ?? null,
          doc: { slug, name },
        })),
      ),
      ...answers.comments
        .filter((c) => c.status === 'open')
        .map((c) => ({
          id: c.id,
          surface: 'chat' as const,
          check: c.check,
          author: 'check',
          text: c.text,
          details: c.details ?? '',
          ref: c.ref,
          where: "Claude's answer",
          quote: plainQuote(c.quote) || null,
        })),
    ]
  }, [cards.comments, docs.docs, answers.comments])
  return { items, cards, docs, answers }
}

/** The open comments with Done: on a card it resolves the card's comment, in a document the passage's. */
export function useComments(ws: string) {
  const { items, cards, docs, answers } = useCommentItems(ws)
  const done = (c: CommentItem) => {
    if (c.surface === 'chat') {
      answers.dismiss(c.id).catch((e: Error) => bus.emit('toast', { text: `Could not resolve the comment. ${e.message}`, kind: 'error' }))
      return
    }
    if (c.surface === 'canvas') {
      const found = cards.comments.find((x) => x.id === c.id)
      if (found) void cards.resolve(found)
      return
    }
    const slug = c.doc?.slug ?? SLUG
    commentsApi
      .resolve(ws, slug, c.id)
      .then((saved) => docs.put(slug, saved))
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
  const go = () => teleport(c.ref, { comment: c.id })
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
