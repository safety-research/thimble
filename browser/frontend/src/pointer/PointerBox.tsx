// The pointer box: the overlay beside the highlight, never over it, holding only the input ("Ask about this…"); its
// accessible label names what was picked. A span of text or a tab takes the box under its last line (or over it); a
// region takes it to its right, or its left when that stays inside the region's pane, else under; a region inside a
// cell takes it beside the cell. ↵ sends, esc closes; the caller releases the highlight on close.
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { TextArea } from '../components/Field'
import type { Box } from './anchors'

export const BOX_WIDTH = 236
/** What the box's field says while it is empty; its accessible label names what was picked. */
export const ASK_PLACEHOLDER = 'Ask about this…'
/** The box stays this far (px) inside the viewport. */
export const MARGIN = 8
/** The gap (px) between a line of text or a tab and the box under it. */
export const GAP_UNDER = 8
/** The gap (px) between a region, or the cell it sits in, and the box beside it. */
export const GAP_BESIDE = 12
/** How far (px) below a tall region's top the box beside it starts. */
export const BESIDE_DROP = 8

/** Where the box goes: under the rect (a span of text, a tab), else beside it, or beside the cell (`host`) it sits in;
 * `pane` is the box of the scrolling pane the element sits in, whose left edge a box at its left keeps inside. */
export interface Place {
  under: boolean
  host?: Box | null
  pane?: Box | null
}

/**
 * Where the box goes, in viewport coordinates, for a box `w` by `h` in a viewport `vw` by `vh` (see the module comment
 * for the placement order). Always MARGIN inside the viewport. `under` is true when the box went under or over the
 * rect rather than beside it.
 */
export function boxPlace(rect: Box, w: number, h: number, vw: number, vh: number, place: Place): { left: number; top: number; under: boolean } {
  const clampY = (y: number) => Math.max(MARGIN, Math.min(y, vh - h - MARGIN))
  const under = () => {
    const left = Math.max(MARGIN, Math.min(rect.left, vw - w - MARGIN))
    const below = rect.bottom + GAP_UNDER
    return { left, top: below + h <= vh - MARGIN ? below : Math.max(MARGIN, rect.top - GAP_UNDER - h), under: true }
  }
  if (place.under) return under()
  const host = place.host ?? null
  const side = host ?? rect
  const top = host ? Math.max(host.top, Math.min(rect.top, host.bottom - h)) : rect.top + Math.max(0, Math.min(rect.bottom - rect.top - h, BESIDE_DROP))
  const right = side.right + GAP_BESIDE
  if (right + w <= vw - MARGIN) return { left: right, top: clampY(top), under: false }
  const left = side.left - GAP_BESIDE - w
  if (left >= Math.max(MARGIN, place.pane?.left ?? 0)) return { left, top: clampY(top), under: false }
  return under()
}

/** The cell an element sits in (its nearest enclosing cell anchor other than itself), whose side the box takes. */
export function hostCell(el: Element): HTMLElement | null {
  return el.parentElement?.closest<HTMLElement>('[data-anchor^="card:"], [data-anchor^="cell:"]') ?? null
}

/** The nearest ancestor of `el` that scrolls (overflow auto or scroll), the pane it is read in; null when none does. */
export function scrollPane(el: Element): HTMLElement | null {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const cs = getComputedStyle(p)
    if (/(auto|scroll)/.test(`${cs.overflowX} ${cs.overflowY}`)) return p
  }
  return null
}

/** Where the box goes for a region: under a tab, else beside the element, or beside the cell it sits in, kept inside
 * the pane it scrolls in on the left. */
export function regionPlace(el: Element): Place {
  if (el.closest('[role="tab"]')) return { under: true }
  const host = hostCell(el)
  const pane = scrollPane(el)
  return { under: false, host: host ? host.getBoundingClientRect() : null, pane: pane ? pane.getBoundingClientRect() : null }
}

export interface PointerBoxProps {
  /** the highlight the box sits beside: a region's box, or a span's last line */
  rect: Box
  place: Place
  /** the accessible name of the box and its text area */
  label: string
  draft: string
  onDraft: (v: string) => void
  busy?: boolean
  onSubmit: () => void
  onClose: () => void
  className?: string
  /** the box element, for the caller's hit tests */
  ref?: RefObject<HTMLElement | null>
  /** data attributes on the box */
  attrs?: Record<string, string | number | undefined>
}

export function PointerBox({ rect, place, label, draft, onDraft, busy = false, onSubmit, onClose, className, ref, attrs }: PointerBoxProps) {
  const own = useRef<HTMLElement>(null)
  const boxEl = ref ?? own
  const taRef = useRef<HTMLTextAreaElement>(null)

  // Escape closes the box from anywhere
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // beside the rect, never on it (boxPlace)
  useLayoutEffect(() => {
    const el = boxEl.current
    if (!el) return
    const vw = window.innerWidth
    const vh = window.innerHeight
    const w = Math.min(BOX_WIDTH, vw - 2 * MARGIN)
    el.style.width = `${w}px`
    const { left, top } = boxPlace(rect, w, el.offsetHeight, vw, vh, place)
    el.style.left = `${left}px`
    el.style.top = `${top}px`
    taRef.current?.focus()
  }, [rect, place, boxEl])

  return createPortal(
    <div
      ref={boxEl as RefObject<HTMLDivElement>}
      className={`pointer-box${className ? ` ${className}` : ''}`}
      role="dialog"
      aria-label={label}
      aria-busy={busy || undefined}
      style={{ left: MARGIN, top: 0 }}
      onMouseDown={(e) => e.stopPropagation()}
      data-panel="pointer"
      {...attrs}
    >
      <TextArea
        ref={taRef}
        bare
        block
        autoGrow
        rows={1}
        className="pointer-box-input"
        value={draft}
        onChange={onDraft}
        aria-label={label}
        placeholder={ASK_PLACEHOLDER}
        disabled={busy}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            onSubmit()
          }
        }}
      />
      {busy && <span className="spinner pointer-box-busy" />}
    </div>,
    document.body,
  )
}
