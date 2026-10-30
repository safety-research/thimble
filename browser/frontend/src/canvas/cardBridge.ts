// A custom card's bridge (canvas/DataViz CustomFrame). The card's page runs in a sandboxed frame the page cannot see
// into, so a small script in the frame (cardBridge, first in the page's head) says what the ⌘ pointer and the wheel do
// there, as a view's bridge does (backend/app/viewer_bridge.js, files/ViewerFrame):
//   point {rect}           frame to page: the part ⌘ points at under the pointer, its box in the frame, so the page's one
//                          highlight follows the pointer into the frame; {card: true} on the page's bare background,
//                          which stands for the whole card; rect null once it points at nothing
//   cite {text, element, rect}
//                          frame to page: a ⌘-click on a part, which opens the pointer's box beside the part, about the
//                          card with the part's text; {card: true} on the bare background, a ⌘-click on the card itself
//   wheel {deltaX, deltaY, deltaMode, ctrlKey, metaKey, x, y}
//                          frame to page: a wheel turn the card's page did not take (nothing under the pointer scrolls
//                          that way, and no handler of its own took it), and every pinch or ⌘ turn, which the page turns
//                          again on the frame, so the canvas pans or zooms as over any other card (files/ViewerFrame
//                          wheelOver)
//   cmd {on, cursor, key}  page to frame: the page's ⌘ pointer went on or off, its arrow, and the ask key Settings pick,
//                          as a view's frame hears it
// A part is an element marked data-part (with data-part-text when its text is not what to quote), as on a card thimble
// draws itself (pointer/parts.ts), a shape of a drawing (SVG) that says what it is (its aria-label or its tooltip), else
// the innermost element with text in it; when that element holds more than one of a drawing's labels, its text is those
// labels run together (an SVG element has no innerText), and the whole card stands for it. On a Mac ⌘ points once it
// has been held alone for HOLD_MS, as on the page, and a ⌘-click asks at once; a ⌘-press selects none of the page's
// text.
import { bus } from '../lib/bus'
import { getAskKey, isMacPlatform, onAskKey } from '../lib/platform'
import { token } from '../lib/vizTheme'
import { toPage, wheelOver, type FrameWheel } from '../files/ViewerFrame'
import { describeElement } from '../pointer/capture'
import { HOLD_MS } from '../pointer/CmdPointer'
import { cmdCursors } from '../pointer/cursor'

const P = 'thimble:'

/** The frame half (module note). It reads nothing outside its own body, since bridgeScript writes its source into the
 * frame: `holdMs` is how long ⌘ is held alone before it points on a Mac, `mac` whether the page runs on one. */
export function cardBridge(holdMs: number, mac: boolean): void {
  const P = 'thimble:'
  const post = (msg: Record<string, unknown>) => {
    try {
      parent.postMessage(msg, '*')
    } catch {
      // the page is gone
    }
  }
  const root = document.documentElement
  // the ask key, from the page's `cmd` message: ⌘ (Ctrl off a Mac) by default, or ⌥ (Alt)
  let alt = false
  const held = (e: MouseEvent | KeyboardEvent) => (alt ? e.altKey : mac ? e.metaKey : e.metaKey || e.ctrlKey)
  const isKey = (key: string) => (alt ? key === 'Alt' : key === 'Meta' || (!mac && key === 'Control'))
  // whether the key points: the page's pointer says so (`cmd`), or the frame's own key while the frame has the focus (off
  // a Mac at once); a key pressed with it, a shortcut's, stops both until the key is pressed again, on a Mac or not
  let pageOn = false
  let ownOn = false
  let wait: number | undefined
  const pointing = (e: MouseEvent) => held(e) && (pageOn || ownOn)
  // while it points, the page's ⌘ arrow is this page's cursor too, since the page cannot draw over the frame
  const sheet = document.createElement('style')
  sheet.textContent = 'html[data-thimble-cmd],html[data-thimble-cmd] *{cursor:var(--thimble-cmd-cursor)!important}'
  ;(document.head || root).appendChild(sheet)
  const arrow = (on: boolean) => root.toggleAttribute('data-thimble-cmd', on && !!root.style.getPropertyValue('--thimble-cmd-cursor'))
  // the page does not scroll sideways: a page wider than the card is cut at the card's edge, as a card's body is, and
  // the card dragged wider shows more of it; a sideways turn over it is the canvas's (scrolls)
  const noSideways = document.createElement('style')
  noSideways.textContent = 'html{overflow-x:hidden!important}'
  ;(document.head || root).appendChild(noSideways)

  // its text as it reads (an SVG element has no innerText)
  const textOf = (el: Element) =>
    String((el as HTMLElement).innerText ?? el.textContent ?? '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\s+\n/g, '\n')
      .trim()
      .slice(0, 2000)
  const boxOf = (el: Element) => {
    const r = el.getBoundingClientRect()
    return { left: r.left, top: r.top, width: r.width, height: r.height }
  }
  // what a shape of a drawing says it is: its aria-label (Vega's marks carry one), else its tooltip (its <title>)
  const said = (el: Element) => (el.getAttribute('aria-label') || Array.from(el.children).find((c) => c.tagName.toLowerCase() === 'title')?.textContent || '').trim()
  // the part under `t` (module note), or the root on the page's bare background and where the text around a shape is a
  // drawing's labels run together
  const partAt = (t: EventTarget | null): Element => {
    const el = t instanceof Element ? t : null
    const own = el && el.closest('[data-part]')
    if (own) return own
    if (el instanceof SVGElement && said(el)) return el
    for (let p = el; p && p !== document.body && p !== root; p = p.parentElement) if ((p.textContent || '').trim()) return p.querySelectorAll('text').length > 1 ? root : p
    return root
  }
  // what the pointer was last over in the page, and what ⌘ points at now
  let over: EventTarget | null = null
  let pointed: Element | null = null
  const point = (el: Element | null) => {
    if (el === pointed) return
    pointed = el
    post(el === root ? { type: P + 'point', card: true } : { type: P + 'point', rect: el ? boxOf(el) : null })
  }
  // the frame's own key points (after holdMs on a Mac), or stops
  const own = (on: boolean) => {
    window.clearTimeout(wait)
    wait = undefined
    ownOn = on
    arrow(on || pageOn)
    point(on && over ? partAt(over) : null)
  }
  // the key let go, or pressed with another key, a shortcut's (⌘C, ⌘Z): the pointer stops until the key is pressed again
  const letGo = () => {
    pageOn = false
    own(false)
  }

  document.addEventListener(
    'mousemove',
    (e) => {
      over = e.target
      // the key let go where this page did not hear it
      if (!held(e) && (ownOn || wait != null)) own(false)
      const on = pointing(e)
      arrow(on)
      point(on ? partAt(e.target) : null)
    },
    true,
  )
  root.addEventListener('mouseleave', () => {
    over = null
    point(null)
  })
  addEventListener('keydown', (e) => {
    if (!isKey(e.key)) {
      if (held(e)) letGo()
    } else if (!mac) own(true)
    else if (!e.repeat && wait == null && !ownOn && !(e.shiftKey || e.ctrlKey || (alt ? e.metaKey : e.altKey))) wait = window.setTimeout(() => own(true), holdMs)
  })
  addEventListener('keyup', (e) => {
    if (isKey(e.key) || !held(e)) letGo()
  })
  addEventListener('blur', () => own(false))
  // a ⌘-click is the pointer's: it asks about the part, and the page's own click does not happen
  document.addEventListener(
    'click',
    (e) => {
      if (!held(e)) return
      e.preventDefault()
      e.stopPropagation()
      const el = partAt(e.target)
      post(el === root ? { type: P + 'cite', card: true } : { type: P + 'cite', text: el.getAttribute('data-part-text') || textOf(el), element: el.getAttribute('aria-label') || '', rect: boxOf(el) })
    },
    true,
  )
  // nor does a ⌘-press select the page's text, which no ⌘-drag can gather from here
  document.addEventListener(
    'mousedown',
    (e) => {
      if (held(e) && e.button === 0) e.preventDefault()
    },
    true,
  )
  addEventListener('message', (e) => {
    const d = e.data
    if (e.source !== parent || !d || d.type !== P + 'cmd') return
    if (d.key === 'alt' || d.key === 'meta') alt = d.key === 'alt'
    if (typeof d.cursor === 'string' && d.cursor) root.style.setProperty('--thimble-cmd-cursor', d.cursor)
    pageOn = !!d.on
    arrow(pageOn || ownOn)
    if (pageOn && over) point(partAt(over))
    else if (!pageOn && !ownOn) point(null)
  })

  // Whether a box under the pointer, or the page itself (only up and down), can still scroll the way the wheel turns
  // most.
  const scrolls = (t: EventTarget | null, dx: number, dy: number) => {
    const across = Math.abs(dx) > Math.abs(dy)
    const d = across ? dx : dy
    const room = (el: Element) =>
      across ? (d > 0 ? el.scrollLeft + el.clientWidth < el.scrollWidth - 1 : el.scrollLeft > 0) : d > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : el.scrollTop > 0
    for (let el = t instanceof Element ? t : null; el && el !== document.body && el !== root; el = el.parentElement) {
      const o = getComputedStyle(el)[across ? 'overflowX' : 'overflowY']
      if ((o === 'auto' || o === 'scroll') && room(el)) return true
    }
    const page = document.scrollingElement
    return !across && !!page && room(page)
  }
  // A turn the page did not take goes to the canvas. A pinch (ctrl) or a ⌘ turn always does, and the browser does not
  // also zoom or scroll here; any other turn the page's boxes cannot scroll still runs its course, so a page that holds
  // the card in a scrolling column (a report) still scrolls under it.
  addEventListener(
    'wheel',
    (e) => {
      if (e.defaultPrevented) return
      const zoom = e.ctrlKey || e.metaKey
      if (!zoom && scrolls(e.target, e.deltaX, e.deltaY)) return
      if (zoom) e.preventDefault()
      post({ type: P + 'wheel', deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode, ctrlKey: e.ctrlKey, metaKey: e.metaKey, x: e.clientX, y: e.clientY })
    },
    { passive: false },
  )
}

/** The frame half as a script for the head of the card's page, before the page's own scripts. */
export const bridgeScript = (): string => `<script>(${cardBridge.toString().replace(/<\/script/gi, '<\\/script')})(${HOLD_MS},${isMacPlatform()})</script>`

/** A message from the card's page (module note). */
export interface CardMessage {
  type?: unknown
  card?: unknown
  rect?: { left: number; top: number; width: number; height: number } | null
  text?: unknown
  element?: unknown
}

/** Do on the page what the card's page in `frame` said about the ⌘ pointer or the wheel (module note). The card it is
 * about is the anchored element around the frame: the card on the board, in focus mode or in a report's figure. */
export function fromCardPage(frame: HTMLIFrameElement, d: CardMessage): void {
  const host = frame.parentElement?.closest<HTMLElement>('[data-anchor]') ?? null
  if (d.type === P + 'point') {
    bus.emit('pointHover', { rect: d.card ? (host?.getBoundingClientRect() ?? null) : d.rect ? toPage(frame, d.rect) : null })
  } else if (d.type === P + 'cite') {
    const anchor = host?.getAttribute('data-anchor')
    if (!host || !anchor) return
    if (d.card) bus.emit('askAbout', { el: host })
    else if (d.rect) bus.emit('pointAt', { anchor, text: String(d.text ?? ''), element: String(d.element ?? ''), rect: toPage(frame, d.rect), frame, info: describeElement(frame) })
  } else if (d.type === P + 'wheel') {
    wheelOver(frame, d as FrameWheel)
  }
}

/** The page's ⌘ pointer as the card's page hears it (`cmd`). */
const cmdOf = (on: boolean, cursor = cmdCursors(token('--accent')).arrow) => ({ type: P + 'cmd', on, cursor, key: getAskKey() })

/** Tell the card's page in `frame` the ⌘ pointer as it is now: once the page has loaded, so a ⌘ pressed while the frame
 * has the focus shows the arrow and follows the ask key. */
export function tellCmd(frame: HTMLIFrameElement | null): void {
  frame?.contentWindow?.postMessage(cmdOf(document.body.hasAttribute('data-cmd')), '*')
}

/** Tell the card's page in the frame `frameOf` gives each time the ⌘ pointer goes on or off, and each time Settings pick
 * another ask key; returns the stop. */
export function followCmd(frameOf: () => HTMLIFrameElement | null): () => void {
  const offHeld = bus.on('cmdHeld', ({ on, cursor }) => frameOf()?.contentWindow?.postMessage(cmdOf(on, cursor), '*'))
  const offKey = onAskKey(() => tellCmd(frameOf()))
  return () => {
    offHeld()
    offKey()
  }
}
