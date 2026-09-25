// The story's pure helpers: a stored section's blocks in reading order, the editor's sections and their save
// (PUT …/story), the edits the editor makes to them, and the items a section's step lights on its card.
import type { StoryBody, StoryCardSide, StoryDoc, WriteupFigure, WriteupParagraph, WriteupSection } from '../lib/types'

/** A block of the editor: text (prose, or a list typed into it), bullets (one item per line), a headline, a quote, a
 * callout, a divider, a card among the text, or a picture of a card. */
export type StoryBlockType = 'text' | 'bullets' | 'headline' | 'quote' | 'callout' | 'divider' | 'card' | 'image'

export interface StoryBlock {
  id: string
  type: StoryBlockType
  /** the block's sentences as typed; a bullets block's items one per line; empty for a divider and a card */
  text: string
  speaker?: string
  cell?: string
  caption?: string
  /** a card block waiting for the card main makes for this request (the text of a block sent with ⌘↵); never saved */
  asked?: string
}

export interface StoryFigure {
  id: string
  cell: string
  caption: string
}

/** A section as the editor holds it: its heading, where its card stands, its card (kept while the card is not shown),
 * and its blocks in order. */
export interface StorySection {
  id: string
  heading: string
  side: StoryCardSide
  main: StoryFigure | null
  blocks: StoryBlock[]
}

export const SIDES: readonly StoryCardSide[] = ['right', 'left', 'full', 'none']
export const TEXT_TYPES: readonly StoryBlockType[] = ['text', 'bullets', 'headline', 'quote', 'callout']

export const sideOf = (sec: Pick<WriteupSection, 'card'>): StoryCardSide => (SIDES.includes(sec.card as StoryCardSide) ? (sec.card as StoryCardSide) : 'right')

/** The section's card, when it has one on a card. */
export const mainOf = (sec: Pick<WriteupSection, 'figures'>): WriteupFigure | null => (sec.figures ?? []).find((f) => f.role === 'main' && !!f.cell) ?? null

export const isFigureType = (t: StoryBlockType): boolean => t === 'card' || t === 'image'

/** A stored paragraph's block type. */
export function paragraphType(p: WriteupParagraph): StoryBlockType {
  if (p.kind) return p.kind
  return (p.sentences ?? []).some((s) => !!s.bullet) ? 'bullets' : 'text'
}

/** A stored paragraph's text as the editor holds it: its sentences joined by a space, a list's items one per line. */
export function paragraphEditText(p: WriteupParagraph): string {
  const xs = (p.sentences ?? []).map((s) => s.text.trim()).filter(Boolean)
  return paragraphType(p) === 'bullets' ? xs.join('\n') : xs.join(' ')
}

const figureBlock = (f: WriteupFigure): StoryBlock => ({ id: f.id, type: f.role === 'image' ? 'image' : 'card', text: '', cell: f.cell ?? '', caption: f.caption ?? '' })

/** A stored section's blocks in reading order: the leading cards, then each paragraph with the cards after it (cards
 * after a missing paragraph last). The section's own card is not among them. */
export function sectionBlocks(sec: Pick<WriteupSection, 'paragraphs' | 'figures'>): StoryBlock[] {
  const figs = (sec.figures ?? []).filter((f) => f.role !== 'main' && !!f.cell)
  const paras = sec.paragraphs ?? []
  const known = new Set(paras.map((p) => p.id))
  const out = figs.filter((f) => !f.after_paragraph).map(figureBlock)
  for (const p of paras) {
    const type = paragraphType(p)
    out.push({ id: p.id, type, text: type === 'divider' ? '' : paragraphEditText(p), ...(type === 'quote' ? { speaker: p.speaker ?? '' } : {}) })
    out.push(...figs.filter((f) => f.after_paragraph === p.id).map(figureBlock))
  }
  out.push(...figs.filter((f) => !!f.after_paragraph && !known.has(f.after_paragraph)).map(figureBlock))
  return out
}

export const newBlock = (mint: () => string, type: StoryBlockType = 'text', text = ''): StoryBlock => ({
  id: mint(),
  type,
  text,
  ...(type === 'quote' ? { speaker: '' } : {}),
  ...(isFigureType(type) ? { cell: '', caption: '' } : {}),
})

/** A new section: a headline, a list for its few short points, and its card at the right. */
export const newSection = (mint: () => string): StorySection => ({ id: mint(), heading: '', side: 'right', main: null, blocks: [newBlock(mint, 'bullets')] })

/** The story's sections as the editor holds them; one new section when the story has none. */
export function editSections(doc: Pick<StoryDoc, 'sections'>, mint: () => string): StorySection[] {
  const out = (doc.sections ?? []).map((sec): StorySection => {
    const main = mainOf(sec)
    return { id: sec.id, heading: sec.heading ?? '', side: sideOf(sec), main: main ? { id: main.id, cell: main.cell ?? '', caption: main.caption ?? '' } : null, blocks: sectionBlocks(sec) }
  })
  return out.length ? out : [newSection(mint)]
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** The editor's story as PUT …/story takes it; a card block not given a card yet is left out. */
export function storyBody(title: string, sections: readonly StorySection[], client?: string): StoryBody {
  return {
    title: oneLine(title),
    ...(client ? { client } : {}),
    sections: sections.map((s) => ({
      id: s.id,
      heading: oneLine(s.heading),
      card: s.side,
      main: s.main && s.main.cell ? { id: s.main.id, cell: s.main.cell, caption: s.main.caption } : null,
      blocks: s.blocks
        .filter((b) => !isFigureType(b.type) || !!b.cell)
        .map((b) => ({
          id: b.id,
          type: b.type,
          ...(isFigureType(b.type) ? { cell: b.cell, caption: b.caption ?? '' } : b.type === 'divider' ? {} : { text: b.text }),
          ...(b.type === 'quote' ? { speaker: oneLine(b.speaker ?? '') } : {}),
        })),
    })),
  }
}

// ---- the editor's edits, each a new list of sections ----

export interface BlockAt {
  s: number
  b: number
}

export function findBlock(sections: readonly StorySection[], id: string): BlockAt | null {
  for (let s = 0; s < sections.length; s++) {
    const b = sections[s].blocks.findIndex((x) => x.id === id)
    if (b >= 0) return { s, b }
  }
  return null
}

const withBlocks = (sections: readonly StorySection[], s: number, blocks: StoryBlock[]): StorySection[] => sections.map((sec, k) => (k === s ? { ...sec, blocks } : sec))

/** `block` put into section `s` at index `at` (at its end when `at` is past it). */
export function insertBlock(sections: readonly StorySection[], s: number, at: number, block: StoryBlock): StorySection[] {
  const blocks = [...sections[s].blocks]
  blocks.splice(Math.max(0, Math.min(at, blocks.length)), 0, block)
  return withBlocks(sections, s, blocks)
}

export function removeBlock(sections: readonly StorySection[], id: string): StorySection[] {
  const at = findBlock(sections, id)
  return at ? withBlocks(sections, at.s, sections[at.s].blocks.filter((b) => b.id !== id)) : [...sections]
}

/** The section holding block `id` split there: the blocks after it open a new section without a headline, and block
 * `id` itself goes. Null when no section holds it. */
export function splitSection(sections: readonly StorySection[], id: string, mint: () => string): { sections: StorySection[]; section: string } | null {
  const at = findBlock(sections, id)
  if (!at) return null
  const blocks = sections[at.s].blocks
  const rest = blocks.slice(at.b + 1)
  const sec: StorySection = { ...newSection(mint), ...(rest.length ? { blocks: rest } : {}) }
  const kept = withBlocks(sections, at.s, blocks.slice(0, at.b))
  return { sections: [...kept.slice(0, at.s + 1), sec, ...kept.slice(at.s + 1)], section: sec.id }
}

export function updateBlock(sections: readonly StorySection[], id: string, patch: Partial<StoryBlock>): StorySection[] {
  const at = findBlock(sections, id)
  return at ? withBlocks(sections, at.s, sections[at.s].blocks.map((b) => (b.id === id ? { ...b, ...patch } : b))) : [...sections]
}

/** Block `id` moved to index `at` of section `to`, `at` counted in that section as it stands before the move. */
export function moveBlock(sections: readonly StorySection[], id: string, to: number, at: number): StorySection[] {
  const from = findBlock(sections, id)
  if (!from || !sections[to]) return [...sections]
  const block = sections[from.s].blocks[from.b]
  let target = at
  if (from.s === to && from.b < at) target -= 1
  if (from.s === to && target === from.b) return [...sections]
  return insertBlock(removeBlock(sections, id), to, target, block)
}

/** Block `id` one step up or down, into the section before or after at the edge of its own. */
export function stepBlock(sections: readonly StorySection[], id: string, dir: -1 | 1): StorySection[] {
  const at = findBlock(sections, id)
  if (!at) return [...sections]
  const n = sections[at.s].blocks.length
  if (dir < 0 && at.b > 0) return moveBlock(sections, id, at.s, at.b - 1)
  if (dir > 0 && at.b < n - 1) return moveBlock(sections, id, at.s, at.b + 2)
  if (dir < 0 && at.s > 0) return moveBlock(sections, id, at.s - 1, sections[at.s - 1].blocks.length)
  if (dir > 0 && at.s < sections.length - 1) return moveBlock(sections, id, at.s + 1, 0)
  return [...sections]
}

/** A block turned into another type, its words kept where the new type has words: a list's items run together as
 * text, text becomes one item; a divider and a card keep none. */
export function retype(block: StoryBlock, type: StoryBlockType): StoryBlock {
  if (block.type === type) return block
  const words = isFigureType(block.type) || block.type === 'divider' ? '' : block.type === 'bullets' ? block.text.split('\n').map((l) => l.trim()).filter(Boolean).join(' ') : block.text
  const next: StoryBlock = { id: block.id, type, text: type === 'divider' || isFigureType(type) ? '' : words }
  if (type === 'quote') next.speaker = block.speaker ?? ''
  if (isFigureType(type)) {
    next.cell = block.cell ?? ''
    next.caption = block.caption ?? ''
  }
  return next
}

export function moveSection(sections: readonly StorySection[], from: number, to: number): StorySection[] {
  if (from === to || from + 1 === to) return [...sections]
  const out = [...sections]
  const [sec] = out.splice(from, 1)
  out.splice(to > from ? to - 1 : to, 0, sec)
  return out
}

/** The cards a story shows, its sections' cards and the cards among its blocks, for the sidebar's ✓. */
export function storyCells(doc: Pick<StoryDoc, 'sections'> | null): string[] {
  return (doc?.sections ?? []).flatMap((sec) => (sec.figures ?? []).map((f) => f.cell ?? '').filter(Boolean))
}

/** Whether an item of a figure (a table's row, a timeline's event, a diagram's node), by its text, is one a section's
 * step highlights: a term standing in the text as a word of its own, case aside. */
export function stepMatches(text: string, terms: readonly string[]): boolean {
  const hay = ` ${text.toLowerCase().replace(/\s+/g, ' ')} `
  return terms.some((t) => {
    const term = t.trim().toLowerCase()
    if (!term) return false
    const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(^|[^\\p{L}\\p{N}])${esc}($|[^\\p{L}\\p{N}])`, 'u').test(hay)
  })
}
