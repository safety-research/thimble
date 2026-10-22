// The checks and the filter as ProseMirror decorations over the editor. Stored sentences are located in each block's
// text; every sentence carries `data-anchor` (for the ⌘ pointer) and `data-sid` (for the margin), and every stored
// block carries its own `data-anchor-cell`. Commented passages take their check's tint, blocks outside the filter dim,
// locked blocks carry `wu-locked`, the block ⌘↵ would send while ⌘ is held carries `wu-agent`, and the space before a
// bare citation is marked so it hides with the chip. A tint is drawn as one element per text node, so only the first
// and last element of each run round their outer corners. None of this is in the document, so a save carries none of it.
import { createExtension } from '@blocknote/core'
import type { Node as PMNode } from 'prosemirror-model'
import { Plugin, PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view'
import type { Writeup, WriteupSentence } from '../lib/types'
import { gapFlag, type Flag } from './checkComments'
import { CITE_CHAR, indexDoc, readableText, sentenceSpans, sentenceStands, TITLE_ID, type ReportFilterSets } from './model'

/** The attributes of a block the ⌘ pointer takes whole (pointer/anchors.ts cellOf): its ref, `data-anchor-cell`, and
 * the text a thread about it quotes. */
function cellAttrs(anchor: string, text: string): Record<string, string> {
  return { 'data-anchor': anchor, 'data-anchor-cell': '', 'data-anchor-text': text }
}

export interface MarksCtx {
  slug: string
  doc: Writeup | null
  /** the tint of every passage a shown comment is on, by sentence or section id */
  flags: ReadonlyMap<string, Flag>
  filter: ReportFilterSets | null
  /** the ids of the blocks the analyst locked (model.ts lockedBlocks), whose lock shows beside them at rest */
  locked: ReadonlySet<string>
  /** the block ⌘↵ would send to main, tinted while ⌘ is held */
  agent?: string | null
}

const KEY = new PluginKey<DecorationSet>('thimble-report-marks')

/** A block's inline text with each atom (a citation) as one CITE_CHAR, so offsets are ProseMirror offsets. */
function plainOfNode(content: PMNode): string {
  let s = ''
  content.forEach((child) => {
    s += child.isText ? (child.text ?? '') : CITE_CHAR.repeat(child.nodeSize)
  })
  return s
}

const PUNCT = /^[.,;:!?)]/

/** A citation chip followed by punctuation (`… [[ref]].`) carries `wu-hug`: a spacing rule that pulls the punctuation
 * against the chip (report.css), not a second chip rendering. */
function hugs(content: PMNode, start: number, decos: Decoration[]): void {
  let prev: { from: number; to: number } | null = null
  content.forEach((child, offset) => {
    if (prev && child.isText && PUNCT.test(child.text ?? '')) decos.push(Decoration.node(prev.from, prev.to, { class: 'wu-hug' }))
    prev = child.type.name === 'cite' && !child.attrs.value ? { from: start + offset, to: start + offset + child.nodeSize } : null
  })
}

const TRAILING_SPACE = /\s+$/

/** The space before a bare citation chip carries `refchip-gap`, so that while the links are hidden it goes with the chip
 * and the punctuation after it closes up to the word (refchip.css), as it would with no citation there. */
function gaps(content: PMNode, start: number, decos: Decoration[]): void {
  let prev: { text: string; at: number } | null = null
  content.forEach((child, offset) => {
    if (child.type.name === 'cite' && !child.attrs.value && prev) {
      const m = TRAILING_SPACE.exec(prev.text)
      if (m) decos.push(Decoration.inline(start + prev.at + m.index, start + prev.at + prev.text.length, { class: 'refchip-gap' }))
    }
    prev = child.isText ? { text: child.text ?? '', at: offset } : null
  })
}

/** A tinted range of a block, in document positions; `key` is equal for tints drawn alike. */
export interface Tint {
  from: number
  to: number
  key: string
}

const tintKey = (flag: Flag): string => `${flag.color}|${flag.active}`

/** The first and last piece of each run of one tint. ProseMirror splits an inline decoration at every text node, atom
 * and other decoration edge (`cuts`); tints that meet with the same key form one run. Each run gives its `head` (start
 * to first cut) and `tail` (last cut to end). Pure. */
export function tintEdges(tints: readonly Tint[], cuts: readonly number[]): { head: [number, number]; tail: [number, number] }[] {
  const runs: Tint[] = []
  for (const t of [...tints].filter((t) => t.from < t.to).sort((a, b) => a.from - b.from)) {
    const last = runs[runs.length - 1]
    if (last && last.to === t.from && last.key === t.key) last.to = t.to
    else runs.push({ ...t })
  }
  const sorted = [...new Set(cuts)].sort((a, b) => a - b)
  return runs.map((r) => {
    const inside = sorted.filter((p) => p > r.from && p < r.to)
    return { head: [r.from, inside[0] ?? r.to], tail: [inside[inside.length - 1] ?? r.from, r.to] }
  })
}

/** Marks the head and tail of each run of `tints` in a block's content that starts at `start`, the cuts being the
 * content's node edges and the edges of the block's other inline decorations (`own`). */
function markTintEdges(content: PMNode, start: number, tints: readonly Tint[], own: readonly Decoration[], decos: Decoration[]): void {
  if (!tints.length) return
  const end = start + content.content.size
  const cuts: number[] = []
  content.forEach((child, offset) => cuts.push(start + offset, start + offset + child.nodeSize))
  for (const d of own) for (const p of [d.from, d.to]) if (p > start && p < end) cuts.push(p)
  for (const { head, tail } of tintEdges(tints, cuts)) {
    decos.push(Decoration.inline(head[0], head[1], { class: 'wu-flag-start' }))
    decos.push(Decoration.inline(tail[0], tail[1], { class: 'wu-flag-end' }))
  }
}

/** The attributes of a passage's tint: the class, the colour as `--flag`, the comments behind it. */
export function flagAttrs(flag: Flag | undefined): Record<string, string> {
  if (!flag) return {}
  return { class: flag.active ? 'wu-flag wu-flag-active' : 'wu-flag', style: `--flag: ${flag.color}`, 'data-cids': flag.cids.join(' ') }
}

function build(pmDoc: PMNode, ctx: MarksCtx): DecorationSet {
  const doc = ctx.doc
  if (!doc) return DecorationSet.empty
  const idx = indexDoc(doc)
  const decos: Decoration[] = []
  pmDoc.descendants((node, pos) => {
    if (node.type.name !== 'blockContainer') return true
    const id = String(node.attrs.id ?? '')
    if (ctx.locked.has(id)) decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'wu-locked' }))
    if (ctx.agent === id) decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'wu-agent' }))
    const content = node.firstChild
    if (!content || !content.isTextblock) return true
    const type = content.type.name
    const start = pos + 2
    const blockFrom = decos.length
    hugs(content, start, decos)
    gaps(content, start, decos)
    if (type === 'heading') {
      if (id === TITLE_ID) {
        if (content.content.size > 0) decos.push(Decoration.node(pos + 1, pos + 1 + content.nodeSize, cellAttrs(`report:${ctx.slug}`, readableText(content.textContent))))
      } else {
        if (!idx.sections.has(id)) return true
        decos.push(Decoration.node(pos + 1, pos + 1 + content.nodeSize, cellAttrs(`report:${ctx.slug}#${id}`, readableText(content.textContent))))
      }
      // a check's comment on the title or on a section's heading tints it (the report checks read the title as a passage)
      const flag = ctx.flags.get(id)
      if (flag && content.content.size > 0) {
        decos.push(Decoration.inline(start, start + content.content.size, { ...flagAttrs(flag), 'data-sid': id }))
        markTintEdges(content, start, [{ from: start, to: start + content.content.size, key: tintKey(flag) }], decos.slice(blockFrom), decos)
      }
      return true
    }
    let sentences: WriteupSentence[] = []
    if (type === 'paragraph') {
      const own = idx.bySentence.get(id)
      sentences = idx.byParagraph.get(id) ?? (own ? [own] : [])
    } else if (type === 'bulletListItem' || type === 'numberedListItem') {
      const own = idx.bySentence.get(id)
      sentences = own ? [own] : idx.byParagraph.get(id) ?? []
    }
    if (!sentences.length) return true
    // the block's own ref: a paragraph as `#p<id>`, a list item (one sentence on the server) as its sentence
    const blockRef = idx.byParagraph.has(id) && !(type !== 'paragraph' && idx.bySentence.has(id)) ? `report:${ctx.slug}#p${id}` : `report:${ctx.slug}#${id}`
    decos.push(Decoration.node(pos + 1, pos + 1 + content.nodeSize, cellAttrs(blockRef, sentences.map((s) => readableText(s.text)).join(' '))))
    const spans = sentenceSpans(plainOfNode(content), sentences)
    const tints: Tint[] = []
    let standing = 0
    spans.forEach((sp, i) => {
      const s = sp.sentence
      const flag = ctx.flags.get(s.id)
      const prev = spans[i - 1]
      const gap = prev && prev.to < sp.from ? gapFlag(ctx.flags.get(prev.sentence.id), flag) : null
      if (gap) {
        decos.push(Decoration.inline(start + prev.to, start + sp.from, flagAttrs(gap)))
        tints.push({ from: start + prev.to, to: start + sp.from, key: tintKey(gap) })
      }
      const tint = flagAttrs(flag)
      const cls = ['wu-s', s.pinned ? 'wu-pinned' : '', tint.class ?? ''].filter(Boolean).join(' ')
      decos.push(Decoration.inline(start + sp.from, start + sp.to, { ...tint, class: cls, 'data-anchor': `report:${ctx.slug}#${s.id}`, 'data-anchor-text': readableText(s.text), 'data-sid': s.id }))
      if (flag) tints.push({ from: start + sp.from, to: start + sp.to, key: tintKey(flag) })
      if (ctx.filter && sentenceStands(ctx.filter, s.id)) standing++
    })
    markTintEdges(content, start, tints, decos.slice(blockFrom), decos)
    if (ctx.filter && spans.length > 0 && standing === 0) decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'wu-dim' }))
    return true
  })
  return DecorationSet.create(pmDoc, decos)
}

/** The extension: one plugin whose decorations follow the document and `ctx`; `refreshMarks` recomputes them after `ctx` changed. */
export function marksExtension(ctx: MarksCtx) {
  const plugin = new Plugin<DecorationSet>({
    key: KEY,
    state: {
      init: (_, state) => build(state.doc, ctx),
      apply: (tr, old, _old, state) => (tr.docChanged || tr.getMeta(KEY) ? build(state.doc, ctx) : old),
    },
    props: { decorations: (state) => KEY.getState(state) ?? null },
  })
  return createExtension({ key: 'thimbleReportMarks' as const, prosemirrorPlugins: [plugin] })
}

export function refreshMarks(editor: { prosemirrorView: EditorView | undefined }): void {
  const view = editor.prosemirrorView
  if (!view) return
  view.dispatch(view.state.tr.setMeta(KEY, true))
}
