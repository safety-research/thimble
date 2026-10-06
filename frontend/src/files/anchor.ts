// Scroll anchoring for the reader's body, the same in every browser: the record at the top of the reader keeps its
// place on screen while records above it change height. A record far from the view is laid out at an estimated height
// (files.css content-visibility) until it nears the view, when its real height replaces the estimate; a page of records
// loads above the view; a page loaded below drops records at the far end above. Without anchoring each of these moves
// what the analyst is reading by the difference, and Safari has no scroll anchoring of its own. The browser's own is off
// for the body (files.css .reader-body overflow-anchor), so that two never correct the same change.
//
// The anchor is the first record whose top is inside the body (takeAnchor), with its top in the scrolled content's
// coordinates and the scroll position it was taken at, taken again after each layout the hook sees. The records within
// a body's height and a half of the view are drawn ahead of it (an IntersectionObserver sets data-near), so a record's
// real height replaces its estimate out of sight. That happens in the first layout after the scroll or the marking that
// brought the record near, which may come at the first layout read of the next frame by any script, in the frame's own
// layout (Chrome), or right after the observer's callback within the frame (Safari). So the hook looks at each: at the
// start of each frame while the body scrolls (an animation frame callback), after a layout in which records changed
// height (a ResizeObserver's callback, before the paint), and in the IntersectionObserver's callback. Each time, it moves the scroll position by how far the anchor's top
// moved in the content, so the frame paints with the anchor in place, and takes the anchor again. A scroll since the
// anchor was taken is the analyst's or the reader's own and is kept, unless it jumped more than two heights of the body
// away (a jump, where the old anchor says nothing). A change the reader makes to its records between
// frames (a page loaded above, records dropped above) is held across its commit: `hold` before it, and the layout after
// it puts the anchor back.
import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

export interface Anchor {
  el: HTMLElement
  /** the record's top, px from the top of the scrolled content */
  y: number
  /** the body's scrollTop when it was taken */
  at: number
}

const RECORDS = '.reader-card[data-line]'
/** how far past each edge of the body a record is drawn ahead (files.css [data-near]), as the IntersectionObserver's
 * margin: its real height replaces the estimate there, out of sight, where the anchor makes up for it */
const NEAR_MARGIN = '150% 0px'
/** frames after the last scroll or change in which the hook still looks at the start of each frame */
const IDLE_FRAMES = 30

/** An element's top in the scrolled content of `body`, px. */
export function contentTop(body: HTMLElement, el: HTMLElement): number {
  return el.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop
}

/** The record the analyst reads at the top: the first whose top is inside the body, else (one record covers the whole
 * body) the one across its top; null when the body holds none. By halving, since the records stand in order. A record
 * across the top is not the anchor while another starts below it: drawn for the first time it grows from its top, and
 * what the analyst sees of it is its end, which must stay where it is. */
export function takeAnchor(body: HTMLElement): Anchor | null {
  const cards = body.querySelectorAll<HTMLElement>(RECORDS)
  if (!cards.length) return null
  const box = body.getBoundingClientRect()
  let lo = 0
  let hi = cards.length - 1
  let at = cards.length
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (cards[mid].getBoundingClientRect().top >= box.top - 0.5) {
      at = mid
      hi = mid - 1
    } else lo = mid + 1
  }
  // none starts inside the body, or the first that does starts below it: the one across the top
  if (at > 0 && (at === cards.length || cards[at].getBoundingClientRect().top >= box.bottom)) at--
  if (at >= cards.length) at = cards.length - 1
  const el = cards[at]
  return { el, y: contentTop(body, el), at: body.scrollTop }
}

/** How far the scroll position must move to keep the anchor where it was on screen: how far its record's top moved in
 * the content. Null when the anchor no longer holds: its record left the body; or the scroll position changed since it
 * was taken, by any amount when `strict`, else by more than `near` px (a jump of the reader's own, far from it). */
export function anchorShift(body: HTMLElement, a: Anchor, strict = true, near = Infinity): number | null {
  if (!a.el.isConnected || !body.contains(a.el)) return null
  const moved = Math.abs(body.scrollTop - a.at)
  if (strict ? moved > 0.5 : moved > near) return null
  return contentTop(body, a.el) - a.y
}

/** Keep the record at the top of the body in place while records change height. `deps` change when the records do,
 * so the records drawn anew are observed. `hold()`, called before a change of the records that adds or removes some
 * above the view, keeps the anchor across the change's commit. */
export function useScrollAnchor(bodyRef: RefObject<HTMLElement | null>, deps: readonly unknown[]): { hold: () => void } {
  const anchor = useRef<Anchor | null>(null)
  const held = useRef<Anchor | null>(null)
  const wakeRef = useRef<() => void>(() => {})
  // what moved the anchor since it was taken is put back, unless the scroll jumped more than two body heights from
  // where it was taken; the anchor is taken again
  const correct = useCallback(() => {
    const body = bodyRef.current
    if (!body) return
    const a = anchor.current
    const shift = a ? anchorShift(body, a, false, 2 * body.clientHeight) : null
    if (shift != null && Math.abs(shift) >= 0.5) body.scrollTop += shift
    anchor.current = takeAnchor(body)
  }, [bodyRef])
  // The observer is made as the reader first renders, before the views in it make theirs, so its callback comes first
  // after each layout: a view's own scroll into view after a resize (views/common useTarget) then starts from the
  // place the anchor kept.
  const observer = useRef<ResizeObserver | null>(null)
  if (!observer.current && typeof ResizeObserver !== 'undefined')
    observer.current = new ResizeObserver(() => {
      correct()
      wakeRef.current()
    })
  const hold = useCallback(() => {
    const body = bodyRef.current
    held.current = body ? takeAnchor(body) : null
  }, [bodyRef])
  // a held anchor is put back once the change is in the page, before the paint
  useLayoutEffect(() => {
    const body = bodyRef.current
    const a = held.current
    held.current = null
    if (!body || !a) return
    const shift = anchorShift(body, a, false)
    if (shift != null && Math.abs(shift) >= 0.5) body.scrollTop += shift
    anchor.current = takeAnchor(body)
    wakeRef.current()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  useEffect(() => {
    const body = bodyRef.current
    const ro = observer.current
    if (!body || !ro) return
    anchor.current = takeAnchor(body)
    let frame = 0
    let idle = 0
    let lastTop = body.scrollTop
    // at the start of each frame while the body scrolls, and after each layout in which records changed height
    const tick = () => {
      frame = 0
      correct()
      idle = body.scrollTop === lastTop ? idle + 1 : 0
      lastTop = body.scrollTop
      if (idle < IDLE_FRAMES) frame = requestAnimationFrame(tick)
    }
    const wake = () => {
      idle = 0
      if (!frame) frame = requestAnimationFrame(tick)
    }
    wakeRef.current = wake
    // the body's parts (the view's root grows or shrinks with any record in it) and each record
    for (const c of Array.from(body.children)) {
      ro.observe(c)
      for (const r of Array.from(c.children)) if (r.matches(RECORDS)) ro.observe(r)
    }
    // the records near the view are drawn ahead of it
    const io =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver(
            (entries) => {
              for (const e of entries) {
                if (e.isIntersecting) e.target.setAttribute('data-near', '')
                else e.target.removeAttribute('data-near')
              }
              // Safari calls this inside the frame, after the frame's other callbacks and before its paint: the
              // records drawn now are made up for at once
              correct()
              wake()
            },
            { root: body, rootMargin: NEAR_MARGIN },
          )
    if (io) for (const r of Array.from(body.querySelectorAll(RECORDS))) io.observe(r)
    body.addEventListener('scroll', wake, { passive: true })
    body.addEventListener('wheel', wake, { passive: true })
    wake()
    return () => {
      ro.disconnect()
      io?.disconnect()
      if (frame) cancelAnimationFrame(frame)
      body.removeEventListener('scroll', wake)
      body.removeEventListener('wheel', wake)
      wakeRef.current = () => {}
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bodyRef, correct, ...deps])
  return { hold }
}
