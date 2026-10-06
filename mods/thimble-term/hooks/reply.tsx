// Main's chat as thimble-term draws it: a reply's text on the mod's grid (views/SPEC.md, "The visual system", "The
// chat column"), each citation a link (red when its place does not hold its value), and the cards the turn made under
// the turn's last reply, each once, in its last state, its takeaway under it. Also a side thread's answer and a
// document's paragraphs in the panel, on the panel's grid. Ported from thimble-cc-mod's register.tsx drawReply, its
// data read from thimble-term's state (hooks/term.ts) instead of the mod's files.
import type { RenderElement, ResolveInput } from 'claude-code'

import type { TermCard } from '../types'
import { blockClaims, chipState, citeLabel, plainCites } from './cite'
import type { ChipView } from './cite'
import { cardLayout, cut, labelHead, placeWords } from './draw'
import type { CardData, CardExample } from './draw'
import type { Target } from './gestures'
import { cid, citations, mdPieces, parseReply } from './lib'
import type { Citation } from './lib'
import { COLORS, paintLines } from './paint'
import { queueCitations } from './term'
import type { Ctx } from './ctx'

/** The columns left of a reply's blocks: ⏺, a space, the "?" shown on hover, a space. */
export const MARGIN = 4
/** A reply's margin in the panel (a side thread's answer, a document): its headings at A0, its text at A2. */
export const PANEL_MARGIN = 2
/** The measure of the prose thimble-term draws (rule 7). */
export const MEASURE = 72
export const CARD_MAX_COLS = 120

const STATUS_WORDS: Record<string, string> = {
  ok: 'the value is at its place',
  differs: 'the value is not at its place',
  missing: 'the place does not exist',
  pending: 'checking',
}

/** A reply's Markdown with its emphasis and headings drawn regular (rule 14: bold means new). From thimble-cc-mod. */
export function plainMarkdown(md: string): string {
  const out: string[] = []
  let fence = false
  for (const line of md.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence
      out.push(line)
      continue
    }
    if (fence || /^\s*\|/.test(line)) {
      out.push(line)
      continue
    }
    const head = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)
    const text = head ? head[1]! : line
    out.push(
      text
        .replace(/`([^`\n]+)`/g, '$1')
        .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '$1')
        .replace(/__(?=\S)(.+?)(?<=\S)__/g, '$1')
        .replace(/(^|[^\w*])\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?![\w*])/g, '$1$2')
        .replace(/(^|[^\w])_(?=[^\s_])([^_\n]+?)(?<=[^\s_])_(?![\w])/g, '$1$2'),
    )
  }
  return out.join('\n')
}

/** A citation as its link draws: its label, red with a problem, and its tip (its place and what the check found). */
export async function chipOf(cx: Ctx, c: Citation): Promise<ChipView> {
  const v = (await cx.verdict(cid(c.raw)))
  const status = v?.status ?? 'pending'
  return { label: citeLabel(c), state: chipState(status, undefined, undefined), mark: '', spin: false, tip: `${placeWords(c.ref.replace(/^(?:card|cell):[A-Za-z0-9_-]+/, 'card'))} · ${STATUS_WORDS[status] ?? status}` }
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
}

/** A reply's blocks as rows: Markdown as the engine draws it, a paragraph or table that holds citations as links. */
export async function drawReply(cx: Ctx, e: ResolveInput, text: string, width: number, opts: ReplyOpts = {}): Promise<RenderElement[]> {
  const { Box, Text, Markdown, Button } = cx.els(e)
  const live = e.surface === 'terminal' || e.surface === 'desktop'
  const cols = Math.max(24, width)
  const M = opts.margin ?? MARGIN
  const prefix = opts.prefix ?? ''
  const out: RenderElement[] = []
  const blocks = parseReply(text)
  const menu = live ? ((await cx.menu()) ?? null) : null
  let lead = opts.first ? '⏺' : ' '
  let n = 0
  queueCitations(citations(text))
  // a block's row: its margin (⏺ on the first, the "?" shown on hover), then the block, prose at the measure; a
  // heading hangs at column 2 (in the panel at A0, with no "?")
  const row = (el: RenderElement, key: string, ask?: () => void, how: { hang?: boolean; prose?: boolean; top?: number } = {}): RenderElement => {
    const mark = lead
    lead = ' '
    const q = ask && live ? (
      <Box width={1} display="none" hover={{ display: 'flex' }}>
        <Button key={`ask-${key}`} label="?" plain onPress={ask} />
      </Box>
    ) : null
    const content = how.prose ? (
      <Box flexDirection="column" width={Math.min(MEASURE, cols)} flexShrink={1}>
        {el}
      </Box>
    ) : (
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {el}
      </Box>
    )
    if (M !== MARGIN) {
      return (
        <Box key={`row-${key}`} flexDirection="row">
          {how.hang ? null : (
            <Box width={M} flexShrink={0} flexDirection="row" marginTop={how.top ?? 0}>
              {q ?? <Text> </Text>}
            </Box>
          )}
          {content}
        </Box>
      )
    }
    const hang = how.hang && mark === ' '
    return (
      <Box key={`row-${key}`} flexDirection="row">
        <Box width={hang ? 2 : MARGIN} flexShrink={0} flexDirection="row" marginTop={how.top ?? 0}>
          {hang ? (q ?? <Text> </Text>) : (
            <Box width={2} flexShrink={0}>
              <Text>{mark}</Text>
            </Box>
          )}
          {hang ? null : q}
        </Box>
        {content}
      </Box>
    )
  }
  const push = (el: RenderElement, gap: boolean) => out.push(gap && out.length ? <Box marginTop={1}>{el}</Box> : el)
  for (const block of blocks) {
    n++
    const key = `${prefix}${n}`
    if (block.type === 'md') {
      const pieces = mdPieces(block.text).flatMap(p => {
        const lines = p.split('\n')
        return /^#{1,6}\s/.test(lines[0]!) && lines.length > 1 && lines.slice(1).join('\n').trim() ? [lines[0]!, lines.slice(1).join('\n')] : [p]
      })
      pieces.forEach((piece, j) => {
        const head = /^#{1,6}\s/.test(piece)
        const ask = opts.ask ? () => opts.ask!({ kind: 'sentence', text: piece.slice(0, 1200) }) : undefined
        const el = row(<Markdown text={plainMarkdown(piece)} />, `${key}-${j}`, ask, { hang: head, prose: !head && !/^\s*\|/.test(piece) })
        const afterHead = j > 0 && /^#{1,6}\s/.test(pieces[j - 1]!)
        push(el, (j === 0 ? block.gap : !afterHead) && !(j === 0 && n === 1))
      })
      continue
    }
    if (block.type === 'card') {
      if (opts.skipCards?.has(block.id)) continue
      const card = await cardBlock(cx, e, block.id, Math.min(cols, CARD_MAX_COLS), key)
      push(row(card, key, opts.ask ? () => opts.ask!({ kind: 'card', ref: `card:${block.id}`, cardId: block.id }) : undefined, { top: 1 }), false)
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
    const ask = opts.ask ? () => opts.ask!({ kind: 'sentence', text: words.slice(0, 1200) }) : undefined
    if (live) {
      const { Client } = cx.els(e)
      const pw = block.table ? cols : Math.min(MEASURE, cols)
      const para = <Client key={`para-${key}`} module="./para.tsx" width={pw} props={JSON.parse(JSON.stringify({ cols: pw, block, chips, ids, raws, menu }))} />
      push(row(para, key, ask, { hang: block.heading > 0 }), block.gap && n > 1)
    } else {
      push(row(<Markdown text={plainMarkdown(plainCites(words))} />, key, undefined, { hang: block.heading > 0 }), block.gap && n > 1)
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

/** A card in a stream (a reply, a document, the panel): between its rules, its question as the title row, its chart,
 *  its state words at the right of the title while it runs; then its takeaway under it, its citations as links. */
export async function cardBlock(cx: Ctx, e: ResolveInput, id: string, w: number, key: string, opts: { pane?: boolean; takeaway?: boolean } = {}): Promise<RenderElement> {
  const { Box, Text } = cx.els(e)
  const live = e.surface === 'terminal' || e.surface === 'desktop'
  const tc: TermCard | undefined = (await cx.card(id))
  if (!tc) return <Text dimColor>{'◌ reading the card'}</Text>
  const data = await withQuotes(cx, tc.data as CardData)
  const meta = { ...(tc.busy ? { busy: tc.busy } : {}), ...(tc.error ? { error: tc.error } : {}) }
  const menu = live ? ((await cx.menu()) ?? null) : null
  const rows: RenderElement[] = []
  if (live) {
    const { Client } = cx.els(e)
    rows.push(<Client key={`card-${key}-${id}`} module="./card.tsx" width={w} props={JSON.parse(JSON.stringify({ card: data, cols: w, meta, menu, ...(opts.pane ? { pane: true, plotRows: 16 } : {}) }))} />)
  } else {
    const rule = { s: '─'.repeat(w), fg: COLORS.rule }
    rows.push(<Box flexDirection="column" width={w}>{paintLines(Box, Text, [[rule], [{ s: cut(data.question, w) }], ...labelHead(data, w).lines, ...cardLayout(data, w, -1).lines, [rule]])}</Box>)
  }
  if (opts.takeaway !== false && tc.takeaway.trim()) {
    const body = await drawReply(cx, e, tc.takeaway, w, { margin: 0, prefix: `tk-${key}-` })
    rows.push(<Box flexDirection="column" width={Math.min(w, MEASURE)}>{body}</Box>)
  }
  return <Box flexDirection="column">{rows}</Box>
}

/** The cards a turn made, under its last reply, on the reply's text axis, one blank row between them. */
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
              <Button key={`ask-card-${i}`} label="?" plain onPress={() => ask({ kind: 'card', ref: `card:${id}`, cardId: id })} />
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
