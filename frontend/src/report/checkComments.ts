// The checks and comments of a document, pure: the checks the Comments pane lists with their colours, the open
// comments a document carries, which passages they tint, the ruler's lanes, the margin's stacking so comment cards
// never overlap, and the edits the pane makes to its list. A check covers the documents, the cards or both; its runs on
// the cards are `runs['@canvas']` (CANVAS).
import { colourVar, LABEL_ORDER } from '../files/labels'
import type { RulerColumn, RulerTick } from '../files/Ruler'
import { hhmm } from '../lib/time'
import type { Check, CheckCover, CheckRun, WriteupComment, WriteupSentence } from '../lib/types'

/** the analyst's own comments: the no-match grey, since they judge nothing */
export const NOTE_COLOR = 'var(--label-none)'
/** The built-in check the citation check's unverified tag belongs to (prompts/checks/unverified.md). */
export const UNVERIFIED = 'unverified'
/** The prefix of a tag's id, so it never collides with a stored comment's. */
export const TAG_PREFIX = 'tag:'
/** The author of a note main left with add_comment (backend comments.py), which no check owns. */
export const CLAUDE_AUTHOR = 'claude'
/** The cards as a check's run target, beside the documents' slugs (backend checks.CANVAS). */
export const CANVAS = '@canvas'

/** What the pane, the tints and the margin read of a check. */
export type CheckInfo = Pick<Check, 'id' | 'name' | 'colour'>

/** A check's colour: its label palette index as the token that carries it. */
export const checkColour = (check: Pick<Check, 'colour'> | null | undefined): string => colourVar(check?.colour)

/** One comment as the margin and the Checks pane show it. */
export interface DocComment {
  id: string
  /** the sentence (or section heading) it is on */
  sid: string
  /** the passages it tints: every sentence of its paragraph for a check's comment on a whole paragraph, else `sid` */
  span: string[]
  /** the check whose run left it; null for the analyst's own and for Claude's notes */
  check: string | null
  text: string
  author: string
  /** the refs the check's comment rests on */
  evidence: string[]
  /** the citation check's tag, which is no comment: nothing to resolve */
  tag: boolean
  /** what supports the statement (`text`), shown on request (backend canvas_comments.note_of) */
  details?: string
}

/** The refs a comment cites that its details do not show as chips already, such as those its statement's citations,
 * flattened for reading, left in its evidence. */
export function extraEvidence(evidence: readonly string[], details: string): string[] {
  return evidence.filter((r) => !details.includes(r))
}

/** The refs a check's comment rests on, from its `evidence` (refs joined by spaces), each once, without the punctuation
 * a ref can carry from the prose it was cut from. */
export function evidenceRefs(evidence: string | null | undefined): string[] {
  const out: string[] = []
  for (const raw of String(evidence ?? '').split(/\s+/)) {
    const ref = raw.replace(/^[\[(]+|[\]),;:.]+$/g, '')
    if (ref && !out.includes(ref)) out.push(ref)
  }
  return out
}

/** The check a stored comment belongs to, null for the analyst's own. */
export function commentCheck(cm: Pick<WriteupComment, 'check'>): string | null {
  return cm.check ? String(cm.check) : null
}

/** The document's open comments in document order: stored open comments, then the citation check's unverified tags
 * on sentences the Unverified check left no open comment on. `order` is the passage ids in reading order (unknown
 * passages last); `paragraphs` maps each sentence to its paragraph, for comments on a whole paragraph. */
export function openComments(comments: readonly WriteupComment[] | undefined, sentences: readonly WriteupSentence[], order: readonly string[] = [], paragraphs: ReadonlyMap<string, readonly string[]> = new Map()): DocComment[] {
  const out: DocComment[] = []
  const marked = new Set<string>()
  for (const cm of comments ?? []) {
    if (!cm || (cm.status ?? 'open') !== 'open') continue
    const sid = String(cm.sentence_id ?? '')
    const text = String(cm.text ?? '').trim()
    if (!sid || !text) continue
    const check = commentCheck(cm)
    if (check === UNVERIFIED) marked.add(sid)
    const span = cm.paragraph ? [...(paragraphs.get(sid) ?? [sid])] : [sid]
    out.push({ id: cm.id, sid, span, check, text, author: cm.author, evidence: evidenceRefs(cm.evidence), tag: false, details: String(cm.details ?? '').trim() })
  }
  for (const s of sentences) {
    if (!(s.tags ?? []).includes('unverified') || marked.has(s.id)) continue
    out.push({ id: TAG_PREFIX + s.id, sid: s.id, span: [s.id], check: UNVERIFIED, text: s.tag_notes?.unverified?.trim() || 'Not checked', author: 'check', evidence: [], tag: true, details: '' })
  }
  if (!order.length) return out
  const rank = new Map(order.map((id, i) => [id, i]))
  return out
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (rank.get(a.c.sid) ?? Infinity) - (rank.get(b.c.sid) ?? Infinity) || a.i - b.i)
    .map((x) => x.c)
}

/** The name a comment's card shows: its check's, else Claude for a note of main's and You for the analyst's own. */
export function commentName(c: Pick<DocComment, 'check' | 'author'>, look: Pick<CheckLook, 'name'>): string {
  if (c.check != null) return look.name(c.check)
  return c.author === CLAUDE_AUTHOR ? 'Claude' : 'You'
}

/** The comments the page shows: the analyst's and Claude's notes always, a check's while that check is on. */
export function shownComments(comments: readonly DocComment[], on: ReadonlySet<string>): DocComment[] {
  return comments.filter((c) => c.check == null || on.has(c.check))
}

/** The open comments per check, whether the check is on or off. */
export function countsByCheck(comments: readonly { check: string | null }[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const c of comments) if (c.check != null) out.set(c.check, (out.get(c.check) ?? 0) + 1)
  return out
}

/** How the page draws a comment's check: its colour, its name and its place in the pane, which orders the ruler's
 * columns and decides a passage's tint. */
export interface CheckLook {
  colour: (check: string | null) => string
  name: (check: string | null) => string
  rank: (check: string | null) => number
}

export function checkLook(checks: readonly CheckInfo[]): CheckLook {
  const by = new Map(checks.map((c, i) => [c.id, { c, i }]))
  return {
    colour: (id) => (id == null ? NOTE_COLOR : checkColour(by.get(id)?.c)),
    name: (id) => (id == null ? 'You' : (by.get(id)?.c.name ?? id)),
    // the analyst's comments after every check, and a check the pane does not list after the listed ones
    rank: (id) => (id == null ? checks.length + 1 : (by.get(id)?.i ?? checks.length)),
  }
}

/** How one passage is tinted: its colour, the comments on it (the card a click opens first), whether one is active. */
export interface Flag {
  color: string
  cids: string[]
  active: boolean
}

/** The tint of every commented passage: the active comment's colour, else that of the first check in pane order,
 * the analyst's own last. */
export function passageFlags(comments: readonly DocComment[], active: string | null, look: CheckLook): Map<string, Flag> {
  const by = new Map<string, DocComment[]>()
  for (const c of comments) {
    for (const sid of c.span) {
      const list = by.get(sid)
      if (list) list.push(c)
      else by.set(sid, [c])
    }
  }
  const out = new Map<string, Flag>()
  for (const [sid, list] of by) {
    const on = list.find((c) => c.id === active)
    const first = list.reduce((a, b) => (look.rank(b.check) < look.rank(a.check) ? b : a))
    out.set(sid, { color: look.colour((on ?? first).check), cids: list.map((c) => c.id), active: !!on })
  }
  return out
}

/** The tint of the space between two sentences: shared paragraph comments when both are drawn alike, else null. */
export function gapFlag(a: Flag | undefined, b: Flag | undefined): Flag | null {
  if (!a || !b || a.color !== b.color || a.active !== b.active) return null
  const cids = a.cids.filter((id) => b.cids.includes(id))
  return cids.length ? { color: a.color, cids, active: a.active } : null
}

/** The margin's layout: each card at its passage's top, pushed below the card before it. With `anchor`, that card
 * stands exactly at its passage and the others are pushed up or down around it. */
export function stackCards(items: readonly { id: string; top: number; height: number }[], gap = 8, anchor: string | null = null): Map<string, number> {
  const list = [...items].sort((a, b) => a.top - b.top)
  const tops = list.map((it) => Math.round(it.top))
  const k = anchor ? list.findIndex((it) => it.id === anchor) : -1
  for (let i = 1; i < list.length; i++) if (i !== k) tops[i] = Math.max(tops[i], tops[i - 1] + list[i - 1].height + gap)
  for (let i = k - 1; i >= 0; i--) tops[i] = Math.min(tops[i], tops[i + 1] - list[i].height - gap)
  return new Map(list.map((it, i) => [it.id, tops[i]]))
}

/** The ruler's lanes: one per check that is on, in pane order, then the analyst's comments, each with a mark per
 * shown passage. `spanOf` gives a passage's top and bottom in px (null when hidden); `total` is the page height. */
export function checkColumns(shown: readonly DocComment[], on: ReadonlySet<string>, checks: readonly CheckInfo[], spanOf: (sid: string) => [number, number] | null, total: number): RulerColumn[] {
  const column = (id: string, name: string, colour: string, list: readonly DocComment[]): RulerColumn => {
    const seen = new Set<string>()
    const ticks: RulerTick[] = []
    for (const c of list) {
      if (seen.has(c.sid)) continue
      seen.add(c.sid)
      const span = spanOf(c.sid)
      if (span) ticks.push({ from: span[0] + 1, to: Math.max(span[0] + 1, span[1]), colour, value: c.sid })
    }
    return { id, name, total, ticks }
  }
  const out = checks.filter((c) => on.has(c.id)).map((c) => column(c.id, c.name, checkColour(c), shown.filter((cm) => cm.check === c.id)))
  const notes = shown.filter((cm) => cm.check == null)
  if (notes.length) out.push(column('note', 'You', NOTE_COLOR, notes))
  return out
}

// ---- the pane's list ----

/** The ids of the checks that are on. */
export const shownIds = (checks: readonly Pick<Check, 'id' | 'shown'>[]): Set<string> => new Set(checks.filter((c) => c.shown).map((c) => c.id))

/** A check's latest run on a document, or on the cards (CANVAS), or null. */
export const runOf = (check: Pick<Check, 'runs'>, doc: string): CheckRun | null => check.runs?.[doc] ?? null

/** What a check comments on: the documents unless the server says otherwise. */
export const coversOf = (check: Pick<Check, 'covers'>): CheckCover[] => (check.covers?.length ? check.covers : ['documents'])

/** Whether a check's rows belong to a surface: the cards (CANVAS), or a document. */
export const coversSurface = (check: Pick<Check, 'covers'>, surface: string): boolean => coversOf(check).includes(surface === CANVAS ? 'cards' : 'documents')

/** The checks a surface's Comments pane lists, in the server's order. */
export const checksFor = <T extends Pick<Check, 'covers'>>(checks: readonly T[], surface: string): T[] => checks.filter((c) => coversSurface(c, surface))

/** What a Checks pane row shows in its count's place: null while running or with no result, else the count. */
export function rowCount(run: Pick<CheckRun, 'status'> | null, open: number): number | null {
  if (run?.status === 'running') return null
  return open > 0 || run?.status === 'done' ? open : null
}

/** What the Checks pane's open row says of a run: its state, when it ended, its comment count or why it failed. */
export function runLine(run: Pick<CheckRun, 'status' | 'chat' | 'started' | 'ended' | 'comments' | 'summary' | 'waiting'> | null): string {
  if (!run) return ''
  const at = hhmm(run.ended || run.started)
  if (run.status === 'running') {
    if (run.waiting === 'writer') return 'Runs once the writer has finished'
    if (run.waiting === 'queued' || !run.chat) return 'Queued: at most 3 checks run at once'
    return hhmm(run.started) ? `Running since ${hhmm(run.started)}` : 'Running'
  }
  if (run.status === 'failed') return `Failed${at ? ` at ${at}` : ''}${run.summary ? `: ${run.summary}` : ''}`
  if (run.status === 'stopped') return `Stopped${at ? ` at ${at}` : ''}`
  const n = run.comments ?? 0
  return `Ran${at ? ` at ${at}` : ''}, ${n} comment${n === 1 ? '' : 's'}`
}

/** The list with one check turned on or off. */
export const withShown = (checks: readonly Check[], id: string, shown: boolean): Check[] => checks.map((c) => (c.id === id ? { ...c, shown } : c))

/** The list with a check as the server answered it: in its place, or at the end for a new one. */
export function withCheck(checks: readonly Check[], check: Check): Check[] {
  return checks.some((c) => c.id === check.id) ? checks.map((c) => (c.id === check.id ? check : c)) : [...checks, check]
}

/** The list with one run on a document updated from a server answer or a stream record (a new run when unknown). */
export function withRun(checks: readonly Check[], id: string, doc: string, run: Partial<CheckRun>): Check[] {
  return checks.map((c) => {
    if (c.id !== id || !doc) return c
    const was = c.runs?.[doc]
    const same = !!was && (run.run == null || run.run === was.run)
    const base: CheckRun = same ? was : { run: '', status: 'running', chat: '', started: '', covered: [], seen: was?.seen ?? [], comments: 0, summary: '' }
    const next = Object.fromEntries(Object.entries(run).filter(([, v]) => v !== undefined)) as Partial<CheckRun>
    return { ...c, runs: { ...(c.runs ?? {}), [doc]: { ...base, ...next } } }
  })
}

/** The places of the label palette a check's color may take, 1 to 8, in the order new checks take them, as new label
 * values do (LABEL_ORDER; the server's checks.NEW_COLOURS). */
export const CHECK_COLOURS: readonly number[] = LABEL_ORDER.filter((k) => k <= 8)

/** The color the server gives a new check: the first unused of CHECK_COLOURS, else the least used. */
export function freeColour(checks: readonly Pick<Check, 'colour'>[]): number {
  const uses = (k: number) => checks.filter((c) => c.colour === k).length
  let best = CHECK_COLOURS[0]
  for (const k of CHECK_COLOURS) {
    if (!uses(k)) return k
    if (uses(k) < uses(best)) best = k
  }
  return best
}

/** Whether a name is taken by another check, compared as the server does (spaces collapsed, case ignored, against
 * names and ids). */
export function nameTaken(checks: readonly Pick<Check, 'id' | 'name'>[], name: string): boolean {
  const key = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()
  const n = key(name)
  return !!n && checks.some((c) => key(c.name) === n || c.id === n)
}
