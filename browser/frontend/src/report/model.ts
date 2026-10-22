// The report's pure helpers: the document as editor blocks and back, a sentence's inline content, sentence spans in
// a block's text, card drop positions, filter sets, the other document types in the report's shape and the type bar's
// options. The story's helpers are in storyModel.ts.
import { parseRef } from '../lib/refs'
import type { AnyDoc, Cell, LabelRow, ReportBlock, TypesState, Writeup, WriteupFigure, WriteupParagraph, WriteupSection, WriteupSentence } from '../lib/types'
import { storageKey } from '../lib/workspace'
import { parseInline, type InlineNode } from './inlineParse'

export const SLUG = 'report'
/** the editor's first block, the document's title */
export const TITLE_ID = 'title'
/** what a citation counts as in a block's plain text: one character, so positions line up with the editor's */
export const CITE_CHAR = ''

/** A paragraph as one editable text: its sentences' stored text, refs kept as their `[[…]]` tokens. */
export function paragraphText(p: WriteupParagraph): string {
  return p.sentences
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join(' ')
}

/** Whether the frame routes may edit or remove a unit here: every unit of a frame, only pinned units of a document. */
export function editable(doc: Pick<Writeup, 'frame'>, unit: object): boolean {
  return doc.frame === true || (unit as { pinned?: boolean }).pinned === true
}

export interface ReportFilterSets {
  /** the sentence ids the value covers */
  sids: Set<string>
  /** the row's rationale per sentence id, when it has one */
  rationale: Map<string, string>
}

/** The sentences a filter value covers, from the label's rows: refs `report:<slug>#<sid>`, other refs ignored. */
export function reportFilterSets(rows: LabelRow[], slug: string): ReportFilterSets {
  const sids = new Set<string>()
  const rationale = new Map<string, string>()
  for (const row of rows) {
    const p = parseRef(row.ref)
    if (!p || p.kind !== 'report' || p.slug !== slug || !p.unit) continue
    sids.add(p.unit)
    const why = typeof row.rationale === 'string' ? row.rationale.trim() : ''
    if (why) rationale.set(p.unit, why)
  }
  return { sids, rationale }
}

/** Whether a label over sentences read the document `slug` at all; a document it never read takes no filter from it. */
export function labelReadDocument(rows: LabelRow[], slug: string): boolean {
  return rows.some((row) => {
    const p = parseRef(row.ref)
    return !!p && p.kind === 'report' && p.slug === slug && !!p.unit
  })
}

/** Whether the filter leaves a sentence standing. Without a filter everything stands. */
export function sentenceStands(sets: ReportFilterSets | null, sid: string): boolean {
  return sets == null || sets.sids.has(sid)
}

/** The cards a figure can show, the ones that draw a figure (components/Outputs figureKind), in canvas order. */
export function figureCandidates(cells: Cell[], figureKind: (cell: Cell) => string | null): Cell[] {
  return cells.filter((c) => figureKind(c) != null)
}

/** The figures placed after paragraph `pid` (null for the section's end and for figures whose paragraph is gone). */
export function figuresAfter(sec: WriteupSection, pid: string | null): WriteupFigure[] {
  const figs = sec.figures ?? []
  if (pid !== null) return figs.filter((f) => (f.after_paragraph ?? null) === pid)
  return figs.filter((f) => !f.lead && (!f.after_paragraph || !sec.paragraphs.some((p) => p.id === f.after_paragraph)))
}

// ---- inline content: a sentence's text as the editor holds it, and back ----

export type Styles = { bold?: true; italic?: true; code?: true }
export type StyledText = { type: 'text'; text: string; styles: Styles }
/** the editor's inline content: styled text, a link over styled text, or a citation atom */
export type InlinePart = StyledText | { type: 'link'; href: string; content: StyledText[] } | { type: 'cite'; props: { value: string; ref: string } }

const sameStyles = (a: Styles, b: Styles) => !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.code === !!b.code

function pushText(out: InlinePart[], text: string, styles: Styles): void {
  if (!text) return
  const prev = out[out.length - 1]
  if (prev && prev.type === 'text' && sameStyles(prev.styles, styles)) prev.text += text
  else out.push({ type: 'text', text, styles: { ...styles } })
}

const token = (n: { ref: string; value?: string; bare?: boolean }) => (n.bare ? n.ref : n.value != null && n.value !== '' ? `[[${n.value}|${n.ref}]]` : `[[${n.ref}]]`)

function walkInline(nodes: InlineNode[], styles: Styles, out: InlinePart[], inLink: boolean): void {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        pushText(out, n.text, styles)
        break
      case 'code':
        pushText(out, n.text, { ...styles, code: true })
        break
      case 'ref':
        if (inLink) pushText(out, token(n), styles)
        else out.push({ type: 'cite', props: { value: n.value ?? '', ref: n.ref } })
        break
      case 'link': {
        const inner: InlinePart[] = []
        walkInline(n.children, styles, inner, true)
        out.push({ type: 'link', href: n.href, content: inner.filter((p): p is StyledText => p.type === 'text') })
        break
      }
      case 'strong':
        walkInline(n.children, { ...styles, bold: true }, out, inLink)
        break
      case 'em':
        walkInline(n.children, { ...styles, italic: true }, out, inLink)
        break
    }
  }
}

/** A sentence's text (or several joined) as the editor's inline content: styled text, links, citation atoms. */
export function contentFromText(text: string): InlinePart[] {
  const out: InlinePart[] = []
  walkInline(parseInline(text), {}, out, false)
  return out
}

/** One styled run back to markdown, the markers hugging the words so the parser reads them again. */
function styledToText(t: StyledText): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(t.text)
  if (!m) return t.text
  let [, lead, core, trail] = m
  if (!core) return t.text
  if (t.styles.code) core = '`' + core + '`'
  if (t.styles.bold) core = `**${core}**`
  if (t.styles.italic) core = `*${core}*`
  return lead + core + trail
}

/** The editor's inline content back to a sentence's text: styles as markdown, links as `[text](href)`, citations as `[[…]]`. */
export function textFromContent(content: readonly InlinePart[] | undefined): string {
  if (!content) return ''
  return content
    .map((p) => {
      if (p.type === 'text') return styledToText(p)
      if (p.type === 'link') return `[${p.content.map(styledToText).join('')}](${p.href})`
      return p.props.value ? `[[${p.props.value}|${p.props.ref}]]` : `[[${p.props.ref}]]`
    })
    .join('')
    .trim()
}

/** A sentence's plain text as the editor lays it out: markers gone, every citation one CITE_CHAR. */
export function plainOf(text: string): string {
  const walk = (nodes: InlineNode[]): string =>
    nodes
      .map((n) => {
        switch (n.kind) {
          case 'text':
          case 'code':
            return n.text
          case 'ref':
            return CITE_CHAR
          default:
            return walk(n.children)
        }
      })
      .join('')
  return walk(parseInline(text))
}

/** What a stored sentence's text says without its citations: a cited value stays, a bare citation goes with the
 * space before it, whitespace squeezed. For a thread's anchor text, the Checks list and a figure's caption. */
export function readableText(text: string): string {
  return text
    .replace(/\[\[([^\[\]|]*)\|[^\[\]]*\]\]/g, '$1')
    .replace(/\s*\[\[[^\[\]]*\]\]\s*(?=[.,;:!?])/g, '')
    .replace(/\[\[[^\[\]]*\]\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** What a block's text says without its citations, for a thread's anchor text. */
export function readableOf(content: readonly InlinePart[] | undefined): string {
  return (content ?? [])
    .map((p) => (p.type === 'text' ? p.text : p.type === 'link' ? p.content.map((t) => t.text).join('') : p.props.value))
    .join('')
    .replace(/\s+(?=[.,;:!?])/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// ---- the document as blocks ----

export interface DocBlocks {
  title: string
  blocks: ReportBlock[]
}

const figureBlock = (f: WriteupFigure): ReportBlock => ({ id: f.id, type: 'figure', cell: f.cell ?? '', caption: f.caption ?? '' })

/** The document (or frame) as editor blocks: a heading per section, its lead figures, then each paragraph (a bullet
 * block per item when every sentence is one) followed by its figures. */
export function blocksFromDoc(doc: Pick<Writeup, 'title' | 'sections'>): DocBlocks {
  const blocks: ReportBlock[] = []
  for (const sec of doc.sections ?? []) {
    if ((sec.heading ?? '').trim()) blocks.push({ id: sec.id, type: 'heading', text: sec.heading ?? '', level: Math.max(sec.level ?? 2, 2) })
    for (const f of sec.figures ?? []) if (f.lead) blocks.push(figureBlock(f))
    for (const p of sec.paragraphs ?? []) {
      const items = p.sentences ?? []
      if (items.length > 0 && items.every((s) => s.bullet)) {
        for (const s of items) blocks.push({ id: s.id, type: 'bullet', text: s.text.trim(), marker: s.bullet === '1.' ? '1.' : '-' })
      } else blocks.push({ id: p.id, type: p.quote ? 'quote' : 'paragraph', text: paragraphText(p) })
      for (const f of figuresAfter(sec, p.id)) blocks.push(figureBlock(f))
    }
    for (const f of figuresAfter(sec, null)) blocks.push(figureBlock(f))
  }
  return { title: doc.title ?? '', blocks }
}

/** The text every block was built from, by id (the title under TITLE_ID), so an untouched block saves as it was. */
export function origTexts(wire: DocBlocks): Map<string, string> {
  const out = new Map<string, string>()
  out.set(TITLE_ID, wire.title)
  for (const b of wire.blocks) if (b.text != null) out.set(b.id, b.text)
  return out
}

/** The shape of an editor block this module reads: BlockNote's `Block` fits it. */
export interface EditorBlockLike {
  id: string
  type: string
  props?: Record<string, unknown>
  content?: unknown
  children?: EditorBlockLike[]
}

/** A BlockNote partial block as this module builds it. */
export interface EditorPartialBlock {
  id: string
  type: string
  props?: Record<string, unknown>
  content?: InlinePart[]
}

/** The editor's blocks from the wire form: the title as the first heading (left out with `withTitle` false, for a
 * scene or a slide that has no title of its own), sections as level-2 headings. */
export function editorBlocksFromWire(wire: DocBlocks, withTitle = true): EditorPartialBlock[] {
  const out: EditorPartialBlock[] = withTitle ? [{ id: TITLE_ID, type: 'heading', props: { level: 1 }, content: contentFromText(wire.title) }] : []
  for (const b of wire.blocks) {
    switch (b.type) {
      case 'heading':
        out.push({ id: b.id, type: 'heading', props: { level: Math.min(Math.max(b.level ?? 2, 2), 6) }, content: contentFromText(b.text ?? '') })
        break
      case 'paragraph':
        out.push({ id: b.id, type: 'paragraph', content: contentFromText(b.text ?? '') })
        break
      case 'quote':
        out.push({ id: b.id, type: 'quote', content: contentFromText(b.text ?? '') })
        break
      case 'bullet':
        out.push({ id: b.id, type: b.marker === '1.' ? 'numberedListItem' : 'bulletListItem', content: contentFromText(b.text ?? '') })
        break
      case 'figure':
        out.push({ id: b.id, type: 'figure', props: { cell: b.cell ?? '', caption: b.caption ?? '' } })
        break
    }
  }
  return out
}

function* flatten(blocks: readonly EditorBlockLike[]): Generator<EditorBlockLike> {
  for (const b of blocks) {
    yield b
    if (b.children?.length) yield* flatten(b.children)
  }
}

/** The editor's blocks as the wire form. A block whose content still reads as the text it was built from sends that
 * text unchanged, so the round trip never respells an untouched sentence; empty text blocks are left out. */
export function wireFromEditor(blocks: readonly EditorBlockLike[], orig: ReadonlyMap<string, string>): DocBlocks {
  let title = ''
  const out: ReportBlock[] = []
  const textOf = (b: EditorBlockLike): string => {
    const raw = textFromContent(b.content as InlinePart[] | undefined)
    const o = orig.get(b.id)
    return o != null && textFromContent(contentFromText(o)) === raw ? o : raw
  }
  for (const b of flatten(blocks)) {
    const props = b.props ?? {}
    switch (b.type) {
      case 'heading': {
        const text = textOf(b)
        if (b.id === TITLE_ID) {
          title = text
          break
        }
        if (text) out.push({ id: b.id, type: 'heading', text, level: typeof props.level === 'number' ? props.level : 2 })
        break
      }
      case 'bulletListItem':
      case 'numberedListItem': {
        const text = textOf(b)
        if (text) out.push({ id: b.id, type: 'bullet', text, marker: b.type === 'numberedListItem' ? '1.' : '-' })
        break
      }
      case 'figure':
        out.push({ id: b.id, type: 'figure', cell: String(props.cell ?? ''), caption: String(props.caption ?? '') })
        break
      case 'quote': {
        const text = textOf(b)
        if (text) out.push({ id: b.id, type: 'quote', text })
        break
      }
      case PROMPT_TYPE:
        // a prompt is the editor's alone until Enter turns it into a figure request: the document never stores one
        break
      default: {
        const text = textOf(b)
        if (text) out.push({ id: b.id, type: 'paragraph', text })
      }
    }
  }
  return { title, blocks: out }
}

/** The editor's block type of a figure prompt (the slash menu's `Prompt`): one field whose Enter posts a figure request. */
export const PROMPT_TYPE = 'prompt'

/** What a text block can be turned into, from its type menu or the slash menu's Turn into items. */
export type BlockKind = 'text' | 'heading' | 'subheading' | 'bullets' | 'numbers' | 'quote'
export const BLOCK_KINDS: readonly BlockKind[] = ['text', 'heading', 'subheading', 'bullets', 'numbers', 'quote']

/** The kind of an editor block; null for a block whose type does not change (the title, a figure, a prompt). */
export function kindOf(block: Pick<EditorBlockLike, 'id' | 'type' | 'props'>): BlockKind | null {
  if (block.id === TITLE_ID) return null
  switch (block.type) {
    case 'paragraph':
      return 'text'
    case 'heading':
      return Number(block.props?.level ?? 2) >= 3 ? 'subheading' : 'heading'
    case 'bulletListItem':
      return 'bullets'
    case 'numberedListItem':
      return 'numbers'
    case 'quote':
      return 'quote'
    default:
      return null
  }
}

/** The editor's block type and props of a kind, as updateBlock takes them. */
export function blockOfKind(kind: BlockKind): { type: string; props?: Record<string, unknown> } {
  switch (kind) {
    case 'heading':
      return { type: 'heading', props: { level: 2 } }
    case 'subheading':
      return { type: 'heading', props: { level: 3 } }
    case 'bullets':
      return { type: 'bulletListItem' }
    case 'numbers':
      return { type: 'numberedListItem' }
    case 'quote':
      return { type: 'quote' }
    default:
      return { type: 'paragraph' }
  }
}

/** The unit a prompt's figure follows: the nearest paragraph, bullet with text or section heading above `id`; null
 * above the first such block. The title never counts. */
export function anchorAbove(blocks: readonly EditorBlockLike[], id: string): string | null {
  let found: string | null = null
  for (const b of flatten(blocks)) {
    if (b.id === id) return found
    if (b.type === 'heading') found = b.id === TITLE_ID ? null : b.id
    else if ((b.type === 'paragraph' || b.type === 'bulletListItem' || b.type === 'numberedListItem') && textFromContent(b.content as InlinePart[] | undefined)) found = b.id
  }
  return null
}

export function sameWire(a: DocBlocks, b: DocBlocks): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** The id of the last block of `next` that is new or changed from the block at its place in `prev`: where a write
 * streaming in grows. Null when nothing changed. Pure. */
export function lastChanged(prev: DocBlocks, next: DocBlocks): string | null {
  for (let i = next.blocks.length - 1; i >= 0; i--) {
    if (JSON.stringify(next.blocks[i]) !== JSON.stringify(prev.blocks[i])) return next.blocks[i].id ?? null
  }
  return null
}

/** Where a card dropped at `y` goes among the page's top-level blocks: before the first block whose middle is below
 * `y`, else after the last; never before the title. Null without blocks. */
export function dropSlot(blocks: readonly { id: string; top: number; bottom: number }[], y: number, titleId = TITLE_ID): { at: number; before: string | null } | null {
  if (!blocks.length) return null
  const i = blocks.findIndex((b) => y < (b.top + b.bottom) / 2)
  if (i < 0) return { at: blocks[blocks.length - 1].bottom, before: null }
  if (blocks[i].id === titleId) {
    const next = blocks[i + 1]
    return next ? { at: next.top, before: next.id } : { at: blocks[i].bottom, before: null }
  }
  return { at: blocks[i].top, before: blocks[i].id }
}

/** The viewport top of a hovered block's actions: centred on the block's first line, clamped to the pane's top while
 * that line is scrolled out, and never below the block's bottom. */
export function actsTop(line: { top: number; height: number }, height: number, blockBottom: number, paneTop: number): number {
  const centred = line.top + (line.height - height) / 2
  if (centred >= paneTop) return centred
  return Math.max(centred, Math.min(paneTop, blockBottom - height))
}

/** The ⌘ pointer's anchor of a block: the section, the paragraph (`#p<id>`), the bullet's sentence, the figure; the title is the document. */
export function anchorFor(slug: string, block: { id: string; type: string }): string {
  if (block.id === TITLE_ID) return `report:${slug}`
  if (block.type === 'paragraph') return `report:${slug}#p${block.id}`
  return `report:${slug}#${block.id}`
}

// ---- the sentence spans a block's text still holds ----

export interface SentenceSpan {
  sentence: WriteupSentence
  /** offsets into the block's plain text */
  from: number
  to: number
}

/** The stored sentences found in a block's plain text, in order, each searched from where the last one ended; a
 * sentence the analyst changed is skipped and the ones after it still match. */
export function sentenceSpans(plain: string, sentences: readonly WriteupSentence[]): SentenceSpan[] {
  const out: SentenceSpan[] = []
  let cursor = 0
  for (const s of sentences) {
    const needle = plainOf(s.text).trim()
    if (!needle) continue
    const at = plain.indexOf(needle, cursor)
    if (at < 0) continue
    out.push({ sentence: s, from: at, to: at + needle.length })
    cursor = at + needle.length
  }
  return out
}

/** The document's sentences by paragraph id and by sentence id, and its section ids. */
export function indexDoc(doc: Pick<Writeup, 'sections'>): { byParagraph: Map<string, WriteupSentence[]>; bySentence: Map<string, WriteupSentence>; sections: Set<string> } {
  const byParagraph = new Map<string, WriteupSentence[]>()
  const bySentence = new Map<string, WriteupSentence>()
  const sections = new Set<string>()
  for (const sec of doc.sections ?? []) {
    sections.add(sec.id)
    for (const p of sec.paragraphs ?? []) {
      byParagraph.set(p.id, p.sentences ?? [])
      for (const s of p.sentences ?? []) bySentence.set(s.id, s)
    }
  }
  return { byParagraph, bySentence, sections }
}

/** A document's sections, as History reads a past draft. */
export function sectionsOf(doc: AnyDoc): WriteupSection[] {
  return (doc as Writeup).sections ?? []
}

// ---- the switcher ----

/** the three document types in the type bar's order */
/** A document's name on its chip in the bar: Report, or the name the person gave it (else its slug). */
export const docLabel = (slug: string, state: TypesState | null | undefined): string => (slug === SLUG ? 'Report' : (state?.[slug]?.name ?? '').trim() || slug)

/** The browser-storage key of the document the tab shows, per workspace. */
export const docKey = (ws: string): string => storageKey(ws, 'report-doc')
