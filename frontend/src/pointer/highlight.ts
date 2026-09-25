// The one highlight: a fixed element on the body that follows the pointer and morphs from target to target
// (pointer.css). A region is the target's box with an accent ring and radius; a word is its box in --accent-tint; several
// lines of text draw a piece per visible line in --accent-wash. Over a word body[data-pointer-text] is set, so the
// pointer becomes the accent I-beam. A click holds the highlight until the box closes.
import { linePieces, toBox, unionBox, type Box } from './anchors'

// a box is a region whose element the page cannot reach: an element inside a view's sandboxed frame, by its rect
type Target = { kind: 'region'; el: Element } | { kind: 'text'; range: Range } | { kind: 'box'; rect: DOMRect }

let node: HTMLDivElement | null = null
let target: Target | null = null
let held = false
let shown = false

/** The smallest radius a region takes (--radius-hl): a square block still reads as a highlight, not a rule. */
export const MIN_RADIUS = 3
/** How far (px) a region with no radius of its own is grown on each side, so its ring clears the content. */
export const REGION_PAD = 2
/** How far (px) a word's tint is grown, across and down. */
export const WORD_PAD = { x: 2, y: 1 }

const root = (): HTMLDivElement => {
  if (node) return node
  node = document.createElement('div')
  node.className = 'pointer-hl'
  node.setAttribute('aria-hidden', 'true')
  document.body.appendChild(node)
  // the page under a held highlight may scroll or resize: the highlight jumps to where its target now is
  const refit = () => {
    if (target && shown) paint(true)
  }
  window.addEventListener('scroll', refit, { capture: true, passive: true })
  window.addEventListener('resize', refit, { passive: true })
  return node
}

/** A region's radius and padding as the highlight takes them: its own radius, at least MIN_RADIUS; padded when it has none. */
export function regionShape(ownRadius: number): { radius: number; pad: number } {
  return { radius: Math.max(MIN_RADIUS, ownRadius), pad: ownRadius > 0 ? 0 : REGION_PAD }
}

const grow = (b: Box, x: number, y: number): Box => ({ left: b.left - x, top: b.top - y, right: b.right + x, bottom: b.bottom + y })

/** Over a word while the highlight follows, body[data-pointer-text] turns the pointer into the I-beam. */
function syncText(): void {
  document.body.toggleAttribute('data-pointer-text', shown && !held && target?.kind === 'text')
}

function paint(jump: boolean): void {
  const el = root()
  if (!target) return
  let outer: Box
  let pieces: Box[] = []
  let radius = MIN_RADIUS
  if (target.kind === 'region') {
    const r = target.el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) return hide()
    const shape = regionShape(parseFloat(getComputedStyle(target.el).borderTopLeftRadius) || 0)
    outer = grow(toBox(r), shape.pad, shape.pad)
    radius = shape.radius
  } else if (target.kind === 'box') {
    if (target.rect.width === 0 && target.rect.height === 0) return hide()
    outer = toBox(target.rect)
  } else {
    pieces = linePieces(target.range)
    if (!pieces.length) return hide()
    outer = pieces.length === 1 ? grow(pieces[0], WORD_PAD.x, WORD_PAD.y) : unionBox(pieces)
  }
  // one line of text is the box itself in the tint; several lines leave the box clear and draw a piece per line
  el.dataset.kind = target.kind !== 'text' ? 'region' : pieces.length === 1 ? 'word' : 'text'
  if (jump) el.classList.add('pointer-hl-jump')
  el.style.transform = `translate3d(${outer.left}px, ${outer.top}px, 0)`
  el.style.width = `${outer.right - outer.left}px`
  el.style.height = `${outer.bottom - outer.top}px`
  el.style.borderRadius = `${radius}px`
  const lines = pieces.length > 1 ? pieces : []
  while (el.children.length > lines.length) el.lastElementChild?.remove()
  while (el.children.length < lines.length) {
    const d = document.createElement('div')
    d.className = 'pointer-hl-line'
    el.appendChild(d)
  }
  lines.forEach((p, i) => {
    const d = el.children[i] as HTMLElement
    d.style.left = `${p.left - outer.left}px`
    d.style.top = `${p.top - outer.top}px`
    d.style.width = `${p.right - p.left}px`
    d.style.height = `${p.bottom - p.top}px`
  })
  if (jump) {
    void el.offsetWidth
    el.classList.remove('pointer-hl-jump')
  }
  el.dataset.on = '1'
  shown = true
  syncText()
}

/**
 * Nothing of the target shows (its text scrolled out of its panel, its element gone): a held highlight fades and keeps
 * its target, so a scroll that brings the target back shows it again; a following one clears.
 */
function hide(): void {
  if (!held) return clear()
  if (node) delete node.dataset.on
}

/** The highlight leaves its target and fades where it stands; a held highlight stays. */
function clear(): void {
  if (held) return
  target = null
  shown = false
  if (node) delete node.dataset.on
  syncText()
}

export const highlight = {
  /** the element under the pointer is a region */
  region(el: Element): void {
    if (held) return
    const jump = !shown
    target = { kind: 'region', el }
    paint(jump)
  },
  /** an element inside a view's frame is a region at the rect the frame reported, in page coordinates */
  box(rect: DOMRect): void {
    if (held) return
    const jump = !shown
    target = { kind: 'box', rect }
    paint(jump)
  },
  /** the text under the pointer: a word in the tint, or a range's lines in the wash */
  text(range: Range): void {
    if (held) return
    const jump = !shown
    target = { kind: 'text', range: range.cloneRange() }
    paint(jump)
  },
  clear,
  /** a click: the highlight stops following until released, and the pointer is the arrow again */
  hold(): void {
    held = !!target
    syncText()
  },
  /** a new pick while one is held: the highlight lets go of the old target where it stands, so the new one morphs from it */
  retarget(): void {
    held = false
  },
  /** the box closed: the highlight follows again (the next move re-shows it) */
  release(): void {
    held = false
    clear()
  },
  isHeld: (): boolean => held,
}
