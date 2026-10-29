// What a thread is told about the element it was opened on: the part of the browser it is in, its kind, a CSS selector,
// and a PNG taken at the ⌘-click. The element is described as a chain of plain nodes (itself, then ancestors up to the
// nearest panel), so the pure part (describe, selectorPath) runs in node; chainOf is the DOM adapter, and capturePng
// draws the element with html-to-image, loaded on first use, and lays the picture each frame in it gives of itself
// (lib/frameShot) over the frame's box, since html-to-image cannot read a sandboxed frame's document.
import { framePicture } from '../lib/frameShot'

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

/** A frame in the element that draws itself (lib/frameShot, marked `data-shot`): its box, and the part of it the boxes
 * around it, up to the element, let show; on screen, where the click found them. */
interface Framed {
  frame: HTMLIFrameElement
  box: DOMRect
  shows: { left: number; top: number; right: number; bottom: number }
}

/** The frames in `el` that draw themselves and show some of their page. */
function framesIn(el: HTMLElement): Framed[] {
  const out: Framed[] = []
  for (const frame of Array.from(el.querySelectorAll<HTMLIFrameElement>('iframe[data-shot]'))) {
    const box = frame.getBoundingClientRect()
    const shows = { left: box.left, top: box.top, right: box.right, bottom: box.bottom }
    for (let p = frame.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p)
      const r = s.overflowX !== 'visible' || s.overflowY !== 'visible' ? p.getBoundingClientRect() : null
      if (r && s.overflowX !== 'visible') [shows.left, shows.right] = [Math.max(shows.left, r.left), Math.min(shows.right, r.right)]
      if (r && s.overflowY !== 'visible') [shows.top, shows.bottom] = [Math.max(shows.top, r.top), Math.min(shows.bottom, r.bottom)]
      if (p === el) break
    }
    if (shows.right - shows.left >= 1 && shows.bottom - shows.top >= 1) out.push({ frame, box, shows })
  }
  return out
}

/** Each frame's picture laid over its place in the element's picture (`at` is the element's box on screen), cut to the
 * part of the frame that shows. */
async function layFrames(canvas: HTMLCanvasElement, at: DOMRect, frames: readonly Framed[], pngs: readonly (string | null)[]): Promise<void> {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const kx = canvas.width / at.width
  const ky = canvas.height / at.height
  for (let i = 0; i < frames.length; i++) {
    const png = pngs[i]
    if (!png) continue
    const pic = new Image()
    pic.src = png
    try {
      await pic.decode()
    } catch {
      continue
    }
    const { box, shows } = frames[i]
    ctx.save()
    ctx.beginPath()
    ctx.rect((shows.left - at.left) * kx, (shows.top - at.top) * ky, (shows.right - shows.left) * kx, (shows.bottom - shows.top) * ky)
    ctx.clip()
    ctx.drawImage(pic, (box.left - at.left) * kx, (box.top - at.top) * ky, box.width * kx, box.height * ky)
    ctx.restore()
  }
}

/** html-to-image's picture `svg` (an SVG data URL) with each frame that draws itself an empty box of its size: a frame
 * takes no room in a picture, which loads no page, so what comes after it would move up into its place, under the
 * frame's own picture. The frame's page, which html-to-image copies with it, is left out. */
function boxed(svg: string): string {
  const doc = new DOMParser().parseFromString(decodeURIComponent(svg.slice(svg.indexOf(',') + 1)), 'image/svg+xml')
  if (doc.querySelector('parsererror')) throw new Error('the picture cannot be read')
  for (const f of Array.from(doc.querySelectorAll('iframe[data-shot]'))) {
    const box = doc.createElementNS('http://www.w3.org/1999/xhtml', 'div')
    box.setAttribute('style', f.getAttribute('style') ?? '')
    f.replaceWith(box)
  }
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(doc))}`
}

/** The SVG image `svg` (a data URL) drawn on `bg` at `ratio` device pixels per CSS pixel, or fewer for a picture larger
 * than a canvas can be, as html-to-image draws its own. */
async function onCanvas(svg: string, ratio: number, bg: string): Promise<HTMLCanvasElement> {
  const pic = new Image()
  pic.src = svg
  await pic.decode()
  await new Promise((resolve) => requestAnimationFrame(resolve))
  const k = Math.min(ratio, CANVAS_MAX_PX / Math.max(pic.naturalWidth, pic.naturalHeight, 1))
  const canvas = document.createElement('canvas')
  canvas.width = pic.naturalWidth * k
  canvas.height = pic.naturalHeight * k
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(pic, 0, 0, canvas.width, canvas.height)
  return canvas
}

/** the longest side html-to-image draws a canvas */
const CANVAS_MAX_PX = 16384

/** A data URL of the element drawn as a PNG, or null when it cannot be drawn in CAPTURE_WAIT_MS. */
export async function capturePng(el: HTMLElement): Promise<string | null> {
  const r = el.getBoundingClientRect()
  if (r.width < 1 || r.height < 1) return null
  const bg = getComputedStyle(document.body).backgroundColor
  const ratio = Math.min(2, window.devicePixelRatio || 1)
  // each frame that draws itself is asked at once, so it draws what the click saw
  const frames = framesIn(el)
  const pictures = Promise.all(frames.map((f) => framePicture(f.frame, ratio)))
  const draw = import('html-to-image').then(async (m) => {
    fontCss ??= m.getFontEmbedCSS(document.body).catch(() => '')
    const css = await fontCss
    const fonts = css ? { fontEmbedCSS: css } : { skipFonts: true }
    const options = { backgroundColor: bg, pixelRatio: ratio, cacheBust: false, ...fonts }
    if (!el.querySelector('iframe[data-shot]')) return m.toPng(el, options)
    const canvas = await onCanvas(boxed(await m.toSvg(el, options)), ratio, bg)
    await layFrames(canvas, r, frames, await pictures)
    return canvas.toDataURL('image/png')
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
