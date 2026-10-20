// Assistant markdown: react-markdown with remark-gfm, the `[[value|ref]]` tokens turned into chips. The tokens are
// hidden from the markdown parser first (protectTokens) so nothing inside a ref reads as markup, then a rehype pass turns
// the markers back into spans that render as RefChip. A streaming text renders per completed block, so a delta
// re-parses only the tail.
import { Fragment, createContext, memo, useContext, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import Markdown, { type Components, type ExtraProps, type Options } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Element, Properties, Root, Text } from 'hast'
import { MarkdownCode } from '../components/Code'
import { MdImage } from '../components/MdImage'
import { GlyphCites, RefChip } from '../components/RefChip'
import { rehypeNumericCells } from '../lib/markdownCells'
import { splitValueRef } from '../lib/refs'
import { LensMark } from '../components/LensMark'
import type { Lens, Mark } from '../lib/marks'
import { useFeature } from '../features'
import { api, type HealResult } from '../lib/api'

export interface ChipCtx {
  workspace: string
  /** the refs the link pass named as not resolving */
  broken: ReadonlySet<string>
  /** the failure per broken ref */
  why?: ReadonlyMap<string, string>
  /** the chips carry `data-anchor` (chat prose, where a ⌘-click may start a thread from a chip) */
  anchor?: boolean
  /** the citations the healing pass made quiet (their place is gone), with why */
  quiet?: ReadonlyMap<string, string>
  /** the citations it re-pointed: the new ref, and the ref as written */
  moved?: ReadonlyMap<string, string>
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

/** A Markdown link whose target is a ref rather than a web page, as Claude writes a citation in thimble browser and in
 * the terminal plugin alike: `[31](card:<id>#outcome/merged)`, `["quote"](runs/x.jsonl#L4)`, `[↗](<ref>)`. A ref may
 * hold spaces (a column's name), written as they are or as %20. */
const CITE_LINK_RE = /(?<!!)\[([^\[\]\n]*)\]\(([^()\n]+?)\)/g
const WEB_TARGET = /^(?:[a-z][a-z0-9+.-]*:\/\/|mailto:|#|\/)/i

/** `text` with each citation written as a Markdown link turned into the `[[value|ref]]` token the chips read; a link to
 * a web page stays a link. Pure. */
export function citeLinks(text: string): string {
  if (!text.includes('](')) return text
  return text.replace(CITE_LINK_RE, (whole, words: string, target: string) => {
    if (WEB_TARGET.test(target.trim())) return whole
    const ref = target.trim().replace(/%20/g, ' ')
    const shown = words.trim()
    return !shown || shown === '↗' ? `[[${ref}]]` : `[[${shown}|${ref}]]`
  })
}

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

/** The marks a text shows, with the lenses that made them (lib/marks.ts). */
const MarkContext = createContext<{ marks: readonly Mark[]; lenses: readonly Lens[] }>({ marks: [], lenses: [] })

/** rehype plugin: the first place each term of `terms` stands in the text (outside code and chips) becomes a
 * `<span data-mark-at=i>` that renders as its lens's mark. */
export function rehypeMarks(terms: readonly string[]) {
  return (tree: Root) => {
    const left = new Set(terms.map((_, i) => i))
    const visit = (node: Root | Element): void => {
      if (!left.size) return
      if (node.type === 'element' && (node.tagName === 'code' || node.tagName === 'pre' || node.properties?.dataRef != null)) return
      const next: (typeof node.children)[number][] = []
      let changed = false
      for (const child of node.children) {
        if (child.type !== 'text' || !left.size) {
          if (child.type === 'element') visit(child)
          next.push(child)
          continue
        }
        let rest = child.value
        for (;;) {
          let best: { i: number; at: number } | null = null
          for (const i of left) {
            const at = rest.indexOf(terms[i])
            if (at >= 0 && (!best || at < best.at)) best = { i, at }
          }
          if (!best) break
          changed = true
          left.delete(best.i)
          if (best.at > 0) next.push({ type: 'text', value: rest.slice(0, best.at) })
          next.push({ type: 'element', tagName: 'span', properties: { dataMarkAt: String(best.i) }, children: [{ type: 'text', value: terms[best.i] }] })
          rest = rest.slice(best.at + terms[best.i].length)
        }
        if (rest) next.push({ type: 'text', value: rest })
      }
      if (changed) node.children = next as typeof node.children
    }
    visit(tree)
  }
}

function MdSpan(props: JSX.IntrinsicElements['span'] & ExtraProps) {
  const ctx = useContext(ChipContext)
  const marks = useContext(MarkContext)
  // citations are the citations feature's (features.ts): while it is off, a link's words are plain text
  const citing = useFeature('citations')
  const markAt = (props as Record<string, unknown>)['data-mark-at']
  if (typeof markAt === 'string' && marks.marks[Number(markAt)]) {
    const m = marks.marks[Number(markAt)]
    return (
      <LensMark mark={m} lens={marks.lenses.find((l) => l.id === m.lens)}>
        {props.children}
      </LensMark>
    )
  }
  const ref = (props as Record<string, unknown>)['data-ref']
  const value = (props as Record<string, unknown>)['data-value']
  if (typeof ref === 'string' && !citing) return <span className="cite-off">{typeof value === 'string' ? value : props.children}</span>
  if (typeof ref === 'string') {
    const broken = ctx.broken.has(ref)
    const quiet = !broken && !!ctx.quiet?.has(ref)
    return <RefChip ref={ref} value={typeof value === 'string' ? value : undefined} broken={broken} brokenWhy={broken ? ctx.why?.get(ref) : undefined} quiet={quiet} quietWhy={quiet ? ctx.quiet?.get(ref) : undefined} movedFrom={ctx.moved?.get(ref)} anchor={ctx.anchor} workspace={ctx.workspace} cite />
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
// a single ~ is no strikethrough: page and file names hold it (`dse~Agent`, live check L21); ~~two~~ still is
const remarkPlugins: Options['remarkPlugins'] = [[remarkGfm, { singleTilde: false }]]
const rehypePlugins = [rehypeRefChips, rehypeNumericCells]

const MarkdownBlock = memo(function MarkdownBlock({ text }: { text: string }) {
  const { marks } = useContext(MarkContext)
  const plugins = useMemo(() => (marks.length ? [...rehypePlugins, () => rehypeMarks(marks.map((m) => m.term))] : rehypePlugins), [marks])
  return (
    <Markdown remarkPlugins={remarkPlugins} rehypePlugins={plugins} components={components}>
      {protectTokens(citeLinks(text))}
    </Markdown>
  )
})

/** Assistant markdown with chips. `streaming`: the text is still growing and renders per completed block. A bare
 * citation in it is its target's glyph alone, its name in the hover, as in a card (components/RefChip GlyphCites). */
/** The healing pass's results by text, for this page load: a text is checked once. */
const healed = new Map<string, HealResult | null>()

/** What the healing pass did to a whole reply's citations of card values (backend cards/heal.py), once it is whole. */
function useHeal(workspace: string, text: string, streaming: boolean): HealResult | null {
  const want = !streaming && !!workspace && /\]\((?:card|cell):/.test(text)
  const [got, setGot] = useState<HealResult | null>(() => (want ? healed.get(text) ?? null : null))
  useEffect(() => {
    if (!want) return
    if (healed.has(text)) { setGot(healed.get(text) ?? null); return }
    let live = true
    api.heal(workspace, text).then((r) => { healed.set(text, r); if (live) setGot(r) }, () => { healed.set(text, null) })
    return () => { live = false }
  }, [want, workspace, text])
  return want ? got : null
}

/** Assistant markdown with its citations as the healing pass left them: a re-pointed one opens its new place (its hover
 * says where it was moved from), a contradicted one is a broken chip with why, one whose place is gone is quiet. */
export const ChatMarkdown = memo(function ChatMarkdown(props: { text: string; streaming?: boolean; marks?: readonly Mark[]; lenses?: readonly Lens[] }) {
  const ctx = useContext(ChipContext)
  const heal = useHeal(ctx.workspace, props.text, !!props.streaming)
  const healedCtx = useMemo(() => {
    if (!heal) return null
    const broken = new Set(ctx.broken)
    const why = new Map(ctx.why ?? [])
    const quiet = new Map<string, string>()
    const moved = new Map<string, string>()
    for (const c of heal.changes) {
      if (c.state === 'contradicted') { broken.add(c.ref); why.set(c.ref, c.why ?? '') }
      else if (c.state === 'quiet') quiet.set(c.ref, c.why ?? '')
      else if (c.to && c.to !== c.ref) moved.set(c.to, c.ref)
    }
    return { ...ctx, broken, why, quiet, moved }
  }, [heal, ctx])
  if (!heal || !healedCtx) return <ReplyMarkdown {...props} />
  return (
    <ChipContext.Provider value={healedCtx}>
      <ReplyMarkdown {...props} text={heal.text} />
    </ChipContext.Provider>
  )
})

const ReplyMarkdown = memo(function ReplyMarkdown({ text, streaming, marks, lenses }: { text: string; streaming?: boolean; marks?: readonly Mark[]; lenses?: readonly Lens[] }) {
  const [chunked, setChunked] = useState(!!streaming)
  if (streaming && !chunked) setChunked(true)
  if (marks?.length && !streaming) {
    // the marks come after the reply is whole: one block, so each term is marked once
    return (
      <MarkContext.Provider value={{ marks, lenses: lenses ?? [] }}>
        <GlyphCites.Provider value={true}>
          <MarkdownBlock text={text} />
        </GlyphCites.Provider>
      </MarkContext.Provider>
    )
  }
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
