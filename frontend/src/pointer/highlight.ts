// The one highlight: a fixed element on the body that follows the pointer and morphs from target to target
// (pointer.css). A region is the target's box with an accent ring and radius; a word is its box in --accent-tint; several
// lines of text draw a piece per visible line in --accent-wash. Over a word body[data-pointer-text] is set, so the
// pointer becomes the accent I-beam. A click holds the highlight until the box closes or its question is sent. While
// held it stays on its target, each frame: it moves with the target when the canvas pans or zooms or the target's card
// is laid out again, and fades when the target is gone (the card drawn anew) or changed.
import { linePieces, toBox, unionBox, type Box } from './anchors'

// a box is a region drawn at a rect: inside a view's sandboxed frame, which the page cannot reach, or a part of a card
// smaller than its element (a point of a line chart, a line of printed output), carried along with the element it was
// drawn in (`el`, whose box was `from` when the rect was taken)
type Target = { kind: 'region'; el: Element; radius?: number; pad?: number } | { kind: 'text'; range: Range } | { kind: 'box'; rect: DOMRect; el?: Element; from?: Box }

let node: HTMLDivElement | null = null
let target: Target | null = null
let held = false
let shown = false
// the geometry last painted, so a held highlight repaints only when its target moved
let painted = ''
let frame: number | null = null

/** The smallest radius a region takes (--radius-hl): a square block still reads as a highlight, not a rule. */
export const MIN_RADIUS = 3
/** How far (px) a region with no radius of its own is grown on each side, so its ring clears the content. */
export const REGION_PAD = 2
/** How far (px) a word's tint is grown, across and down. */
export const WORD_PAD = { x: 2, y: 1 }
/** How far apart (as a ratio) the scales across and down of a box's element may be before the element counts as drawn
 * anew rather than zoomed: a zoom scales both alike. */
export const SCALE_SLACK = 0.02

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

/**
 * Where a rect taken inside an element is now that the element's box went from `from` to `now`: moved with the element
 * and scaled as it was (a pan, a zoom, a card laid out again). Null when the element was scaled differently across and
 * down, which no zoom does: its content was drawn anew, and the rect no longer marks the same thing. Pure.
 */
export function carried(rect: Box, from: Box, now: Box): Box | null {
  const fw = from.right - from.left
  const fh = from.bottom - from.top
  const kx = fw > 0 ? (now.right - now.left) / fw : null
  const ky = fh > 0 ? (now.bottom - now.top) / fh : null
  if (kx != null && ky != null && Math.abs(kx - ky) > SCALE_SLACK * Math.max(kx, ky)) return null
  const k = kx ?? ky ?? 1
  const left = now.left + (rect.left - from.left) * k
  const top = now.top + (rect.top - from.top) * k
  return { left, top, right: left + (rect.right - rect.left) * k, bottom: top + (rect.bottom - rect.top) * k }
}

const grow = (b: Box, x: number, y: number): Box => ({ left: b.left - x, top: b.top - y, right: b.right + x, bottom: b.bottom + y })

/** Over a word while the highlight follows, body[data-pointer-text] turns the pointer into the I-beam. */
function syncText(): void {
  document.body.toggleAttribute('data-pointer-text', shown && !held && target?.kind === 'text')
}

/** Paint the target where it is now; with `moved`, only when that differs from what was painted last. */
function paint(jump: boolean, moved = false): void {
  const el = root()
  if (!target) return
  let outer: Box
  let pieces: Box[] = []
  let radius = MIN_RADIUS
  if (target.kind === 'region') {
    if (!target.el.isConnected) return hide()
    const r = target.el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) return hide()
    if (target.radius == null) {
      const shape = regionShape(parseFloat(getComputedStyle(target.el).borderTopLeftRadius) || 0)
      target.radius = shape.radius
      target.pad = shape.pad
    }
    outer = grow(toBox(r), target.pad ?? 0, target.pad ?? 0)
    radius = target.radius
  } else if (target.kind === 'box') {
    let b: Box | null = toBox(target.rect)
    if (target.el && target.from) {
      b = target.el.isConnected ? carried(b, target.from, toBox(target.el.getBoundingClientRect())) : null
      if (!b) return hide()
    }
    if (b.right - b.left === 0 && b.bottom - b.top === 0) return hide()
    outer = b
  } else {
    pieces = linePieces(target.range)
    if (!pieces.length) return hide()
    outer = pieces.length === 1 ? grow(pieces[0], WORD_PAD.x, WORD_PAD.y) : unionBox(pieces)
  }
  const key = [outer.left, outer.top, outer.right, outer.bottom, radius, pieces.length, ...pieces.flatMap((p) => [p.left, p.top, p.right, p.bottom])].join(',')
  if (moved && shown && key === painted && el.dataset.on) return
  painted = key
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
  painted = ''
  if (node) delete node.dataset.on
}

/** The highlight leaves its target and fades where it stands; a held highlight stays. */
function clear(): void {
  if (held) return
  target = null
  shown = false
  painted = ''
  if (node) delete node.dataset.on
  syncText()
}

const nextFrame = (fn: () => void): number => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : window.setTimeout(fn, 16))
const cancelFrame = (id: number): void => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : window.clearTimeout(id))

/** Each frame while held, the highlight goes where its target is now (module note). */
function follow(): void {
  frame = null
  if (!held || !target) return
  paint(true, true)
  frame = nextFrame(follow)
}

function stopFollowing(): void {
  if (frame != null) cancelFrame(frame)
  frame = null
}

export const highlight = {
  /** the element under the pointer is a region */
  region(el: Element): void {
    if (held) return
    const jump = !shown
    target = { kind: 'region', el }
    paint(jump)
  },
  /** a region at a rect, in page coordinates: an element inside a view's frame as the frame reported it, or a part of
   * a card smaller than its element, carried along with `el`, the element it was drawn in */
  box(rect: DOMRect, el?: Element | null): void {
    if (held) return
    const jump = !shown
    target = el ? { kind: 'box', rect, el, from: toBox(el.getBoundingClientRect()) } : { kind: 'box', rect }
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
  /** a click: the highlight stops following the pointer until released, stays on its target, and the pointer is the
   * arrow again */
  hold(): void {
    held = !!target
    syncText()
    stopFollowing()
    if (held) frame = nextFrame(follow)
  },
  /** a new pick while one is held: the highlight lets go of the old target where it stands, so the new one morphs from it */
  retarget(): void {
    held = false
    stopFollowing()
  },
  /** the box closed or its question was sent: the highlight follows the pointer again (the next move re-shows it) */
  release(): void {
    held = false
    stopFollowing()
    clear()
  },
  isHeld: (): boolean => held,
}
