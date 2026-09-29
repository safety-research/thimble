// The report's pure helpers: the document as editor blocks and back, a sentence's inline content, sentence spans in
// a block's text, card drop positions, filter sets, the other document types in the report's shape and the type bar's
// options. The story's helpers are in storyModel.ts.
import { parseRef } from '../lib/refs'
import type { AnyDoc, Cell, DeckBody, DeckDoc, DeckSlide, LabelRow, PageDoc, ReportBlock, StoryDoc, TypesState, VideoDoc, Writeup, WriteupFigure, WriteupParagraph, WriteupSection, WriteupSentence } from '../lib/types'
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

/** The cards a figure can show: the ones whose primary artifact is a chart or a table, in canvas order. */
export function figureCandidates(cells: Cell[], artifactKind: (cell: Cell) => string | null): Cell[] {
  return cells.filter((c) => {
    const k = artifactKind(c)
    return k === 'chart' || k === 'table'
  })
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
      } else blocks.push({ id: p.id, type: 'paragraph', text: paragraphText(p) })
      for (const f of figuresAfter(sec, p.id)) blocks.push(figureBlock(f))
    }
    for (const f of figuresAfter(sec, null)) blocks.push(figureBlock(f))
  }
  return { title: doc.title ?? '', blocks }
}

/** The ids of the editor blocks the analyst locked: title, headings, paragraphs, every item of a locked list, figures. */
export function lockedBlocks(doc: Pick<Writeup, 'sections' | 'title_locked'>): Set<string> {
  const out = new Set<string>()
  if (doc.title_locked) out.add(TITLE_ID)
  for (const sec of doc.sections ?? []) {
    if (sec.locked) out.add(sec.id)
    for (const p of sec.paragraphs ?? []) {
      if (!p.locked) continue
      out.add(p.id)
      for (const s of p.sentences ?? []) out.add(s.id)
    }
    for (const f of sec.figures ?? []) if (f.locked) out.add(f.id)
  }
  return out
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
export type BlockKind = 'text' | 'heading' | 'subheading' | 'bullets' | 'numbers'
export const BLOCK_KINDS: readonly BlockKind[] = ['text', 'heading', 'subheading', 'bullets', 'numbers']

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

/** Every sentence of a document in the report's shape, in reading order. */
export function allSentences(doc: Pick<Writeup, 'sections'>): WriteupSentence[] {
  return (doc.sections ?? []).flatMap((sec) => (sec.paragraphs ?? []).flatMap((p) => p.sentences ?? []))
}

/** The ids a comment can be on, in reading order: each section's id, then its sentences'. */
export function passageOrder(doc: Pick<Writeup, 'sections'>): string[] {
  return (doc.sections ?? []).flatMap((sec) => [sec.id, ...(sec.paragraphs ?? []).flatMap((p) => (p.sentences ?? []).map((s) => s.id))])
}

/** Each sentence's paragraph as the ids of its sentences, by sentence id: what a comment on a whole paragraph tints. */
export function paragraphOf(doc: Pick<Writeup, 'sections'>): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const sec of doc.sections ?? []) {
    for (const p of sec.paragraphs ?? []) {
      const ids = (p.sentences ?? []).map((s) => s.id)
      for (const id of ids) out.set(id, ids)
    }
  }
  return out
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

// ---- the other documents in the report's shape: a story's sections, a deck's slides, a page's claims ----

export type DocShape = 'document' | 'story' | 'slides' | 'page' | 'video'

/** What a stored document is, by its renderer or its shape: `document` (sections), `story` (sections of blocks beside
 * their card), `slides`, `page` (html). */
export function shapeOf(doc: AnyDoc | null | undefined): DocShape {
  if (!doc) return 'document'
  const d = doc as { renderer?: string; slides?: unknown; sections?: unknown }
  if (d.renderer === 'story') return 'story'
  if (d.renderer === 'slides' || Array.isArray(d.slides)) return 'slides'
  if (d.renderer === 'video') return 'video'
  if (d.renderer === 'custom' && !Array.isArray(d.sections)) return 'page'
  return 'document'
}

/** a page's claims as one section */
export const CLAIMS_ID = 'claims'

/** A story's sections, already in the report's shape. */
export const sectionsOfStory = (doc: Pick<StoryDoc, 'sections'>): WriteupSection[] => doc.sections ?? []

/** A deck as sections: each slide a section whose lines are bullets (one block and one anchor per line), its figures leading. */
export function sectionsOfDeck(doc: Pick<DeckDoc, 'slides'>): WriteupSection[] {
  return (doc.slides ?? []).map((s) => ({
    id: s.id,
    heading: s.heading ?? '',
    paragraphs: [{ id: `${s.id}-p`, sentences: (s.sentences ?? []).map((x) => ({ ...x, bullet: x.bullet ?? '-' })) }],
    figures: slideFigures(s).map((f) => ({ id: f.id, cell: f.cell, caption: f.caption ?? '', lead: true })),
  }))
}

// ---- a deck's slides and their layouts (Deck.tsx; backend slides.py) ----

/** A slide's arrangement: `title`, `text` (heading and lines), `figure` (lines beside one or two cards), `card` (one
 * card across), `figures` (two to four cards in a row or grid), `quote`. */
export type SlideLayout = 'title' | 'text' | 'figure' | 'card' | 'figures' | 'quote'

/** A layout as the picker offers it: an arrangement with its card slots, a grid, and whether the lines are bullets
 * (null leaves them as they are). Ids match backend slides.PRESETS. */
export interface LayoutPreset {
  id: string
  label: string
  layout: SlideLayout
  slots: number
  grid: boolean
  bullets: boolean | null
}

export const PRESETS: readonly LayoutPreset[] = [
  { id: 'title', label: 'Title', layout: 'title', slots: 0, grid: false, bullets: null },
  { id: 'bullets', label: 'Bullets', layout: 'text', slots: 0, grid: false, bullets: true },
  { id: 'paragraph', label: 'Paragraph', layout: 'text', slots: 0, grid: false, bullets: false },
  { id: 'bullets + card', label: 'Bullets + card', layout: 'figure', slots: 1, grid: false, bullets: true },
  { id: 'paragraph + card', label: 'Paragraph + card', layout: 'figure', slots: 1, grid: false, bullets: false },
  { id: 'card', label: 'Card, full slide', layout: 'card', slots: 1, grid: false, bullets: null },
  { id: 'two cards', label: 'Two cards', layout: 'figures', slots: 2, grid: false, bullets: null },
  { id: 'three cards', label: 'Three cards', layout: 'figures', slots: 3, grid: false, bullets: null },
  { id: 'four cards', label: 'Four cards', layout: 'figures', slots: 4, grid: false, bullets: null },
  { id: 'card grid', label: 'Four cards in a grid', layout: 'figures', slots: 4, grid: true, bullets: null },
  { id: 'quote', label: 'Quote', layout: 'quote', slots: 0, grid: false, bullets: null },
]
const LAYOUT_IDS = new Set<string>(['title', 'text', 'figure', 'card', 'figures', 'quote'])
/** the most cards a slide holds */
export const MAX_SLIDE_FIGURES = 4
/** the card slots each layout shows, least and most; the others show none */
const SLOT_RANGE: Partial<Record<SlideLayout, [number, number]>> = { figure: [1, 2], card: [1, 1], figures: [2, MAX_SLIDE_FIGURES] }
/** the figure's share of the width a slide's format may set, in percent */
export const FIGURE_WIDTHS = [40, 50, 60] as const

/** A slide's figures in order: an older deck's `figure`, then `figures`, each once. */
export function slideFigures(s: Pick<DeckSlide, 'figure' | 'figures'>): { id: string; cell: string; caption: string }[] {
  const out: { id: string; cell: string; caption: string }[] = []
  for (const f of [s.figure, ...(s.figures ?? [])]) if (f && f.cell && !out.some((g) => g.id === f.id)) out.push({ id: f.id, cell: f.cell, caption: f.caption ?? '' })
  return out
}

/** A slide's quote, the sentence marked `quote`. */
export const slideQuote = (s: Pick<DeckSlide, 'sentences'>): WriteupSentence | null => (s.sentences ?? []).find((x) => x.quote) ?? null

/** A slide's lines, its quote left out. */
export const slideLines = (s: Pick<DeckSlide, 'sentences'>): WriteupSentence[] => (s.sentences ?? []).filter((x) => !x.quote)

/** A slide's layout: the stored one, else the one its cells call for, as the server has it (slides.layout_of). */
export function layoutOf(s: Pick<DeckSlide, 'layout' | 'sentences' | 'figure' | 'figures'>): SlideLayout {
  if (s.layout && LAYOUT_IDS.has(s.layout)) return s.layout as SlideLayout
  const figs = slideFigures(s).length
  if (slideQuote(s) && !figs) return 'quote'
  if (figs >= 2) return 'figures'
  if (figs) return 'figure'
  return slideLines(s).length ? 'text' : 'title'
}

/** A slide as the deck's editor holds it. The first `slotsOf` figures stand in the layout's card slots; the rest stay
 * on the slide unseen until a layout with room shows them. */
export interface EditSlide {
  id: string
  heading: string
  layout: SlideLayout
  side: 'left' | 'right'
  width: number
  /** the card slots the layout shows, within its range (slotsOf) */
  slots: number
  /** four cards in a grid of two by two rather than in a row */
  grid: boolean
  lines: { id: string; text: string }[]
  bullets: boolean
  quote: { id: string; text: string; speaker: string } | null
  figures: { id: string; cell: string; caption: string }[]
  notes: string
}

/** The card slots a slide shows: its `slots` within its layout's range; none for a layout without cards. */
export function slotsOf(s: Pick<EditSlide, 'layout' | 'slots'>): number {
  const range = SLOT_RANGE[s.layout]
  return range ? Math.max(range[0], Math.min(range[1], s.slots)) : 0
}

/** A stored slide as the editor holds it. Lines are bullets unless all are prose; slots follow the format, else as
 * the server reads them (slides.slots_of). */
export function editSlide(s: DeckSlide): EditSlide {
  const lines = slideLines(s)
  const q = slideQuote(s)
  const width = s.format?.width
  const layout = layoutOf(s)
  const figures = slideFigures(s)
  const stored = s.format?.slots
  const slots = slotsOf({ layout, slots: typeof stored === 'number' ? stored : layout === 'figures' ? figures.length : 1 })
  return {
    id: s.id,
    heading: s.heading ?? '',
    layout,
    side: s.format?.side === 'left' ? 'left' : 'right',
    width: typeof width === 'number' ? width : 50,
    slots,
    grid: layout === 'figures' && slots === MAX_SLIDE_FIGURES && s.format?.grid === true,
    lines: lines.map((x) => ({ id: x.id, text: x.text })),
    bullets: !lines.length || lines.some((x) => !!x.bullet),
    quote: q ? { id: q.id, text: q.text, speaker: q.speaker ?? '' } : null,
    figures,
    notes: s.notes ?? '',
  }
}

/** The preset a slide's layout, slots, grid and lines match, which the picker marks. */
export function presetOf(s: Pick<EditSlide, 'layout' | 'slots' | 'grid' | 'bullets'>): string {
  switch (s.layout) {
    case 'text':
      return s.bullets ? 'bullets' : 'paragraph'
    case 'figure':
      return s.bullets ? 'bullets + card' : 'paragraph + card'
    case 'figures':
      return s.grid && slotsOf(s) === MAX_SLIDE_FIGURES ? 'card grid' : (['two cards', 'three cards', 'four cards'][slotsOf(s) - 2] ?? 'two cards')
    default:
      return s.layout
  }
}

/** The slide in preset `id`: its layout, grid and lines as the preset has them; slots are kept where the preset
 * leaves the count open. Every cell stays on the slide. */
export function applyPreset(s: EditSlide, id: string): EditSlide {
  const p = PRESETS.find((x) => x.id === id)
  if (!p) return s
  const keep = p.layout === 'figure' && s.layout === 'figure'
  return { ...s, layout: p.layout, slots: keep ? s.slots : p.slots, grid: p.grid, bullets: p.bullets ?? s.bullets }
}

/** The slide with one more card slot, or null where its layout has no room (lines gain up to two cards, cards side by
 * side go up to four, a quote takes none). */
export function addSlot(s: EditSlide): EditSlide | null {
  const n = slotsOf(s)
  switch (s.layout) {
    case 'title':
    case 'text':
      return { ...s, layout: 'figure', slots: 1, grid: false }
    case 'figure':
      return n < 2 ? { ...s, slots: n + 1 } : null
    case 'card':
      return { ...s, layout: 'figures', slots: 2, grid: false }
    case 'figures':
      return n < MAX_SLIDE_FIGURES ? { ...s, slots: n + 1, grid: false } : null
    default:
      return null
  }
}

/** The slide with one card slot fewer, or null where it shows none; the removed card stays on the slide, unseen. */
export function removeSlot(s: EditSlide): EditSlide | null {
  const n = slotsOf(s)
  switch (s.layout) {
    case 'figure':
      return n > 1 ? { ...s, slots: n - 1 } : { ...s, layout: 'text', slots: 0 }
    case 'card':
      return { ...s, layout: 'title', slots: 0 }
    case 'figures':
      return n > 2 ? { ...s, slots: n - 1, grid: false } : { ...s, layout: 'card', slots: 1, grid: false }
    default:
      return null
  }
}

/** A new slide in preset `id` (default bullets), its id from `mint`. */
export const newSlide = (mint: () => string, preset = 'bullets'): EditSlide =>
  applyPreset({ id: mint(), heading: '', layout: 'text', side: 'right', width: 50, slots: 0, grid: false, lines: [], bullets: true, quote: null, figures: [], notes: '' }, preset)

/** A copy of a slide under new ids: its lines, quote and figures are the analyst's new ones, since the copy is theirs. */
export function duplicateSlide(s: EditSlide, mint: () => string): EditSlide {
  return { ...s, id: mint(), lines: s.lines.map((l) => ({ id: mint(), text: l.text })), quote: s.quote ? { ...s.quote, id: mint() } : null, figures: s.figures.map((f) => ({ ...f, id: mint() })) }
}

/** `list` with the item at `from` moved to `to`. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list]
  if (from < 0 || from >= out.length) return out
  const [it] = out.splice(from, 1)
  out.splice(Math.max(0, Math.min(to, out.length)), 0, it)
  return out
}

/** A slide with a card dropped on it: into slot `slot` (replacing its card) or the first empty one, else a slot added
 * for it, else the last slot. A card already on the slide only moves. Slots fill from the first. `mint` gives the new
 * figure's id. */
export function dropCard(s: EditSlide, cell: string, mint: () => string, slot: number | null = null): EditSlide {
  const ref = cell.startsWith('card:') ? cell : `card:${cell}`
  const had = s.figures.find((f) => f.cell === ref)
  let shown = slotsOf(s)
  if (had && slot == null && s.figures.indexOf(had) < shown) return s
  const figures = s.figures.filter((f) => f.cell !== ref)
  const fig = had ?? { id: mint(), cell: ref, caption: '' }
  let next: EditSlide = s
  const filled = Math.min(figures.length, shown)
  if (slot == null && filled >= shown) {
    const grown = addSlot(s)
    if (grown) {
      next = grown
      shown = slotsOf(grown)
    }
  }
  const at = slot != null ? Math.min(slot, shown - 1) : shown - 1
  const place = Math.max(0, Math.min(at, Math.min(figures.length, shown)))
  // a new card on a filled slot takes its place; one the slide holds moves there, the others shifting over
  const replaces = !had && place < figures.length && place < shown && (slot != null || filled >= shown)
  figures.splice(place, replaces ? 1 : 0, fig)
  return { ...next, figures: figures.slice(0, MAX_SLIDE_FIGURES) }
}

/** The deck editor's save (PUT …/deck) from its title and slides; a line left empty is left out. */
export function deckBody(title: string, slides: readonly EditSlide[], client?: string): DeckBody {
  return {
    title: title.replace(/\s+/g, ' ').trim(),
    client,
    slides: slides.map((s) => ({
      id: s.id,
      heading: s.heading.replace(/\s+/g, ' ').trim(),
      layout: s.layout,
      format: slideFormat(s),
      lines: s.lines.filter((l) => l.text.trim()).map((l) => ({ id: l.id, text: l.text.trim() })),
      bullets: s.bullets,
      quote: s.quote && s.quote.text.trim() ? { id: s.quote.id, text: s.quote.text.trim(), speaker: s.quote.speaker.trim() } : null,
      figures: s.figures.map((f) => ({ id: f.id, cell: f.cell, caption: f.caption })),
      notes: s.notes.trim(),
    })),
  }
}

/** A slide's stored format: the figure's side and width and its slots for the lines beside cards, the slots (and the
 * grid) for cards side by side; null for the other layouts. */
function slideFormat(s: EditSlide): DeckBody['slides'][number]['format'] {
  if (s.layout === 'figure') return { side: s.side, width: s.width, slots: slotsOf(s) }
  if (s.layout === 'figures') return s.grid && slotsOf(s) === MAX_SLIDE_FIGURES ? { slots: slotsOf(s), grid: true } : { slots: slotsOf(s) }
  return null
}

/** A text field's lines as a slide's lines: each line keeps the id of the line it replaces at its place, and a line
 * added gets a new id from `mint`. */
export function linesFromText(text: string, before: readonly { id: string }[], mint: () => string): { id: string; text: string }[] {
  return text
    .split('\n')
    .map((t) => t.replace(/^\s*[-•*]\s+/, '').trim())
    .filter(Boolean)
    .map((t, i) => ({ id: before[i]?.id ?? mint(), text: t }))
}

/** A page's claims as one section without a heading; none without claims. */
export function sectionsOfPage(doc: Pick<PageDoc, 'claims'>): WriteupSection[] {
  const claims = doc.claims ?? []
  return claims.length ? [{ id: CLAIMS_ID, heading: '', paragraphs: [{ id: `${CLAIMS_ID}-p`, sentences: claims }], figures: [] }] : []
}

/** A video's lines, each a section without a heading holding one paragraph of its sentences. */
export function sectionsOfVideo(doc: Pick<VideoDoc, 'lines'>): WriteupSection[] {
  return (doc.lines ?? []).map((l) => ({ id: l.id, heading: '', paragraphs: [{ id: `${l.id}-p`, sentences: l.sentences ?? [] }], figures: [] }))
}

export function sectionsOf(doc: AnyDoc): WriteupSection[] {
  switch (shapeOf(doc)) {
    case 'story':
      return sectionsOfStory(doc as StoryDoc)
    case 'slides':
      return sectionsOfDeck(doc as DeckDoc)
    case 'page':
      return sectionsOfPage(doc as PageDoc)
    case 'video':
      return sectionsOfVideo(doc as VideoDoc)
    default:
      return (doc as Writeup).sections ?? []
  }
}

/** Any document in the report's shape, so the marks, the figures and the filter read it as they read the report. */
export function asWriteup(doc: AnyDoc): Writeup {
  if (shapeOf(doc) === 'document') return doc as Writeup
  return { ...(doc as object), title: doc.title ?? '', sections: sectionsOf(doc), comments: doc.comments ?? [], frame: false } as Writeup
}

// ---- the switcher ----

/** the three document types in the type bar's order */
export const BUILTIN_SLUGS = ['report', 'slides', 'story', 'video'] as const
const BUILTIN_RENDERER: Record<string, string> = { report: 'document', story: 'story', slides: 'slides', video: 'video' }
const BUILTIN_LABEL: Record<string, string> = { report: 'Report', story: 'Story', slides: 'Slides', video: 'Video' }

/** A document's name on its tab in the type bar: Report, Slides, Story, or a custom type's name (else its slug). */
export const docLabel = (slug: string, state: TypesState | null | undefined): string => BUILTIN_LABEL[slug] ?? ((state?.[slug]?.name ?? '').trim() || slug)

export interface SwitcherItem {
  slug: string
  /** the option's text: Report, Slides, Story, or a page's name */
  label: string
  exists: boolean
  renderer: string
  page: boolean
  generating: boolean
}

/** The type bar's options: Report, Slides, Story, then the workspace's own types in state order. */
export function switcherItems(state: TypesState | null): SwitcherItem[] {
  if (!state) return BUILTIN_SLUGS.map((slug) => ({ slug, label: docLabel(slug, null), exists: false, renderer: BUILTIN_RENDERER[slug], page: false, generating: false }))
  const builtin = BUILTIN_SLUGS.filter((s) => s in state) as string[]
  const rest = Object.keys(state).filter((s) => !(BUILTIN_SLUGS as readonly string[]).includes(s))
  return [...builtin, ...rest].map((slug) => {
    const e = state[slug]
    return {
      slug,
      label: docLabel(slug, state),
      exists: !!e.exists,
      renderer: e.renderer ?? BUILTIN_RENDERER[slug] ?? 'document',
      page: !!e.page,
      generating: e.status === 'generating',
    }
  })
}

/** An entry of + New: what it makes (`kind`, POST /report-types/new) and its label; `custom` asks for a name and a
 * brief first. */
export interface NewDocItem {
  kind: string
  label: string
  custom?: boolean
}

/** + New's entries: a page, each preset in the server's order, then a document of the analyst's own. */
export function newDocItems(presets: readonly { id: string; name: string }[]): NewDocItem[] {
  return [{ kind: 'page', label: 'Page' }, ...presets.map((p) => ({ kind: p.id, label: p.name })), { kind: 'document', label: 'Custom', custom: true }]
}

/** Whether the analyst may rename or delete a type: every type but the three built-ins. */
export const ownType = (slug: string): boolean => !(BUILTIN_SLUGS as readonly string[]).includes(slug)

/** The renderer that decides a slug's view: the state's entry, else the document's shape, else the report's. */
export function rendererOf(state: TypesState | null, slug: string, doc: AnyDoc | null): string {
  const r = state?.[slug]?.renderer
  if (r) return r
  if (doc) {
    const shape = shapeOf(doc)
    return shape === 'page' ? 'custom' : shape
  }
  return BUILTIN_RENDERER[slug] ?? 'document'
}

/** The browser-storage key of the document the tab shows, per workspace. */
export const docKey = (ws: string): string => storageKey(ws, 'report-doc')
