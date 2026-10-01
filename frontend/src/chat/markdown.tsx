// Assistant markdown: react-markdown with remark-gfm, the `[[value|ref]]` tokens turned into chips. The tokens are
// hidden from the markdown parser first (protectTokens) so nothing inside a ref reads as markup, then a rehype pass turns
// the markers back into spans that render as RefChip. A streaming text renders per completed block, so a delta
// re-parses only the tail.
import { Fragment, createContext, memo, useContext, useState, type JSX, type ReactNode } from 'react'
import Markdown, { type Components, type ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Element, Properties, Root, Text } from 'hast'
import { MarkdownCode } from '../components/Code'
import { MdImage } from '../components/MdImage'
import { GlyphCites, RefChip } from '../components/RefChip'
import { rehypeNumericCells } from '../lib/markdownCells'
import { splitValueRef } from '../lib/refs'

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
/** a bare `card:<id>` (or `cell:<id>`) or `concept:<id>` typed into prose renders as the same chip */
export const BARE_SRC = String.raw`(?<![\w[|:])((?:card|cell):[A-Za-z0-9_-]{6,}(?:@\d+|@out\d+#L\d+(?:-\d+)?|#[^\s/]+\/[^\s,;)]*[^\s,;.)])?|(?:concept|group):[A-Za-z0-9_-]{6,})`
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
const mayHaveToken = (value: string) => value.includes(PH_OPEN) || value.includes('[[') || value.includes('card:') || value.includes('cell:') || value.includes('concept:') || value.includes('group:')

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

function MdSpan(props: JSX.IntrinsicElements['span'] & ExtraProps) {
  const ctx = useContext(ChipContext)
  const ref = (props as Record<string, unknown>)['data-ref']
  const value = (props as Record<string, unknown>)['data-value']
  if (typeof ref === 'string') {
    const broken = ctx.broken.has(ref)
    return <RefChip ref={ref} value={typeof value === 'string' ? value : undefined} broken={broken} brokenWhy={broken ? ctx.why?.get(ref) : undefined} anchor={ctx.anchor} workspace={ctx.workspace} cite />
  }
  const { node: _node, ...rest } = props
  return <span {...rest} />
}

function MdLink(props: JSX.IntrinsicElements['a'] & ExtraProps) {
  const { node: _node, ...rest } = props
  return <a {...rest} target="_blank" rel="noreferrer" />
}

// a fenced block in the language it names takes the syntax colours code has everywhere (components/Code.tsx); an image
// loads only from the machine (components/MdImage)
const components: Components = { span: MdSpan, a: MdLink, code: MarkdownCode, img: MdImage }
const remarkPlugins = [remarkGfm]
const rehypePlugins = [rehypeRefChips, rehypeNumericCells]

const MarkdownBlock = memo(function MarkdownBlock({ text }: { text: string }) {
  return (
    <Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
      {protectTokens(text)}
    </Markdown>
  )
})

/** Assistant markdown with chips. `streaming`: the text is still growing and renders per completed block. A bare
 * citation in it is its target's glyph alone, its name in the hover, as in a card (components/RefChip GlyphCites). */
export const ChatMarkdown = memo(function ChatMarkdown({ text, streaming }: { text: string; streaming?: boolean }) {
  const [chunked, setChunked] = useState(!!streaming)
  if (streaming && !chunked) setChunked(true)
  if (!chunked && !streaming) {
    return (
      <GlyphCites.Provider value={true}>
        <MarkdownBlock text={text} />
      </GlyphCites.Provider>
    )
  }
  const chunks = splitMarkdownBlocks(text)
  return (
    <GlyphCites.Provider value={true}>
      {chunks.map((chunk, i) => (
        <Fragment key={i}>
          {i > 0 && '\n'}
          <MarkdownBlock text={chunk} />
        </Fragment>
      ))}
    </GlyphCites.Provider>
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
