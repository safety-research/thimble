// Checks on Claude's answers, in the browser's chat: a check that reads an answer comments on its passages (backend
// answer_comments.py, routes GET /ws/{c}/answer-comments and POST …/{id}/dismiss|reopen, the stream's
// `answer-comments` record). Each open comment tints its passage in main's chat in its check's colour (the label palette
// place C9 sends as `color`, drawn as checkColour draws a check's), the first piece of the passage carries the anchor
// `answer:<turn>#s<n>` (a deep link `?ref=` scrolls to it), and a click opens the comment under the answer: the check's
// name, the comment, its details, and Done, which dismisses it.
//
// A comment names the text row it is on (`row`, the uuid the mirror's text records carry) and quotes its passage raw,
// as Claude wrote it. The chat draws the answer as markdown, so the passage is found in the drawn words (plainQuote:
// the quote without markdown's marks, a citation as the value it shows).
import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import { colourVar } from '../files/labels'

export interface AnswerComment {
  id: string
  check: string
  check_name: string
  /** the check's place in the label palette, 1 to 8 (backend checks.COLOURS; C9 `color`) */
  color: number
  about?: string
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

/** What GET /ws/{c}/answer-comments answers (C9). */
export interface AnswerComments {
  comments: AnswerComment[]
  running: { check: string; check_name: string; turn: string }[]
}

/** A passage to tint in one text row (chat/markdown rehypeAnswerMarks). */
export interface AnswerMark {
  id: string
  quote: string
  /** the CSS colour of the tint */
  colour: string
  /** the passage's ref, the first piece's anchor */
  ref: string
  /** its comment is open under the answer */
  active: boolean
}

/** A comment's tint colour: its check's palette place (checkColour). Pure. */
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

/** The open comments of one text row: those naming one of its uuids, or, where the chat's rows carry no uuid (an older
 * log), those whose passage its text holds. Pure. */
export function commentsOfRow(row: { text: string; uuids?: readonly string[] }, comments: readonly AnswerComment[]): AnswerComment[] {
  const open = comments.filter((c) => c.status === 'open')
  if (row.uuids?.length) return open.filter((c) => row.uuids!.includes(c.row))
  const words = plainQuote(row.text).toLowerCase()
  return open.filter((c) => {
    const q = plainQuote(c.quote).toLowerCase()
    return !!q && words.includes(q)
  })
}

/** The marks of one row's comments, `active` the open one. Pure. */
export function marksOf(comments: readonly AnswerComment[], active: string | null): AnswerMark[] {
  return comments.map((c) => ({ id: c.id, quote: c.quote, colour: tintOf(c), ref: c.ref, active: c.id === active }))
}

/** The workspace's comments on Claude's answers, read again on the stream's `answer-comments` record and when the stream
 * comes back; none while `enabled` is false or where the server has no such route. */
export function useAnswerComments(ws: string, enabled: boolean): { comments: AnswerComment[]; dismiss: (id: string) => Promise<void> } {
  const [comments, setComments] = useState<AnswerComment[]>([])
  useEffect(() => {
    if (!enabled) {
      setComments([])
      return
    }
    let alive = true
    const load = () =>
      api
        .answerComments(ws)
        .then((got) => alive && setComments(Array.isArray(got?.comments) ? got.comments : []))
        .catch(() => undefined)
    void load()
    const offs = [bus.on('answerComments', () => void load()), bus.on('wsStream', (e) => e.connected && void load())]
    return () => {
      alive = false
      offs.forEach((off) => off())
    }
  }, [ws, enabled])
  return useMemo(
    () => ({
      comments,
      dismiss: async (id: string) => {
        await api.dismissAnswerComment(ws, id)
        setComments((cur) => cur.map((c) => (c.id === id ? { ...c, status: 'dismissed' } : c)))
      },
    }),
    [comments, ws],
  )
}
