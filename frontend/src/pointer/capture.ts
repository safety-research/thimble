// What a thread is told about the element it was opened on: the part of the browser it is in, its kind, a CSS selector,
// and a PNG taken at the ⌘-click. The element is described as a chain of plain nodes (itself, then ancestors up to the
// nearest panel), so the pure part (describe, selectorPath) runs in node; chainOf is the DOM adapter, and capturePng
// draws the element with html-to-image, loaded on first use.

/** the most segments a selector path carries */
export const PATH_LEVELS = 6

export interface ChainNode {
  /** lower case */
  tag: string
  classes: string[]
  /** data-anchor */
  anchor?: string
  /** data-panel */
  panel?: string
}

/** Classes that name a component and so identify an element, the specific before the generic frames (a chat row is a Card). */
const STABLE_CLASSES = ['canvas-card', 'frame', 'bdetail', 'bfocus', 'chat-row', 'chat-msg', 'composer', 'popover', 'menu', 'segmented', 'field', 'reader', 'files-row', 'pointer-box', 'toast', 'chip', 'btn', 'card']
const STABLE_PREFIXES = ['wu-']
/** State words a selector path must not depend on. */
const STATE_CLASSES = new Set(['active', 'open', 'selected', 'dim', 'busy', 'running', 'done', 'failed', 'error', 'hidden', 'focus', 'anchor-flash', 'is-selected', 'is-open', 'is-dragging', 'is-target', 'is-into', 'is-moving', 'is-collapsed', 'is-sized', 'is-dimmed', 'is-nested', 'is-current'])

/** 0 for the `wu-` family, then STABLE_CLASSES' order from 1, Infinity for a class that names nothing. */
const stableRank = (c: string): number => {
  if (STABLE_PREFIXES.some((p) => c.startsWith(p))) return 0
  const i = STABLE_CLASSES.indexOf(c)
  return i < 0 ? Infinity : i + 1
}

/** The class that best names an element: the `wu-` family first, then the most specific stable class, or undefined. */
export function stableClassOf(classes: readonly string[]): string | undefined {
  const ranked = classes.filter((c) => stableRank(c) < Infinity).sort((a, b) => stableRank(a) - stableRank(b))
  return ranked[0]
}

/** A CSS identifier escaped without the DOM: a class such as `a:b` or `1x` selects as written. */
export function cssIdent(s: string): string {
  return s.replace(/^(\d)/, '\\3$1 ').replace(/([^\w-\\ ])/g, '\\$1')
}

const attrValue = (s: string) => `"${s.replace(/["\\]/g, '\\$&')}"`

const segment = (n: ChainNode): string => n.tag + n.classes.filter((c) => c && !STATE_CLASSES.has(c)).map((c) => `.${cssIdent(c)}`).join('')

/**
 * The selector path: from the nearest `data-anchor` element (its attribute selector) or the nearest panel down to the
 * element, tag and classes at each level, at most PATH_LEVELS segments, never an id.
 */
export function selectorPath(chain: readonly ChainNode[]): string {
  const segs: string[] = []
  for (const n of chain) {
    if (segs.length >= PATH_LEVELS) break
    if (n.anchor) {
      segs.push(`[data-anchor=${attrValue(n.anchor)}]`)
      break
    }
    if (n.panel) {
      segs.push(`[data-panel=${attrValue(n.panel)}]`)
      break
    }
    segs.push(segment(n))
  }
  return segs.reverse().join(' > ')
}

const attr = (el: Element, name: string): string | undefined => {
  const v = el.getAttribute(name)?.trim()
  return v ? v : undefined
}

/** The element and its ancestors up to and including the nearest `data-panel` (or the body), as plain nodes. */
export function chainOf(el: Element): ChainNode[] {
  const out: ChainNode[] = []
  let cur: Element | null = el
  while (cur && cur !== document.documentElement) {
    const n: ChainNode = { tag: cur.tagName.toLowerCase(), classes: Array.from(cur.classList) }
    const anchor = attr(cur, 'data-anchor')
    const panel = attr(cur, 'data-panel')
    if (anchor) n.anchor = anchor
    if (panel) n.panel = panel
    out.push(n)
    if (panel || cur === document.body) break
    cur = cur.parentElement
  }
  return out
}

/** The largest element drawn whole; a bigger one (a whole column, a long document) is drawn by its first anchor. */
export const MAX_CAPTURE_PX = 1600 * 1600
/** How long a thread waits for its picture before it opens without one. */
export const CAPTURE_WAIT_MS = 3000

export interface ElementInfo {
  /** the nearest data-panel: chat, files, canvas, report, pointer */
  surface?: string
  /** the element's kind: its most specific component class, else its tag */
  element: string
  /** its selector path, the data-anchor attribute selector when it carries one */
  selector: string
}

/** Surface, kind and selector of an element described as its chain (itself first, then its ancestors). Pure. */
export function describe(chain: readonly ChainNode[]): ElementInfo {
  const first = chain[0]
  const surface = chain.find((n) => n.panel)?.panel
  return { surface, element: (first && (stableClassOf(first.classes) ?? first.tag)) || 'element', selector: selectorPath(chain) }
}

export const describeElement = (el: Element): ElementInfo => describe(chainOf(el))

/** The nearest element that holds all of `els` (the first when there is one), for a ⌘-drag over several anchors. */
export function commonElement(els: readonly HTMLElement[]): HTMLElement | null {
  if (!els.length) return null
  let cur: HTMLElement | null = els[0]
  while (cur && !els.every((e) => cur!.contains(e))) cur = cur.parentElement
  if (!cur || cur === document.body || cur === document.documentElement) return els[0]
  const r = cur.getBoundingClientRect()
  return r.width * r.height > MAX_CAPTURE_PX ? els[0] : cur
}

// The page's fonts as CSS with the font files inlined, read once (about half a second) and reused, so a picture shows
// the element in its own type rather than a fallback whose metrics break the lines; '' when they cannot be read.
let fontCss: Promise<string> | null = null

/** A data URL of the element drawn as a PNG, or null when it cannot be drawn in CAPTURE_WAIT_MS. */
export async function capturePng(el: HTMLElement): Promise<string | null> {
  const r = el.getBoundingClientRect()
  if (r.width < 1 || r.height < 1) return null
  const bg = getComputedStyle(document.body).backgroundColor
  const draw = import('html-to-image').then(async (m) => {
    fontCss ??= m.getFontEmbedCSS(document.body).catch(() => '')
    const css = await fontCss
    const fonts = css ? { fontEmbedCSS: css } : { skipFonts: true }
    return m.toPng(el, { backgroundColor: bg, pixelRatio: Math.min(2, window.devicePixelRatio || 1), cacheBust: false, ...fonts })
  })
  const late = new Promise<null>((resolve) => window.setTimeout(() => resolve(null), CAPTURE_WAIT_MS))
  try {
    return await Promise.race([draw, late])
  } catch {
    return null
  }
}

/** The element carrying `data-anchor=ref`, if one is mounted. */
export function anchorElement(ref: string): HTMLElement | null {
  // a card's anchor is written `card:<id>`; `cell:<id>` is accepted as an alias
  const r = ref.startsWith('cell:') ? `card:${ref.slice(5)}` : ref
  const esc = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(r) : r.replace(/["\\]/g, '\\$&')
  return document.querySelector<HTMLElement>(`[data-anchor="${esc}"]`)
}
