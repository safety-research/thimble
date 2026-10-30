// Checks on Claude's answers, in the chat: a check whose Show in has Chat reads each answer of main's when its turn ends
// and comments on its passages (backend answer_comments.py, routes GET /ws/{c}/answer-comments and POST
// …/{id}/dismiss, the stream's `answer-comments` record). Each open comment tints the words of its passage it is about in
// main's chat in its check's color, as the terminal marks a term's words, or its whole passage when it names no words;
// the first piece of the tint carries the anchor `answer:<turn>#s<n>` (Go to it in the Comments sidebar scrolls to it and
// opens its comment), and a click opens the comment beside the passage as the comment card the canvas and the report's
// margin draw (AnswerComment.tsx AnswerCommentPop). An explainer and a heads-up never share words, so each of their
// tints opens its own comment (marksOf).
//
// A comment names the turn it is on (`turn`, the id the turn's `done` record names, chat/model.ts TextRow.turn) and
// quotes its passage raw, as Claude wrote it. The chat draws the answer as markdown, so the passage is found in the drawn
// words (plainQuote: the quote without markdown's marks, a citation as the value it shows), and its words in the passage.
import { useEffect, useMemo, useState } from 'react'
import { checksApi } from '../lib/api'
import { bus } from '../lib/bus'
import { colourVar } from '../files/labels'
import { findQuote } from '../lib/quoteFind'

export interface AnswerComment {
  id: string
  check: string
  check_name: string
  /** the check's place in the label palette, 1 to 8 (backend checks.COLOURS) */
  color: number
  turn: string
  row: string
  ref: string
  start: number
  end: number
  quote: string
  /** the words of the passage it is about, as the chat draws them; none for the whole passage */
  words?: string
  text: string
  details?: string
  status: 'open' | 'dismissed'
  at?: string
}

/** What GET /ws/{c}/answer-comments answers. */
export interface AnswerComments {
  comments: AnswerComment[]
  running: { check: string; check_name: string; turn: string }[]
}

/** A passage to tint in one text row (chat/markdown rehypeAnswerMarks). */
export interface AnswerMark {
  id: string
  quote: string
  /** the words of the passage to tint; none for the whole passage */
  words?: string
  /** the CSS color of the tint */
  colour: string
  /** the passage's ref, the first piece's anchor */
  ref: string
  /** its comment is open beside it */
  active: boolean
}

/** A comment's tint color: its check's palette place, as checkColour draws a check's. Pure. */
export const tintOf = (c: Pick<AnswerComment, 'color'>): string => colourVar(c.color)

/** A raw passage as the chat draws its words: a `[[value|ref]]` citation as its value (a bare `[[ref]]` as nothing), a
 * link as its text, code and emphasis without their marks, a list item or heading without its lead. Pure. */
export function plainQuote(raw: string): string {
  return raw
    .replace(/\[\[([^\]|]*)\|[^\]]*\]\]/g, '$1')
    .replace(/\[\[[^\]]*\]\]/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/^\s*(?:[-*+]|\d+[.)]|#{1,6})\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The open comments of one text row: those on its turn whose passage its text holds. Pure. */
export function commentsOfRow(row: { text: string; turn?: string }, comments: readonly AnswerComment[]): AnswerComment[] {
  if (!row.turn) return []
  const words = plainQuote(row.text).toLowerCase()
  return comments.filter((c) => {
    if (c.status !== 'open' || c.turn !== row.turn) return false
    const q = plainQuote(c.quote).toLowerCase()
    return !!q && words.includes(q)
  })
}

/** The checks whose comments never share words, each with the other: the explainers and the heads-ups (backend
 * answer_comments.APART). */
const APART: Readonly<Record<string, string>> = { 'heads-up': 'explainers', explainers: 'heads-up' }

/** Where a comment's words stand in its passage as the chat draws it, [start, end): their first place, else the whole
 * passage (backend answer_comments._span). Pure. */
function spanOf(c: Pick<AnswerComment, 'quote' | 'words'>): [number, number] {
  const passage = plainQuote(c.quote)
  return (c.words && findQuote(passage, plainQuote(c.words))) || [0, passage.length]
}

/** Whether two comments' words meet: on one passage, their spans overlap. Pure. */
function meet(a: AnswerComment, b: AnswerComment): boolean {
  if (a.ref !== b.ref) return false
  const [x, y] = [spanOf(a), spanOf(b)]
  return x[0] < y[1] && y[0] < x[1]
}

/** The marks of one row's comments, `active` the open one. An explainer and a heads-up never share words: of two stored
 * on the same words (before the backend kept them apart, or while one of their checks was hidden), the open one is drawn,
 * else the one there first, so each tint opens its own comment and an open comment stands on its words. Pure. */
export function marksOf(comments: readonly AnswerComment[], active: string | null): AnswerMark[] {
  const drawn: AnswerComment[] = []
  for (const c of [...comments].sort((a, b) => Number(b.id === active) - Number(a.id === active)))
    if (!drawn.some((d) => APART[d.check] === c.check && meet(d, c))) drawn.push(c)
  return comments.filter((c) => drawn.includes(c)).map((c) => ({ id: c.id, quote: c.quote, words: c.words, colour: tintOf(c), ref: c.ref, active: c.id === active }))
}

/** What Go to it asked for: an `answer:` ref, and the comment to open there when it names one (shell/CommentsList). */
export interface AnswerAsk {
  ref: string
  comment?: string
}

// the last ask Go to it made that no chat has opened yet: main's chat may mount after the ask, when the chat column was
// folded or showed another chat (Rows reads it as it mounts)
let wanted: AnswerAsk | null = null
bus.on('openRef', (e) => {
  if (e.ref.startsWith('answer:')) wanted = { ref: e.ref, comment: e.comment }
})

/** The ask for an `answer:` ref that no chat opened yet, or null. */
export const askedAnswer = (): AnswerAsk | null => wanted

/** The ask was answered: its comment opened. */
export function answeredAsk(ask: AnswerAsk): void {
  if (wanted?.ref === ask.ref && wanted.comment === ask.comment) wanted = null
}

/** The open comment an ask opens: the one it names, else the first on its passage. Pure. */
export function commentAsked(comments: readonly AnswerComment[], ask: AnswerAsk): AnswerComment | null {
  const open = comments.filter((c) => c.ref === ask.ref && c.status === 'open')
  return open.find((c) => c.id === ask.comment) ?? open[0] ?? null
}

/** The workspace's comments on Claude's answers, read again on the stream's `answer-comments` record, when a check
 * changes and when the stream comes back; none while `enabled` is false. */
export function useAnswerComments(ws: string, enabled = true): { comments: AnswerComment[]; dismiss: (id: string) => Promise<void> } {
  const [comments, setComments] = useState<AnswerComment[]>([])
  useEffect(() => {
    if (!enabled) {
      setComments([])
      return
    }
    let alive = true
    const load = () =>
      checksApi
        .answerComments(ws)
        .then((got) => alive && setComments(Array.isArray(got?.comments) ? got.comments : []))
        .catch(() => undefined)
    void load()
    const offs = [bus.on('answerComments', () => void load()), bus.on('checks', () => void load()), bus.on('wsStream', (e) => e.connected && void load())]
    return () => {
      alive = false
      offs.forEach((off) => off())
    }
  }, [ws, enabled])
  return useMemo(
    () => ({
      comments,
      dismiss: async (id: string) => {
        await checksApi.dismissAnswerComment(ws, id)
        setComments((cur) => cur.map((c) => (c.id === id ? { ...c, status: 'dismissed' } : c)))
      },
    }),
    [comments, ws],
  )
}
