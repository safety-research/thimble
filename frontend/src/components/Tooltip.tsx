// The one tooltip: an opaque label portaled to <body>, so no scroll or overflow clips it. It names what an icon-only
// control does, shown on hover after a moment (at once if a tip showed a moment ago) and at once on keyboard focus; it
// goes with the pointer, the focus, a press or Escape. An icon Button takes its text from `title` (Button.tsx); other
// icon-only controls use TipButton or a Tipped box; a disabled menu item uses Menu's `tip`. No control uses the
// browser's own title.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent, type PointerEvent, type ReactNode, type ButtonHTMLAttributes } from 'react'
import { createPortal } from 'react-dom'

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

/** The label itself, placed by `place` once its size is known. */
export function Tip({ id, text, place, className }: { id?: string; text: string; place: (w: number, h: number) => { left: number; top: number }; className?: string }) {
  const el = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const sheet = el.current
    if (sheet) setPos(place(sheet.offsetWidth, sheet.offsetHeight))
  }, [place, text])
  const style: CSSProperties = { position: 'fixed', left: pos?.left ?? MARGIN, top: pos?.top ?? MARGIN, visibility: pos ? 'visible' : 'hidden' }
  return createPortal(
    <div ref={el} id={id} className={`tip overlay${className ? ` ${className}` : ''}`} role="tooltip" style={style}>
      {text}
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
