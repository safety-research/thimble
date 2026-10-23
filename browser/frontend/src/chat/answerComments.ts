// Checks on Claude's answers, in the chat: a check whose Show in has Chat reads each answer of main's when its turn ends
// and comments on its passages (backend answer_comments.py, routes GET /ws/{c}/answer-comments and POST
// …/{id}/dismiss, the stream's `answer-comments` record). Each open comment tints its passage in main's chat in its
// check's color, as the report tints a commented passage; the first piece of the passage carries the anchor
// `answer:<turn>#s<n>` (Go to it in the Comments sidebar scrolls to it), and a click opens the comment under the answer
// as the comment card the canvas and the report's margin draw.
//
// A comment names the turn it is on (`turn`, the id the turn's `done` record names, chat/model.ts TextRow.turn) and
// quotes its passage raw, as Claude wrote it. The chat draws the answer as markdown, so the passage is found in the drawn
// words (plainQuote: the quote without markdown's marks, a citation as the value it shows).
import { useEffect, useMemo, useState } from 'react'
import { checksApi } from '../lib/api'
import { bus } from '../lib/bus'
import { colourVar } from '../files/labels'

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
  /** the CSS color of the tint */
  colour: string
  /** the passage's ref, the first piece's anchor */
  ref: string
  /** its comment is open under the answer */
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

/** The marks of one row's comments, `active` the open one. Pure. */
export function marksOf(comments: readonly AnswerComment[], active: string | null): AnswerMark[] {
  return comments.map((c) => ({ id: c.id, quote: c.quote, colour: tintOf(c), ref: c.ref, active: c.id === active }))
}

// the last `answer:` ref Go to it asked for and no chat has opened yet: main's chat may mount after the ask, when the
// chat column was folded or showed another chat (Rows reads it as it mounts)
let wanted: string | null = null
bus.on('openRef', (e) => {
  if (e.ref.startsWith('answer:')) wanted = e.ref
})

/** The `answer:` ref asked for that no chat opened yet, or null. */
export const askedAnswer = (): string | null => wanted

/** The ask was answered: its comment opened. */
export function answeredAsk(ref: string): void {
  if (wanted === ref) wanted = null
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
