// A sidebar beside a pane's main column docks in the row only while the row fits both the sidebar and the column at
// its readable minimum (--read-min on its ReadProbe, about 60ch of the column's font plus gutters). In a narrower row
// the sidebar overlays the column's left edge or folds to its toggle (useFoldingSide). A docked sidebar is dragged no
// wider than `room`, so a drag never undocks it.
import { useCallback, useEffect, useLayoutEffect, useState, type Ref } from 'react'

/** An empty line as wide as the column's readable minimum (--read-min), measured and never seen. */
export function ReadProbe({ probe }: { probe: Ref<HTMLSpanElement> }) {
  return (
    <span className="read-probe" aria-hidden="true">
      <span ref={probe} />
    </span>
  )
}

export interface Dock {
  /** the row holds the sidebar at its width beside the column at its readable minimum */
  docks: boolean
  /** the widest the sidebar can be while it docks: the row's width less the column's minimum */
  room: number
  /** the refs of the row that holds the sidebar and the column, and of the column's ReadProbe */
  row: (el: HTMLElement | null) => void
  probe: (el: HTMLElement | null) => void
}

/** Whether a sidebar `sideWidth` wide docks beside the column, measured as the row resizes; a row that measures 0
 * (its tab hidden) keeps the last answer. */
export function useDock(sideWidth: number): Dock {
  const [row, setRow] = useState<HTMLElement | null>(null)
  const [probe, setProbe] = useState<HTMLElement | null>(null)
  const [room, setRoom] = useState(Infinity)
  useLayoutEffect(() => {
    if (!row || !probe) return
    const measure = () => {
      const w = row.clientWidth
      if (w > 0) setRoom(w - probe.getBoundingClientRect().width)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(row)
    // the probe's width changes when its font loads
    ro.observe(probe)
    return () => ro.disconnect()
  }, [row, probe])
  return { docks: sideWidth <= room, room, row: setRow, probe: setProbe }
}

export interface FoldingSide {
  /** the sidebar shows */
  shown: boolean
  /** it shows over the column's left edge rather than beside it */
  over: boolean
  show: () => void
  hide: () => void
}

/** A sidebar that folds to its toggle when it cannot dock. While it docks, `open` (the analyst's kept choice) says
 * whether it shows; in a row too narrow it starts folded and its toggle opens it over the column without changing
 * `open`. */
export function useFoldingSide(docks: boolean, open: boolean, setOpen: (next: boolean) => void): FoldingSide {
  const [over, setOver] = useState(false)
  useEffect(() => {
    if (docks) setOver(false)
  }, [docks])
  const show = useCallback(() => (docks ? setOpen(true) : setOver(true)), [docks, setOpen])
  const hide = useCallback(() => (docks ? setOpen(false) : setOver(false)), [docks, setOpen])
  return docks ? { shown: open, over: false, show, hide } : { shown: over, over, show, hide }
}
