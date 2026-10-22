// Which stored passage a selection comments on, read from the page's `data-sid` marks: the sentence the selection
// starts in; else the first one after its start in the same block (a selection starting in the space between sentences
// is in no mark); else the block's last one; else the block's own id, as a heading has.

/** The id a block's ⌘ anchor names, when a comment can go on it: a heading, slide, beat or list item's sentence; not a
 * paragraph (`#p<id>`) nor the document itself. */
export function anchorId(block: Element | null): string | null {
  const m = /^report:[^#\s]+#([A-Za-z0-9_-]+)$/.exec(block?.getAttribute('data-anchor') ?? '')
  return m && !/^p[0-9a-f]/.test(m[1]) ? m[1] : null
}

/** The `data-sid` a selection that starts at (`node`, `offset`) comments on (module note), searching no further than
 * `block`; null when it names none. */
export function sidAt(node: Node | null, offset: number, block: Element | null): string | null {
  if (!node) return null
  const el = node.nodeType === 1 ? (node as Element) : node.parentElement
  const own = el?.closest('[data-sid]')?.getAttribute('data-sid')
  if (own) return own
  if (!block || !block.contains(node)) return null
  const marks = [...block.querySelectorAll('[data-sid]')]
  if (!marks.length) return anchorId(block)
  const range = node.ownerDocument?.createRange()
  if (range) {
    try {
      range.setStart(node, Math.min(offset, node.nodeType === 3 ? (node.textContent ?? '').length : node.childNodes.length))
      range.collapse(true)
      const next = marks.find((m) => range.comparePoint(m, 0) >= 0)
      if (next) return next.getAttribute('data-sid')
    } catch {
      /* a point the range refuses reads as the block's end */
    }
  }
  return marks[marks.length - 1].getAttribute('data-sid')
}
