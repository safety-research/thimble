// The ⌘ pointer: hold ⌘ and the pointer becomes the accent arrow (cursor.ts), with the one highlight (highlight.ts)
// following it over anchorable elements; over text, the word under it. A ⌘-click holds the highlight and opens the box
// beside it: on a region, the element; on text, the chunk around the word, quoted. A ⌘-drag selects text and joins the
// anchors it touches. Report blocks (`data-anchor-cell`) are taken whole (anchors.ts cellOf); inside a card
// (`data-anchor-parts`) the innermost part is taken (parts.ts). The click also captures a picture (capture.ts), and
// Enter posts a thread to the analyst's Claude Code session. A view's frame sends its own hover and click through the bus
// (pointHover, pointAt, cmdHeld). On a Mac ⌘ is also every shortcut's key, so the pointer shows once ⌘ has been held
// alone for HOLD_MS, and a key pressed with ⌘ (⌘C, ⌘V, ⌘Z) lets go of it until ⌘ is released; a ⌘-press points at
// once. Off a Mac, Ctrl does what ⌘ does (lib/platform), at once, and lets go at a key pressed with it. The send lets
// go of the highlight and opens the thread in the chat column. The box shows only while the element it is about is on
// screen: a switch to another tab or a collapsed frame hides it, its text kept, and it comes back beside the element
// when the element is back (onScreen); a send under way goes on. ⌘ here stands for the ask key Settings picks
// (lib/platform pointKeyHeld): ⌘ by default, or ⌥, which then holds alone for HOLD_MS on a Mac as ⌘ does, and lets go
// at a key pressed with it (⌥ types a letter's accent there); off a Mac, Ctrl or Alt, at once.
import { useEffect, useRef, useState } from 'react'
import { agentTinted } from '../lib/agentKey'
import { api } from '../lib/api'
import { demoStop } from '../lib/demo'
import { bus } from '../lib/bus'
import { getAskKey, isMacPlatform, isPointKey, pointKeyHeld } from '../lib/platform'
import { track } from '../lib/telemetry'
import { token } from '../lib/vizTheme'
import { anchorsInSelection, cellOf, chunkAt, isDrag, isShown, joinAnchors, lastLine, nearestAnchor, pressRoot, rangeContext, selectionTextWithin, textHitAt, toBox, type Anchor, type Box } from './anchors'
import { capturePng, commonElement, describeElement, type ElementInfo } from './capture'
import { cmdCursors } from './cursor'
import { carried, highlight } from './highlight'
import { partOf, type Part } from './parts'
import { PointerBox, regionPlace, type Place } from './PointerBox'

interface Ask {
  /** one ref, or several joined by ',' */
  anchor: string
  /** the anchors the box stands for, in document order */
  anchors: string[]
  text: string
  /** the region's box, or the span's last line */
  rect: Box
  /** the highlight is a span of text (a clicked chunk or a dragged range), not a region: the box goes under it */
  span: boolean
  /** the element pointed at: its surface, kind and selector */
  info: ElementInfo
  /** its picture, drawn from the click on */
  image: Promise<string | null>
  /** where a region's box goes: beside it, beside its cell, or under a tab */
  place?: Place
  /** the chat shown in the chat panel when the element is in it, which the thread hangs under */
  parent?: string | null
  /** the element the box is about, which shows the box while it is on screen, and its box when `rect` was taken */
  el: Element
  from: Box
  /** how the highlight marks it again when it is back: whole, or `rect` inside it; the text of a span, `range`, while
   * the element is the same */
  mark: 'region' | 'box'
  range?: Range
  /** where the element, a view's frame, is found again once it is drawn anew (homeOf); null for any other element */
  home: Home | null
}

/** What an opened box is given: everything but where its element was when it opened, which openBox takes. */
type Opened = Omit<Ask, 'from' | 'home'>

/** Where a view's frame, which has no `data-anchor` of its own, is found again once it is drawn anew: in the nearest
 * anchored element around it (a card), else in the surface it is in (a view's pane), by its title. */
export interface Home {
  anchor: string | null
  surface: string | null
  title: string | null
}

/** The Home of a view's frame (an iframe); null for any other element, which is found again by its `data-anchor`. */
export function homeOf(el: Element): Home | null {
  if (el.tagName !== 'IFRAME' || el.hasAttribute('data-anchor')) return null
  return {
    anchor: el.parentElement?.closest('[data-anchor]')?.getAttribute('data-anchor') ?? null,
    surface: el.closest('[data-surface]')?.getAttribute('data-surface') ?? null,
    title: el.getAttribute('title'),
  }
}

const escAttr = (v: string): string => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(v) : v.replace(/["\\]/g, '\\$&'))
const shownAll = (root: ParentNode, sel: string): Element[] => Array.from(root.querySelectorAll(sel)).filter(isShown)

/**
 * The element a box is about as it is on screen now: the element itself while it is laid out (a hidden tab's elements
 * are not); once it has left the page, the element drawn anew in its place, with its `data-anchor`, in the panel it was
 * in (a card a collapsed frame no longer drew, once the frame opens again), or, for a view's frame, the frame drawn anew
 * at its `home` (in its card, or in its view's pane); else null.
 */
export function onScreen(el: Element, panel: Element | null, home: Home | null = null): Element | null {
  if (el.isConnected) return isShown(el) ? el : null
  const root: ParentNode = panel?.isConnected ? panel : document
  const anchor = el.getAttribute('data-anchor')
  if (anchor) return shownAll(root, `[data-anchor="${escAttr(anchor)}"]`)[0] ?? null
  if (!home || (!home.anchor && !home.surface)) return null
  const hosts = home.anchor ? shownAll(root, `[data-anchor="${escAttr(home.anchor)}"]`) : shownAll(document, `[data-surface="${escAttr(home.surface!)}"]`)
  for (const h of hosts) {
    const hit = shownAll(h, 'iframe').find((e) => e.getAttribute('title') === home.title)
    if (hit) return hit
  }
  return null
}

/** Where a region's box goes beside the element drawn anew: as beside the element, keeping the side of the element
 * itself when the box first went beside it as a cell holding a part (a point of a chart). */
function placeAgain(old: Place | undefined, el: Element): Place {
  const p = regionPlace(el)
  return old?.host && !p.host && !p.under ? { ...p, host: toBox(el.getBoundingClientRect()) } : p
}

/** how often (ms) a hidden box looks for its element again */
const GONE_MS = 200
const nextFrame = (fn: () => void): number => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : window.setTimeout(fn, 16))
const cancelFrame = (id: number): void => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : window.clearTimeout(id))

/** The element's description, the start of its picture, where a box about it goes and the chat it is in, for a box
 * about `el`; `shot` is what the picture shows, the element itself unless given. */
const pointAt = (el: Element, shot: HTMLElement = el as HTMLElement): Pick<Ask, 'info' | 'image' | 'place' | 'parent'> => ({
  info: describeElement(el),
  image: capturePng(shot),
  place: regionPlace(el),
  parent: el.closest('[data-chat-current]')?.getAttribute('data-chat-current') ?? null,
})

/** Light a card's part: its own box, carried along with its element, when it has one, else its element. */
const lightPart = (p: Part) => (p.rect ? highlight.box(p.rect, p.el) : highlight.region(p.el))

const UNDER: Place = { under: true }
const BESIDE: Place = { under: false }

const cmdOn = () => document.body.hasAttribute('data-cmd')
/** On a Mac, how long ⌘ is held alone before the pointer shows: a shortcut presses its key with ⌘ well within it. */
export const HOLD_MS = 300

const near = (a: Box, b: Box): boolean => Math.abs(a.left - b.left) < 0.5 && Math.abs(a.top - b.top) < 0.5 && Math.abs(a.right - b.right) < 0.5 && Math.abs(a.bottom - b.bottom) < 0.5

export function CmdPointer({ ws }: { ws: string }) {
  const [box, setBox] = useState<Ask | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  // the element the box is about is off screen: the box is not drawn, and keeps its text
  const [hidden, setHidden] = useState(false)
  // the panel the box's element is in, where the element drawn anew is looked for
  const panel = useRef<Element | null>(null)
  const boxEl = useRef<HTMLElement>(null)
  // a ⌘-press in flight: where it started, the panel it started in, `dragged` once it moved far enough
  const press = useRef<{ x: number; y: number; root: ParentNode; dragged: boolean } | null>(null)
  // the click that follows a drag's release is not a ⌘-click
  const swallowClick = useRef(false)

  useEffect(() => {
    const mac = isMacPlatform()
    const held = (e: MouseEvent | KeyboardEvent) => pointKeyHeld(e, mac)
    const on = () => {
      if (cmdOn()) return
      // the cursors are drawn in the accent of the moment, which the analyst may have changed since the last ⌘
      const cursors = cmdCursors(token('--accent'))
      document.body.style.setProperty('--cmd-cursor', cursors.arrow)
      document.body.style.setProperty('--cmd-cursor-text', cursors.beam)
      document.body.setAttribute('data-cmd', '1')
      bus.emit('cmdHeld', { on: true, cursor: cursors.arrow })
    }
    const off = () => {
      if (!cmdOn()) return
      document.body.removeAttribute('data-cmd')
      bus.emit('cmdHeld', { on: false, cursor: '' })
      highlight.clear()
    }
    const openBox = (b: Opened) => {
      setDraft('')
      setHidden(false)
      panel.current = b.el.closest('[data-panel]')
      setBox({ ...b, from: toBox(b.el.getBoundingClientRect()), home: homeOf(b.el) })
    }
    const inBox = (t: EventTarget | null) => !!boxEl.current?.contains(t as Node)
    // what the pointer is on: the report block it is in, else the part of a card under it, else a word of an anchored
    // element's text, else the element, else nothing
    const follow = (target: EventTarget | null, x: number, y: number) => {
      const a = nearestAnchor(target)
      if (!a || inBox(target)) return highlight.clear()
      const cell = cellOf(a)
      if (cell) return highlight.region(cell.el)
      const part = partOf(a, target, x, y)
      if (part) return lightPart(part)
      const t = textHitAt(x, y, a.el)
      if (t) highlight.text(t.range)
      else highlight.region(a.el)
    }
    // on a Mac, ⌘ held alone waits HOLD_MS before the pointer shows, at what the pointer is over (`at`, its last place);
    // while ⌘↵'s tint shows on the text being typed (lib/agentKey), the highlight waits for the mouse to move, as the
    // tint goes then
    let wait: number | null = null
    let at: { x: number; y: number } | null = null
    const unwait = () => {
      if (wait != null) window.clearTimeout(wait)
      wait = null
    }
    const shown = () => {
      wait = null
      on()
      if (at && !press.current && !highlight.isHeld() && !agentTinted()) follow(document.elementFromPoint(at.x, at.y), at.x, at.y)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (!mac) {
        if (isPointKey(e.key, mac)) on()
        // off a Mac, Ctrl with another key is a shortcut (Ctrl+C, Ctrl+Z), not a point: the pointer lets go of it
        else if (cmdOn()) off()
        return
      }
      if (isPointKey(e.key, mac)) {
        // ⌘ pressed with another key already down is a shortcut's start: it stays off until ⌘ is released
        const other = e.shiftKey || e.ctrlKey || (getAskKey() === 'alt' ? e.metaKey : e.altKey)
        if (!e.repeat && wait == null && !cmdOn() && !other) wait = window.setTimeout(shown, HOLD_MS)
      } else if (held(e)) {
        // a key pressed with ⌘ is a shortcut (⌘C, ⌘V, ⌘Z), not a point: the pointer lets go until ⌘ is released
        unwait()
        off()
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (isPointKey(e.key, mac) || !held(e)) {
        unwait()
        off()
      }
    }
    const onMouseDown = (e: MouseEvent) => {
      if (!held(e) || e.button !== 0) return
      if (inBox(e.target)) return
      // a ⌘-press points at once, before ⌘ has been held for HOLD_MS: its text selects for a ⌘-drag
      unwait()
      on()
      press.current = { x: e.clientX, y: e.clientY, root: pressRoot(e.target), dragged: false }
      document.body.setAttribute('data-cmd-press', '1')
    }
    const onMouseMove = (e: MouseEvent) => {
      at = { x: e.clientX, y: e.clientY }
      // a ⌘ whose key-up never arrived (a system shortcut such as ⌘⇧4 took it) ends at the next move made without ⌘,
      // so the page never stays in the ⌘ state with its text selectable
      if (!held(e)) {
        unwait()
        if (cmdOn()) off()
      }
      const p = press.current
      if (p) {
        if (!p.dragged && isDrag(p, { x: e.clientX, y: e.clientY })) {
          p.dragged = true
          document.body.setAttribute('data-cmd-drag', '1')
          // the native selection is the highlight while the drag runs
          highlight.clear()
        }
        return
      }
      if (!cmdOn() || highlight.isHeld()) return
      follow(e.target, e.clientX, e.clientY)
    }
    const endPress = () => {
      press.current = null
      document.body.removeAttribute('data-cmd-press')
      document.body.removeAttribute('data-cmd-drag')
    }
    const onMouseUp = (e: MouseEvent) => {
      const p = press.current
      if (!p) return
      const dragged = p.dragged || isDrag(p, { x: e.clientX, y: e.clientY })
      endPress()
      if (!dragged) return
      swallowClick.current = true
      window.setTimeout(() => (swallowClick.current = false), 0)
      // the range stays inside the panel the press started in: a sweep never gathers another surface's anchors
      const sel = document.getSelection()
      const anchors: Anchor[] = anchorsInSelection(sel, p.root)
      if (!anchors.length) return
      const anchor = joinAnchors(anchors)
      const text = rangeContext(anchors, selectionTextWithin(sel, p.root as Node))
      const rect = (sel && sel.rangeCount ? lastLine(sel.getRangeAt(sel.rangeCount - 1)) : null) ?? anchors[anchors.length - 1].el.getBoundingClientRect()
      // the selection's lines hold as the highlight: the box takes the focus and the native selection with it
      const range = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : undefined
      highlight.retarget()
      if (range) highlight.text(range)
      highlight.hold()
      track('pointer-open', { target: anchor, detail: { range: anchors.length } })
      const held = commonElement(anchors.map((a) => a.el)) ?? anchors[0].el
      openBox({ anchor, anchors: anchors.map((a) => a.anchor), text, rect, span: true, ...pointAt(held), el: held, mark: 'region', range })
    }
    const onClick = (e: MouseEvent) => {
      if (swallowClick.current) {
        swallowClick.current = false
        e.preventDefault()
        e.stopPropagation()
        return
      }
      if (!held(e)) return
      if (inBox(e.target)) return
      const a: Anchor | null = nearestAnchor(e.target)
      if (!a) return
      e.preventDefault()
      e.stopPropagation()
      // a report block is picked whole, as a region
      const cell = cellOf(a)
      if (cell) {
        highlight.retarget()
        highlight.region(cell.el)
        highlight.hold()
        track('pointer-open', { target: cell.anchor, detail: { cell: true } })
        openBox({ anchor: cell.anchor, anchors: [cell.anchor], text: cell.text, rect: cell.el.getBoundingClientRect(), span: false, ...pointAt(cell.el), el: cell.el, mark: 'region' })
        return
      }
      // a card's part is picked as a region, the card drawn around it
      const part = partOf(a, e.target, e.clientX, e.clientY)
      if (part) {
        highlight.retarget()
        lightPart(part)
        highlight.hold()
        track('pointer-open', { target: part.anchor, detail: { part: true } })
        openBox({ anchor: part.anchor, anchors: [part.anchor], text: part.text, rect: part.rect ?? part.el.getBoundingClientRect(), span: false, ...pointAt(part.el, a.el), el: a.el, mark: 'box' })
        return
      }
      const t = textHitAt(e.clientX, e.clientY, a.el)
      // a click on text selects the chunk around the word, anchored to its element; a region carries its own text
      const chunk = t ? chunkAt(t, a.el) : null
      highlight.retarget()
      if (chunk) highlight.text(chunk.range)
      else highlight.region(a.el)
      highlight.hold()
      track('pointer-open', { target: a.anchor })
      const at = { ...pointAt(a.el), el: a.el, mark: 'region' as const }
      openBox(chunk ? { anchor: a.anchor, anchors: [a.anchor], text: chunk.text, rect: lastLine(chunk.range) ?? t!.rect, span: true, ...at, range: chunk.range } : { anchor: a.anchor, anchors: [a.anchor], text: a.text, rect: a.el.getBoundingClientRect(), span: false, ...at })
    }
    const onBlur = () => {
      unwait()
      off()
      endPress()
    }
    // a view's page is a sandboxed frame the pointer cannot see into: the frame reports the anchorable element under
    // the pointer while ⌘ is held, and a ⌘-click on one (files/ViewerFrame, backend/app/viewer_bridge.js)
    const offHover = bus.on('pointHover', ({ rect }) => {
      if (highlight.isHeld()) return
      if (rect) highlight.box(rect)
      else highlight.clear()
    })
    const offPoint = bus.on('pointAt', ({ anchor, text, element, rect, frame, view }) => {
      highlight.retarget()
      highlight.box(rect, frame)
      highlight.hold()
      track('pointer-open', { target: anchor, detail: { frame: true } })
      // inside a viewer's frame, whose sandbox cannot be drawn from here: the element is named by its view (`view:<slug>`),
            // so the thread can reach that view's ticket
      openBox({ anchor, anchors: [anchor], text: element ? `${element}\n${text}`.trim() : text, rect, span: false, info: { surface: 'files', element: view ? `view:${view}` : 'view', selector: '' }, image: Promise.resolve(null), el: frame, mark: 'box' })
    })
    // a control that asks about its element (a card's Ask about this): the box opens as a ⌘-click on the element opens it
    const offAsk = bus.on('askAbout', ({ el }) => {
      const a = nearestAnchor(el)
      if (!a) return
      highlight.region(a.el)
      highlight.hold()
      track('pointer-open', { target: a.anchor, detail: { via: 'ask' } })
      openBox({ anchor: a.anchor, anchors: [a.anchor], text: a.text, rect: a.el.getBoundingClientRect(), span: false, ...pointAt(a.el), el: a.el, mark: 'region' })
    })
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    document.addEventListener('mousedown', onMouseDown, true)
    document.addEventListener('mousemove', onMouseMove, true)
    document.addEventListener('mouseup', onMouseUp, true)
    document.addEventListener('click', onClick, true)
    return () => {
      offHover()
      offPoint()
      offAsk()
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('mousedown', onMouseDown, true)
      document.removeEventListener('mousemove', onMouseMove, true)
      document.removeEventListener('mouseup', onMouseUp, true)
      document.removeEventListener('click', onClick, true)
      unwait()
      off()
      endPress()
      highlight.release()
    }
  }, [])

  // the box shows while its element is on screen (onScreen). A switch to another tab or a collapsed frame takes the
  // element away: the box is not drawn, keeps its text, and leaves the ⌘ pointer free for what is on screen. Once the
  // element, or the element drawn anew in its place, is back, the box comes back beside it with the highlight on it. A
  // send under way goes on, and closes the box when it is done.
  useEffect(() => {
    if (!box) return
    let id = 0
    let gone = false
    // each frame while the box shows; while it is hidden, every GONE_MS
    let later = 0
    const tick = () => {
      const now = onScreen(box.el, panel.current, box.home)
      if (!now) {
        if (!gone) {
          gone = true
          highlight.release()
          setHidden(true)
        }
      } else if (gone || now !== box.el) {
        const at = toBox(now.getBoundingClientRect())
        const moved = carried(box.rect, box.from, at) ?? at
        const rect = near(moved, box.rect) ? box.rect : moved
        highlight.retarget()
        if (box.range && now === box.el) highlight.text(box.range)
        else if (box.mark === 'box') highlight.box(new DOMRect(rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top), now)
        else highlight.region(now)
        highlight.hold()
        setHidden(false)
        // a view's frame keeps the place it had: its box went beside the frame's element, which only the frame knows
        const place = gone && !box.span && !box.home ? placeAgain(box.place, now) : box.place
        setBox((b) => (b === box ? { ...box, el: now, from: at, rect, place } : b))
        return
      }
      if (gone) later = window.setTimeout(tick, GONE_MS)
      else id = nextFrame(tick)
    }
    id = nextFrame(tick)
    return () => {
      cancelFrame(id)
      window.clearTimeout(later)
    }
  }, [box])

  const close = () => {
    setBox(null)
    setHidden(false)
    highlight.release()
  }
  const submit = async () => {
    const text = draft.trim()
    if (!box || !text || busy || demoStop()) return
    setBusy(true)
    track('pointer-send', { target: box.anchor, detail: { text, range: box.anchors.length } })
    try {
      const image = await box.image
      const meta = await api.createThread(ws, { anchor: box.anchor, anchor_text: box.text || null, ...box.info, image, parent: box.parent ?? null, text })
      setDraft('')
      bus.emit('openChat', { chatId: meta.id })
      close()
    } catch (e) {
      bus.emit('toast', { text: `Could not open a thread: ${(e as Error).message}`, kind: 'error' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      {box && !hidden && (
        <PointerBox
          ref={boxEl}
          rect={box.rect}
          place={box.span ? UNDER : (box.place ?? BESIDE)}
          className={box.anchors.length > 1 ? 'pointer-box-range' : undefined}
          label={box.anchors.length > 1 ? `Ask about these ${box.anchors.length}` : 'Ask about this'}
          draft={draft}
          onDraft={setDraft}
          busy={busy}
          onSubmit={() => void submit()}
          onClose={close}
          attrs={{ 'data-anchors': box.anchors.length }}
        />
      )}
    </>
  )
}
