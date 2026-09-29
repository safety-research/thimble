// A view's page in a sandboxed frame, the page half of the bridge (the frame half is backend/app/viewer_bridge.js).
// The page may reach only the view's media route; everything else comes through these messages:
//   open      the place to show (ref, locator, resolved answer, quoted passage to highlight)
//   quoted    whether that passage showed; when it did not, onQuoteMissing
//   fetch     answered with reader.records(index, query)
//   cite      a ⌘-click inside the frame opens the pointer's box on that element
//   navigate  another place, opened the way a chip opens it (lib/teleport)
//   size      the height the page needs, used when the frame sizes to its content (`fit`)
//   anchors   the data-anchor refs the page shows, answered with `labels`: the marks of its records (labels.ts
//             viewMarks, with the filter's keep) and of its units (the view's marks route), the labels that are on,
//             the Files label filter, every label over files and the palette, which the page hears through
//             thimble.onLabels
//   label, labelColour, newLabel
//             the page's label controls, done here as the Labels pane does them (`labelActions`): a label turned on or
//             off, a value given a palette colour, the new-label prompt opened
//   state     what the analyst is looking at (the element they picked, scroll positions, fields), asked for through
//             `handle` before a newer version replaces the page, and sent back as `restore` once that version is ready
// plus ready, error, point and cmd (for the ⌘ pointer). A new ref is sent as a new `open` without reloading the page.
// The page and every call it makes are of the view's `version`, so the page stays as it was loaded while the view
// changes (backend views.VERSIONS_SUBDIR).
// A card of a card type (`card`, backend cardtypes.py) loads the type's page, which gets `init` with what the card
// stored once it is ready and says `settled` once it has drawn it; its fetches go to the type's records route under the
// card's labels, its `open` names the record ref as it is (with `pick` to open it in full), and its height stays within
// the type's range.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import { viewFonts, viewStyle, withFrameStyle } from '../lib/frame'
import { notePress } from '../lib/surfaces'
import { teleport } from '../lib/teleport'
import { useTheme } from '../lib/theme'
import { token } from '../lib/vizTheme'
import { cmdCursors } from '../pointer/cursor'
import type { Concept, LabelRow, ViewOpen } from '../lib/types'
import { PALETTE, pageLabelList, pageLabels, pagePalette, recordRef, viewMarks, withKeeps, type Keep, type LabelFilter, type PageLabelItem, type ViewMark } from './labels'
import { wantLabels, watchPathLabels } from './marks'

const P = 'thimble:'
const FIT_MIN = 80
const FIT_MAX = 1600
const STATE_WAIT_MS = 400 // how long a page has to say what the analyst is looking at

/** What the analyst is looking at in a view's page (backend/app/viewer_bridge.js pageState), put back in a newer version
 * of the page: `ref` is opened there, the rest restored as far as it fits. */
export interface ViewState {
  ref: string | null
  scroll: { path: string; top: number; left: number }[]
  fields: { path: string; value?: string; checked?: boolean }[]
  segs: { path: string; text: string }[]
}

/** What the page's label controls do, as the Labels pane does it. */
export interface ViewLabelActions {
  /** turn a label over files on or off */
  setOn: (id: string, on: boolean) => void
  /** give a label's value a palette colour (labels.ts PALETTE) */
  setColour: (id: string, value: string, colour: number) => void
  /** open the new-label prompt beside the view */
  create?: () => void
}

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
  /** what the page's label controls do; without it they do nothing */
  labelActions?: ViewLabelActions
  onError?: (message: string) => void
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
  /** in a card, the record `targetRef` names is opened in full rather than lit */
  targetPick?: boolean
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

const NO_LABELS: readonly Concept[] = []
const NO_CONCEPTS: ReadonlyMap<string, Concept> = new Map()
const UNIT_BATCH = 500 // unit refs one marks request asks about

/** The labels over the page's records and units: keeps the refs the page reports (`anchors`) and sends `labels`
 * whenever its marks, the labels that are on or the filter change; each message replaces the last. A record's marks
 * come from the label rows read here, a unit's from the view's marks route, asked again when the labels, their runs or
 * the filter change. `reset` forgets the refs. */
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
): { add: (refs: unknown) => void; reset: () => void; ready: () => void } {
  const refs = useRef(new Set<string>())
  const units = useRef(new Set<string>())
  const unitMarks = useRef<Record<string, ViewMark | Keep>>({})
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
        let got: Record<string, ViewMark | Keep> = {}
        if (live.current) {
          try {
            got = (await api.viewMarks(ws, slug, batch, version)) as Record<string, ViewMark | Keep>
          } catch {
            continue // the units keep the marks they had until the next ask
          }
        }
        for (const r of batch) {
          if (got[r]) unitMarks.current[r] = got[r]
          else delete unitMarks.current[r]
        }
        setTick((t) => t + 1)
      }
    },
    [ws, slug, version],
  )
  const add = useCallback(
    (list: unknown) => {
      if (!Array.isArray(list)) return
      let fresh = false
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
        if (refs.current.has(ref) || !recordRef(ref)) continue
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
        const at = recordRef(ref)!
        if (!watching.current.has(at.path))
          watching.current.set(
            at.path,
            watchPathLabels(ws, at.path, (got) => {
              rows.current.set(at.path, got)
              setTick((t) => t + 1)
            }),
          )
        wantLabels(ws, at.path, at.line)
      }
    }
    const rowsOf = { get: (ref: string) => rows.current.get(recordRef(ref)?.path ?? '')?.get(ref) }
    const marks = { ...withKeeps(viewMarks(on, rowsOf, refs.current), filter, rowsOf, refs.current, filterFiles), ...(labelled ? unitMarks.current : {}) }
    const state = pageLabels(on, filter, filterLabel ? new Map([[filterLabel.id, filterLabel]]) : byId, (name) => token(name) || `var(${name})`)
    const text = JSON.stringify([marks, state, all, palette])
    if (text === sent.current) return
    sent.current = text
    send.current({ type: P + 'labels', marks, on: state.on, filter: state.filter, all, palette })
  }, [ws, on, filter, filterFiles, filterLabel, byId, all, palette, labelled, tick])
  return useMemo(() => ({ add, reset, ready }), [add, reset, ready])
}

export function ViewerFrame({ ws, slug, targetRef, path, title, fit, labels = NO_LABELS, filter = null, filterFiles, byId = NO_CONCEPTS, first, labelActions, onError, className, quote, onQuoteMissing, version, restore, handle, card, onSettled, targetPick }: ViewerFrameProps) {
  const ref = useRef<HTMLIFrameElement>(null)
  const [page, setPage] = useState<string | null>(null)
  const [height, setHeight] = useState<number | null>(null)
  const { resolved, key } = useTheme()
  const ready = useRef(false)
  const target = useRef(targetRef)
  target.current = targetRef
  const report = useRef(onError)
  report.current = onError
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
  const pick = useRef(targetPick)
  pick.current = targetPick
  const cardType = card?.type

  const [fonts, setFonts] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    ready.current = false
    ;(cardType ? api.cardTypeFrame(ws, cardType) : api.viewFrame(ws, slug, version))
      .then((doc) => alive && setPage(doc))
      .catch((e: Error) => alive && report.current?.(`the view's page did not load: ${e.message}`))
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
  }, [doc, marks])
  const sendInit = () => {
    const c = drawn.current
    if (c) post({ type: P + 'init', mode: c.mode, data: c.data, args: c.args, width: c.width, card: c.id, key: c.key })
  }
  const sendOpen = async (r: string | undefined) => {
    let open: ViewOpen = path ? { ref: null, path } : { ref: null }
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
    if (target.current === r) post({ type: P + 'open', open, quote: q && q.record === r ? q : undefined })
  }
  // A newer version's page opens where the analyst was, when this version knows that place, else where the ref it was
  // given names; then the rest of what they were looking at is put back.
  const reopen = async (st: ViewState) => {
    const at = st.ref && st.ref !== target.current ? await api.viewOpen(ws, slug, st.ref, version).catch(() => null) : null
    if (at && !at.error) post({ type: P + 'open', open: at })
    else await sendOpen(target.current)
    post({ type: P + 'restore', state: st })
  }

  // a new ref (or a new passage in the same record) for a page that is already up: a new `open`, no reload
  useEffect(() => {
    if (ready.current) void sendOpen(targetRef)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetRef, quote?.text, targetPick])
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
          try {
            const c = drawn.current
            const res = c ? await api.cardTypeRecords(ws, c.type, c.id, d.query) : await api.viewRecords(ws, slug, d.query, version)
            post({ type: P + 'result', id: d.id, data: res.data })
          } catch (err) {
            post({ type: P + 'result', id: d.id, error: (err as Error).message })
          }
          return
        }
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
        case P + 'navigate':
          // the click that asked for it landed in the frame's document, which the shell does not see
          if (typeof d.ref !== 'string' || !d.ref) return
          notePress(frame)
          teleport(d.ref)
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
        case P + 'anchors':
          marks.add(d.refs)
          return
        case P + 'quoted':
          if (d.found === false) missing.current?.()
          return
        case P + 'label':
        case P + 'labelColour': {
          // the page names a label by the id it heard in `all`; anything else is ignored
          const act = actions.current
          const id = typeof d.id === 'string' ? d.id : ''
          if (!act || !known.current.has(id)) return
          notePress(frame)
          if (d.type === P + 'label') act.setOn(id, !!d.on)
          else {
            const at = colours.current.findIndex((c) => c.toLowerCase() === String(d.colour ?? '').toLowerCase())
            if (at >= 0 && typeof d.value === 'string') act.setColour(id, d.value, PALETTE[at])
          }
          return
        }
        case P + 'newLabel':
          notePress(frame)
          actions.current?.create?.()
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
  }, [ws, slug, marks, version])

  if (doc == null) return <div className={'viewer-frame viewer-frame-loading' + (className ? ` ${className}` : '')} />
  return (
    <iframe
      ref={ref}
      className={'viewer-frame' + (className ? ` ${className}` : '')}
      sandbox="allow-scripts"
      srcDoc={doc}
      title={title}
      style={fit && height ? { height } : undefined}
    />
  )
}
