// Checks on Claude's answers, in the chat: a check whose Show in has Chat reads each answer of main's when its turn ends
// and comments on its passages (backend answer_comments.py, routes GET /ws/{c}/answer-comments and POST
// …/{id}/dismiss, the stream's `answer-comments` record). Each open comment tints the words of its passage it is about in
// main's chat in its check's color, as the terminal marks a term's words, or its whole passage when it names no words;
// the first piece of the tint carries the anchor `answer:<turn>#s<n>` (Go to it in the Comments sidebar scrolls to it and
// opens its comment), and a click opens the comment beside the passage as the comment card the canvas and the report's
// margin draw (AnswerComment.tsx AnswerCommentPop). An explainer and a heads-up never share words, so each of their
// tints opens its own comment (marksOf).
//
// Words may carry more than one mark: a citation's words a comment's words meet, or two comments' words that meet (two
// explainers, or another check's comment). A click on them opens the innermost comment, as the terminal opens an
// explainer or a heads-up before the citation it stands on; each click on them again opens the next mark out, the
// citation last, then the innermost again (nextMark). Esc or a press elsewhere closes what is open.
//
// A comment names the turn it is on (`turn`, the id the turn's `done` record names, chat/model.ts TextRow.turn) and
// quotes its passage raw, as Claude wrote it. The chat draws the answer as markdown, so the passage is found in the drawn
// words (plainQuote: the quote without markdown's marks, a citation as the value it shows), and its words in the passage.
// Once the check of the citations settled, the chat draws the words as the check left them (marks/marks.ts asChecked), so
// a comment's passage and words are carried from Claude's words into those, as the terminal carries an explainer's
// (placedOn); the Comments sidebar quotes the passage as the chat draws it (noteDrawn). A comment whose words the check
// took away (a sentence it rewrote) has no tint, and its card says so beside the answer.
//
// An explainer the analyst asked for with Explain (chat/picked.tsx, backend explain.py) is an Explainers comment too, on
// an answer of main's or of a side thread's (`chat`), whose chat tints it as main's chat does, and Go to it opens the
// chat it is in. While it is written, its chat draws its words' tint and its card (`writing`) as soon as asked
// (wantComment), and the written comment takes that card's place. Its words stand where they were selected: when they
// stand more than once in its passage, `nth` says which of their places it is about (wordsAt).
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { carrier } from '../../../../plugin/marks/message.js'
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
  /** which of the passage's places of its words it is about, from 0; none for the first */
  nth?: number
  text: string
  details?: string
  status: 'open' | 'dismissed'
  at?: string
  /** the check of the citations took its words away (placedOn): it has no tint, and its card says so */
  gone?: boolean
  /** the chat whose answer it is on: main, or a side thread (an explainer asked for there) */
  chat?: string
  /** an explainer being written (chat/picked.tsx), which has no text yet: its card shows a spinner in its place */
  writing?: boolean
  /** why that explainer was not written, which its card says in place of the spinner */
  failed?: string
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
  /** which of the passage's places of the words to tint, from 0 (wordsAt); none for the first */
  nth?: number
  /** the CSS color of the tint */
  colour: string
  /** the passage's ref, the first piece's anchor */
  ref: string
  /** its comment is open beside it */
  active: boolean
  /** words whose explainer is being written (chat/picked.tsx): tinted alone, with no comment to open yet */
  pending?: boolean
  /** its comment's check, which Explain reads off the tint (chat/picked.tsx) */
  check?: string
}

/** A comment's tint color: its check's palette place, as checkColour draws a check's. Pure. */
export const tintOf = (c: Pick<AnswerComment, 'color'>): string => colourVar(c.color)

// markdown's marks as the chat drops them, each with the groups of its match it keeps: a `[[value|ref]]` citation as its
// value (a bare `[[ref]]` as nothing), a link as its text, code and emphasis without their marks, a list item or heading
// without its lead (backend answer_comments._PLAIN)
const PLAIN: readonly (readonly [RegExp, readonly number[]])[] = [
  [/\[\[([^\]|]*)\|[^\]]*\]\]/dg, [1]],
  [/\[\[[^\]]*\]\]/dg, []],
  [/!?\[([^\]]*)\]\([^)]*\)/dg, [1]],
  [/`+([^`]*)`+/dg, [1]],
  [/(\*\*|__|~~)(.+?)\1/dg, [2]],
  [/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/dg, [1, 2]],
  [/^\s*(?:[-*+]|\d+[.)]|#{1,6})\s+/dgm, []],
]

/** A raw passage as the chat draws its words (PLAIN), white space as one space. Pure. */
export function plainQuote(raw: string): string {
  let s = raw
  for (const [re, keep] of PLAIN) s = s.replace(re, (...m: string[]) => keep.map((g) => m[g] ?? '').join(''))
  return s.replace(/\s+/g, ' ').trim()
}

/** plainQuote's words, with the place in `raw` of each of their characters (`at`). Pure. */
export function plainPlaces(raw: string): { text: string; at: number[] } {
  let text = raw
  let at = Array.from({ length: raw.length }, (_, i) => i)
  const keep = (re: RegExp, groups: readonly number[]) => {
    let s = ''
    let a: number[] = []
    let last = 0
    for (const m of text.matchAll(re)) {
      const i = m.index ?? 0
      s += text.slice(last, i)
      a = a.concat(at.slice(last, i))
      for (const g of groups) {
        const [x, y] = m.indices?.[g] ?? [i, i]
        s += text.slice(x, y)
        a = a.concat(at.slice(x, y))
      }
      last = i + m[0].length
    }
    text = s + text.slice(last)
    at = a.concat(at.slice(last))
  }
  for (const [re, groups] of PLAIN) keep(re, groups)
  // each run of white space as one space, and none at either end
  keep(/(\s)\s*/dg, [1])
  text = text.replace(/\s/g, ' ')
  const lead = text.length - text.trimStart().length
  const end = Math.max(lead, text.trimEnd().length)
  return { text: text.slice(lead, end), at: at.slice(lead, end) }
}

/** Each place of `words` in a text, [start, end), white space and case aside (backend answer_comments._find). Pure. */
function placesOf(text: string, words: string): [number, number][] {
  const tokens = words.trim().split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (!tokens.length) return []
  return [...text.matchAll(new RegExp(tokens.join('\\s+'), 'gi'))].map((m) => [m.index, m.index + m[0].length])
}

/** Where `words` stand in a passage's words, [start, end): their first place (lib/quoteFind findQuote), or with `nth` the
 * nth of their places, case and white space aside, as the backend counts them (answer_comments._find); the first when
 * the passage holds fewer. Pure. */
export function wordsAt(passage: string, words: string, nth = 0): [number, number] | null {
  const first = findQuote(passage, words)
  return nth > 0 && first ? (placesOf(passage, words)[nth] ?? first) : first
}

/** How many times `words` stand in a text, white space and case aside (backend answer_comments.times_in). Pure. */
export const timesIn = (text: string, words: string): number => placesOf(text, words).length

/** Where comment `c` stands on its row's words as the chat draws them, `drawn`, the version of `text` (Claude's words, as
 * the row holds them) the check of the citations made (marks/marks.ts asChecked): its passage carried from Claude's words
 * into the drawn ones as the terminal carries an explainer's (plugin/marks/message.js carrier), and its words found
 * there again, or, when the check changed them, carried onto the check's words for them. `gone` when the check took the
 * passage or its words away (a sentence it rewrote). A passage the row does not hold as written stands as it is. Pure. */
export function placedOn(c: AnswerComment, text: string, drawn: string): AnswerComment {
  if (drawn === text || !c.quote) return c
  const at = text.startsWith(c.quote, c.start) ? c.start : text.indexOf(c.quote)
  if (at < 0) return c
  const carry = carrier(text, drawn)
  const p = carry(at, at + c.quote.length)
  if (!p) return { ...c, gone: true }
  const quote = drawn.slice(p.start, p.end)
  const words = plainQuote(c.words ?? '')
  const was = plainPlaces(c.quote)
  const w = words ? wordsAt(was.text, words, c.nth) : null
  if (!w || findQuote(plainQuote(quote), words)) return { ...c, quote }
  const to = carry(at + was.at[w[0]], at + was.at[w[1] - 1] + 1)
  const now = plainPlaces(quote)
  const kept = to ? now.at.flatMap((i, k) => (p.start + i >= to.start && p.start + i < to.end ? [k] : [])) : []
  if (!kept.length) return { ...c, gone: true }
  const moved = now.text.slice(kept[0], kept[kept.length - 1] + 1)
  return { ...c, quote, words: moved, nth: timesIn(now.text.slice(0, kept[0]), moved) }
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

/** Where a comment's words stand in its passage as the chat draws it, [start, end): the place of them it is about
 * (wordsAt), else the whole passage (backend answer_comments._span). Pure. */
function spanOf(c: Pick<AnswerComment, 'quote' | 'words' | 'nth'>): [number, number] {
  const passage = plainQuote(c.quote)
  return (c.words && wordsAt(passage, plainQuote(c.words), c.nth)) || [0, passage.length]
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
  return comments.filter((c) => drawn.includes(c)).map((c) => ({ id: c.id, quote: c.quote, words: c.words, nth: c.nth, colour: tintOf(c), ref: c.ref, active: c.id === active, check: c.check }))
}

/** Which of the marks over clicked words a click opens. `count` marks stand on the words, from the innermost out (the
 * comments' tints, then the citation whose words hold them), and `open` is the one of them open now, -1 for none. The
 * innermost when none is open, else the one after the open one, the innermost again after the last; null when that is
 * the open one itself, a lone mark, which the click closes. Pure. */
export function nextMark(count: number, open: number): number | null {
  if (count <= 0) return null
  const next = open < 0 || open >= count ? 0 : (open + 1) % count
  return next === open ? null : next
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

// the chat of each comment the page read last (useAnswerComments), which Go to it opens (ChatPanel)
const chats = new Map<string, string>()

/** The chat whose answer comment `id` is on, as the page read it last; main for one it has not read. */
export const chatOfComment = (id: string | undefined): string => (id && chats.get(id)) || 'main'

// the comment Explain asked to open (chat/picked.tsx): the chat that draws it opens it (Rows), wherever it is
let wantedComment: string | null = null
const wantedSubs = new Set<() => void>()

/** Open comment `id` once a chat draws it: now when one does, else when the comments are read again. */
export function wantComment(id: string): void {
  wantedComment = id
  wantedSubs.forEach((f) => f())
}

/** The comment Explain asked to open, which the chat that draws it takes (takeComment). */
export function useWantedComment(): string | null {
  return useSyncExternalStore(
    (f) => {
      wantedSubs.add(f)
      return () => void wantedSubs.delete(f)
    },
    () => wantedComment,
  )
}

/** The comment Explain asked to open is open now: no chat opens it again. */
export function takeComment(id: string): void {
  if (wantedComment === id) wantedComment = null
}

/** The open comment an ask opens: the one it names, else the first on its passage. Pure. */
export function commentAsked(comments: readonly AnswerComment[], ask: AnswerAsk): AnswerComment | null {
  const open = comments.filter((c) => c.ref === ask.ref && c.status === 'open')
  return open.find((c) => c.id === ask.comment) ?? open[0] ?? null
}

// the passages of the comments as main's chat draws them now (Rows, placedOn), by comment, which the Comments sidebar
// quotes; none for a comment whose words the check of the citations took away
let drawnQuotes: ReadonlyMap<string, string> = new Map()
const drawnSubs = new Set<() => void>()

/** The comments as main's chat draws them now (placedOn): the sidebar quotes their passages. */
export function noteDrawn(comments: readonly AnswerComment[]): void {
  const next = new Map(drawnQuotes)
  for (const c of comments) {
    if (c.gone) next.delete(c.id)
    else next.set(c.id, plainQuote(c.quote))
  }
  if (next.size === drawnQuotes.size && [...next].every(([id, q]) => drawnQuotes.get(id) === q)) return
  drawnQuotes = next
  drawnSubs.forEach((f) => f())
}

/** The passages main's chat draws now, by comment (noteDrawn). */
export function useDrawnQuotes(): ReadonlyMap<string, string> {
  return useSyncExternalStore(
    (f) => {
      drawnSubs.add(f)
      return () => void drawnSubs.delete(f)
    },
    () => drawnQuotes,
  )
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
        .then((got) => {
          const list = Array.isArray(got?.comments) ? got.comments : []
          for (const c of list) chats.set(c.id, c.chat || 'main')
          if (alive) setComments(list)
        })
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
