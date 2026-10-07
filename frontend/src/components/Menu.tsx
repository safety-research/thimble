// Popover: a sheet placed beside an anchor, portaled to <body>, closed by Escape or a click outside, a click in a view's
// frame among them. The anchor is an element, or any box that says where it is (a control inside a view's frame, which
// the page reports in the frame's coordinates: files/labelCalls frameAnchor).
// Menu: a trigger that opens a Popover of items. A disabled item with a `tip` stays in the menu, dimmed, and says why in
// the shared tooltip on hover and keyboard focus; it is aria-disabled rather than disabled, since a disabled button gets
// neither focus nor, in every browser, hover.
import { Children, cloneElement, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactElement, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Icon, type IconName } from './Icon'
import { Tip } from './Tooltip'

export type Align = 'start' | 'end'

/** What a sheet is placed beside: an element, or a box that is not one, which then holds no click of its own. */
export interface PopoverAnchor {
  getBoundingClientRect: () => DOMRect
  contains?: (other: Node | null) => boolean
  /** false once it is out of the page, where it has no box */
  readonly isConnected?: boolean
}
type AnchorLike = PopoverAnchor | RefObject<HTMLElement | null> | null | undefined

const GAP = 4
const MARGIN = 8

const anchorEl = (a: AnchorLike): PopoverAnchor | null => (a && 'current' in a ? a.current : (a ?? null))

/** Where a sheet of `w`×`h` goes beside `rect`: below when it fits, else above, else clamped to the viewport. Pure. */
export function placeBeside(rect: { left: number; right: number; top: number; bottom: number }, w: number, h: number, vw: number, vh: number, align: Align): { left: number; top: number } {
  const left = Math.max(MARGIN, Math.min(align === 'end' ? rect.right - w : rect.left, vw - w - MARGIN))
  const below = rect.bottom + GAP
  const above = rect.top - GAP - h
  let top: number
  if (below + h <= vh - MARGIN) top = below
  else if (above >= MARGIN) top = above
  else top = Math.max(MARGIN, vh - MARGIN - h)
  return { left, top }
}

/** Where a tip of `w`×`h` goes beside `rect` (the menu's sides, the item's top and bottom): to its right when it fits,
 * else to its left, level with the item's middle, clamped to the viewport. Pure. */
export function placeAside(rect: { left: number; right: number; top: number; bottom: number }, w: number, h: number, vw: number, vh: number): { left: number; top: number } {
  const right = rect.right + GAP
  const leftSide = rect.left - GAP - w
  const left = right + w <= vw - MARGIN ? right : leftSide >= MARGIN ? leftSide : Math.max(MARGIN, vw - MARGIN - w)
  const top = Math.max(MARGIN, Math.min((rect.top + rect.bottom - h) / 2, vh - MARGIN - h))
  return { left, top }
}

export interface PopoverProps {
  /** what the sheet sits beside: an element, a ref to one, or a box (PopoverAnchor) */
  anchor: AnchorLike
  open: boolean
  /** Escape was pressed, or a click landed outside the sheet (where the focus then is the click's) */
  onClose: (how: 'escape' | 'outside') => void
  /** which edge of the anchor the sheet's edge lines up with (default start, the left) */
  align?: Align
  /** `aside`: to the anchor's right, else its left, level with its middle (placeAside), rather than below or above it */
  side?: 'below' | 'aside'
  /** a fixed width in px; without one the sheet takes its content's width */
  width?: number
  role?: string
  /** the accessible name */
  label?: string
  className?: string
  children?: ReactNode
}

export function Popover({ anchor, open, onClose, align = 'start', side = 'below', width, role = 'dialog', label, className, children }: PopoverProps) {
  const el = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  // where the anchor was last: an anchor taken out of the page (a menu row that closed, a view's frame) keeps the sheet
  // there
  const was = useRef<DOMRect | null>(null)

  const place = useCallback(() => {
    const a = anchorEl(anchor)
    const sheet = el.current
    if (!a || !sheet) return
    const r = a.isConnected === false && was.current ? was.current : a.getBoundingClientRect()
    was.current = r
    const w = sheet.offsetWidth
    const h = sheet.offsetHeight
    setPos(side === 'aside' ? placeAside(r, w, h, window.innerWidth, window.innerHeight) : placeBeside(r, w, h, window.innerWidth, window.innerHeight, align))
  }, [anchor, align, side])

  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    place()
    const sheet = el.current
    const ro = sheet ? new ResizeObserver(place) : null
    if (sheet) ro!.observe(sheet)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, place])

  useEffect(() => {
    if (!open) return
    const onDown = (e: globalThis.MouseEvent) => {
      const t = e.target as Node
      if (el.current?.contains(t) || anchorEl(anchor)?.contains?.(t)) return
      onClose('outside')
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose('escape')
      }
    }
    // a click in a view's frame reaches this document as no mousedown: the frame takes the focus and the window blurs,
    // while the document keeps the focus (hasFocus), which it loses when the analyst leaves the browser
    let blurred: number | null = null
    const onBlur = () => {
      if (blurred != null) window.clearTimeout(blurred)
      blurred = window.setTimeout(() => {
        blurred = null
        const at = document.activeElement
        if (at instanceof HTMLIFrameElement && document.hasFocus() && !el.current?.contains(at)) onClose('outside')
      }, 0)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', onBlur)
      if (blurred != null) window.clearTimeout(blurred)
    }
  }, [open, onClose, anchor])

  if (!open) return null
  const style: CSSProperties = { position: 'fixed', left: pos?.left ?? MARGIN, top: pos?.top ?? MARGIN, width, visibility: pos ? 'visible' : 'hidden' }
  return createPortal(
    <div ref={el} className={`popover${className ? ` ${className}` : ''}`} style={style} role={role} aria-label={label} onMouseDown={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
      {children}
    </div>,
    document.body,
  )
}

export type MenuItem =
  | {
      id: string
      label: ReactNode
      /** small text after the label, tertiary */
      note?: ReactNode
      icon?: IconName
      /** the chosen one of a radio group: a check at the right, accent text */
      checked?: boolean
      disabled?: boolean
      /** with `disabled`, why the choice cannot take effect: said beside the item on hover and on keyboard focus */
      tip?: string
      /** a destructive item, in the negative colour */
      danger?: boolean
      onSelect: () => void
    }
  | { id: string; heading: string }
  | { id: string; separator: true }

export interface MenuProps {
  /** the control that opens the menu; it gets aria-haspopup and aria-expanded */
  trigger: ReactElement<Record<string, unknown>>
  items: readonly MenuItem[]
  align?: Align
  /** the accessible name of the menu */
  label?: string
  width?: number
  onOpenChange?: (open: boolean) => void
  className?: string
}

export function Menu({ trigger, items, align = 'start', label, width, onOpenChange, className }: MenuProps) {
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const listEl = useRef<HTMLDivElement>(null)
  const tipBase = useId()
  const [tip, setTip] = useState<{ id: string; el: HTMLElement; text: string } | null>(null)
  const set = (v: boolean) => {
    setOpen(v)
    onOpenChange?.(v)
  }
  const close = useCallback(() => {
    // the focus in the menu, which is about to unmount, goes back to the trigger rather than to the page
    if (listEl.current?.contains(document.activeElement)) (anchor?.firstElementChild as HTMLElement | null)?.focus()
    setOpen(false)
    onOpenChange?.(false)
  }, [onOpenChange, anchor])

  useEffect(() => {
    if (!open) {
      setTip(null)
      return
    }
    // The focus goes to the checked item, else the first, a frame later: the Popover keeps the sheet hidden until placed,
    // and a hidden button does not take focus. An item that only says why it cannot be chosen is skipped, or its tip would
    // show at once.
    const raf = requestAnimationFrame(() => {
      const list = listEl.current
      const first = list?.querySelector<HTMLButtonElement>('.menu-item.checked:not(:disabled):not([aria-disabled])') ?? list?.querySelector<HTMLButtonElement>('.menu-item:not(:disabled):not([aria-disabled])')
      first?.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [open])

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const all = Array.from(listEl.current?.querySelectorAll<HTMLButtonElement>('.menu-item:not(:disabled)') ?? [])
    if (!all.length) return
    const i = all.indexOf(document.activeElement as HTMLButtonElement)
    const next = e.key === 'ArrowDown' ? (i + 1) % all.length : (i - 1 + all.length) % all.length
    all[next].focus()
  }

  const only = Children.only(trigger)
  const wrapped = isValidElement(only) ? cloneElement(only, { 'aria-haspopup': 'menu', 'aria-expanded': open }) : only
  return (
    <>
      <span
        ref={setAnchor}
        className={`menu-trigger${className ? ` ${className}` : ''}`}
        onClick={(e: MouseEvent) => {
          e.stopPropagation()
          set(!open)
        }}
      >
        {wrapped}
      </span>
      <Popover anchor={anchor} open={open} onClose={close} align={align} width={width} role="menu" label={label}>
        <div className="menu" ref={listEl} onKeyDown={onKey}>
          {items.map((it) => {
            if ('separator' in it) return <div key={it.id} className="menu-sep" role="separator" />
            if ('heading' in it)
              return (
                <div key={it.id} className="menu-heading" role="presentation">
                  {it.heading}
                </div>
              )
            const tipText = it.disabled && it.tip ? it.tip : null
            const tipId = `${tipBase}-tip-${it.id}`
            const showTip = tipText ? (e: { currentTarget: HTMLElement }) => setTip({ id: tipId, el: e.currentTarget, text: tipText }) : undefined
            const hideTip = tipText ? () => setTip((t) => (t?.id === tipId ? null : t)) : undefined
            return (
              <button
                key={it.id}
                type="button"
                role={it.checked != null ? 'menuitemradio' : 'menuitem'}
                aria-checked={it.checked != null ? it.checked : undefined}
                className={`menu-item${it.checked ? ' checked' : ''}${it.danger ? ' danger' : ''}`}
                disabled={it.disabled && !tipText}
                aria-disabled={tipText ? true : undefined}
                aria-describedby={tipText ? tipId : undefined}
                data-item={it.id}
                onMouseEnter={showTip}
                onMouseLeave={hideTip}
                onFocus={showTip}
                onBlur={hideTip}
                onClick={(e) => {
                  // a click on an item that cannot be chosen goes no further: the menu is portaled, so the click would still bubble to
                  // the trigger's React ancestors, which may take focus out of the open menu
                  if (tipText) {
                    e.stopPropagation()
                    return
                  }
                  close()
                  it.onSelect()
                }}
              >
                {it.icon && <Icon name={it.icon} size={14} className="menu-ico" />}
                <span className="menu-item-label">{it.label}</span>
                {it.note != null && <span className="menu-item-note">{it.note}</span>}
                {it.checked && <Icon name="check" size={14} className="menu-check" />}
              </button>
            )
          })}
        </div>
      </Popover>
      {open && tip && <MenuTip id={tip.id} anchor={tip.el} text={tip.text} />}
    </>
  )
}

/** A disabled item's reason in the tooltip beside the item (placeAside); the item names it with aria-describedby. */
function MenuTip({ id, anchor, text }: { id: string; anchor: HTMLElement; text: string }) {
  // beside the menu's edge, not the item's, which sits inside the menu's padding; level with the item
  const place = useCallback(
    (w: number, h: number) => {
      const item = anchor.getBoundingClientRect()
      const menu = (anchor.closest('.popover') ?? anchor).getBoundingClientRect()
      return placeAside({ left: menu.left, right: menu.right, top: item.top, bottom: item.bottom }, w, h, window.innerWidth, window.innerHeight)
    },
    [anchor],
  )
  return <Tip id={id} text={text} place={place} />
}

export default Menu
