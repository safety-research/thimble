// Assistant markdown: react-markdown with remark-gfm, the `[[value|ref]]` tokens turned into chips, and each mark,
// `[words](#)`, drawn as its check says (marks/Mark.tsx). In main's chat a rehype pass wraps the words of each passage
// a check commented on in <mark>, tinted in the check's color, which opens its comment on a click (AnswerMarksContext,
// chat/answerComments.ts). The tokens are
// hidden from the markdown parser first (protectTokens) so nothing inside a ref reads as markup, then a rehype pass turns
// the markers back into spans that render as RefChip. A streaming text renders per completed block, so a delta
// re-parses only the tail.
import { Fragment, createContext, memo, useContext, useMemo, useState, type JSX, type ReactNode } from 'react'
import Markdown, { type Components, type ExtraProps, type Options } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Element, Properties, Root, Text } from 'hast'
import { MarkdownCode } from '../components/Code'
import { findQuote } from '../lib/quoteFind'
import { plainQuote, type AnswerMark } from './answerComments'
import { MdImage } from '../components/MdImage'
import { GlyphCites, RefChip } from '../components/RefChip'
import { rehypeNumericCells } from '../lib/markdownCells'
import { parseRef, shownValue, splitValueRef } from '../lib/refs'
import { Mark, MarkItems } from '../marks/Mark'
import { asChecked, MARK_HREF, withMarkHrefs, type MarkItem } from '../marks/marks'

export interface ChipCtx {
  workspace: string
  /** the refs the link pass named as not resolving */
  broken: ReadonlySet<string>
  /** the failure per broken ref */
  why?: ReadonlyMap<string, string>
  /** the chips carry `data-anchor` (chat prose, where a ⌘-click may start a thread from a chip) */
  anchor?: boolean
}

export const ChipContext = createContext<ChipCtx>({ workspace: '', broken: new Set() })

const BRACKET_SRC = String.raw`\[\[((?:[^\[\]\n]|\[[^\[\]\n]*\])+?)\]\]`
/** A bare ref typed into prose renders as the same chip as its `[[ref]]`: a card's (`card:<id>`, `cell:<id>`, with its
 * run, output lines, step or table cell), a label's or a group's, a report's or one of its passages
 * (`report:<slug>#<id>`), a view's or one of its units, an orientation call's, a thread's. Each needs its prefix's
 * colon right before the id, so prose such as "the report: it" stays text. One capturing group (inlineParse counts on it). */
export const BARE_SRC = String.raw`(?<![\w[|:/])((?:card|cell):[A-Za-z0-9_-]{6,}(?:@\d+|@out\d+#L\d+(?:-\d+)?|#step-\d+(?![\w/-])|#[^\s/]+\/[^\s,;)]*[^\s,;.)])?|(?:concept|group):[A-Za-z0-9_-]{6,}|report:[A-Za-z0-9_-]+(?:#[A-Za-z0-9_-]+)?|view:[a-z0-9][a-z0-9-]{0,39}(?:\/[^\s,;)]*[^\s,;.)])?|call:[A-Za-z0-9_-]+\/\d+(?:#L\d+(?:-L?\d+)?)?|chat:[A-Za-z0-9_-]{6,}(?:#\d+)?)`
const BARE_PREFIXES = ['card:', 'cell:', 'concept:', 'group:', 'report:', 'view:', 'call:', 'chat:']
const TOKEN_RE = new RegExp(`${BRACKET_SRC}|${BARE_SRC}`, 'g')

const PH_OPEN = ''
const PH_CLOSE = ''
const BRACKET_RE = new RegExp(BRACKET_SRC, 'g')
const PH_SRC = String.raw`([0-9a-f]*)`
const PH_RE = new RegExp(PH_SRC, 'g')
const utf8 = new TextEncoder()
const utf8d = new TextDecoder()
const toHex = (s: string) => Array.from(utf8.encode(s), (b) => b.toString(16).padStart(2, '0')).join('')
const fromHex = (h: string) => (h ? utf8d.decode(new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16)))) : '')

/** `text` with every `[[…]]` token replaced by a private-use marker the markdown parser leaves alone. */
export function protectTokens(text: string): string {
  return text.includes('[[') ? text.replace(BRACKET_RE, (_m, inner: string) => PH_OPEN + toHex(inner) + PH_CLOSE) : text
}
const restoreTokens = (text: string) => text.replace(PH_RE, (_m, hex: string) => `[[${fromHex(hex)}]]`)
const SPLIT_RE = new RegExp(`${PH_SRC}|${BRACKET_SRC}|${BARE_SRC}`, 'g')
function tokenOfSplit(m: RegExpMatchArray): { ref: string; value?: string } {
  if (m[1] != null) return splitValueRef(fromHex(m[1]).trim())
  if (m[2] != null) return splitValueRef(m[2].trim())
  return { ref: m[3] }
}
const mayHaveToken = (value: string) => value.includes(PH_OPEN) || value.includes('[[') || BARE_PREFIXES.some((p) => value.includes(p))

function splitText(value: string): (Element | Text)[] {
  const out: (Element | Text)[] = []
  let last = 0
  for (const m of value.matchAll(SPLIT_RE)) {
    const at = m.index ?? 0
    const { value: display, ref } = tokenOfSplit(m)
    if (at > last) {
      const before = value.slice(last, at)
      // the space before a bare citation hides with it while the links are off (refchip.css): "see [[ref]]." reads "see."
      const gap = display == null ? /\s+$/.exec(before) : null
      if (gap) {
        if (gap.index > 0) out.push({ type: 'text', value: before.slice(0, gap.index) })
        out.push({ type: 'element', tagName: 'span', properties: { className: ['refchip-gap'] }, children: [{ type: 'text', value: gap[0] }] })
      } else out.push({ type: 'text', value: before })
    }
    const props: Properties = { dataRef: ref }
    if (display != null) props.dataValue = display
    out.push({ type: 'element', tagName: 'span', properties: props, children: [] })
    last = at + m[0].length
  }
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) })
  return out
}

function restore(node: Root | Element): void {
  for (const child of node.children) {
    if (child.type === 'text') {
      if (child.value.includes(PH_OPEN)) child.value = restoreTokens(child.value)
    } else if (child.type === 'element') restore(child)
  }
}

function walk(node: Root | Element): void {
  if (node.type === 'element' && node.tagName === 'pre') {
    restore(node)
    return
  }
  let changed = false
  const next: (typeof node.children)[number][] = []
  for (const child of node.children) {
    if (child.type === 'text' && mayHaveToken(child.value)) {
      const parts = splitText(child.value)
      if (parts.length !== 1 || parts[0].type !== 'text') changed = true
      next.push(...parts)
    } else {
      if (child.type === 'element') walk(child)
      next.push(child)
    }
  }
  if (changed) node.children = next as typeof node.children
}

/** rehype plugin: `[[ref]]` markers in text nodes become `<span data-ref>` elements. */
export function rehypeRefChips() {
  return (tree: Root) => {
    walk(tree)
  }
}

/** An old citation of a value a card shows, `[[value|card:<id>#<col>/<row>]]` or `[[value|card:<id>@out<i>#L<n>]]`,
 * as a mark the check verified with that place as its evidence (failed when the link pass found it broken), so it
 * reads and opens as a mark does; null for any other ref. Pure. */
export function cardCitationMark(ref: string, value: string, broken?: string | null): MarkItem | null {
  const p = parseRef(ref)
  if (p?.kind !== 'cell' || !((p.col != null && p.row != null) || (p.out != null && p.line != null))) return null
  return {
    n: 0, piece: 0, k: 0, words: value, sentence: '', shown: value,
    status: broken != null ? 'failed' : 'verified',
    ...(broken != null ? { reason: broken || 'The value is no longer at this place of the card.' } : {}),
    evidence: { kind: 'card', card: p.cellId, ref },
  }
}

function MdSpan(props: JSX.IntrinsicElements['span'] & ExtraProps) {
  const ctx = useContext(ChipContext)
  const ref = (props as Record<string, unknown>)['data-ref']
  const value = (props as Record<string, unknown>)['data-value']
  if (typeof ref === 'string' && typeof value === 'string') {
    const item = cardCitationMark(ref, value, ctx.broken.has(ref) ? (ctx.why?.get(ref) ?? '') : null)
    if (item) return <Mark k={-1} item={item}>{shownValue(value)}</Mark>
  }
  if (typeof ref === 'string') {
    const broken = ctx.broken.has(ref)
    return <RefChip ref={ref} value={typeof value === 'string' ? value : undefined} broken={broken} brokenWhy={broken ? ctx.why?.get(ref) : undefined} anchor={ctx.anchor} workspace={ctx.workspace} cite />
  }
  const { node: _node, ...rest } = props
  return <span {...rest} />
}

/** The blocks a passage is looked for in, each alone. */
const MARK_BLOCKS = new Set(['p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'td', 'th'])

interface Piece {
  /** a text node, or null for a citation chip, whose shown value counts but is not wrapped */
  node: Text | null
  parent: Root | Element
  text: string
}

function piecesOf(node: Root | Element, out: Piece[] = []): Piece[] {
  for (const child of node.children) {
    if (child.type === 'text') out.push({ node: child, parent: node, text: child.value })
    else if (child.type === 'element') {
      const ref = child.properties?.dataRef
      if (typeof ref === 'string') out.push({ node: null, parent: node, text: typeof child.properties?.dataValue === 'string' ? child.properties.dataValue : '' })
      else piecesOf(child, out)
    }
  }
  return out
}

function blocksOf(node: Root | Element, out: Element[] = []): Element[] {
  for (const child of node.children) {
    if (child.type !== 'element' || child.tagName === 'pre') continue
    if (MARK_BLOCKS.has(child.tagName)) out.push(child)
    blocksOf(child, out)
  }
  return out
}

/** Wrap the text of `pieces` in [at, end) in <mark> elements of `m`, the first carrying the passage's anchor. */
function wrapPieces(pieces: Piece[], at: number, end: number, m: AnswerMark): void {
  let offset = 0
  let first = true
  for (const p of pieces) {
    const from = offset
    offset += p.text.length
    if (!p.node || offset <= at || from >= end) continue
    const s = Math.max(0, at - from)
    const e = Math.min(p.text.length, end - from)
    const props: Properties = { className: ['answer-tint', ...(m.active ? ['answer-tint-open'] : [])], dataAnswerComment: m.id, style: `--tint: ${m.colour}` }
    if (first) props.dataAnchor = m.ref
    first = false
    const parts: (Element | Text)[] = []
    if (s > 0) parts.push({ type: 'text', value: p.text.slice(0, s) })
    parts.push({ type: 'element', tagName: 'mark', properties: props, children: [{ type: 'text', value: p.text.slice(s, e) }] })
    if (e < p.text.length) parts.push({ type: 'text', value: p.text.slice(e) })
    const i = p.parent.children.indexOf(p.node)
    if (i >= 0) p.parent.children.splice(i, 1, ...(parts as typeof p.parent.children))
  }
}

/** rehype plugin: each passage of `marks` (a check's comment on this answer) found in the drawn words of one block is
 * wrapped in <mark class="answer-tint"> in its check's color; a passage not found draws nothing. */
export function rehypeAnswerMarks(options: { marks?: readonly AnswerMark[] } = {}) {
  return (tree: Root) => {
    const marks = options.marks ?? []
    if (!marks.length) return
    for (const m of marks) {
      const q = plainQuote(m.quote)
      if (!q) continue
      for (const b of blocksOf(tree)) {
        const pieces = piecesOf(b)
        const at = findQuote(pieces.map((p) => p.text).join(''), q)
        if (!at) continue
        wrapPieces(pieces, at[0], at[1], m)
        break
      }
    }
  }
}

/** What a tinted passage's click does: open its comment in a popover beside it (chat/Rows, AnswerComment.tsx). */
export const AnswerMarksContext = createContext<{ open: (id: string) => void } | null>(null)

function MdMark(props: JSX.IntrinsicElements['mark'] & ExtraProps) {
  const ctx = useContext(AnswerMarksContext)
  const { node: _node, ...rest } = props
  const id = (props as Record<string, unknown>)['data-answer-comment']
  if (typeof id !== 'string' || !ctx) return <mark {...rest} />
  return (
    <mark
      {...rest}
      role="button"
      tabIndex={0}
      onClick={(e) => {
        // a citation's words in the passage open the citation (marks/Mark), so the two popovers never open at once
        if ((e.target as HTMLElement).closest?.('.mark-words')) return
        e.stopPropagation()
        ctx.open(id)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          ctx.open(id)
        }
      }}
    />
  )
}

function MdLink(props: JSX.IntrinsicElements['a'] & ExtraProps) {
  const mark = MARK_HREF.exec(props.href ?? '')
  if (mark) return <Mark k={Number(mark[1])}>{props.children}</Mark>
  const { node: _node, ...rest } = props
  return <a {...rest} target="_blank" rel="noreferrer" />
}

// a fenced block in the language it names takes the syntax colours code has everywhere (components/Code.tsx); an image
// loads only from the machine (components/MdImage)
const components: Components = { span: MdSpan, a: MdLink, code: MarkdownCode, img: MdImage, mark: MdMark }
// a single ~ is no strikethrough: page and file names hold it (`dse~Agent`, live check L21); ~~two~~ still is
const remarkPlugins: Options['remarkPlugins'] = [[remarkGfm, { singleTilde: false }]]
const rehypePlugins = [rehypeRefChips, rehypeNumericCells]

const NO_MARKS: readonly AnswerMark[] = []

const MarkdownBlock = memo(function MarkdownBlock({ text, marks = NO_MARKS }: { text: string; marks?: readonly AnswerMark[] }) {
  const plugins: Options['rehypePlugins'] = marks.length ? [rehypeRefChips, [rehypeAnswerMarks, { marks }], rehypeNumericCells] : rehypePlugins
  return (
    <Markdown remarkPlugins={remarkPlugins} rehypePlugins={plugins} components={components}>
      {protectTokens(text)}
    </Markdown>
  )
})

/** Assistant markdown with chips and marks. `streaming`: the text is still growing and renders per completed block.
 * `checks`: what the check found of each of its marks, by their order in the text. `marks`: the passages the checks
 * commented on, tinted (rehypeAnswerMarks). A bare citation in it is its target's glyph alone, its name in the hover,
 * as in a card, and a card's its chip with the card's name (components/RefChip GlyphCites). */
export const ChatMarkdown = memo(function ChatMarkdown({ text, streaming, checks, marks }: { text: string; streaming?: boolean; checks?: readonly (MarkItem | undefined)[]; marks?: readonly AnswerMark[] }) {
  const [chunked, setChunked] = useState(!!streaming)
  if (streaming && !chunked) setChunked(true)
  // once checked, the text reads as the check left it: its rewritten sentences and corrected words in place
  const read = useMemo(() => (checks && !streaming ? asChecked(text, checks) : { text, checks: checks ?? [] }), [text, checks, streaming])
  // each mark's href names its order in the whole text, so a block cut from it still finds its check
  const marked = withMarkHrefs(read.text)
  return (
    <MarkItems.Provider value={{ items: read.checks, streaming: !!streaming }}>
      <GlyphCites.Provider value={true}>
        {!chunked && !streaming ? (
          <MarkdownBlock text={marked} marks={marks} />
        ) : (
          splitMarkdownBlocks(marked).map((chunk, i) => (
            <Fragment key={i}>
              {i > 0 && '\n'}
              <MarkdownBlock text={chunk} marks={marks} />
            </Fragment>
          ))
        )}
      </GlyphCites.Provider>
    </MarkItems.Provider>
  )
})

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/
const LIST_ITEM = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?: |$)/
const INDENTED = /^(?: {4}|\t)/
const BLANK = /^\s*$/
const NO_SPLIT = /^ {0,3}\[[^\]]*\]:|<(?:script|pre|style|textarea)\b|<!--|<\?|<!\[CDATA\[|<![A-Za-z]/im

/** Cut `text` at blank lines where block structure cannot cross the cut, so each chunk parses as it would whole. */
export function splitMarkdownBlocks(text: string): string[] {
  if (NO_SPLIT.test(text)) return [text]
  const lines = text.split('\n')
  const chunks: string[] = []
  let start = 0
  let offset = 0
  let fence: { ch: string; n: number } | null = null
  let hasList = false
  let hasContent = false
  let afterBlank = false
  for (const line of lines) {
    if (fence) {
      const m = FENCE_CLOSE.exec(line)
      if (m && m[1][0] === fence.ch && m[1].length >= fence.n) fence = null
      afterBlank = false
    } else if (BLANK.test(line)) {
      afterBlank = true
    } else {
      if (afterBlank && hasContent && !INDENTED.test(line) && !(hasList && (LIST_ITEM.test(line) || /^\s/.test(line)))) {
        chunks.push(text.slice(start, offset))
        start = offset
        hasList = false
        hasContent = false
      }
      const f = FENCE_OPEN.exec(line)
      if (f) fence = { ch: f[1][0], n: f[1].length }
      else if (LIST_ITEM.test(line) || INDENTED.test(line)) hasList = true
      hasContent = true
      afterBlank = false
    }
    offset += line.length + 1
  }
  chunks.push(text.slice(start))
  return chunks
}

/** Plain text as typed, with only the `[[ref]]` tokens turned into chips. `cite`: the text is the model's prose (an
 * aside), so a bare ref is a citation, its target's glyph alone as in a reply (ChatMarkdown). */
export function RefText({ text, workspace, cite = false }: { text: string; workspace: string; cite?: boolean }): ReactNode {
  const ctx = useContext(ChipContext)
  const parts: (string | { ref: string; value?: string })[] = []
  let last = 0
  for (const m of text.matchAll(TOKEN_RE)) {
    const at = m.index ?? 0
    if (at > last) parts.push(text.slice(last, at))
    parts.push(m[1] != null ? splitValueRef(m[1].trim()) : { ref: m[2] })
    last = at + m[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  const shown = parts.map((p, i) =>
    typeof p === 'string' ? <Fragment key={i}>{p}</Fragment> : <RefChip key={i} ref={p.ref} value={p.value} compact anchor={ctx.anchor} workspace={workspace} cite={cite} />,
  )
  return cite ? <GlyphCites.Provider value={true}>{shown}</GlyphCites.Provider> : <>{shown}</>
}
