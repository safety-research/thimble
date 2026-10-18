// Where the product tour runs: always in thimble's read-only demo workspace, never over the analyst's own files. The
// page the tour starts on (shell/TourHost) opens that workspace in a frame over the whole window, under a banner that
// says it is the tour and example data and has Exit tour (shell/TourFrame); the page under the frame stays exactly as
// it was, and its browser storage for the demo workspace is put back when the frame closes. The page in the frame
// (`?ws=<demo>&tour=frame`) runs the tour from its first step and tells the page around it when the tour started and
// when it ended, by a message of this origin only.
import type { WorkspaceRow } from './types'
import { storageKey } from './workspace'

/** The address parameter that marks the page in the tour's frame, and its value. */
export const TOUR_PARAM = 'tour'
export const TOUR_FRAME = 'frame'
/** The example workspace whose files the tour's own examples come from (plugin/viewers/timeline), when no demo dataset
 * is installed. */
export const TOUR_EXAMPLE = 'example-timeline'

export type TourEvent = 'started' | 'end' | 'fail'
const EVENTS: readonly TourEvent[] = ['started', 'end', 'fail']
const SOURCE = 'thimble-tour'

/** Whether this page is the tour's frame: its address says so and it has a page around it. */
export function inTourFrame(): boolean {
  if (typeof window === 'undefined' || window.parent === window) return false
  return new URLSearchParams(window.location.search).get(TOUR_PARAM) === TOUR_FRAME
}

/** The workspace the tour runs in: this one when it is a demo page (`demoHere`), else an installed demo dataset (one
 * whose orientation ran in advance first), else a worked example (the tour's own, example-timeline, first); null when
 * none is installed, and the frame sets up example-timeline (shell/TourFrame, backend tour.py). Pure. */
export function tourWorkspace(rows: readonly Pick<WorkspaceRow, 'name' | 'kind' | 'ready'>[], here: string | null, demoHere: boolean): string | null {
  if (demoHere && here) return here
  const demos = rows.filter((r) => r.kind === 'demo')
  const examples = rows.filter((r) => r.kind === 'example')
  return (demos.find((r) => r.ready) ?? demos[0] ?? examples.find((r) => r.name === TOUR_EXAMPLE) ?? examples[0])?.name ?? null
}

/** The frame's address: the page at `pathname` on workspace `ws`, marked as the tour's frame. Pure. */
export function tourFrameHref(ws: string, pathname: string): string {
  return `${pathname}?${new URLSearchParams({ ws, [TOUR_PARAM]: TOUR_FRAME }).toString()}`
}

/** The tour event a message carries, when it comes from `from` (the frame's window) on this origin; else null. */
export function tourEventOf(e: Pick<MessageEvent, 'data' | 'origin' | 'source'>, from: Window | null, origin: string): TourEvent | null {
  if (!from || e.source !== from || e.origin !== origin) return null
  const d = e.data as { source?: unknown; event?: unknown } | null
  return d && typeof d === 'object' && d.source === SOURCE && EVENTS.includes(d.event as TourEvent) ? (d.event as TourEvent) : null
}

/** Send a tour event to `to` (the page around the frame), on this origin only. */
export function sendTourEvent(to: Window | null | undefined, event: TourEvent): void {
  try {
    to?.postMessage({ source: SOURCE, event }, window.location.origin)
  } catch {
    /* a closed frame takes nothing */
  }
}

/** What browser storage holds for workspace `ws` now, in localStorage and this tab's sessionStorage, with the function
 * that puts it back: keys added since are removed and keys changed since get their old values. The tour's frame changes
 * the demo workspace's layout as it shows its surfaces; this undoes that once the frame is gone. */
export function keepWorkspaceStorage(ws: string): () => void {
  const prefix = storageKey(ws, '')
  const stores: { store: Storage; items: Map<string, string> }[] = []
  for (const get of [() => window.localStorage, () => window.sessionStorage]) {
    try {
      const store = get()
      const items = new Map<string, string>()
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i)
        const v = k != null && k.startsWith(prefix) ? store.getItem(k) : null
        if (k != null && v != null) items.set(k, v)
      }
      stores.push({ store, items })
    } catch {
      /* storage is a convenience */
    }
  }
  return () => {
    for (const { store, items } of stores) {
      try {
        const now: string[] = []
        for (let i = 0; i < store.length; i++) {
          const k = store.key(i)
          if (k != null && k.startsWith(prefix)) now.push(k)
        }
        for (const k of now) if (!items.has(k)) store.removeItem(k)
        for (const [k, v] of items) if (store.getItem(k) !== v) store.setItem(k, v)
      } catch {
        /* storage is a convenience */
      }
    }
  }
}
