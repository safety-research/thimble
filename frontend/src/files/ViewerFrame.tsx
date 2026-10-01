// A view's page in a sandboxed frame, the page half of the bridge (the frame half is backend/app/viewer_bridge.js).
// The page may reach only the view's media route; everything else comes through these messages:
//   open      the place to show (ref, locator, resolved answer, quoted passage to highlight)
//   quoted    whether that passage showed; when it did not, onQuoteMissing
//   fetch     answered with reader.records(index, query), with no time limit; while it runs the page hears `progress`
//             about once a second (the call's seconds, phase and what the reader reported)
//   cancel    the page dropped a fetch, so its reader's call is cancelled; closing the frame or loading another page in
//             it cancels every fetch still running
//   cite      a ⌘-click inside the frame opens the pointer's box on that element
//   navigate  another place, opened the way a chip opens it (lib/teleport)
//   size      the height the page needs, used when the frame sizes to its content (`fit`)
//   reveal    a box of the page to bring into view: the boxes around the frame scroll to it (revealBox), and the
//             canvas pans to it (bus revealBox)
//   anchors   the data-anchor refs the page shows, answered with `labels`: the marks of its records (labels.ts
//             viewMarks, with the filter's keep) and of its units (the view's marks route), the labels that are on,
//             the Files label filter, every label over files and the palette, which the page hears through
//             thimble.onLabels
//   key       sent once the page is ready: the key the bridge puts on each labelCall
//   labelCall the page's label controls (labelCalls.ts), answered by labelDone: done here as the Labels pane does them
//             (`labelActions`), a mark stored as the analyst's verdict and the label filter set, each only during the
//             analyst's own gesture in the frame; labelRefused says the bridge refused one for want of a gesture
//   hidden    how many anchored refs the bridge hides for the label filter, which with what the reader left out for
//             it (the records answers' `hidden`) is the count the view's head shows (onHidden)
//   labelControls
//             whether the page shows label controls of its own (onLabelControls)
//   state     what the analyst is looking at (the element they picked, scroll positions, fields), asked for through
//             `handle` before a newer version replaces the page, and sent back as `restore` once that version is ready
// plus ready, error, point and cmd (for the ⌘ pointer). A new ref is sent as a new `open` without reloading the page.
// The page and every call it makes are of the view's `version`, so the page stays as it was loaded while the view
// changes (backend views.VERSIONS_SUBDIR).
// A card of a card type (`card`, backend cardtypes.py) loads the type's page, which gets `init` with what the card
// stored once it is ready and says `settled` once it has drawn it; its fetches go to the type's records route under the
// card's labels, its `open` names the record ref as it is (with `pick` to open it in full), and its height stays within
// the type's range. The page's `setQuery` says how the analyst reshaped the card, as a patch of its call's arguments
// (onQuery). Every `open` of a view carries `query`: the card it was opened from with its arguments, or null, which
// drops them; a view's `setQuery` null says the page dropped them itself (onQuery).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import { viewFonts, viewStyle, withFrameStyle } from '../lib/frame'
import { recordOf } from '../lib/refs'
import { notePress } from '../lib/surfaces'
import { teleport } from '../lib/teleport'
import { useTheme } from '../lib/theme'
import { token } from '../lib/vizTheme'
import { cmdCursors } from '../pointer/cursor'
import type { Concept, LabelRow, ViewOpen, ViewQuery } from '../lib/types'
import { callKey, inGesture, NO_GESTURE, runLabelCall, type ViewLabelActions } from './labelCalls'
import { pageLabelList, pageLabels, pagePalette, viewMarks, withKeeps, type Keep, type LabelFilter, type PageLabelItem, type ViewMark } from './labels'
import { labelsArrived, wantLabels, wantRecordLabels, watchPathLabels } from './marks'

const P = 'thimble:'
const FIT_MIN = 80
const FIT_MAX = 1600
const STATE_WAIT_MS = 400 // how long a page has to say what the analyst is looking at
const PROGRESS_MS = 1000 // how often a running fetch's progress is asked for

/** What the analyst is looking at in a view's page (backend/app/viewer_bridge.js pageState), put back in a newer version
 * of the page: `ref` is opened there, the rest restored as far as it fits. */
export interface ViewState {
  ref: string | null
  scroll: { path: string; top: number; left: number }[]
  fields: { path: string; value?: string; checked?: boolean }[]
  segs: { path: string; text: string }[]
}

export type { ViewLabelActions } from './labelCalls'

/** What a frame's owner can ask of it. */
export interface ViewerFrameHandle {
  /** what the analyst is looking at, or null when the page does not answer */
  state: () => Promise<ViewState | null>
}

export interface ViewerFrameProps {
  ws: string
  slug: string
  /** what the view shows: a file ref it accepts or one of its view:<slug>/<key> refs; none for the view's own start */
  targetRef?: string
  /** the file the view was opened on, sent as `open`'s path when no ref names a place in it */
  path?: string
  /** the analyst opened the view on `path` (Open in), sent as `open`'s picked */
  pathPicked?: boolean
  title: string
  /** the frame is as tall as its page (a card) rather than filling its box (Files) */
  fit?: boolean
  /** the labels that are on, drawn over the records the page shows */
  labels?: readonly Concept[]
  /** the Files label filter, which the view keeps its records by, with every label by id to name it */
  filter?: LabelFilter | null
  /** the files the filter's label left a value on (its presence); the filter leaves the records of other files alone */
  filterFiles?: Readonly<Record<string, unknown>>
  byId?: ReadonlyMap<string, Concept>
  /** the labels that mark the view's files, listed first to the page */
  first?: ReadonlySet<string>
  /** what the page's label controls do; without it they can only mark records and set the filter */
  labelActions?: ViewLabelActions
  /** with a label filter on, how many anchored refs the page and its reader leave out for it; null without a filter or
   * until the page has said */
  onHidden?: (n: number | null) => void
  /** whether the page shows label controls of its own */
  onLabelControls?: (on: boolean) => void
  onError?: (message: string) => void
  /** the page itself did not load, in place of onError */
  onNoPage?: (message: string) => void
  className?: string
  /** a passage inside the record `targetRef` names, for a view that shows the record but not the span */
  quote?: ViewQuote
  /** the page did not show `quote` */
  onQuoteMissing?: () => void
  /** the view's version the page is loaded at; none for its current files */
  version?: string
  /** what the analyst was looking at in the version before, put back once this one is ready */
  restore?: ViewState | null
  /** filled with what the frame's owner can ask of it */
  handle?: RefObject<ViewerFrameHandle | null>
  /** a card of a card type, in place of the view `slug` names (slug is then the type) */
  card?: CardFrame
  /** a card's page has drawn what it was given */
  onSettled?: () => void
  /** a card's page asks for its call's arguments to change (the patch), or for none (null); a view's page dropped the
   * card's arguments it was opened with (null) */
  onQuery?: (patch: Record<string, unknown> | null) => void
  /** in a card, the record `targetRef` names is opened in full rather than lit */
  targetPick?: boolean
  /** a view opened from a card: the card and its arguments, which the page draws its records by */
  query?: ViewQuery | null
}

/** A card of a card type drawn in the frame: the card's id, its type, how it is drawn (on the canvas, full size or for
 * the card check's picture), what its code stored, its width and the type's height range. `key` names what it stored:
 * the page is sent `init` again only when the key, the mode or the width changes. */
export interface CardFrame {
  id: string
  type: string
  mode: 'card' | 'full' | 'render'
  data: unknown
  args: Record<string, unknown>
  width: number
  size: [number, number]
  key: string
}

/** A quoted passage: the record ref it sits in and its text. */
export interface ViewQuote {
  record: string
  text: string
}

/** A rect the frame reports, in the page's coordinates. */
export function toPage(frame: HTMLIFrameElement, r: { left: number; top: number; width: number; height: number }): DOMRect {
  const f = frame.getBoundingClientRect()
  return new DOMRect(f.left + r.left, f.top + r.top, r.width, r.height)
}

/** Scroll each scrolling box around `from`, innermost first, so the page box `r` sits in view, a third of the way down
 * when it has to move (a frame's `reveal`). */
export function revealBox(from: HTMLElement, r: DOMRect): void {
  let top = r.top
  for (let a = from.parentElement; a; a = a.parentElement) {
    if (!/(auto|scroll)/.test(getComputedStyle(a).overflowY) || a.scrollHeight <= a.clientHeight) continue
    const box = a.getBoundingClientRect()
    if (top >= box.top && top + r.height <= box.bottom) continue
    const before = a.scrollTop
    a.scrollTop += top - box.top - Math.max(0, (a.clientHeight - r.height) / 3)
    top -= a.scrollTop - before
  }
}

/** Whether the filter's keep of a record ref is known: its file is one the filter's label never ran over, or its rows
 * have arrived. */
function keepKnown(ws: string, ref: string, filterFiles: Readonly<Record<string, unknown>> | undefined): boolean {
  const at = recordOf(ref)
  return !at || (!!filterFiles && !(at.path in filterFiles)) || labelsArrived(ws, at.path, ref)
}

function everyOne(items: Iterable<string>, ok: (x: string) => boolean): boolean {
  for (const x of items) if (!ok(x)) return false
  return true
}

const NO_LABELS: readonly Concept[] = []
const NO_CONCEPTS: ReadonlyMap<string, Concept> = new Map()
const UNIT_BATCH = 500 // unit refs one marks request asks about

/** The labels over the page's records and units: keeps the refs the page reports (`anchors`) and sends `labels`
 * whenever its marks, the labels that are on or the filter change; each message replaces the last. A record's marks
 * come from the label rows read here, a unit's from the view's marks route, asked again when the labels, their runs or
 * the filter change. With a filter on, `answered` is the last anchors' seq once every ref reported has its rows or its
 * unit's marks, else -1. `reset` forgets the refs. */
function useViewLabels(
  ws: string,
  slug: string,
  version: string | undefined,
  on: readonly Concept[],
  filter: LabelFilter | null,
  filterFiles: Readonly<Record<string, unknown>> | undefined,
  byId: ReadonlyMap<string, Concept>,
  all: PageLabelItem[],
  palette: string[],
  post: (msg: unknown) => void,
  withUnits: boolean,
): { add: (refs: unknown, seq?: unknown) => void; reset: () => void; ready: () => void } {
  const refs = useRef(new Set<string>())
  const units = useRef(new Set<string>())
  const unitMarks = useRef<Record<string, ViewMark | Keep>>({})
  /** the units whose marks have arrived under the current filter, and that filter's turn */
  const unitsAnswered = useRef(new Set<string>())
  const filterTurn = useRef(0)
  /** the seq of the last anchors the page sent */
  const seqNow = useRef(0)
  /** the refs whose block of rows has been asked for */
  const asked = useRef(new Set<string>())
  const rows = useRef(new Map<string, Map<string, Map<string, LabelRow>>>())
  const watching = useRef(new Map<string, () => void>())
  const sent = useRef('{}')
  const [tick, setTick] = useState(0)
  const send = useRef(post)
  send.current = post

  useEffect(
    () => () => {
      for (const off of watching.current.values()) off()
      watching.current.clear()
      rows.current.clear()
      asked.current.clear()
    },
    [ws],
  )
  const unitPrefix = withUnits ? `view:${slug}/` : '\u0000'
  const labelled = on.length > 0 || !!filter
  const live = useRef(labelled)
  live.current = labelled
  /** the marks of these unit refs, asked of the server a batch at a time */
  const askUnits = useCallback(
    async (list: string[]) => {
      for (let i = 0; i < list.length; i += UNIT_BATCH) {
        const batch = list.slice(i, i + UNIT_BATCH)
        const turn = filterTurn.current
        let got: Record<string, ViewMark | Keep> = {}
        if (live.current) {
          try {
            got = (await api.viewMarks(ws, slug, batch, version)) as Record<string, ViewMark | Keep>
          } catch {
            continue // the units keep the marks they had until the next ask
          }
        }
        const answered = live.current && turn === filterTurn.current
        for (const r of batch) {
          if (got[r]) unitMarks.current[r] = got[r]
          else delete unitMarks.current[r]
          if (answered) unitsAnswered.current.add(r)
        }
        setTick((t) => t + 1)
      }
    },
    [ws, slug, version],
  )
  const add = useCallback(
    (list: unknown, seq?: unknown) => {
      if (!Array.isArray(list)) return
      let fresh = typeof seq === 'number' && seq !== seqNow.current
      if (typeof seq === 'number') seqNow.current = seq
      const newUnits: string[] = []
      for (const ref of list) {
        if (typeof ref !== 'string') continue
        if (ref.startsWith(unitPrefix) && ref.length > unitPrefix.length) {
          if (!units.current.has(ref)) {
            units.current.add(ref)
            newUnits.push(ref)
          }
          continue
        }
        if (refs.current.has(ref) || !recordOf(ref)) continue
        refs.current.add(ref)
        fresh = true
      }
      if (fresh) setTick((t) => t + 1)
      if (newUnits.length && live.current) void askUnits(newUnits)
    },
    [askUnits, unitPrefix],
  )
  const reset = useCallback(() => {
    refs.current.clear()
    units.current.clear()
    unitMarks.current = {}
    unitsAnswered.current.clear()
    seqNow.current = 0
    sent.current = '{}'
  }, [])
  // a page that says ready hears the labels at once, even one that anchors nothing
  const ready = useCallback(() => {
    sent.current = ''
    setTick((t) => t + 1)
  }, [])
  // the units are marked afresh when the labels that are on, their values or the filter change, and when a label's
  // rows change (a run, an edit)
  const labelKey = JSON.stringify([on.map((k) => [k.id, (k.classes ?? []).map((c) => c.highlight)]), filter])
  const filterKey = JSON.stringify(filter)
  // the units' marks from before a new filter do not answer for it
  useEffect(() => {
    filterTurn.current += 1
    unitsAnswered.current.clear()
  }, [filterKey])
  useEffect(() => {
    if (units.current.size) void askUnits([...units.current])
  }, [labelKey, askUnits])
  useEffect(() => {
    let timer: number | null = null
    const off = bus.on('concepts', () => {
      if (timer != null) window.clearTimeout(timer)
      timer = window.setTimeout(() => units.current.size && void askUnits([...units.current]), 300)
    })
    return () => {
      off()
      if (timer != null) window.clearTimeout(timer)
    }
  }, [askUnits])
  const filterLabel = filter ? byId.get(filter.concept) : undefined
  useEffect(() => {
    if (on.length || filter) {
      for (const ref of refs.current) {
        if (asked.current.has(ref)) continue
        asked.current.add(ref)
        const at = recordOf(ref)!
        if (!watching.current.has(at.path))
          watching.current.set(
            at.path,
            watchPathLabels(ws, at.path, (got) => {
              rows.current.set(at.path, got)
              setTick((t) => t + 1)
            }),
          )
        if (at.line != null) wantLabels(ws, at.path, at.line)
        else wantRecordLabels(ws, at.path, ref)
      }
    }
    const rowsOf = { get: (ref: string) => rows.current.get(recordOf(ref)?.path ?? '')?.get(ref) }
    const marks = { ...withKeeps(viewMarks(on, rowsOf, refs.current), filter, rowsOf, refs.current, filterFiles), ...(labelled ? unitMarks.current : {}) }
    const state = pageLabels(on, filter, filterLabel ? new Map([[filterLabel.id, filterLabel]]) : byId, (name) => token(name) || `var(${name})`)
    const answered = !filter || (everyOne(refs.current, (ref) => keepKnown(ws, ref, filterFiles)) && everyOne(units.current, (u) => unitsAnswered.current.has(u))) ? seqNow.current : -1
    const text = JSON.stringify([marks, state, all, palette, answered])
    if (text === sent.current) return
    sent.current = text
    send.current({ type: P + 'labels', marks, on: state.on, filter: state.filter, all, palette, answered })
  }, [ws, on, filter, filterFiles, filterLabel, byId, all, palette, labelled, tick])
  return useMemo(() => ({ add, reset, ready }), [add, reset, ready])
}

export function ViewerFrame({ ws, slug, targetRef, path, pathPicked, title, fit, labels = NO_LABELS, filter = null, filterFiles, byId = NO_CONCEPTS, first, labelActions, onHidden, onLabelControls, onError, onNoPage, className, quote, onQuoteMissing, version, restore, handle, card, onSettled, onQuery, targetPick, query }: ViewerFrameProps) {
  const ref = useRef<HTMLIFrameElement>(null)
  const [page, setPage] = useState<string | null>(null)
  const [height, setHeight] = useState<number | null>(null)
  const { resolved, key } = useTheme()
  const ready = useRef(false)
  const target = useRef(targetRef)
  target.current = targetRef
  const report = useRef(onError)
  report.current = onError
  const noPage = useRef(onNoPage)
  noPage.current = onNoPage
  const quoted = useRef(quote)
  quoted.current = quote
  const missing = useRef(onQuoteMissing)
  missing.current = onQuoteMissing
  const restoring = useRef(restore ?? null)
  const asked = useRef(new Map<number, (s: ViewState | null) => void>())
  const seq = useRef(0)
  const drawn = useRef(card)
  drawn.current = card
  const settledFn = useRef(onSettled)
  settledFn.current = onSettled
  const queryFn = useRef(onQuery)
  queryFn.current = onQuery
  const pick = useRef(targetPick)
  pick.current = targetPick
  const viewQuery = useRef(query)
  viewQuery.current = query
  const queryKey = query ? JSON.stringify(query) : ''
  const cardType = card?.type

  // the page's fetches still running, by the page's id: what drops the request, the call's name, the progress timer.
  // A call's name is unique for the frame's life, since a new page in the frame counts its fetches from 1 again.
  const calls = useRef(new Map<number, { ctrl: AbortController; call: string; view: boolean; timer: number | null }>())
  const frameId = useMemo(() => Math.random().toString(36).slice(2, 10), [])
  const callSeq = useRef(0)
  const stopCall = useCallback(
    (id: number) => {
      const f = calls.current.get(id)
      if (!f) return
      calls.current.delete(id)
      if (f.timer != null) window.clearInterval(f.timer)
      f.ctrl.abort()
      if (f.view) void api.viewCancel(ws, slug, f.call).catch(() => {})
    },
    [ws, slug],
  )
  const stopCalls = useCallback(() => {
    for (const id of [...calls.current.keys()]) stopCall(id)
  }, [stopCall])
  useEffect(() => stopCalls, [stopCalls])

  const [fonts, setFonts] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    ready.current = false
    ;(cardType ? api.cardTypeFrame(ws, cardType) : api.viewFrame(ws, slug, version))
      .then((doc) => alive && setPage(doc))
      .catch((e: Error) => alive && (noPage.current ? noPage.current(e.message) : report.current?.(`the view's page did not load: ${e.message}`)))
    void viewFonts().then((f) => alive && setFonts(f))
    return () => {
      alive = false
    }
  }, [ws, slug, version, cardType])
  // the theme's tokens are read when the page is built, so a theme change reloads the page with the new colours; the
  // page waits for the app's faces so it is drawn once, in them
  const doc = useMemo(() => (page == null || fonts == null ? null : withFrameStyle(page, viewStyle(resolved) + fonts)), [page, fonts, resolved, key]) // key: the tokens are read again when the paper or the accent changes
  const post = (msg: unknown) => ref.current?.contentWindow?.postMessage(msg, '*')
  const resolveToken = (name: string) => token(name) || `var(${name})`
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const all = useMemo(() => pageLabelList(byId.values(), resolveToken, first), [byId, first, resolved, key])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const palette = useMemo(() => pagePalette(resolveToken), [resolved, key])
  const marks = useViewLabels(ws, slug, version, labels, filter, filterFiles, byId, all, palette, post, !card)
  const actions = useRef(labelActions)
  actions.current = labelActions
  const known = useRef(byId)
  known.current = byId
  const colours = useRef(palette)
  colours.current = palette
  const pageKey = useRef('')
  const hiddenFn = useRef(onHidden)
  hiddenFn.current = onHidden
  const controlsFn = useRef(onLabelControls)
  controlsFn.current = onLabelControls
  const filtering = useRef(!!filter)
  filtering.current = !!filter
  // what the bridge hid in the page (null until it said) and what the reader left out (null when the server could not
  // count it exactly), for the current filter
  const hidden = useRef<{ page: number | null; reader: number | null }>({ page: null, reader: 0 })
  const tellHidden = () => {
    const h = hidden.current
    hiddenFn.current?.(filtering.current && h.page != null && h.reader != null ? h.page + h.reader : null)
  }
  const filterKey = filter ? `${filter.concept}\n${filter.value}` : ''
  // what the page shows, stepped with each new page and each file shown, which its records calls carry (note_left_out)
  const turn = useRef(0)
  const filterNow = useRef(filterKey)
  filterNow.current = filterKey
  useEffect(() => {
    hidden.current.reader = 0
    tellHidden()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey])
  useEffect(() => {
    if (!handle) return
    handle.current = {
      state: () =>
        new Promise<ViewState | null>((resolve) => {
          if (!ready.current) return resolve(null)
          const id = ++seq.current
          const timer = window.setTimeout(() => (asked.current.delete(id), resolve(null)), STATE_WAIT_MS)
          asked.current.set(id, (st) => (window.clearTimeout(timer), resolve(st)))
          post({ type: P + 'state', id })
        }),
    }
    return () => {
      handle.current = null
    }
  })
  // a new document is a new page, which says ready again and reports its anchors afresh; set before any message of the
  // new page can be handled
  useLayoutEffect(() => {
    ready.current = false
    marks.reset()
    stopCalls()
    pageKey.current = callKey()
    hidden.current = { page: null, reader: 0 }
    turn.current += 1
  }, [doc, marks, stopCalls])
  const sendInit = () => {
    const c = drawn.current
    if (c) post({ type: P + 'init', mode: c.mode, data: c.data, args: c.args, width: c.width, card: c.id, key: c.key })
  }
  const sendOpen = async (r: string | undefined) => {
    let open: ViewOpen = path ? { ref: null, path, ...(pathPicked ? { picked: true } : {}) } : { ref: null }
    if (drawn.current) open = r ? ({ ref: r, target: { ref: r, pick: !!pick.current } } as ViewOpen) : { ref: null }
    else if (r) {
      try {
        open = await api.viewOpen(ws, slug, r, version)
      } catch (e) {
        open = { ref: r, error: (e as Error).message }
      }
      if (open.error) report.current?.(`${r}: ${open.error}`)
    }
    const q = quoted.current
    const withQuery = drawn.current ? open : { ...open, query: viewQuery.current ?? null }
    if (target.current === r) post({ type: P + 'open', open: withQuery, quote: q && q.record === r ? q : undefined })
  }
  // A newer version's page opens where the analyst was, when this version knows that place, else where the ref it was
  // given names; then the rest of what they were looking at is put back.
  const reopen = async (st: ViewState) => {
    const at = st.ref && st.ref !== target.current ? await api.viewOpen(ws, slug, st.ref, version).catch(() => null) : null
    if (at && !at.error) post({ type: P + 'open', open: { ...at, query: viewQuery.current ?? null } })
    else await sendOpen(target.current)
    post({ type: P + 'restore', state: st })
  }

  // another file shown is a new turn of what the page shows, whose records answers count what the filter hides afresh
  const shownPath = useRef(path)
  useEffect(() => {
    if (shownPath.current === path) return
    shownPath.current = path
    turn.current += 1
  }, [path])
  // a new ref (or a new passage in the same record) for a page that is already up: a new `open`, no reload
  useEffect(() => {
    if (ready.current) void sendOpen(targetRef)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetRef, quote?.text, targetPick, queryKey, path, pathPicked])
  // a card run again, or drawn in another mode or width: a new `init`, no reload
  useEffect(() => {
    if (ready.current) sendInit()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card?.key, card?.mode, card?.width])

  useEffect(() => {
    const onMessage = async (e: MessageEvent) => {
      const frame = ref.current
      if (!frame || e.source !== frame.contentWindow) return
      const d = (e.data ?? {}) as Record<string, any>
      switch (d.type) {
        case P + 'ready': {
          ready.current = true
          post({ type: P + 'key', key: pageKey.current })
          marks.ready()
          sendInit()
          const st = restoring.current
          restoring.current = null
          if (st) void reopen(st)
          else void sendOpen(target.current)
          // the ⌘ arrow up front, so a ⌘ pressed while the frame has the focus shows it too
          post({ type: P + 'cmd', on: document.body.hasAttribute('data-cmd'), cursor: cmdCursors(token('--accent')).arrow })
          return
        }
        case P + 'state': {
          const answer = asked.current.get(Number(d.id))
          asked.current.delete(Number(d.id))
          answer?.(d.state && typeof d.state === 'object' ? (d.state as ViewState) : null)
          return
        }
        case P + 'fetch': {
          const id = Number(d.id)
          const c = drawn.current
          const f = { ctrl: new AbortController(), call: `${frameId}-${++callSeq.current}`, view: !c, timer: null as number | null }
          const askedUnder = filterNow.current
          const askedTurn = turn.current
          calls.current.set(id, f)
          if (!c)
            f.timer = window.setInterval(() => {
              void api
                .viewCall(ws, slug, f.call)
                .then((p) => p.running && calls.current.get(id) === f && post({ type: P + 'progress', id, ...p }))
                .catch(() => {})
            }, PROGRESS_MS)
          try {
            const key = typeof d.key === 'string' ? d.key : undefined
            const res = c ? await api.cardTypeRecords(ws, c.type, c.id, d.query) : await api.viewRecords(ws, slug, d.query, version, { call: f.call, signal: f.ctrl.signal, key, frame: frameId, turn: askedTurn })
            if (calls.current.get(id) === f) post({ type: P + 'result', id: d.id, data: res.data })
            const left = 'hidden' in res ? res.hidden : undefined
            if (!c && left !== undefined && askedUnder === filterNow.current && askedTurn === turn.current && left !== hidden.current.reader) {
              hidden.current.reader = typeof left === 'number' ? left : null
              tellHidden()
            }
          } catch (err) {
            const message = (err as Error).message
            if (calls.current.get(id) === f) post({ type: P + 'result', id: d.id, error: message, cancelled: message.startsWith('409 ') })
          } finally {
            if (calls.current.get(id) === f) {
              calls.current.delete(id)
              if (f.timer != null) window.clearInterval(f.timer)
            }
          }
          return
        }
        case P + 'cancel':
          stopCall(Number(d.id))
          return
        case P + 'cite': {
          if (typeof d.ref !== 'string' || !d.ref) return
          const rect = d.rect ? toPage(frame, d.rect) : frame.getBoundingClientRect()
          const payload = { anchor: d.ref, text: String(d.text ?? ''), element: String(d.element ?? ''), rect, frame, view: slug }
          bus.emit('pointAt', payload)
          return
        }
        case P + 'point':
          bus.emit('pointHover', { rect: d.rect ? toPage(frame, d.rect) : null })
          return
        case P + 'reveal':
          if (!d.rect) return
          revealBox(frame, toPage(frame, d.rect))
          bus.emit('revealBox', { rect: toPage(frame, d.rect), frame })
          return
        case P + 'navigate':
          // the click that asked for it landed in the frame's document, which the shell does not see
          if (typeof d.ref !== 'string' || !d.ref) return
          notePress(frame)
          teleport(d.ref, { browser: d.browser === true })
          return
        case P + 'error':
          report.current?.(String(d.message ?? 'the view failed'))
          return
        case P + 'size': {
          const [lo, hi] = drawn.current?.size ?? [FIT_MIN, FIT_MAX]
          if (typeof d.height === 'number' && Number.isFinite(d.height)) setHeight(Math.min(hi, Math.max(lo, Math.ceil(d.height))))
          return
        }
        case P + 'settled':
          settledFn.current?.()
          return
        case P + 'setQuery':
          queryFn.current?.(d.patch && typeof d.patch === 'object' && Object.keys(d.patch).length ? (d.patch as Record<string, unknown>) : null)
          return
        case P + 'anchors':
          marks.add(d.refs, d.seq)
          return
        case P + 'quoted':
          if (d.found === false) missing.current?.()
          return
        case P + 'labelCall': {
          const done = (error?: string) => post({ type: P + 'labelDone', id: d.id, ...(error ? { error } : {}) })
          if (typeof d.key !== 'string' || !pageKey.current || d.key !== pageKey.current) return done('this label call did not come through thimble')
          if (!inGesture(frame)) return done(NO_GESTURE)
          notePress(frame)
          runLabelCall(String(d.op), d.args, { ws, byId: known.current, palette: colours.current, actions: actions.current }).then(
            () => done(),
            (err: Error) => done(err.message || String(err)),
          )
          return
        }
        case P + 'hidden':
          hidden.current.page = typeof d.n === 'number' && Number.isFinite(d.n) ? d.n : null
          tellHidden()
          return
        case P + 'labelControls':
          controlsFn.current?.(!!d.on)
          return
      }
    }
    window.addEventListener('message', onMessage)
    const offCmd = bus.on('cmdHeld', ({ on, cursor }) => post({ type: P + 'cmd', on, cursor }))
    return () => {
      window.removeEventListener('message', onMessage)
      offCmd()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, slug, marks, version, frameId, stopCall])

  if (doc == null) return <div className={'viewer-frame viewer-frame-loading' + (className ? ` ${className}` : '')} />
  return (
    <iframe
      ref={ref}
      className={'viewer-frame' + (className ? ` ${className}` : '')}
      sandbox="allow-scripts"
      allow="fullscreen"
      allowFullScreen
      srcDoc={doc}
      title={title}
      style={fit && height ? { height } : undefined}
    />
  )
}
