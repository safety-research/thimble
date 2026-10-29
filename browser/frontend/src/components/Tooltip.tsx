// The one tooltip: an opaque label portaled to <body>, so no scroll or overflow clips it. It names what an icon-only
// control does, shown on hover after a moment (at once if a tip showed a moment ago) and at once on keyboard focus; it
// goes with the pointer, the focus, a press or Escape. An icon Button takes its text from `title` (Button.tsx); other
// icon-only controls use TipButton or a Tipped box; a disabled menu item uses Menu's `tip`. No control uses the
// browser's own title. A mark that names a value, of which a file has as many as records (a record's labels and their
// values), carries its text in `data-tip`, which the page's one HoverTips shows under the pointer.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent, type PointerEvent, type ReactNode, type ButtonHTMLAttributes } from 'react'
import { createPortal } from 'react-dom'
import { isMacPlatform, isPointKey, pointKeyHeld } from '../lib/platform'

const GAP = 6
const MARGIN = 8
/** How long (ms) the pointer rests on a control before its tip shows. */
export const TIP_DELAY_MS = 350
/** A tip shown within this long (ms) of the last one closing shows at once, as the pointer runs along a row. */
export const TIP_WARM_MS = 500

type Rect = { left: number; right: number; top: number; bottom: number }
/** How a tip lines up under its control: centred, or from the control's left edge (a control at the right of content
 * the tip would otherwise cover). */
export type TipAlign = 'center' | 'start'

/** Where a tip of `w`×`h` goes for a control at `rect`: under it, centred or (`start`) from its left edge, else over it
 * when there is no room below, clamped to the viewport. Pure. */
export function placeTip(rect: Rect, w: number, h: number, vw: number, vh: number, align: TipAlign = 'center'): { left: number; top: number } {
  const x = align === 'start' ? rect.left : (rect.left + rect.right - w) / 2
  const left = Math.max(MARGIN, Math.min(x, vw - MARGIN - w))
  const below = rect.bottom + GAP
  const top = below + h <= vh - MARGIN ? below : Math.max(MARGIN, rect.top - GAP - h)
  return { left, top }
}

/** px under the pointer a tip at the pointer stands, clear of the pointer's arrow */
const UNDER_POINTER = 20

/** Where a tip of `w`×`h` goes for the pointer at (`x`, `y`): just under it, from its left, else over it when there is
 * no room below, clamped to the viewport. Pure. */
export function placeAtPointer(x: number, y: number, w: number, h: number, vw: number, vh: number): { left: number; top: number } {
  const left = Math.max(MARGIN, Math.min(x, vw - MARGIN - w))
  const below = y + UNDER_POINTER
  const top = below + h <= vh - MARGIN ? below : Math.max(MARGIN, y - GAP - h)
  return { left, top }
}

/** The label itself, placed by `place` once its size is known: `text`, or `children` drawn in its place (`text` then
 * says what they say, which places the label again when it changes). */
export function Tip({ id, text, place, className, children }: { id?: string; text: string; place: (w: number, h: number) => { left: number; top: number }; className?: string; children?: ReactNode }) {
  const el = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const sheet = el.current
    if (sheet) setPos(place(sheet.offsetWidth, sheet.offsetHeight))
  }, [place, text])
  const style: CSSProperties = { position: 'fixed', left: pos?.left ?? MARGIN, top: pos?.top ?? MARGIN, visibility: pos ? 'visible' : 'hidden' }
  return createPortal(
    <div ref={el} id={id} className={`tip overlay${className ? ` ${className}` : ''}`} role="tooltip" style={style}>
      {children ?? text}
    </div>,
    document.body,
  )
}

let lastClosed = 0

/**
 * A control's tooltip: the handlers its element takes and the label to render beside it. `text` null or empty shows
 * nothing. The label is placed under the control (placeTip, lined up by `align`); `className` goes on the label.
 */
export function useTooltip(text: string | null | undefined, className?: string, align: TipAlign = 'center') {
  const id = useId()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const timer = useRef<number | null>(null)
  const clear = () => {
    if (timer.current != null) window.clearTimeout(timer.current)
    timer.current = null
  }
  const hide = useCallback(() => {
    clear()
    setAnchor((a) => {
      if (a) lastClosed = Date.now()
      return null
    })
  }, [])
  useEffect(() => {
    if (!anchor) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && hide()
    // a scroll moves the control out from under its label
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', hide, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', hide, true)
    }
  }, [anchor, hide])
  useEffect(() => clear, [])
  const place = useCallback(
    (w: number, h: number) => (anchor ? placeTip(anchor.getBoundingClientRect(), w, h, window.innerWidth, window.innerHeight, align) : { left: MARGIN, top: MARGIN }),
    [anchor, align],
  )
  if (!text) return { props: {}, tip: null }
  const props = {
    'aria-describedby': anchor ? id : undefined,
    onPointerEnter: (e: PointerEvent<HTMLElement>) => {
      if (e.pointerType === 'touch') return
      const el = e.currentTarget
      clear()
      if (Date.now() - lastClosed < TIP_WARM_MS) setAnchor(el)
      else timer.current = window.setTimeout(() => setAnchor(el), TIP_DELAY_MS)
    },
    onPointerLeave: hide,
    onPointerDown: hide,
    onFocus: (e: FocusEvent<HTMLElement>) => {
      // on keyboard focus only: a click focuses the button too, and its tip would outstay the click. The focused
      // element is read rather than the one holding the handlers, so a box around a control (Tipped) works too.
      if ((e.target as HTMLElement).matches(':focus-visible')) {
        clear()
        setAnchor(e.currentTarget)
      }
    },
    onBlur: hide,
  }
  return { props, tip: anchor ? <Tip id={id} text={text} place={place} className={className} /> : null }
}

/** What a move of the pointer says (a pointer event): where the pointer is, the buttons held, and the modifier keys,
 * the ask key among them. */
export interface PointerAt {
  clientX: number
  clientY: number
  buttons: number
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
}

/** What the pointer and the keys do to the tip of a mark that names a value, whoever draws it (HoverTips; the tour's
 * examples, tour/engine), from the events that reach it: the mark under the pointer shows its tip once the pointer has
 * rested on it a moment, at once when the pointer has just left another tip (as it runs along the rows). No tip shows
 * while the pointer is busy, a button held for a selection or a drag or the ask key held for the ⌘ pointer
 * (lib/platform), since it would cover what the pointer marks: a press or the ask key takes the tip away the moment it
 * goes down, and a tip still waiting its moment with it, whether the pointer moves or not. A tip taken away (a press,
 * the ask key, Escape) stays away from its mark until the pointer reaches another, and that one waits its moment.
 * `show` draws `mark`'s tip for the pointer at (x, y), false when it has none to draw; `hide` takes it away. */
export function markTips(show: (mark: Element, x: number, y: number) => boolean, hide: () => void) {
  const mac = isMacPlatform()
  let on: Element | null = null
  let shown = false
  let timer = 0
  let x = 0
  let y = 0
  // `warm`: the pointer left the tip for another place, so the next tip shows at once
  const away = (warm: boolean) => {
    window.clearTimeout(timer)
    timer = 0
    if (!shown) return
    shown = false
    if (warm) lastClosed = Date.now()
    hide()
  }
  // the tip taken away from `mark`, the mark under the pointer, which shows none until the pointer reaches another
  const drop = (mark: Element | null) => {
    away(false)
    on = mark
  }
  const reset = () => {
    away(false)
    on = null
  }
  return {
    /** a move of the pointer, `e`, over `mark` (null for none) */
    point(mark: Element | null, e: PointerAt) {
      x = e.clientX
      y = e.clientY
      if (e.buttons !== 0 || pointKeyHeld(e, mac)) return drop(mark)
      if (mark === on) return
      away(true)
      on = mark
      if (!mark) return
      const go = () => {
        timer = 0
        if (on === mark && mark.isConnected) shown = show(mark, x, y)
      }
      if (Date.now() - lastClosed < TIP_WARM_MS) go()
      else timer = window.setTimeout(go, TIP_DELAY_MS)
    },
    /** a press of a button on `mark` (null for none) */
    press: drop,
    /** a key going down, `e`: the ask key and Escape take the tip away from the mark under the pointer */
    key(e: { key: string }) {
      if (e.key === 'Escape' || isPointKey(e.key, mac)) drop(on)
    },
    /** the pointer going out of an element, `e`: out of the page (to no element), it takes the tip with it */
    out(e: { relatedTarget: EventTarget | null }) {
      if (!e.relatedTarget) reset()
    },
    /** the tip gone, and the mark under the pointer waits its moment again (a scroll moved the marks, the pointer left) */
    reset,
  }
}

/** A mark that names a value: an element whose `data-tip` says something. */
export const TIP_MARK = '[data-tip]:not([data-tip=""])'
/** The mark at `target`: it, or the nearest element around it that is one. */
const markAt = (target: EventTarget | null) => (target instanceof Element ? target.closest(TIP_MARK) : null)

/**
 * The one tooltip for marks that name a value, of which a file has as many as records (a record's labels and their
 * values, a label's cell beside a record): the element under the pointer with `data-tip` shows its text, line by line,
 * under the pointer where it rests, by markTips' rules. It goes when the pointer leaves the element, at a press, the ask
 * key, a scroll or Escape. Drawn once for the page (shell/Shell), so a mark needs no listener of its own. The text a
 * mark's tip shows is for the pointer; the mark gives it to a screen reader in its own words (an aria-label or
 * aria-description).
 */
export function HoverTips() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null)
  useEffect(() => {
    const tips = markTips(
      (mark, x, y) => {
        const text = mark.getAttribute('data-tip')
        if (text) setTip({ text, x, y })
        return !!text
      },
      () => setTip(null),
    )
    // (the DOM's pointer events: this file's PointerEvent is React's)
    const move = (e: MouseEvent & { pointerType?: string }) => {
      if (e.pointerType === 'touch') return
      tips.point(markAt(e.target), e)
    }
    const press = (e: MouseEvent) => tips.press(markAt(e.target))
    const out = (e: MouseEvent) => tips.out(e)
    const scroll = () => tips.reset()
    const key = (e: KeyboardEvent) => tips.key(e)
    document.addEventListener('pointermove', move, { capture: true, passive: true })
    document.addEventListener('pointerout', out, true)
    document.addEventListener('pointerdown', press, true)
    window.addEventListener('scroll', scroll, true)
    window.addEventListener('keydown', key, true)
    return () => {
      tips.reset()
      document.removeEventListener('pointermove', move, { capture: true })
      document.removeEventListener('pointerout', out, true)
      document.removeEventListener('pointerdown', press, true)
      window.removeEventListener('scroll', scroll, true)
      window.removeEventListener('keydown', key, true)
    }
  }, [])
  const place = useCallback((w: number, h: number) => (tip ? placeAtPointer(tip.x, tip.y, w, h, window.innerWidth, window.innerHeight) : { left: MARGIN, top: MARGIN }), [tip])
  return tip ? <Tip text={tip.text} place={place} className="tip-lines" /> : null
}

/**
 * The tooltip on a box around an icon-only control that takes no handlers of its own. The box is inline-flex, so the
 * control sits in it as it sat in its row.
 */
export function Tipped({ text, className, children }: { text: string; className?: string; children: ReactNode }) {
  const { props, tip } = useTooltip(text)
  return (
    <span className={`tipped${className ? ` ${className}` : ''}`} {...props}>
      {children}
      {tip}
    </span>
  )
}

/** An icon-only <button> drawn with its own class rather than Button's: `tip` names it in the one tooltip, and to a
 * screen reader unless it passes its own aria-label. */
export function TipButton({ tip: text, children, ...rest }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title'> & { tip: string }) {
  const { props, tip } = useTooltip(text)
  return (
    <button type="button" aria-label={text} {...rest} {...props}>
      {children}
      {tip}
    </button>
  )
}
