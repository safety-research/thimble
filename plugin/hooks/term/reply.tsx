// Main's chat as thimble-term draws it: a reply's text on the grid (SPEC.md, "The visual system", "The
// chat column"), each citation purple and underlined (red with × when its place does not hold its value), and the cards
// the turn made under the turn's last reply, each once, in its last state and its border, its takeaway under it. Also
// a side thread's answer and a document in the panel, on the panel's grid. Its data comes from thimble-term's state
// (hooks/term.ts).
//
// The model's Markdown is drawn as Claude Code draws it (bold bold, headings bold, inline code coloured); prose and
// cards share one left edge (column 2, where Claude Code's own reply text starts after its ⏺) and one width (the
// terminal's), with no measure; a card has its full round border, which stands in for the blank rows next to it. The
// margin is the ⏺'s column: it holds the blue `?` of the passage under the pointer (a heading's asks about its whole
// section) and a blue `↳` beside a passage or a card a side thread was asked about, whose click opens that thread; on
// the reply's first row the mark takes the ⏺'s cell (Matt, 2026-10-07: "indent 2 chars and replace the dot with ? when
// they overlap"), so a mark never adds indent.
//
// A citation's state (cite.ts chipLook): ` ◌` as part of it, purple and underlined, while its place is resolved or
// thimble's links check runs on a card's takeaway, nothing once it is found (never a ✓), a red × when it is not there or the check found another
// value. A citation the check rewrote (another value, another place) reads as rewritten, with no mark; its panel shows
// what Claude wrote. The citation under the pointer shows its status in plain words (where it was found, or why not)
// on a quiet box. With "Citation marks" off a citation is a plain link: no mark, no check.
//
// A passage of main's answer a check commented on (SPEC-v2 3.12) is tinted in the check's color (16%, 30% while its
// comment is open in the panel) and carries a flag ⚑ in that color in the margin on its first row; its paragraph is
// drawn by the mod's own layout (para.tsx, cite.ts), which knows where it wraps. A click on either opens the panel at
// Checks. In fullscreen a card's border row ends with a ↗ that opens the card in the browser; a custom card draws its
// table or its words and a `view in browser ↗` link.
import type { RenderElement, ResolveInput } from 'claude-code'

import type { TermCard, TermLinks, TermVerdict } from './types'
import { SPIN, blockClaims, blockLayout, chipLook, citeLabel, passageIn, plainCites, richMarkdown, showsValue, streamLink, tintCells } from './cite'
import type { ChipView, Tint } from './cite'
import { LINK } from './chrome'
import { cardLayout, labelHead, placeWords, titleLines, wrapRows } from './draw'
import type { CardData, CardExample } from './draw'
import { focusFromRef, focusItem } from './anim'
import type { Focus } from './anim'
import type { Target } from './gestures'
import { bareCard, cardTag, cardWords, chipPlace, cid, questionOf, citations, clip, curlyQuotes, isChip, labelRef, labelRunning, mdPieces, noteLabelName, noteQuestion, outputLine, parseReply, quoted, sectionsOf } from './lib'
import { linesEl } from './lines'
import type { Block, Citation, Run } from './lib'
import { COLORS, FLAG, labelHex, paintLines, themeNow, tintOf } from './paint'
import { labelLinkStale, labelsOf } from './model'
import { loadCards, queueCitations, rt } from './term'
import type { AnswerComment } from './contracts'
import { openInBrowser } from './offramp'
import { featureOn } from './settings'
import type { Ctx } from './ctx'
import type { ThimbleLabel } from './cell'

/** The columns left of a reply's blocks in main's chat, Claude Code's own: its ⏺ and a space. The reply's margin ("?"
 *  on hover, a passage's ↳) is the ⏺'s cell, the mark in its place on the row where both fall. */
export const MARGIN = 2
/** A reply's margin in the panel (a side thread's answer, a document): its marks at M, its text at A0. */
export const PANEL_MARGIN = 2

/** The mark beside a passage or a card a side thread can be asked about, dim; the pointer turns it into a "?". */
export const DOT = '·'

/** The "?" that asks a side thread: blue under the pointer, drawn out of the flow over the cell's glyph (the ⏺ or a
 *  passage's dot) and shown only while the pointer is over the row, which the row's keyed Box scopes (so its own Box
 *  takes no key: a keyed one would scope its own hover, and a hidden Box is never under the pointer). */
function askMark(cx: Ctx, e: ResolveInput, key: string, press: () => void): RenderElement {
  const { Box, Button } = cx.els(e)
  return (
    <Box width={1} display="none" hover={{ display: 'flex' }} position="absolute" top={0} left={0}>
      <Button key={key} label="?" plain hover={{ color: LINK }} onPress={press} />
    </Box>
  )
}

const CARD_REF = /^(?:card|cell):([A-Za-z0-9_-]+)(?:@[A-Za-z0-9_]+)?(?:#(.*))?$/
const CALL_REF = /^call:[A-Za-z0-9_-]+(?:#L(\d+)(?:-L?(\d+))?)?$/

// ------------------------------------------------------------------------------------------------ a citation in words

/** A card by its question, cut at a word, never its id: as its drawing data has it, else as a read of it noted it
 *  (lib.ts noteQuestion: a document's cards are read before it is drawn). */
export async function cardName(cx: Ctx, id: string): Promise<string> {
  const q = ((await cx.card(id))?.data as CardData | undefined)?.question || questionOf(id)
  return q ? cardWords(q) : 'the card'
}

/** A ref as the analyst reads it: a card's place by the card's question, a command's output by its line, never an id;
 *  any other place in words. */
export async function placeName(cx: Ctx, ref: string): Promise<string> {
  // lines the card printed, by its question and the output's lines
  const out = outputLine(ref)
  if (out) {
    const lines = out.last !== out.first ? `lines ${out.first}-${out.last}` : `line ${out.first}`
    const name = await cardName(cx, out.card)
    return name === 'the card' ? `the card's output ${lines}` : `${name} output ${lines}`
  }
  const m = CARD_REF.exec(ref)
  // a card's output line (`card:<id>@out0#L8`) by its line, a cell by its column and row
  if (m) return m[2] ? `${await cardName(cx, m[1]!)} · ${/^L\d+$/.test(m[2]) ? `line ${m[2].slice(1)}` : m[2].replace('/', ' ')}` : cardName(cx, m[1]!)
  const call = CALL_REF.exec(ref)
  if (call) return `the command's output${call[1] ? ` · line ${call[1]}${call[2] && call[2] !== call[1] ? `-${call[2]}` : ''}` : ''}`
  return placeWords(ref)
}

/** A reason as the analyst reads it: citations as their shown words, a card by its question, a command's output as
 *  `the command`, no card file's path. */
export async function plainWhy(cx: Ctx, why: string): Promise<string> {
  let out = plainCites(why)
  for (const m of [...out.matchAll(/\b(?:card|cell)[: ]([A-Za-z0-9_-]{4,})/g)]) {
    const known = await cx.card(m[1]!)
    if (known || /^[0-9a-f]{6,12}$/.test(m[1]!)) out = out.replace(m[0], await cardName(cx, m[1]!))
  }
  return out
    .replace(/\bcall[: ](?=[a-z]*\d)[0-9a-z]{3,12}\b/g, 'the command')
    .replace(/\S*notebooks\/[A-Za-z0-9_-]+\.json/g, 'its card file')
}

const ID_IN_TEXT = /\b(?:card|cell):([A-Za-z0-9_-]{4,})/g

/** Hex ids in a row's words (an agent's step in the panel), as the card's question cut at a word (or `card`): the
 *  analyst never reads an id. */
export async function scrubIds(cx: Ctx, text: string): Promise<string> {
  let out = text
  for (const m of text.matchAll(ID_IN_TEXT)) {
    const tc = await cx.card(m[1]!)
    const q = (tc?.data as { question?: string } | null | undefined)?.question
    out = out.replace(m[0], q ? cardWords(q) : 'card')
  }
  return out
}

const BARE_CARD = /^(?:card:|cell:)?([A-Za-z0-9_-]{6,})$/
const CARD_EMBED = /\[\[(?:card|cell):([A-Za-z0-9_-]+)\]\]|!\[[^\]\n]*\]\((?:card|cell):([A-Za-z0-9_-]+)\)/g

// the keys of a thimble tool's input whose values are words (a question, a takeaway, a message), not code or a name
const PROSE_KEYS = new Set(['question', 'takeaway', 'text', 'message', 'request', 'brief', 'title', 'caption', 'name'])

/** A value of a thimble tool's input as its row in Claude Code shows it (the row and ctrl+o's detailed view): the
 *  card a `card` names by its question alone, which the key already says is a card; elsewhere a citation as its words,
 *  a card it embeds or names by its question in curly quotation marks; each question cut at a word. No id. Words keep
 *  no straight quotation marks, which Claude Code would escape (`\"Agent\"`): curly ones stand for them. */
export async function toolWords(cx: Ctx, key: string, value: string): Promise<string> {
  const question = async (id: string) => ((await cx.card(id))?.data as { question?: string } | null | undefined)?.question ?? ''
  const bare = key === 'card' ? BARE_CARD.exec(value.trim()) : null
  if (bare) return curlyQuotes(clip(await question(bare[1]!), 60)) || value
  // a question in curly quotation marks keeps its own quoted words in single ones
  const named = (q: string) => `card “${clip(q, 40).replace(/"([^"]*)"/g, '‘$1’')}”`
  let out = value
  for (const m of [...value.matchAll(CARD_EMBED)]) {
    const q = await question((m[1] ?? m[2])!)
    out = out.replace(m[0], q ? named(q) : 'a card')
  }
  // a tool's own words: a place cited alone reads in them as written, not as a reference in parentheses
  out = plainCites(out, false)
  for (const m of [...out.matchAll(ID_IN_TEXT)]) {
    const q = await question(m[1]!)
    out = out.replace(m[0], q ? named(q) : 'a card')
  }
  return PROSE_KEYS.has(key) ? curlyQuotes(out) : out
}

/** Where a citation's place is, in words: on the card, in the command's output at a line, in a file at a line. */
export function whereWords(ref: string): string {
  if (CARD_REF.test(ref)) return 'on the card'
  const call = CALL_REF.exec(ref)
  if (call) return `in the command's output${call[1] ? `, line ${call[1]}` : ''}`
  return `in ${placeWords(ref)}`
}

/** What thimble's links check of a card's takeaway says of one of its citations (backend verify.py): `running` while
 *  it runs, `verified` once it found the value at its place, `refuted` with why and the value the place shows when it
 *  found another, `typed` with why when the card's code types the value in rather than computes it. `fixed`: what
 *  Claude wrote, where the check rewrote the citation in place (its value `was`, its place `from`), and why. */
export function linkCheck(l: TermLinks | undefined, c: Citation): { state?: string; why?: string; source?: string; fixed?: { was: string; from: string; why: string } } {
  if (!l) return {}
  const key = `${c.display ?? ''}|${c.ref}`
  const mine = (k: string) => k === key || k.endsWith(`|${c.ref}`)
  const f = (l.fixed ?? []).find(x => x.key === key)
  const fixed = f ? { fixed: { was: f.was, from: f.from, why: f.why } } : {}
  const b = l.broken.find(x => x.key === key) ?? l.broken.find(x => mine(x.key))
  if (b) return { state: 'refuted', why: b.why, source: b.source }
  const t = (l.typed ?? []).find(x => x.key === key) ?? (l.typed ?? []).find(x => mine(x.key))
  if (t) return { state: 'typed', why: t.why }
  if (l.pending) return { state: 'running', ...fixed }
  if (l.checked && l.ok.some(mine)) return { state: 'verified', ...fixed }
  return fixed
}

/** A citation's status in plain words (SPEC.md, section 5, "Words that recur"): `◌ checking`, `found on the
 *  card`, `found in revisions.jsonl line 10566`, `found in the command's output, line 1`, `found in …; its value is not
 *  checked` for words that show no value, `not found …`; after thimble's links check, `…, and a script got the same
 *  number`, `…, but a script got 5,883` or `…; ◌ being checked`. It agrees with the link's colour and mark. */
export async function citeStatus(cx: Ctx, c: Citation, v: TermVerdict | undefined, check: { state?: string; why?: string; source?: string } = {}): Promise<string> {
  const where = whereWords(c.ref)
  const status = v?.status ?? 'pending'
  const place =
    status === 'pending' || !v
      ? '◌ checking'
      : status === 'missing'
        ? `not found: ${await placeName(cx, c.ref)} does not exist`
        : status === 'differs'
          ? `not found ${where}`
          : c.display !== null && !showsValue(c.display)
            ? `found ${where}; its value is not checked`
            : `found ${where}`
  if (check.state === 'verified') return `${place}, and a script got the same number`
  if (check.state === 'refuted') return `${place}, but a script got ${check.source || 'another value'}`
  if (check.state === 'typed') return `${place}, but ${check.why || 'typed in the code, not computed'}`
  if (check.state === 'running') return `${place}; ◌ being checked`
  return place
}

/** A citation as its link draws: its label, purple, red with × once it failed, ` ◌` as part of it while it is checked (its
 *  place resolved, thimble's links check of the card whose takeaway it is in, `card`), and its tip (its status in plain words, and why for a problem). A chip (a
 *  citation with no words of its own, `[ card ]`) has its place in full words first in its tip (`card "How many pages…"
 *  · found`), since its brackets name it short. */
export async function chipOf(cx: Ctx, c: Citation, card?: string): Promise<ChipView> {
  const chip = isChip(c) ? { chip: true } : {}
  // "Citation marks" off: a plain link, unchecked
  if (!featureOn('citationMarks')) return { label: citeLabel(c), state: 'link', mark: '', spin: false, tip: '', ...chip }
  // a label's link (`[33](concept:<id>/yes)`): purple, no check, a click opens the label at its value; in a card's
  // takeaway, red with × once the label counts another number (a verdict changed the counts), its tip the count now
  const lr = labelRef(c.ref)
  if (lr) {
    const opens = lr.value ? `opens the label at its value ${quoted(lr.value)}` : 'opens the label'
    // its name, for a link with no words of its own (lib.ts chipWords); the labels read when no drawing read them yet
    const now = await labelNow(cx, lr.id)
    if (now?.name) noteLabelName(lr.id, now.name)
    else if (!now) rt.wantLabels = true
    const stale = card ? labelLinkStale(c.display, now, lr.value) : ''
    const named = chip.chip && now?.name ? `label ${quoted(clip(now.name, 40))} · ` : ''
    return { label: citeLabel(c), state: stale ? 'failed' : 'link', mark: stale ? '×' : '', spin: false, tip: stale ? `${stale} · ${opens}` : `${named}${opens}`, ...chip }
  }
  const v = await cx.verdict(cid(c.raw))
  const check = card ? linkCheck((await cx.card(card))?.links, c) : {}
  const look = chipLook(v?.status ?? 'pending', undefined, check.state)
  const problem = v?.status === 'missing' || v?.status === 'differs'
  const why = problem ? await plainWhy(cx, v?.why ?? '') : check.state === 'refuted' && check.why ? await plainWhy(cx, check.why) : ''
  const status = await citeStatus(cx, c, v, check)
  if (chip.chip) {
    // the place in full words, then `found`, `◌ checking` or why it is not found
    const place = chipPlace(c) || (await placeName(cx, c.ref))
    const said = status.startsWith('found') ? status.replace(/^found (?:on the card|in the command's output(?:, line \d+(?:-\d+)?)?|in .+?)(?=;|,|$)/, 'found') : status
    return { label: citeLabel(c), ...look, tip: [place, said, why].filter(Boolean).join(' · '), ...chip }
  }
  const tip = [status, why].filter(Boolean).join(' · ')
  return { label: citeLabel(c), ...look, tip }
}

/** A label as thimble-term last read it: the one a label card read (term.ts labelFor), else the labels list's. */
async function labelNow(cx: Ctx, id: string): Promise<ThimbleLabel | null> {
  const read = rt.labelRead.get(id)
  if (read) return read
  const list = (await cx.surface('labels')) as { ok: boolean; value?: unknown } | undefined
  return list?.ok ? (labelsOf(list.value).find(l => l.id === id) ?? null) : null
}

/** A file URL for a citation's place: a file of the folder, or the group file that holds a card. */
export async function placeUrl(cx: Ctx, ref: string): Promise<string> {
  const base = ref.split('#', 1)[0] ?? ''
  const m = CARD_REF.exec(base)
  const root = (await cx.root().catch(() => '')).replace(/\/+$/, '')
  let file = base.startsWith('/') ? base : `${root}/${base}`
  if (m) {
    const g = (await cx.card(m[1]!))?.group
    file = rt.sc ? `${rt.sc.ws}/notebooks${g ? `/${g}.json` : ''}` : `${root}`
  } else if (CALL_REF.test(base)) file = root
  return `file://${encodeURI(file).replace(/[()]/g, ch => `%${ch.charCodeAt(0).toString(16)}`)}`
}

// the sentence each citation drawn stands in, by its claim's key (cite.ts claimKey): what its panel's `source` row shows
// and what a thread asked about it is told
const claimSentences = new Map<string, string>()

/** The sentence (a table's row) a citation drawn stands in, by its claim's key; '' when none was drawn. */
export function claimSentence(key: string | undefined): string {
  return key ? (claimSentences.get(key) ?? '') : ''
}

// the card whose takeaway holds each citation drawn there, by its claim's key: its citation panel shows that card's links
// check, as the chat does
const claimCards = new Map<string, string>()

/** The card whose takeaway holds a citation drawn, by its claim's key; '' for a citation of a reply's prose. */
export function claimCard(key: string | undefined): string {
  return key ? (claimCards.get(key) ?? '') : ''
}

// ------------------------------------------------------------------------------------------------ threads asked

const flat = (s: string) => plainCites(s).replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim()

/** The thread asked about a passage, by its words: a side thread whose anchor text is the passage's (or holds it), or
 *  one asked about a citation in the passage (its anchor the cited place, its anchor text the citation's sentence, which
 *  the passage holds); for a card (`card:<id>`), a thread anchored on it or on a value it shows, or one asked about a
 *  passage of its takeaway (a citation in it, whose anchor is the cited place). */
async function threadAbout(cx: Ctx, words: string): Promise<string> {
  const card = /^card:([A-Za-z0-9_-]+)$/.exec(words)
  if (card) {
    const id = card[1]!
    const threads = await cx.threads()
    const on = threads.find(x => /^(?:card|cell):/.test(x.anchor) && x.anchor.replace(/^cell:/, 'card:').split(/[#@,]/)[0] === `card:${id}`)
    if (on) return on.id
    const takeaway = flat((await cx.card(id))?.takeaway ?? '')
    if (takeaway.length < 8) return ''
    return threads.find(x => x.anchorText && flat(x.anchorText).length >= 12 && takeaway.includes(flat(x.anchorText)))?.id ?? ''
  }
  const w = flat(words)
  if (w.length < 8) return ''
  const threads = await cx.threads()
  const holds = (text: string) => flat(text) === w || (flat(text).length > 20 && w.includes(flat(text)))
  const t = threads.find(x => x.anchorText && !x.anchor && holds(x.anchorText))
  if (t) return t.id
  // a citation of a value or a place: a thread asked about a whole card stands beside the card, not a passage naming it
  const refs = new Set(citations(words).filter(c => !bareCard(c)).map(c => c.ref))
  if (!refs.size) return ''
  return threads.find(x => x.anchor && refs.has(x.anchor.split(',')[0]!) && (!x.anchorText || holds(x.anchorText)))?.id ?? ''
}

/** A rich block's runs with each chip (a citation that names only its place: a card cited whole, `[[card:<id>]]`, a
 *  card's printed line or a file's line, `[↗](<ref>)`) kept as a chip wherever it stands (Matt, 2026-10-07: drawn as
 *  `[ card ]`, never left out where the card is drawn under the reply, never ` (card "…")`), without the brackets main
 *  put around it: a chip carries its own. A card a chip names is read now, so its tip names it by its question. */
async function chipRuns(cx: Ctx, block: Extract<Block, { type: 'rich' }>): Promise<Extract<Block, { type: 'rich' }>> {
  const all = block.table ? block.table.rows.flat(2) : block.runs
  if (!all.some(r => r.cite && isChip(r.cite))) return block
  for (const r of all) {
    if (!r.cite || !isChip(r.cite)) continue
    const card = bareCard(r.cite) || outputLine(r.cite.ref)?.card || /^(?:card|cell):([A-Za-z0-9_-]+)/.exec(r.cite.ref)?.[1] || ''
    if (!card) continue
    const tc = await cx.card(card)
    if (!tc && !rt.shown.has(card)) rt.wanted.add(card)
    noteQuestion(card, (tc?.data as CardData | null | undefined)?.question ?? '')
  }
  if (block.table) return block
  const src = block.runs.map(r => ({ ...r }))
  const runs: Run[] = []
  for (const [i, r] of src.entries()) {
    const prev = runs.at(-1)
    const next = src[i + 1]
    // `… ([[card:<id>]]).` reads `… [ card ].`: the brackets main wrote around the chip alone are left out
    if (r.cite && isChip(r.cite) && prev && !prev.cite && /\(\s*$/.test(prev.text) && next && !next.cite && /^\s*\)/.test(next.text)) {
      const head = prev.text.replace(/\s*\(\s*$/, '')
      if (head) runs[runs.length - 1] = { ...prev, text: `${head} ` }
      else runs.pop()
      next.text = next.text.replace(/^\s*\)/, '')
    }
    runs.push(r)
  }
  return { ...block, runs: runs.filter(r => r.cite || r.text) }
}

// ------------------------------------------------------------------------------------------------ a reply

export type ReplyOpts = {
  /** columns left of the text: PANEL_MARGIN in the panel, 0 in a card's takeaway; none for main's chat (MARGIN) */
  margin?: number
  /** the block that draws the reply's ⏺ */
  first?: boolean
  /** element keys' prefix, so two replies in one tree keep apart */
  prefix?: string
  /** cards not drawn where the text embeds them, since they are drawn under the reply */
  skipCards?: ReadonlySet<string>
  /** a side thread about a passage of the reply: the "?" beside it */
  ask?: (target: Target) => void
  /** a thread's ↳ beside its passage: a click opens the thread */
  open?: (thread: string) => void
  /** the card whose takeaway this is: its citations take the card's links check */
  card?: string
  /** where a card that cannot be drawn is: `reply` (`card 2`), or `report` (`this card`) */
  in?: 'reply' | 'report'
  /** the mark to light on a card, by its id (a story beat's step) */
  focus?: Record<string, Focus>
  /** a blank row before each card and after it (a side thread's answer), where elsewhere the border stands in for one */
  cardGaps?: boolean
  /** the checks' open comments on this row's passages: tinted, flagged; `lit` the one open in the panel; `check` opens
   *  the panel on one */
  comments?: AnswerComment[]
  lit?: string | null
  check?: (id: string) => void
}

/** Where a comment's passage stands in the text drawn: its offsets when the text there is its quote, else where its
 *  quote is found, else null (no tint; the panel still holds the comment). */
export function locate(text: string, c: Pick<AnswerComment, 'start' | 'end' | 'quote'>): [number, number] | null {
  if (!c.quote) return null
  if (c.start >= 0 && c.end > c.start && text.slice(c.start, c.end) === c.quote) return [c.start, c.end]
  const at = text.indexOf(c.quote)
  return at >= 0 ? [at, at + c.quote.length] : null
}

/** A reply's blocks with each Markdown chunk that holds a commented passage read again as rich blocks (paragraphs,
 *  items, headings, quotes), so the mod's layout draws it; the places stay the reply's. */
function withPassages(blocks: Block[], spans: readonly [number, number][]): Block[] {
  if (!spans.length) return blocks
  const out: Block[] = []
  for (const b of blocks) {
    const at = b.at ?? -1
    const end = b.end ?? -1
    if (b.type !== 'md' || !spans.some(([x, y]) => x < end && y > at)) {
      out.push(b)
      continue
    }
    const sub = parseReply(b.text, { all: true }).map(x => ({ ...x, at: (x.at ?? 0) + at, end: (x.end ?? 0) + at }))
    if (sub[0]) sub[0].gap = b.gap
    out.push(...sub)
  }
  return out
}

/** A reply's blocks as rows: Markdown as the engine draws it, a paragraph or table that holds citations as links, a card
 *  in its border. */
export async function drawReply(cx: Ctx, e: ResolveInput, text: string, width: number, opts: ReplyOpts = {}): Promise<RenderElement[]> {
  const { Box, Text, Markdown, Button } = cx.els(e)
  const live = e.surface === 'terminal' || e.surface === 'desktop'
  const M = opts.margin ?? MARGIN
  // one width for the prose and the cards, so they share both edges: the column's
  const cols = Math.max(24, width)
  const prefix = opts.prefix ?? ''
  const out: RenderElement[] = []
  // the checks' passages, where the text drawn holds them
  const located = (opts.comments ?? []).flatMap(c => {
    const at = locate(text, c)
    return at ? [{ c, at }] : []
  })
  const blocks = withPassages(parseReply(text), located.map(l => l.at))
  const secs = sectionsOf(text)
  let lead = opts.first ? '⏺' : ' '
  let n = 0
  let order = 0 // a card's place among the reply's cards, its name for the analyst ("card 2")
  queueCitations(citations(text))
  type Ask = { key: string; press?: () => void; words: string; top?: number }
  // a heading's "?" asks about its whole section; any other passage's about its words
  const askOf = (words: string): (() => void) | undefined => {
    if (!opts.ask) return undefined
    const first = words.split('\n')[0]!.trim()
    const head = /^#{1,6}\s/.test(first) ? [...secs.keys()].find(k => k === first || flat(k) === flat(first)) : undefined
    const sec = head ? secs.get(head) : undefined
    if (sec) return () => opts.ask!({ kind: 'sentence', text: sec.slice(0, 4000), label: `the section ${quoted(clip(flat(first), 60))}` })
    return () => opts.ask!({ kind: 'sentence', text: words.slice(0, 1200) })
  }
  // the margin's mark: a blue ↳ once a thread was asked about the passage, which stays; else a blue "?" shown under the
  // pointer over the cell's glyph, the ⏺ on the reply's first row and a dim dot on any other passage's, which it hides
  // while it shows (Matt, 2026-10-16: "a dot that gets replaced with a question mark when you hover")
  const markOf = async (ask: Ask | undefined): Promise<{ el: RenderElement; asked: boolean } | null> => {
    if (!ask || !live) return null
    const tid = opts.open ? await threadAbout(cx, ask.words) : ''
    if (tid) return { asked: true, el: linesEl(cx, e, `asked-${ask.key}`, [[{ s: '↳', fg: LINK }]], [{ y: 0, x0: 0, x1: 1, row: false, run: () => opts.open?.(tid) }], 1) }
    if (!ask.press) return null
    return { asked: false, el: askMark(cx, e, `ask-${ask.key}`, ask.press) }
  }
  // a block's row: its margin (⏺ on the reply's first, a passage's mark in its cell), then the block, filling the column.
  // A flag stands on the row of the block it names (`flag.row`), in its check's color, over a ↳ or a "?" on that row
  const row = async (el: RenderElement, ask?: Ask, flag?: { row: number; color: string; id: string }): Promise<RenderElement> => {
    const mark = lead
    lead = ' '
    const dot = mark.trim() !== ''
    const q = await markOf(ask)
    const content = (
      <Box flexDirection="column" width={cols} flexShrink={1}>
        {el}
      </Box>
    )
    const flagEl = flag ? linesEl(cx, e, `flag-${ask?.key ?? `${prefix}${n}`}`, [[{ s: FLAG, fg: flag.color }]], [{ y: 0, x0: 0, x1: 1, row: false, run: () => opts.check?.(flag.id) }], 1) : null
    // a ↳ takes the cell; a "?" lies over the ⏺ or a passage's dot, shown only under the pointer
    const glyph = q?.asked ? null : dot ? <Text>{mark}</Text> : q ? <Text dimColor>{DOT}</Text> : <Text> </Text>
    const first = (
      <Box key="m0" flexDirection="row">
        {glyph}
        {q?.el ?? null}
      </Box>
    )
    const margin = !flagEl ? (
      <Box width={M} flexShrink={0} flexDirection="row" marginTop={ask?.top ?? 0}>
        {glyph}
        {q?.el ?? null}
      </Box>
    ) : (
      <Box width={M} flexShrink={0} flexDirection="column" marginTop={ask?.top ?? 0}>
        {flag!.row === 0 ? flagEl : [first, ...Array.from({ length: flag!.row - 1 }, (_, i) => <Text key={`m${i + 1}`}> </Text>), <Box key="flag">{flagEl}</Box>]}
      </Box>
    )
    return (
      <Box key={`row-${ask?.key ?? `${prefix}${n}`}`} flexDirection="row">
        {margin}
        {content}
      </Box>
    )
  }
  // a blank row before a block that had a blank line before it; none under a heading (it belongs to what follows it),
  // and none next to a card, whose border stands in for one (SPEC.md, rule 11), unless a caption stands under the card;
  // in a side thread's answer (cardGaps) a blank row before each card and after it, as between its turns
  const gapBefore = (i: number): boolean => {
    const b = blocks[i]!
    const before = blocks[i - 1]
    if (opts.cardGaps && i > 0 && (b.type === 'card' || before?.type === 'card')) return true
    if (i === 0 || !b.gap || b.type === 'card' || (before?.type === 'card' && !before.caption)) return false
    const underHead = (before?.type === 'rich' && before.heading > 0) || (before?.type === 'md' && /^#{1,6}\s/.test(before.text.split('\n').at(-1)!.trim()))
    return !underHead
  }
  const push = (el: RenderElement, gap: boolean) => out.push(gap ? <Box marginTop={1}>{el}</Box> : el)
  for (const [i, whole] of blocks.entries()) {
    n++
    const key = `${prefix}${n}`
    const block = whole.type === 'rich' ? await chipRuns(cx, whole) : whole
    if (block.type === 'md') {
      if (!live) {
        push(await row(<Markdown text={block.text} />), gapBefore(i))
        continue
      }
      // the engine's Markdown, so its bold and headings are drawn bold and its code coloured as in any reply; a heading
      // and the prose right under it as two pieces, each with its own "?"
      const pieces = mdPieces(block.text).flatMap(p => {
        const lines = p.split('\n')
        return /^#{1,6}\s/.test(lines[0]!) && lines.length > 1 && lines.slice(1).join('\n').trim() ? [lines[0]!, lines.slice(1).join('\n')] : [p]
      })
      for (const [j, piece] of pieces.entries()) {
        const press = askOf(piece)
        const ask: Ask = { key: `${key}-${j}`, words: piece, ...(press ? { press } : {}) }
        const el = await row(<Markdown text={piece} />, ask)
        const afterHead = j > 0 && /^#{1,6}\s/.test(pieces[j - 1]!)
        push(el, j === 0 ? gapBefore(i) : !afterHead)
      }
      continue
    }
    if (block.type === 'card') {
      if (opts.skipCards?.has(block.id)) continue
      order++
      const focus = opts.focus?.[block.id] ?? (block.caption ? await captionFocus(cx, block.id, block.caption) : undefined)
      const card = await cardBlock(cx, e, block.id, cols, key, { order, in: opts.in ?? 'reply', ...(focus ? { focus } : {}) })
      const ask: Ask = { key, words: `card:${block.id}`, top: 1, ...(opts.ask ? { press: () => opts.ask!({ kind: 'card', ref: `card:${block.id}`, cardId: block.id }) } : {}) }
      push(await row(card, ask), gapBefore(i))
      // a figure's caption: dim, right under the card's border
      if (block.caption) push(await row(<Text dimColor wrap="wrap">{plainCites(block.caption)}</Text>), false)
      continue
    }
    const chips: ChipView[] = []
    const ids: string[] = []
    const raws: string[] = []
    for (const cl of blockClaims(block, prefix)) {
      chips.push(await chipOf(cx, cl.c, opts.card))
      ids.push(cl.key)
      raws.push(cl.c.raw)
      claimSentences.delete(cl.key)
      claimSentences.set(cl.key, cl.sentence)
      claimCards.delete(cl.key)
      if (opts.card) claimCards.set(cl.key, opts.card)
    }
    for (const k of [...claimSentences.keys()].slice(0, Math.max(0, claimSentences.size - 2000))) claimSentences.delete(k)
    for (const k of [...claimCards.keys()].slice(0, Math.max(0, claimCards.size - 2000))) claimCards.delete(k)
    const words = `${block.heading ? `${'#'.repeat(block.heading)} ` : ''}${block.runs.map(r => (r.cite ? r.cite.raw : r.text)).join('')}`
    const press = askOf(words)
    const ask: Ask = { key, words, ...(press ? { press } : {}) }
    if (live) {
      const { Client } = cx.els(e)
      // the checks' passages in this block: tinted in each check's color, a flag on the first row of the first passage
      // (two starting on one row share its flag, in the first's color)
      const tints: Tint[] = []
      let flag: { row: number; color: string; id: string } | undefined
      const { at: _at, end: _end, ...plain } = block
      if (!block.table) {
        const lay = located.length ? blockLayout(plain, chips, cols, -1) : null
        for (const { c, at } of [...located].sort((x, y) => x.at[0] - y.at[0])) {
          if (block.at === undefined || block.end === undefined || at[0] >= block.end || at[1] <= block.at) continue
          const where = passageIn(plain, text.slice(at[0], at[1]))
          if (!where || !lay) continue
          const color = labelHex(c.color)
          tints.push({ ...where, bg: tintOf(color, themeNow(), opts.lit === c.id ? 0.3 : 0.16), id: c.id })
          const cells = tintCells(lay, where)
          if (cells.length && (!flag || cells[0]!.line < flag.row)) flag = { row: cells[0]!.line, color, id: c.id }
        }
      }
      // the paragraph fills the column: each citation a link, a click on it the panel; a drag selects and copies
      const para = <Client key={`para-${key}`} module="./para.tsx" width={cols} props={JSON.parse(JSON.stringify({ cols, block: plain, chips, ids, raws, ...(tints.length ? { tints } : {}) }))} />
      push(await row(para, ask, flag), gapBefore(i))
    } else {
      // elsewhere, Markdown with each citation a link to its file; Markdown has no red, so a problem is marked × too
      const urls: string[] = []
      for (const r of block.runs) if (r.cite) urls.push(await placeUrl(cx, r.cite.ref))
      const md = richMarkdown(block, (c, k) => {
        const v = chips[k]
        // the spinner inside the link, part of the citation (`[3,934 ◌](…)`); a problem's × after it
        if (v?.spin) return streamLink({ ...c, display: `${citeLabel(c)} ${SPIN}` }, urls[k] ?? '')
        const mark = v?.mark ? ` ${v.mark}` : v?.state === 'problem' ? ' ×' : ''
        return `${streamLink(c, urls[k] ?? '')}${mark}`
      })
      push(await row(<Markdown text={md} />), gapBefore(i))
    }
  }
  return out
}

/** The mark of a card a figure's caption cites, to light while nothing is hovered (anim.ts focusFromRef): a story
 *  beat's step, the value a report's caption names. */
async function captionFocus(cx: Ctx, id: string, caption: string): Promise<Focus | undefined> {
  const data = (await cx.card(id))?.data as CardData | undefined
  if (!data) return undefined
  for (const c of citations(caption)) {
    const f = focusFromRef(data, c.ref.replace(/^cell:/, 'card:'))
    if (f) return f
  }
  return undefined
}

// ------------------------------------------------------------------------------------------------ a card

/** A card's drawing data with what the check of its records found: an example's words, read from its places. */
async function withQuotes(cx: Ctx, data: CardData): Promise<CardData> {
  if (data.kind !== 'example' || !data.examples?.length) return data
  const examples: CardExample[] = []
  for (const x of data.examples) {
    if (x.quote) {
      examples.push(x)
      continue
    }
    const v = await cx.verdict(cid(`[[${x.ref}]]`))
    const quote = v ? v.lines.filter(l => l.hit).map(l => l.text).join(' ').slice(0, 600) : ''
    examples.push({ ...x, quote })
  }
  return { ...data, examples }
}

/** `clip`: at most `rows` rows of the card's plot or body, and none of what stands under it, where the card holds more
 *  than a row past them (a side thread's subject); `more` shows it whole. */
export type CardOpts = { pane?: boolean; takeaway?: boolean; order?: number; in?: 'reply' | 'report'; focus?: Focus; clip?: { rows: number; more: () => void } }

/** A card in a stream (a reply, a document, the panel), as Matt laid cards out (2026-10-07): a full round border in the
 *  rule grey with a cell of padding; inside, its title in bold, wrapped and never cut, with its id as its chips read it
 *  (`card:<name>`) dim at the right of the first row, one blank row, then its plot or body directly, and below the plot
 *  everything else it shows: the readout and its state words, its label rows, its params (card.tsx draws these), then
 *  after a blank row its takeaway, its citations as links. In the card pane the question is the panel's title. A card
 *  that cannot be read is one red line naming it by its place (`× card 2 cannot be drawn: …`), never by its id. */
export async function cardBlock(cx: Ctx, e: ResolveInput, id: string, w: number, key: string, opts: CardOpts = {}): Promise<RenderElement> {
  const { Box, Text, Button } = cx.els(e)
  const live = e.surface === 'terminal' || e.surface === 'desktop'
  // in fullscreen (the only screen that takes clicks) a ↗ on the card's border row opens it in the browser
  const fullscreen = (e as { viewport?: { isFullscreen?: boolean } }).viewport?.isFullscreen === true
  const arrow = fullscreen && !opts.pane ? <Button key={`open-${key}-${id}`} label=" ↗ " plain onPress={() => openInBrowser(cx, `card:${id}`)} /> : null
  const tc: TermCard | undefined = await cx.card(id)
  if (!tc) {
    // a card a reply embeds that no turn of this session made: read it now
    if (!rt.shown.has(id)) void loadCards(cx, [id])
    return <Text dimColor>{'◌ reading the card'}</Text>
  }
  if (!tc.data) {
    const name = opts.in === 'report' ? 'this card' : opts.order ? `card ${opts.order}` : 'the card'
    return <Text color={COLORS.problem} wrap="wrap">{`× ${name} cannot be drawn: ${tc.error || 'the card is not in this workspace'}`}</Text>
  }
  let data = await withQuotes(cx, tc.data as CardData)
  // a label whose run is going (a chat follows it): `◌ labeling`, with the records labeled so far once its bars show
  // them, never `not run yet` or `stopped at` (live check term-fix9, quirk 4)
  if (data.kind === 'label' && data.label && labelRunning((await cx.agents()) ?? [], data.label.name)) {
    const lb = data.label
    const n = (x: number) => x.toLocaleString('en-US')
    data = { ...data, note: (data.rows ?? []).length && lb.labeled ? `◌ labeling ${n(lb.labeled)}${lb.total > lb.labeled ? ` of ${n(lb.total)}` : ''}` : '◌ labeling' }
  }
  const meta = { ...(tc.busy ? { busy: tc.busy } : {}), ...(tc.error ? { error: tc.error } : {}) }
  const inner = Math.max(10, w - 4)
  // the card's id on its title row, as its chip reads it (`card:<name>`); none while an older card's name is not read
  const name = cardTag(id)
  const rows: RenderElement[] = []
  // a subject's card cut to its rows where it holds more than one row past them: its plot's first rows and its readout,
  // then `… N more` for the rest (the plot's other rows, the label and params rows, the takeaway)
  let clip: number | undefined
  let hidden = 0
  if (opts.clip) {
    const lay = cardLayout(data, inner, -1)
    const under = labelHead(data, inner).lines.length + ((data.params ?? []).length ? 1 : 0) + (tc.takeaway.trim() ? wrapRows(plainCites(tc.takeaway), inner, 999).length : 0)
    const left = Math.max(0, lay.lines.length - opts.clip.rows) + under
    if (left >= 2) {
      clip = opts.clip.rows
      hidden = left
    }
  }
  if (live) {
    const { Client } = cx.els(e)
    rows.push(<Client key={`card-${key}-${id}`} module="./card.tsx" width={inner} props={JSON.parse(JSON.stringify({ card: data, cols: inner, meta, ...(name ? { name } : {}), ...(opts.pane ? { pane: true, plotRows: 16 } : {}), ...(opts.focus ? { focus: opts.focus } : {}), ...(clip !== undefined ? { clip } : {}) }))} />)
  } else {
    const state = meta.busy || meta.error ? [[{ s: meta.busy || meta.error || '', fg: meta.error ? COLORS.problem : COLORS.dim }]] : []
    const first = cardLayout(data, inner, -1)
    const lit = opts.focus ? focusItem(data, first.items, opts.focus) : -1
    const body = lit >= 0 ? cardLayout(data, inner, lit).lines : first.lines
    rows.push(<Box flexDirection="column">{paintLines(Box, Text, [...(opts.pane ? [] : [...titleLines(data.question, inner, name).lines, []]), ...(clip !== undefined ? body.slice(0, clip) : body), ...state, ...(clip !== undefined ? [] : labelHead(data, inner).lines)])}</Box>)
  }
  // a custom card is HTML: the terminal draws its table or its words (cell.ts cardOfCell), and its link opens the whole
  // card in the browser (Matt, 2026-10-16: the link text is "view in browser")
  const custom = tc.kind === 'custom'
  if (custom && clip === undefined) {
    rows.push(fullscreen
      ? <Box key={`custom-row-${key}-${id}`} flexDirection="row"><Button key={`custom-open-${key}-${id}`} plain onPress={() => openInBrowser(cx, `card:${id}`)}><Text color={COLORS.link}>view in browser ↗</Text></Button></Box>
      : <Text key={`custom-row-${key}-${id}`} color={COLORS.link}>view in browser ↗</Text>)
  }
  if (clip !== undefined) {
    const { Button } = cx.els(e)
    rows.push(<Box key={`more-row-${key}`} flexDirection="row"><Button key={`more-${key}`} label={`… ${hidden.toLocaleString('en-US')} more`} plain dimColor onPress={opts.clip!.more} /></Box>)
  } else if (opts.takeaway !== false && tc.takeaway.trim()) {
    // a blank row before the takeaway, which would otherwise read as one with the row above it, the label row's or the
    // card's last (Matt, 2026-10-16); none where the card's last row is its readout, blank while nothing is pointed at
    const readoutLast = live && !custom && !labelHead(data, inner).lines.length && !(data.params ?? []).length && (cardLayout(data, inner, -1).items.length > 0 || Boolean(meta.busy || meta.error))
    if (!readoutLast) rows.push(<Text key={`gap-${key}-${id}`}> </Text>)
    rows.push(<Box flexDirection="column" width={inner}>{await drawReply(cx, e, tc.takeaway, inner, { margin: 0, prefix: `tk-${key}-`, card: id })}</Box>)
  }
  const framed = (
    <Box flexDirection="column" width={w} borderStyle="round" borderColor={COLORS.rule} paddingX={1}>
      {rows}
    </Box>
  )
  if (!arrow) return framed
  // the ↗ over the end of the border row: a box laid over the frame from outside it (a box inside a border paints
  // only within it)
  return (
    <Box flexDirection="column" width={w}>
      {framed}
      <Box key={`arrow-${key}-${id}`} position="absolute" top={0} left={Math.max(0, w - 6)}>
        {arrow}
      </Box>
    </Box>
  )
}

/** The cards a turn made, under its last reply, on the reply's text column (2), border to border: the border stands in
 *  for a blank row. A dim dot in the margin beside each title turns into a blue "?" under the pointer, which asks a
 *  side thread about the card; once one was asked, a blue ↳ stays there and opens it. */
export async function drawCards(cx: Ctx, e: ResolveInput, ids: readonly string[], cols: number, ask?: (t: Target) => void, open?: (thread: string) => void): Promise<RenderElement | null> {
  if (!ids.length) return null
  const { Box, Text } = cx.els(e)
  const live = e.surface === 'terminal' || e.surface === 'desktop'
  const w = Math.max(24, cols - MARGIN)
  const out: RenderElement[] = []
  for (const [i, id] of ids.entries()) {
    const card = await cardBlock(cx, e, id, w, `t${i}`, { order: i + 1 })
    const tid = live && open ? await threadAbout(cx, `card:${id}`) : ''
    const asked = tid ? linesEl(cx, e, `asked-card-${i}`, [[{ s: '↳', fg: LINK }]], [{ y: 0, x0: 0, x1: 1, row: false, run: () => open?.(tid) }], 1) : null
    const can = !tid && ask && live
    out.push(
      <Box key={`turn-card-${i}`} flexDirection="row">
        <Box width={MARGIN} flexShrink={0} flexDirection="row" marginTop={1}>
          {asked}
          {can ? <Text dimColor>{DOT}</Text> : null}
          {can ? askMark(cx, e, `ask-card-${i}`, () => ask?.({ kind: 'card', ref: `card:${id}`, cardId: id })) : null}
        </Box>
        <Box flexDirection="column" flexShrink={1}>
          {card}
        </Box>
      </Box>,
    )
  }
  return <Box flexDirection="column">{out}</Box>
}
