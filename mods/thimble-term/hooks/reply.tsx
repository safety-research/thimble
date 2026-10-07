// Main's chat as thimble-term draws it: a reply's text on the grid (SPEC.md, "The visual system", "The
// chat column"), each citation a link, blue and underlined (red when its place does not hold its value), and the cards
// the turn made under the turn's last reply, each once, in its last state and its border, its takeaway under it. Also
// a side thread's answer and a document in the panel, on the panel's grid. Its data comes from thimble-term's state
// (hooks/term.ts).
//
// The model's Markdown is drawn as Claude Code draws it (bold bold, headings bold, inline code coloured); prose and
// cards share one left edge (column 4, the ⏺ row's text) and one width (the terminal's), with no measure; a card has
// its full round border, which stands in for the blank rows next to it. The margin at column 2 holds the blue `?` of
// the passage under the pointer (a heading's asks about its whole section), and a blue `↳` beside a passage or a card a
// side thread was asked about, whose click opens that thread.
//
// A citation's state after it: ◌ while thimble's links check runs on a card's takeaway, ✓ once the check recomputed it,
// a red × when the check found another value. The citation under the pointer shows its status in plain words (where it
// was found, or why not) on a quiet box.
import type { RenderElement, ResolveInput } from 'claude-code'

import type { TermCard, TermLinks, TermVerdict } from '../types'
import { blockClaims, chipLook, citeLabel, plainCites, richMarkdown, showsValue, streamLink } from './cite'
import type { ChipView } from './cite'
import { LINK } from './chrome'
import { cardLayout, cut, labelHead, placeWords } from './draw'
import type { CardData, CardExample } from './draw'
import { focusFromRef, focusItem } from './anim'
import type { Focus } from './anim'
import type { Target } from './gestures'
import { cid, citations, clip, clipWords, mdPieces, parseReply, sectionsOf } from './lib'
import { linesEl } from './lines'
import type { Citation } from './lib'
import { COLORS, paintLines } from './paint'
import { loadCards, queueCitations, rt } from './term'
import type { Ctx } from './ctx'

/** The columns left of a reply's blocks: ⏺, a space, the reply's margin ("?" on hover, a passage's ↳), a space. */
export const MARGIN = 4
/** A reply's margin in the panel (a side thread's answer, a document): its marks at M, its text at A0. */
export const PANEL_MARGIN = 2

const CARD_REF = /^(?:card|cell):([A-Za-z0-9_-]+)(?:@[A-Za-z0-9_]+)?(?:#(.*))?$/
const CALL_REF = /^call:[A-Za-z0-9_-]+(?:#L(\d+)(?:-L?(\d+))?)?$/

// ------------------------------------------------------------------------------------------------ a citation in words

/** A card by its question, cut at a word, never its id. */
export async function cardName(cx: Ctx, id: string): Promise<string> {
  const q = ((await cx.card(id))?.data as CardData | undefined)?.question
  return q ? `card "${clipWords(q, 40)}"` : 'the card'
}

/** A ref as the analyst reads it: a card's place by the card's question, a command's output by its line, never an id;
 *  any other place in words. */
export async function placeName(cx: Ctx, ref: string): Promise<string> {
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
    out = out.replace(m[0], q ? `card "${clipWords(q, 40)}"` : 'card')
  }
  return out
}

const BARE_CARD = /^(?:card:|cell:)?([A-Za-z0-9_-]{6,})$/
const CARD_EMBED = /\[\[(?:card|cell):([A-Za-z0-9_-]+)\]\]|!\[[^\]\n]*\]\((?:card|cell):([A-Za-z0-9_-]+)\)/g

/** A value of a thimble tool's input as its row in Claude Code shows it (the row and ctrl+o's detailed view): the
 *  card a `card` names by its question alone, which the key already says is a card; elsewhere a citation as its words,
 *  a card it embeds or names by its question in curly quotation marks, which Claude Code does not escape as it escapes
 *  straight ones; each question cut at a word. No id. */
export async function toolWords(cx: Ctx, key: string, value: string): Promise<string> {
  const question = async (id: string) => ((await cx.card(id))?.data as { question?: string } | null | undefined)?.question ?? ''
  const bare = key === 'card' ? BARE_CARD.exec(value.trim()) : null
  if (bare) return clipWords(await question(bare[1]!), 60) || value
  let out = value
  for (const m of [...value.matchAll(CARD_EMBED)]) {
    const q = await question((m[1] ?? m[2])!)
    out = out.replace(m[0], q ? `card “${clipWords(q, 40)}”` : 'a card')
  }
  out = plainCites(out)
  for (const m of [...out.matchAll(ID_IN_TEXT)]) {
    const q = await question(m[1]!)
    out = out.replace(m[0], q ? `card “${clipWords(q, 40)}”` : 'a card')
  }
  return out
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
 *  found another. */
export function linkCheck(l: TermLinks | undefined, c: Citation): { state?: string; why?: string; source?: string } {
  if (!l) return {}
  const key = `${c.display ?? ''}|${c.ref}`
  const mine = (k: string) => k === key || k.endsWith(`|${c.ref}`)
  const b = l.broken.find(x => x.key === key) ?? l.broken.find(x => mine(x.key))
  if (b) return { state: 'refuted', why: b.why, source: b.source }
  if (l.pending) return { state: 'running' }
  if (l.checked && l.ok.some(mine)) return { state: 'verified' }
  return {}
}

/** A citation's status in plain words (SPEC.md, section 5, "Words that recur"): `◌ checking`, `found on the
 *  card`, `found in revisions.jsonl line 10566`, `found in the command's output, line 1`, `found in …; its value is not
 *  checked` for words that show no value, `not found …`; after thimble's links check, `…, and a script got the same
 *  number`, `…, but a script got 5,883` or `…; ◌ being checked`. It agrees with the link's colour and mark. */
export async function citeStatus(cx: Ctx, c: Citation, v: TermVerdict | undefined, check: { state?: string; source?: string } = {}): Promise<string> {
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
  if (check.state === 'running') return `${place}; ◌ being checked`
  return place
}

/** A citation as its link draws: its label, red with a problem, ◌ ✓ or × after it from thimble's links check of the
 *  card whose takeaway it is in (`card`), and its tip (its status in plain words, and why for a problem). */
export async function chipOf(cx: Ctx, c: Citation, card?: string): Promise<ChipView> {
  const v = await cx.verdict(cid(c.raw))
  const check = card ? linkCheck((await cx.card(card))?.links, c) : {}
  const look = chipLook(v?.status ?? 'pending', undefined, check.state)
  const problem = v?.status === 'missing' || v?.status === 'differs'
  const why = problem ? await plainWhy(cx, v?.why ?? '') : check.state === 'refuted' && check.why ? await plainWhy(cx, check.why) : ''
  const tip = [await citeStatus(cx, c, v, check), why].filter(Boolean).join(' · ')
  return { label: citeLabel(c), ...look, tip }
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

/** The thread asked about a passage, by its words: a side thread whose anchor text is the passage's (or holds it); for
 *  a card (`card:<id>`), a thread anchored on it or on a value it shows, or one asked about a passage of its takeaway (a
 *  citation in it, whose anchor is the cited place). */
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
  const t = (await cx.threads()).find(x => x.anchorText && !x.anchor && (flat(x.anchorText) === w || (flat(x.anchorText).length > 20 && w.includes(flat(x.anchorText)))))
  return t?.id ?? ''
}

// ------------------------------------------------------------------------------------------------ a reply

export type ReplyOpts = {
  /** columns left of the text: MARGIN in main's chat, PANEL_MARGIN in the panel */
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
  const blocks = parseReply(text)
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
    if (sec) return () => opts.ask!({ kind: 'sentence', text: clip(sec, 4000), label: `the section "${clip(flat(first), 60)}"` })
    return () => opts.ask!({ kind: 'sentence', text: words.slice(0, 1200) })
  }
  // the margin's mark: a blue ↳ once a thread was asked about the passage, else a blue "?" shown under the pointer
  const markOf = async (ask: Ask | undefined): Promise<RenderElement | null> => {
    if (!ask || !live) return null
    const tid = opts.open ? await threadAbout(cx, ask.words) : ''
    if (tid) return linesEl(cx, e, `asked-${ask.key}`, [[{ s: '↳', fg: LINK }]], [{ y: 0, x0: 0, x1: 1, row: false, run: () => opts.open?.(tid) }], 1)
    if (!ask.press) return null
    return (
      <Box width={1} display="none" hover={{ display: 'flex' }}>
        <Button key={`ask-${ask.key}`} label="?" plain hover={{ color: LINK }} onPress={ask.press} />
      </Box>
    )
  }
  // a block's row: its margin (⏺ on the first, the mark), then the block, filling the column
  const row = async (el: RenderElement, ask?: Ask): Promise<RenderElement> => {
    const mark = lead
    lead = ' '
    const q = await markOf(ask)
    const content = (
      <Box flexDirection="column" width={cols} flexShrink={1}>
        {el}
      </Box>
    )
    if (M !== MARGIN)
      return (
        <Box key={`row-${ask?.key ?? `${prefix}${n}`}`} flexDirection="row">
          <Box width={M} flexShrink={0} flexDirection="row" marginTop={ask?.top ?? 0}>
            {q ?? <Text> </Text>}
          </Box>
          {content}
        </Box>
      )
    return (
      <Box key={`row-${ask?.key ?? `${prefix}${n}`}`} flexDirection="row">
        <Box width={MARGIN} flexShrink={0} flexDirection="row" marginTop={ask?.top ?? 0}>
          <Box width={2} flexShrink={0}>
            <Text>{mark}</Text>
          </Box>
          {q}
        </Box>
        {content}
      </Box>
    )
  }
  // a blank row before a block that had a blank line before it; none under a heading (it belongs to what follows it),
  // and none next to a card, whose border stands in for one (SPEC.md, rule 11)
  const gapBefore = (i: number): boolean => {
    const b = blocks[i]!
    const before = blocks[i - 1]
    if (i === 0 || !b.gap || b.type === 'card' || before?.type === 'card') return false
    const underHead = (before?.type === 'rich' && before.heading > 0) || (before?.type === 'md' && /^#{1,6}\s/.test(before.text.split('\n').at(-1)!.trim()))
    return !underHead
  }
  const push = (el: RenderElement, gap: boolean) => out.push(gap ? <Box marginTop={1}>{el}</Box> : el)
  for (const [i, block] of blocks.entries()) {
    n++
    const key = `${prefix}${n}`
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
      push(await row(card, ask), false)
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
      // the paragraph fills the column: each citation a link, a click on it the panel; a drag selects and copies
      const para = <Client key={`para-${key}`} module="./para.tsx" width={cols} props={JSON.parse(JSON.stringify({ cols, block, chips, ids, raws }))} />
      push(await row(para, ask), gapBefore(i))
    } else {
      // elsewhere, Markdown with each citation a link to its file; Markdown has no red, so a problem is marked × too
      const urls: string[] = []
      for (const r of block.runs) if (r.cite) urls.push(await placeUrl(cx, r.cite.ref))
      const md = richMarkdown(block, (c, k) => {
        const v = chips[k]
        const mark = v?.spin ? ' ◌' : v?.mark ? ` ${v.mark}` : v?.state === 'problem' ? ' ×' : ''
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

export type CardOpts = { pane?: boolean; takeaway?: boolean; order?: number; in?: 'reply' | 'report'; focus?: Focus }

/** A card in a stream (a reply, a document, the panel), as Matt laid cards out (2026-10-07): a full round border in the
 *  rule grey with a cell of padding; inside, its title in bold, one blank row, then its plot or body directly, and below
 *  the plot everything else it shows: the readout and its state words, its label rows, its params (card.tsx draws
 *  these), then its takeaway, its citations as links. In the card pane the question is the panel's title. A card that
 *  cannot be read is one red line naming it by its place (`× card 2 cannot be drawn: …`), never by its id. */
export async function cardBlock(cx: Ctx, e: ResolveInput, id: string, w: number, key: string, opts: CardOpts = {}): Promise<RenderElement> {
  const { Box, Text } = cx.els(e)
  const live = e.surface === 'terminal' || e.surface === 'desktop'
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
  const data = await withQuotes(cx, tc.data as CardData)
  const meta = { ...(tc.busy ? { busy: tc.busy } : {}), ...(tc.error ? { error: tc.error } : {}) }
  const inner = Math.max(10, w - 4)
  const rows: RenderElement[] = []
  if (live) {
    const { Client } = cx.els(e)
    rows.push(<Client key={`card-${key}-${id}`} module="./card.tsx" width={inner} props={JSON.parse(JSON.stringify({ card: data, cols: inner, meta, ...(opts.pane ? { pane: true, plotRows: 16 } : {}), ...(opts.focus ? { focus: opts.focus } : {}) }))} />)
  } else {
    const state = meta.busy || meta.error ? [[{ s: meta.busy || meta.error || '', fg: meta.error ? COLORS.problem : COLORS.dim }]] : []
    const first = cardLayout(data, inner, -1)
    const lit = opts.focus ? focusItem(data, first.items, opts.focus) : -1
    const body = lit >= 0 ? cardLayout(data, inner, lit).lines : first.lines
    rows.push(<Box flexDirection="column">{paintLines(Box, Text, [...(opts.pane ? [] : [[{ s: cut(data.question, inner), b: true }], []]), ...body, ...state, ...labelHead(data, inner).lines])}</Box>)
  }
  if (opts.takeaway !== false && tc.takeaway.trim()) rows.push(<Box flexDirection="column" width={inner}>{await drawReply(cx, e, tc.takeaway, inner, { margin: 0, prefix: `tk-${key}-`, card: id })}</Box>)
  return (
    <Box flexDirection="column" width={w} borderStyle="round" borderColor={COLORS.rule} paddingX={1}>
      {rows}
    </Box>
  )
}

/** The cards a turn made, under its last reply, on the reply's text column (4), border to border: the border stands in
 *  for a blank row. The blue "?" beside each, under the pointer, asks a side thread about it; once one was asked, a
 *  blue ↳ stays there and opens it. */
export async function drawCards(cx: Ctx, e: ResolveInput, ids: readonly string[], cols: number, ask?: (t: Target) => void, open?: (thread: string) => void): Promise<RenderElement | null> {
  if (!ids.length) return null
  const { Box, Button } = cx.els(e)
  const live = e.surface === 'terminal' || e.surface === 'desktop'
  const w = Math.max(24, cols - MARGIN)
  const out: RenderElement[] = []
  for (const [i, id] of ids.entries()) {
    const card = await cardBlock(cx, e, id, w, `t${i}`, { order: i + 1 })
    const tid = live && open ? await threadAbout(cx, `card:${id}`) : ''
    const mark = tid ? (
      linesEl(cx, e, `asked-card-${i}`, [[{ s: '↳', fg: LINK }]], [{ y: 0, x0: 0, x1: 1, row: false, run: () => open?.(tid) }], 1)
    ) : ask && live ? (
      <Box width={1} display="none" hover={{ display: 'flex' }}>
        <Button key={`ask-card-${i}`} label="?" plain hover={{ color: LINK }} onPress={() => ask({ kind: 'card', ref: `card:${id}`, cardId: id })} />
      </Box>
    ) : null
    out.push(
      <Box key={`turn-card-${i}`} flexDirection="row">
        <Box width={MARGIN} flexShrink={0} flexDirection="row" marginTop={1}>
          <Box width={2} flexShrink={0} />
          {mark}
        </Box>
        <Box flexDirection="column" flexShrink={1}>
          {card}
        </Box>
      </Box>,
    )
  }
  return <Box flexDirection="column">{out}</Box>
}
