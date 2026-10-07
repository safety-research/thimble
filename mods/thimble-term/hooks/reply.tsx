// Main's chat as thimble-term draws it: a reply's text on the mod's grid (views/SPEC.md, "The visual system", "The
// chat column"), each citation a link, blue and underlined (red when its place does not hold its value), and the cards
// the turn made under the turn's last reply, each once, in its last state and its border, its takeaway under it. Also
// a side thread's answer and a document in the panel, on the panel's grid. Ported from thimble-cc-mod's register.tsx
// drawReply (round 8), its data read from thimble-term's state (hooks/term.ts) instead of the mod's files.
//
// The model's Markdown is drawn as Claude Code draws it (bold bold, headings bold, inline code coloured); prose and
// cards share one left edge (column 4, the ⏺ row's text) and one width (the column, at most a card's cap of 120), with
// no measure; a card has its full round border, which stands in for the blank rows next to it. The margin
// at column 2 holds the blue `?` of the passage under the pointer, and a blue `↳` beside a passage a side thread was
// asked about, whose click opens that thread.
import type { RenderElement, ResolveInput } from 'claude-code'

import type { TermCard } from '../types'
import { blockClaims, chipState, citeLabel, plainCites } from './cite'
import type { ChipView } from './cite'
import { LINK } from './chrome'
import { cardLayout, cut, labelHead, placeWords } from './draw'
import type { CardData, CardExample } from './draw'
import type { Target } from './gestures'
import { cid, citations, mdPieces, parseReply } from './lib'
import { linesEl } from './lines'
import type { Citation } from './lib'
import { COLORS, paintLines } from './paint'
import { queueCitations } from './term'
import type { Ctx } from './ctx'

/** The columns left of a reply's blocks: ⏺, a space, the reply's margin ("?" on hover, a passage's ↳), a space. */
export const MARGIN = 4
/** A reply's margin in the panel (a side thread's answer, a document): its marks at M, its text at A0. */
export const PANEL_MARGIN = 2
export const CARD_MAX_COLS = 120

/** A citation as its link draws: its label, red with a problem, and its tip (its place and what the check found). */
export async function chipOf(cx: Ctx, c: Citation): Promise<ChipView> {
  const v = await cx.verdict(cid(c.raw))
  const status = v?.status ?? 'pending'
  const onCard = /^(?:card|cell):/.test(c.ref)
  const place = onCard ? 'the card' : placeWords(c.ref)
  const words = status === 'ok' ? (c.display !== null ? (onCard ? 'found on the card' : `found in ${place}`) : place) : status === 'differs' ? `not found in ${place}` : status === 'missing' ? `not found: ${place} does not exist` : `${place} · checking`
  return { label: citeLabel(c), state: chipState(status, undefined, undefined), mark: '', spin: false, tip: words }
}

/** The thread asked about a passage, by its words: a side thread whose anchor text is the passage's (or holds it). */
async function threadAbout(cx: Ctx, words: string): Promise<string> {
  const flat = (s: string) => plainCites(s).replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim()
  const w = flat(words)
  if (w.length < 8) return ''
  const t = (await cx.threads()).find(x => x.anchorText && !x.anchor && (flat(x.anchorText) === w || (flat(x.anchorText).length > 20 && w.includes(flat(x.anchorText)))))
  return t?.id ?? ''
}

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
}

/** A reply's blocks as rows: Markdown as the engine draws it, a paragraph or table that holds citations as links, a card
 *  in its border. */
export async function drawReply(cx: Ctx, e: ResolveInput, text: string, width: number, opts: ReplyOpts = {}): Promise<RenderElement[]> {
  const { Box, Text, Markdown, Button } = cx.els(e)
  const live = e.surface === 'terminal' || e.surface === 'desktop'
  const M = opts.margin ?? MARGIN
  // one width for the prose and the cards, so they share both edges: the column's, at most a card's cap
  const cols = Math.max(24, Math.min(width, CARD_MAX_COLS))
  const prefix = opts.prefix ?? ''
  const out: RenderElement[] = []
  const blocks = parseReply(text)
  let lead = opts.first ? '⏺' : ' '
  let n = 0
  queueCitations(citations(text))
  type Ask = { key: string; press?: () => void; words: string; top?: number }
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
  // and none next to a card, whose border stands in for one (views/SPEC.md, rule 11)
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
        const ask: Ask = { key: `${key}-${j}`, words: piece, ...(opts.ask ? { press: () => opts.ask!({ kind: 'sentence', text: piece.slice(0, 1200) }) } : {}) }
        const el = await row(<Markdown text={piece} />, ask)
        const afterHead = j > 0 && /^#{1,6}\s/.test(pieces[j - 1]!)
        push(el, j === 0 ? gapBefore(i) : !afterHead)
      }
      continue
    }
    if (block.type === 'card') {
      if (opts.skipCards?.has(block.id)) continue
      const card = await cardBlock(cx, e, block.id, Math.min(cols, CARD_MAX_COLS), key)
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
      chips.push(await chipOf(cx, cl.c))
      ids.push(cl.key)
      raws.push(cl.c.raw)
    }
    const words = block.runs.map(r => (r.cite ? r.cite.raw : r.text)).join('')
    const ask: Ask = { key, words, ...(opts.ask ? { press: () => opts.ask!({ kind: 'sentence', text: words.slice(0, 1200) }) } : {}) }
    if (live) {
      const { Client } = cx.els(e)
      // the paragraph fills the column: each citation a link, a click on it the panel; a drag selects and copies
      const para = <Client key={`para-${key}`} module="./para.tsx" width={cols} props={JSON.parse(JSON.stringify({ cols, block, chips, ids, raws }))} />
      push(await row(para, ask), gapBefore(i))
    } else {
      push(await row(<Markdown text={plainCites(words)} />), gapBefore(i))
    }
  }
  return out
}

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

/** A card in a stream (a reply, a document, the panel), as Matt laid cards out (2026-10-07): a full round border in the
 *  rule grey with a cell of padding; inside, its title in bold, one blank row, then its plot or body directly, and below
 *  the plot everything else it shows: the readout and its state words, its label rows, its params (card.tsx draws
 *  these), then its takeaway, its citations as links. In the card pane the question is the panel's title. */
export async function cardBlock(cx: Ctx, e: ResolveInput, id: string, w: number, key: string, opts: { pane?: boolean; takeaway?: boolean } = {}): Promise<RenderElement> {
  const { Box, Text } = cx.els(e)
  const live = e.surface === 'terminal' || e.surface === 'desktop'
  const tc: TermCard | undefined = await cx.card(id)
  if (!tc) return <Text dimColor>{'◌ reading the card'}</Text>
  const data = await withQuotes(cx, tc.data as CardData)
  const meta = { ...(tc.busy ? { busy: tc.busy } : {}), ...(tc.error ? { error: tc.error } : {}) }
  const inner = Math.max(10, w - 4)
  const rows: RenderElement[] = []
  if (live) {
    const { Client } = cx.els(e)
    rows.push(<Client key={`card-${key}-${id}`} module="./card.tsx" width={inner} props={JSON.parse(JSON.stringify({ card: data, cols: inner, meta, ...(opts.pane ? { pane: true, plotRows: 16 } : {}) }))} />)
  } else {
    const state = meta.busy || meta.error ? [[{ s: meta.busy || meta.error || '', fg: meta.error ? COLORS.problem : COLORS.dim }]] : []
    rows.push(<Box flexDirection="column">{paintLines(Box, Text, [...(opts.pane ? [] : [[{ s: cut(data.question, inner), b: true }], []]), ...cardLayout(data, inner, -1).lines, ...state, ...labelHead(data, inner).lines])}</Box>)
  }
  if (opts.takeaway !== false && tc.takeaway.trim()) rows.push(<Box flexDirection="column" width={inner}>{await drawReply(cx, e, tc.takeaway, inner, { margin: 0, prefix: `tk-${key}-` })}</Box>)
  return (
    <Box flexDirection="column" width={w} borderStyle="round" borderColor={COLORS.rule} paddingX={1}>
      {rows}
    </Box>
  )
}

/** The cards a turn made, under its last reply, on the reply's text column (4), one blank row between them; the blue "?"
 *  beside each, under the pointer, asks a side thread about it. */
export async function drawCards(cx: Ctx, e: ResolveInput, ids: readonly string[], cols: number, ask?: (t: Target) => void): Promise<RenderElement | null> {
  if (!ids.length) return null
  const { Box, Button } = cx.els(e)
  const live = e.surface === 'terminal' || e.surface === 'desktop'
  const w = Math.min(Math.max(24, cols - MARGIN), CARD_MAX_COLS)
  const out: RenderElement[] = []
  for (const [i, id] of ids.entries()) {
    const card = await cardBlock(cx, e, id, w, `t${i}`)
    out.push(
      <Box key={`turn-card-${i}`} flexDirection="row" marginTop={1}>
        <Box width={MARGIN} flexShrink={0} flexDirection="row" marginTop={1}>
          <Box width={2} flexShrink={0} />
          {ask && live ? (
            <Box width={1} display="none" hover={{ display: 'flex' }}>
              <Button key={`ask-card-${i}`} label="?" plain hover={{ color: LINK }} onPress={() => ask({ kind: 'card', ref: `card:${id}`, cardId: id })} />
            </Box>
          ) : null}
        </Box>
        <Box flexDirection="column" flexShrink={1}>
          {card}
        </Box>
      </Box>,
    )
  }
  return <Box flexDirection="column">{out}</Box>
}
