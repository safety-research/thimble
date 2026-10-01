// The ⌘ pointer's contract with the surfaces: every element the pointer may target carries `data-anchor` (a ref) and
// may carry `data-anchor-text`; a range of elements is the list of covered anchors joined by `,`.

export const ANCHOR_TEXT_MAX = 2000

export interface Anchor {
  el: HTMLElement
  anchor: string
  text: string
}

/** The element's visible text, or its `data-anchor-text`, for the thread's `anchor_text`. */
export function anchorText(el: HTMLElement): string {
  const own = el.getAttribute('data-anchor-text')
  const raw = own != null && own !== '' ? own : (el.innerText ?? el.textContent ?? '')
  return squeezeText(raw)
}

/** The nearest anchorable ancestor of `target`, or null. */
export function nearestAnchor(target: EventTarget | Element | null): Anchor | null {
  if (!(target instanceof Element)) return null
  const el = target.closest<HTMLElement>('[data-anchor]')
  const anchor = el?.getAttribute('data-anchor')?.trim()
  if (!el || !anchor) return null
  return { el, anchor, text: anchorText(el) }
}

/**
 * The block a passage stands in, when the pointer takes that block whole: a report block carries `data-anchor-cell`
 * (report/decorations.ts), and ⌘ over it picks the whole block, while a ⌘-drag inside it still selects text. A control
 * inside the block (a citation chip) keeps its own region.
 */
export function cellOf(a: Anchor): Anchor | null {
  if (isControl(a.el)) return null
  const el = a.el.closest<HTMLElement>('[data-anchor-cell]')
  const anchor = el?.getAttribute('data-anchor')?.trim()
  if (!el || !anchor) return null
  return el === a.el ? a : { el, anchor, text: anchorText(el) }
}

/** Whether an element is laid out: a hidden tab's elements have no client rects. */
export const isShown = (el: Element): boolean => el.getClientRects().length > 0

/** The anchorable elements a selection range covers, in document order; elements that are not laid out are skipped. */
export function anchorsInRange(range: Range, root: ParentNode = document): Anchor[] {
  const out: Anchor[] = []
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-anchor]'))) {
    if (!isShown(el) || !range.intersectsNode(el)) continue
    if (el.querySelector('[data-anchor]') && Array.from(el.querySelectorAll('[data-anchor]')).some((inner) => range.intersectsNode(inner))) continue
    const anchor = el.getAttribute('data-anchor')?.trim()
    if (anchor) out.push({ el, anchor, text: anchorText(el) })
  }
  return out
}

/** A range's anchor: the covered anchors joined by `,`. */
export function joinAnchors(anchors: readonly Anchor[]): string {
  return anchors.map((a) => a.anchor).join(',')
}

/** A range's anchor text: each covered element's text on its own line. */
export function joinAnchorText(anchors: readonly Anchor[]): string {
  return anchors
    .map((a) => a.text)
    .filter(Boolean)
    .join('\n')
    .slice(0, ANCHOR_TEXT_MAX)
}

/** A ⌘-press that moved this far (px) before release is a drag, not a click. */
export const DRAG_MIN_PX = 5

export function isDrag(start: { x: number; y: number }, end: { x: number; y: number }, min = DRAG_MIN_PX): boolean {
  return Math.abs(end.x - start.x) >= min || Math.abs(end.y - start.y) >= min
}

/** The same anchor once, in first-seen order; a range that crosses a card and its rows keeps each ref once. */
export function dedupeAnchors(anchors: readonly Anchor[]): Anchor[] {
  const seen = new Set<string>()
  const out: Anchor[] = []
  for (const a of anchors) {
    if (seen.has(a.anchor)) continue
    seen.add(a.anchor)
    out.push(a)
  }
  return out
}

/** The selected text, whitespace squeezed, cut to ANCHOR_TEXT_MAX. */
export function squeezeText(raw: string): string {
  return raw.replace(/\s+\n/g, '\n').replace(/[ \t]+/g, ' ').trim().slice(0, ANCHOR_TEXT_MAX)
}

/** A range's context for the thread: the selected text when there is some, else the covered elements' text. */
export function rangeContext(anchors: readonly Anchor[], selectedText: string): string {
  const own = squeezeText(selectedText)
  return own || joinAnchorText(anchors)
}

/** The anchors of a range's selection under `root`, deduplicated, or [] when the selection is collapsed or touches none. */
export function anchorsInSelection(sel: Selection | null, root: ParentNode = document): Anchor[] {
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return []
  const all: Anchor[] = []
  for (let i = 0; i < sel.rangeCount; i++) all.push(...anchorsInRange(sel.getRangeAt(i), root))
  return dedupeAnchors(all)
}

/** The selection's text when the whole selection sits under `root`, else '' (the covered elements' text then stands in). */
export function selectionTextWithin(sel: Selection | null, root: Node): string {
  if (!sel || sel.rangeCount === 0) return ''
  for (let i = 0; i < sel.rangeCount; i++) if (!root.contains(sel.getRangeAt(i).commonAncestorContainer)) return ''
  return sel.toString()
}

/** The panel a ⌘-press started in (the nearest `data-panel`), the whole document when none. */
export function pressRoot(target: EventTarget | null): ParentNode {
  const el = target instanceof Element ? target : target instanceof Node ? target.parentElement : null
  return el?.closest('[data-panel]') ?? document
}

// ----------------------------------------------------------------------------- text under the pointer

/**
 * Where a point on text is a control, not a span of text: the highlight stays a region there and a pick never
 * activates the control. The chip and the switch are named by class because they are spans and buttons alike.
 */
export const CONTROL_SELECTOR = 'button, a, input, textarea, select, summary, [role="button"], [role="tab"], [role="radio"], [role="switch"], [role="menuitem"], [role="option"], .chip, .switch'

export const isControl = (el: Element | null | undefined): boolean => !!el?.closest(CONTROL_SELECTOR)

/** A plain rectangle, as getClientRects hands them and as the tests build them. */
export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

export const toBox = (r: { left: number; top: number; right: number; bottom: number }): Box => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })

/** How far (px) beside a glyph's box a point still counts as on the word: the gap between letters and lines. */
export const TEXT_SLACK = 2

export const boxContains = (b: Box, x: number, y: number, slack = 0): boolean => x >= b.left - slack && x <= b.right + slack && y >= b.top - slack && y <= b.bottom + slack

/** The smallest box around the pieces. */
export function unionBox(boxes: readonly Box[]): Box {
  let out: Box = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity }
  for (const b of boxes) out = { left: Math.min(out.left, b.left), top: Math.min(out.top, b.top), right: Math.max(out.right, b.right), bottom: Math.max(out.bottom, b.bottom) }
  return out
}

const isSpace = (ch: string) => /\s/.test(ch)
const isWordChar = (ch: string) => /[\p{L}\p{N}]/u.test(ch)

export interface Word {
  start: number
  end: number
  word: string
}

/**
 * The word around a caret offset: the run of non-space characters the caret sits in, trimmed of the punctuation at
 * its ends, so "notes.jsonl," reads as notes.jsonl and "(alice)" as alice. A caret at the end of a run
 * belongs to the run; a caret in white space, or a run that is punctuation alone, is no word.
 */
export function wordAt(text: string, offset: number): Word | null {
  if (!text) return null
  let i = Math.max(0, Math.min(offset, text.length))
  if ((i === text.length || isSpace(text[i])) && i > 0 && !isSpace(text[i - 1])) i -= 1
  if (i >= text.length || isSpace(text[i])) return null
  let start = i
  let end = i + 1
  while (start > 0 && !isSpace(text[start - 1])) start--
  while (end < text.length && !isSpace(text[end])) end++
  while (start < end && !isWordChar(text[start])) start++
  while (end > start && !isWordChar(text[end - 1])) end--
  if (start >= end) return null
  return { start, end, word: text.slice(start, end) }
}

const sameLine = (a: Box, b: Box): boolean => {
  const overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
  return overlap > 0.5 * Math.min(a.bottom - a.top, b.bottom - b.top)
}

/**
 * Glyph rects merged into one piece per line: rects whose vertical spans overlap by more than half the smaller
 * height share a line and join into their union. Empty rects are dropped; the pieces come top to bottom.
 */
export function mergeLineRects(rects: readonly Box[]): Box[] {
  const kept = rects.filter((r) => r.right - r.left > 0 && r.bottom - r.top > 0).sort((a, b) => a.top - b.top || a.left - b.left)
  const out: Box[] = []
  for (const r of kept) {
    const last = out[out.length - 1]
    if (last && sameLine(last, r)) {
      last.left = Math.min(last.left, r.left)
      last.right = Math.max(last.right, r.right)
      last.top = Math.min(last.top, r.top)
      last.bottom = Math.max(last.bottom, r.bottom)
    } else out.push({ ...r })
  }
  return out
}

/** What a probe of the point found, as the decision needs it and as a test can state it. */
export interface TextProbe {
  /** the text sits inside a control */
  inControl: boolean
  /** the word under the caret, or null in white space or on punctuation */
  word: string | null
  /** the word's glyph rects, one per line */
  rects: readonly Box[]
}

/** Whether the point is on a span of text: a word, outside a control, whose glyph rects hold the point. */
export function isTextHit(probe: TextProbe, x: number, y: number, slack = TEXT_SLACK): boolean {
  if (probe.inControl || !probe.word) return false
  return probe.rects.some((b) => boxContains(b, x, y, slack))
}

// ----------------------------------------------------------------------------- the DOM side of the text hit

interface Caret {
  node: Node
  offset: number
}

/** The caret position under a viewport point, from caretPositionFromPoint or the older caretRangeFromPoint. */
export function caretAt(x: number, y: number): Caret | null {
  const d = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
    caretRangeFromPoint?: (x: number, y: number) => Range | null
  }
  if (typeof d.caretPositionFromPoint === 'function') {
    const p = d.caretPositionFromPoint(x, y)
    return p ? { node: p.offsetNode, offset: p.offset } : null
  }
  const r = d.caretRangeFromPoint?.(x, y)
  return r ? { node: r.startContainer, offset: r.startOffset } : null
}

/** The text nodes a range touches, in document order. */
function textNodesIn(range: Range): Text[] {
  const root = range.commonAncestorContainer
  if (root.nodeType === Node.TEXT_NODE) return [root as Text]
  const out: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (range.intersectsNode(n)) out.push(n as Text)
  return out
}

/** A box cut to `clip`, or null when less than half a pixel of it is left inside (a line wholly outside the clip). */
export function clipBox(b: Box, clip: Box | null): Box | null {
  if (!clip) return b
  const out = { left: Math.max(b.left, clip.left), top: Math.max(b.top, clip.top), right: Math.min(b.right, clip.right), bottom: Math.min(b.bottom, clip.bottom) }
  return out.right - out.left > 0.5 && out.bottom - out.top > 0.5 ? out : null
}

/**
 * Screen pixels per layout pixel of an element, on each axis: its box on screen over its layout box. The client sizes
 * and offsets are layout pixels, which a CSS transform (the canvas's zoom) does not scale; getBoundingClientRect is
 * on screen. 1 on an axis the element has no size on.
 */
export function screenScale(el: Element, r: { width: number; height: number }, s: CSSStyleDeclaration): { x: number; y: number } {
  const html = el instanceof HTMLElement
  const w = html ? el.offsetWidth : el.clientWidth + el.clientLeft + (parseFloat(s.borderRightWidth) || 0)
  const h = html ? el.offsetHeight : el.clientHeight + el.clientTop + (parseFloat(s.borderBottomWidth) || 0)
  return { x: w > 0 && r.width > 0 ? r.width / w : 1, y: h > 0 && r.height > 0 ? r.height / h : 1 }
}

/**
 * The part of the viewport where an element's content shows: its padding box on each axis its overflow clips, cut by
 * every ancestor's; null when nothing clips it. The body, the root and a fixed element's ancestors are left out.
 * `memo` caches boxes across the text nodes of one range.
 */
export function visibleBox(el: Element | null, memo: Map<Element, Box | null> = new Map()): Box | null {
  if (!el || el === document.body || el === document.documentElement) return null
  const known = memo.get(el)
  if (known !== undefined) return known
  const s = getComputedStyle(el)
  // a fixed element is placed against the viewport, out of its ancestors' overflow
  const outer = s.position === 'fixed' ? null : visibleBox(el.parentElement, memo)
  const x = s.overflowX !== 'visible'
  const y = s.overflowY !== 'visible'
  let out = outer
  if (x || y) {
    const r = el.getBoundingClientRect()
    const k = screenScale(el, r, s)
    const left = r.left + el.clientLeft * k.x
    const top = r.top + el.clientTop * k.y
    const own = { left: x ? left : -Infinity, top: y ? top : -Infinity, right: x ? left + el.clientWidth * k.x : Infinity, bottom: y ? top + el.clientHeight * k.y : Infinity }
    out = outer ? { left: Math.max(own.left, outer.left), top: Math.max(own.top, outer.top), right: Math.min(own.right, outer.right), bottom: Math.min(own.bottom, outer.bottom) } : own
  }
  memo.set(el, out)
  return out
}

/**
 * The glyph rects of a range's text, clipped to the range, so a range across whole cards draws as lines, not card
 * boxes. Each rect is cut to where its text shows (visibleBox), so hidden lines draw nothing.
 */
export function rangeTextRects(range: Range): Box[] {
  const out: Box[] = []
  const memo = new Map<Element, Box | null>()
  for (const t of textNodesIn(range)) {
    const r = document.createRange()
    r.selectNodeContents(t)
    if (t === range.startContainer) r.setStart(t, range.startOffset)
    if (t === range.endContainer) r.setEnd(t, range.endOffset)
    const clip = visibleBox(t.parentElement, memo)
    for (const rect of Array.from(r.getClientRects())) {
      const b = clipBox(toBox(rect), clip)
      if (b) out.push(b)
    }
  }
  return out
}

/** A range as one piece per line, only the lines that show. */
export const linePieces = (range: Range): Box[] => mergeLineRects(rangeTextRects(range))

export interface TextHit {
  /** the element holding the text */
  el: HTMLElement
  range: Range
  word: string
  pieces: Box[]
  rect: DOMRect
}

/**
 * The word under a viewport point, when the point is on text and not on a control. The point must sit on the word's
 * glyphs, since the caret alone would name the nearest text from anywhere in the margin. `within` limits the hit.
 */
export function textHitAt(x: number, y: number, within?: Element | null): TextHit | null {
  const c = caretAt(x, y)
  if (!c || c.node.nodeType !== Node.TEXT_NODE) return null
  const node = c.node as Text
  const el = node.parentElement
  if (!el || (within && !within.contains(el))) return null
  const w = wordAt(node.data, c.offset)
  const range = document.createRange()
  if (w) {
    range.setStart(node, w.start)
    range.setEnd(node, w.end)
  }
  const pieces = w ? mergeLineRects(Array.from(range.getClientRects(), toBox)) : []
  if (!w || !isTextHit({ inControl: isControl(el), word: w.word, rects: pieces }, x, y)) return null
  return { el, range, word: w.word, pieces, rect: range.getBoundingClientRect() }
}

// ----------------------------------------------------------------------------- the chunk

/** A chunk longer than this (characters) gives way to the line around the click. */
export const CHUNK_MAX = 1200

/**
 * The line of `text` around `offset`, between line breaks, trimmed; a line longer than `max` is cut to `max`
 * characters around the offset, at spaces where there are any.
 */
export function lineAround(text: string, offset: number, max = CHUNK_MAX): { start: number; end: number } {
  const i = Math.max(0, Math.min(offset, text.length))
  let start = i > 0 ? text.lastIndexOf('\n', i - 1) + 1 : 0
  let end = text.indexOf('\n', i)
  if (end < 0) end = text.length
  if (end - start > max) {
    const s = Math.max(start, Math.min(i - (max >> 1), end - max))
    const e = s + max
    const sp = text.indexOf(' ', s)
    const ep = text.lastIndexOf(' ', e)
    start = s > start && sp >= 0 && sp < i ? sp + 1 : s
    end = e < end && ep > i ? ep : e
  }
  while (start < end && isSpace(text[start])) start++
  while (end > start && isSpace(text[end - 1])) end--
  return { start, end }
}

const isInline = (el: Element): boolean => {
  const d = getComputedStyle(el).display
  return d === 'inline' || d === 'contents'
}

/** The element whose text a click selects: the text's nearest ancestor that is not laid out inline, never above `within`. */
export function chunkElement(node: Node, within?: Element | null): HTMLElement | null {
  let el = node.parentElement
  while (el && el !== within && isInline(el) && el.parentElement && (!within || within.contains(el.parentElement))) el = el.parentElement
  return el
}

export interface Chunk {
  /** the element whose text it is */
  el: HTMLElement
  range: Range
  text: string
}

/**
 * What a click on text selects: the whole text of the chunk around the word (its paragraph, a table cell, a takeaway),
 * within `within`; a chunk longer than CHUNK_MAX, such as a raw file in one element, gives way to the line around the
 * word.
 */
export function chunkAt(hit: TextHit, within?: Element | null): Chunk {
  const node = hit.range.startContainer
  const el = chunkElement(node, within) ?? hit.el
  const range = document.createRange()
  range.selectNodeContents(el)
  if ((el.textContent ?? '').length > CHUNK_MAX && node.nodeType === Node.TEXT_NODE) {
    const { start, end } = lineAround((node as Text).data, hit.range.startOffset)
    range.setStart(node, start)
    range.setEnd(node, end)
    return { el, range, text: squeezeText(range.toString()) }
  }
  // the text as the range holds it: innerText would break the line at every inline-flex chip in a paragraph
  return { el, range, text: squeezeText(range.toString()) }
}

/**
 * The last of a range's line pieces, widened by the inline boxes on its line that hold no text (a chip's glyph, a
 * cited number's box), so a line that starts with a chip starts where the chip does. A box taller than twice the line
 * (a whole card the range covers) is not on the line.
 */
export function lastLineOf(pieces: readonly Box[], boxes: readonly Box[]): Box | null {
  const last = pieces[pieces.length - 1]
  if (!last) return null
  const out = { ...last }
  const h = last.bottom - last.top
  for (const b of boxes) {
    if (b.right - b.left <= 0 || b.bottom - b.top > 2 * h || !sameLine(b, last)) continue
    out.left = Math.min(out.left, b.left)
    out.right = Math.max(out.right, b.right)
  }
  return out
}

/**
 * The last line of a range that shows, where a box under the range starts (a clamped comment's box goes under its
 * last visible line, not under the lines the clamp hides); null for a range with no text in sight.
 */
export const lastLine = (range: Range): Box | null => lastLineOf(linePieces(range), Array.from(range.getClientRects(), toBox))
