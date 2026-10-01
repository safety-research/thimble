// The canvas: an infinite board of frames and cards on a dot grid. The layout is layout.ts's; this file handles what
// the analyst does to it (drag, resize, marquee select, group, delete, rename, pan and zoom, teleports to a ref) and
// writes every change through the notebook routes before re-reading. With no view kept it opens on the orientation's
// deck; a switch to the tab while it has its dot lands by landing.ts. Every card carries `data-anchor`, so ⌘-click
// reaches it.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FocusEvent as ReactFocusEvent, type MouseEvent as ReactMouseEvent, type UIEvent as ReactUIEvent } from 'react'
import { ChipContext } from '../chat/markdown'
import { readSeen } from '../chat/seen'
import { Chip } from '../components/Chip'
import { FilterChip } from '../components/FilterChip'
import { Icon } from '../components/Icon'
import { Spinner } from '../components/Spinner'
import { TipButton } from '../components/Tooltip'
import { api, canvasApi, isNotFound } from '../lib/api'
import { bus } from '../lib/bus'
import { isReplay } from '../lib/events'
import { CHECK_WORDS, checkState, type CheckFilterState } from '../lib/cardCheck'
import { pointKeyHeld } from '../lib/platform'
import { takesSideways } from '../lib/scrolls'
import { registerCells } from '../lib/cellName'
import { parseRef } from '../lib/refs'
import { revealCell, revealLines } from '../lib/tableCell'
import { track } from '../lib/telemetry'
import type { CanvasResponse, Cell, ChatMeta, Filters, Pos } from '../lib/types'
import { readStorage, storageKey, writeStorage } from '../lib/workspace'
import { anchorElement, capturePng, describeElement } from '../pointer/capture'
import { NO_FILTER, activeParts, bothKeep, cardParts, keepShown, keptBy, readFilter, searchText, type CardFilter, type FilterCard, type FilterPart } from './cardFilter'
import { CellCard, type CardAction, type CardField, type Edge } from './Cell'
import { conceptName, useConcepts } from './concepts'
import { CanvasContext, type CanvasCtx } from './context'
import { Controls, type CanvasLabel } from './Controls'
import { labelValues } from './details'
import { DetailPanel, LabelPanel, type OutputCite } from './DetailPanel'
import { Focus } from './Focus'
import { addSeen, canvasLanding } from './landing'
import {
  DEFAULT_VIEW,
  DOUBLE_MS,
  GAP,
  HEAD,
  PAD,
  activeFrame,
  analystGroup,
  boardOf,
  cardCount,
  cardsIn,
  cellThread,
  centerOn,
  clampHeight,
  clampScale,
  clampWidth,
  extentOf,
  filterSet,
  firstCardOf,
  fitView,
  frameAt,
  framesAbove,
  insertionAt,
  isWithin,
  kidsOf,
  kindOf,
  layoutBoard,
  minimapOf,
  moveLocal,
  overlaps,
  nextGroupTitle,
  offView,
  openOn,
  openingFrame,
  patchCellLocal,
  patchGroupLocal,
  pillAt,
  readable,
  removeLocal,
  scopeForUnit,
  stepZoom,
  toPlane,
  unreadAnchors,
  wheelView,
  zoomTo,
  type Board,
  type Insertion,
  type Rect,
  type View,
} from './layout'

const REFETCH_DEBOUNCE_MS = 250
const ROWS_LIMIT = 5000
/** a change of the card filter waits this long for the next before it is written, so typed words go as one write */
const FILTER_WRITE_MS = 200
const EMPTY: ReadonlySet<string> = new Set()
/** a press that moved less than this (screen px) is a click */
const DRAG_SLOP = 4
/** how long a teleport keeps centring its card as the measures settle, and waits for a card that is not drawn yet */
const SETTLE_MS = 1500
const WAIT_MS = 5000
/** how long a card stays in view on the shown tab before it counts as seen (landing.ts) */
const SEEN_MS = 800
/** the controls' column at the bottom right, which Fit leaves clear */
const CONTROLS_W = 180 + 14 + 16

const fail = (e: unknown) => bus.emit('toast', { text: (e as Error)?.message || String(e), kind: 'error' })

/** A card a ref opened flashes once. */
function flashCard(el: HTMLElement): void {
  el.classList.add('anchor-flash')
  window.setTimeout(() => el.classList.remove('anchor-flash'), 1600)
}

/** The view the analyst left the board at, or null when there is none yet (the canvas then opens on its deck). */
function readView(key: string): View | null {
  const v = readStorage<Partial<View>>(key, {})
  if (typeof v.x !== 'number' || typeof v.y !== 'number' || typeof v.scale !== 'number') return null
  return { x: v.x, y: v.y, scale: clampScale(v.scale) }
}

const typing = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
}

const PART_WORD: Record<FilterPart, string> = { kinds: 'Kind', groups: 'Group', makers: 'Made by', checks: 'Check', starred: 'Starred', locked: 'Locked', text: 'Text' }

/** What a part of the card filter keeps, as its chip in the band names it: `Kind · plot, table`, `Starred`, `Text · "merge"`. */
function partLabel(f: CardFilter, part: FilterPart, groupName: (id: string) => string): string {
  if (part === 'starred' || part === 'locked') return PART_WORD[part]
  if (part === 'text') return `${PART_WORD[part]} · "${f.text.trim()}"`
  const values = part === 'groups' ? f.groups.map(groupName) : part === 'checks' ? f.checks.map((s) => CHECK_WORDS[s as CheckFilterState] ?? s) : f[part]
  return `${PART_WORD[part]} · ${values.join(', ')}`
}

const clearPart = (f: CardFilter, part: FilterPart): CardFilter => (part === 'starred' || part === 'locked' ? { ...f, [part]: false } : part === 'text' ? { ...f, text: '' } : { ...f, [part]: [] })

/** A card being resized, drawn at its new size (and, from its left or top edge, its new place) before it is written. */
interface Sizing {
  id: string
  w: number
  h: number | null
  pos: Pos | null
}

/** A drag in flight: the card or frame, where its corner is now (plane px), and what it would be dropped into. */
interface Drag {
  t: 'c' | 'g'
  id: string
  x: number
  y: number
  target: string | null
  ins: Insertion | null
  /** a card placed free (no gap under the pointer, or ⌥) */
  free: boolean
  /** the target is not where it is now */
  move: boolean
}

export function Canvas({ ws, active, focused = active }: { ws: string; active: boolean; focused?: boolean }) {
  const [data, setData] = useState<CanvasResponse | null>(null)
  const [chats, setChats] = useState<ChatMeta[]>([])
  const [filters, setFilters] = useState<Filters | null>(null)
  const [keep, setKeep] = useState<Set<string> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)
  const openKey = storageKey(ws, 'canvas-open')
  const [open, setOpenState] = useState<ReadonlySet<string>>(() => new Set(readStorage<string[]>(openKey, [])))
  // the card filter as the analyst sets it, shown at once; the server's canvas filter holds it (filters, loadFilters)
  const [cardFilter, setCardFilterState] = useState<CardFilter>(NO_FILTER)
  const viewKey = storageKey(ws, 'canvas-view')
  const [view, setViewState] = useState<View>(() => readView(viewKey) ?? DEFAULT_VIEW)
  // whether the view is one the analyst or a teleport set (or one kept from an earlier visit); until then the canvas
  // opens on its deck once the deck is drawn
  const placed = useRef(readView(viewKey) != null)
  const [heights, setHeights] = useState<Record<string, number>>({})
  const [sel, setSel] = useState<string[]>([])
  const [gsel, setGsel] = useState<string | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [marquee, setMarquee] = useState<Rect | null>(null)
  const [detail, setDetail] = useState<string | null>(null)
  // the lines of a card's output a citation opened its details at, while those details are open
  const [cite, setCite] = useState<(OutputCite & { cell: string }) | null>(null)
  useEffect(() => {
    if (cite && detail !== cite.cell) setCite(null)
  }, [detail, cite])
  // the label whose review is open in the side panel, for a label with no card of its own (LabelPanel)
  const [labelPanel, setLabelPanel] = useState<string | null>(null)
  const [focus, setFocus] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ id: string; field: CardField } | null>(null)
  const [sizing, setSizing] = useState<Sizing | null>(null)
  const [vpSize, setVpSize] = useState({ w: 900, h: 700 })
  // the viewport has been measured (a hidden tab measures 0 wide), so a view can be placed in it
  const [vpReady, setVpReady] = useState(false)
  const concepts = useConcepts(ws)
  const vp = useRef<HTMLDivElement>(null)

  useEffect(() => setOpenState(new Set(readStorage<string[]>(openKey, []))), [openKey])
  useEffect(() => {
    const kept = readView(viewKey)
    placed.current = kept != null
    setViewState(kept ?? DEFAULT_VIEW)
  }, [viewKey])
  const setOpen = useCallback(
    (f: (cur: ReadonlySet<string>) => ReadonlySet<string>) =>
      setOpenState((cur) => {
        const next = f(cur)
        writeStorage(openKey, [...next])
        return next
      }),
    [openKey],
  )
  const setView = useCallback(
    (f: View | ((v: View) => View)) =>
      setViewState((cur) => {
        placed.current = true
        const next = typeof f === 'function' ? f(cur) : f
        writeStorage(viewKey, next)
        return next
      }),
    [viewKey],
  )

  // ---- the data: the canvas route, the chats (the thread names on the cards), the canvas filter ----

  const load = useCallback(async () => {
    try {
      const d = await api.canvas(ws)
      setData(d)
      setError(null)
      setMissing(false)
      registerCells(d.cells.map((c) => ({ id: c.id, title: c.title, slug: c.slug })))
    } catch (e) {
      if (isNotFound(e)) setMissing(true)
      else setError((e as Error).message)
    }
  }, [ws])
  const loadChats = useCallback(() => api.chats(ws).then(setChats).catch(() => undefined), [ws])
  // A filter change shows at once and is written after FILTER_WRITE_MS. While a write is pending, a reload keeps the
  // card parts shown, so a quick run of clicks never shows the server's older answers.
  const cardWrite = useRef<{ timer: number | null; flying: number; next: CardFilter }>({ timer: null, flying: 0, next: NO_FILTER })
  const writing = () => cardWrite.current.timer != null || cardWrite.current.flying > 0
  const loadFilters = useCallback(
    () =>
      api
        .filters(ws)
        .then((f) => {
          setFilters(f)
          if (!writing()) setCardFilterState((cur) => keepShown(cur, readFilter(f.canvas)))
        })
        .catch(() => setFilters({})),
    [ws],
  )
  const writeCardFilter = useCallback(
    async (send: () => Promise<Filters>) => {
      const w = cardWrite.current
      w.flying += 1
      try {
        const f = await send()
        if (w.flying === 1 && w.timer == null) {
          setFilters(f)
          setCardFilterState((cur) => keepShown(cur, readFilter(f.canvas)))
        }
      } catch (e) {
        fail(e)
      } finally {
        w.flying -= 1
        if (!writing()) void loadFilters()
      }
    },
    [loadFilters],
  )
  const setCardFilter = useCallback(
    (f: CardFilter) => {
      const w = cardWrite.current
      setCardFilterState(f)
      w.next = f
      if (w.timer != null) window.clearTimeout(w.timer)
      w.timer = window.setTimeout(() => {
        w.timer = null
        track('filter-set', { target: null, detail: { scope: 'canvas-cards', ...cardParts(w.next) } })
        void writeCardFilter(() => api.putCardFilter(ws, cardParts(w.next)))
      }, FILTER_WRITE_MS)
    },
    [ws, writeCardFilter],
  )
  // a write still waiting when the workspace changes goes out at once, to its own workspace
  useEffect(
    () => () => {
      const w = cardWrite.current
      if (w.timer == null) return
      window.clearTimeout(w.timer)
      w.timer = null
      void api.putCardFilter(ws, cardParts(w.next)).catch(() => undefined)
    },
    [ws],
  )
  useEffect(() => {
    setFilters(null)
    setCardFilterState(NO_FILTER)
  }, [ws])
  /** Clear filters: the label part and every card part, in one write. */
  const clearCanvasFilter = useCallback(() => {
    const w = cardWrite.current
    if (w.timer != null) window.clearTimeout(w.timer)
    w.timer = null
    w.next = NO_FILTER
    setCardFilterState(NO_FILTER)
    track('filter-clear', { target: null, detail: { scope: 'canvas', via: 'filter-menu', whole: true } })
    void writeCardFilter(() => api.deleteFilter(ws, 'canvas', true))
  }, [ws, writeCardFilter])
  useEffect(() => {
    void load()
    void loadChats()
    void loadFilters()
    let timer: number | null = null
    const later = () => {
      if (timer != null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        void load()
        void loadChats()
      }, REFETCH_DEBOUNCE_MS)
    }
    const offs = [bus.on('cell', later), bus.on('chat', later), bus.on('orient', later), bus.on('filter', () => void loadFilters())]
    return () => {
      offs.forEach((f) => f())
      if (timer != null) window.clearTimeout(timer)
    }
  }, [load, loadChats, loadFilters])

  // the label part of the canvas's filter; its card parts are cardFilter
  const canvasLabel = filters?.canvas
  const canvasFilter = canvasLabel?.concept && canvasLabel.value != null ? { concept: canvasLabel.concept, value: canvasLabel.value } : null
  useEffect(() => {
    if (!canvasFilter) {
      setKeep(null)
      return
    }
    let alive = true
    const fetchRows = () =>
      api
        .conceptRows(ws, canvasFilter.concept, { value: canvasFilter.value, limit: ROWS_LIMIT })
        .then((r) => alive && setKeep(filterSet(r.rows)))
        .catch(() => alive && setKeep(null))
    void fetchRows()
    const off = bus.on('concepts', (e) => e.concept === canvasFilter.concept && void fetchRows())
    return () => {
      alive = false
      off()
    }
  }, [ws, canvasFilter?.concept, canvasFilter?.value])

  // a change the route has not made yet, shown at once; the reload after the route agrees with it
  const change = useCallback(
    async (local: (d: CanvasResponse) => CanvasResponse, remote: () => Promise<unknown>) => {
      setData((d) => (d ? local(d) : d))
      try {
        await remote()
      } catch (e) {
        fail(e)
      } finally {
        void load()
      }
    },
    [load],
  )

  // ---- the layout ----

  const board = useMemo(() => (data ? boardOf(data) : null), [data])
  // a card being resized is drawn at its new size before it is written
  const shownBoard = useMemo((): Board | null => {
    if (!board || !sizing) return board
    const cells = board.cells.map((c) => (c.id === sizing.id ? { ...c, w: sizing.w, h: sizing.h, pos: sizing.pos } : c))
    return { ...board, cells, cellById: new Map(cells.map((c) => [c.id, c] as const)) }
  }, [board, sizing])
  const lay = useMemo(() => (shownBoard ? layoutBoard(shownBoard, open, heights) : null), [shownBoard, open, heights])
  const content = useMemo(() => (lay ? extentOf(lay.rects.values()) : null), [lay])

  // the height of every card that has none of its own, measured as drawn (offsets ignore the zoom)
  const cardEls = useRef(new Map<string, HTMLElement>())
  const observer = useRef<ResizeObserver | null>(null)
  const measureSoon = useRef<number | null>(null)
  const measure = useCallback(() => {
    measureSoon.current = null
    setHeights((cur) => {
      let next: Record<string, number> | null = null
      for (const [id, el] of cardEls.current) {
        if (el.classList.contains('is-sized')) continue
        const h = el.offsetHeight
        if (h > 0 && Math.abs((cur[id] ?? 0) - h) >= 1) (next ??= { ...cur })[id] = h
      }
      return next ?? cur
    })
  }, [])
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (measureSoon.current == null) measureSoon.current = requestAnimationFrame(measure)
    })
    observer.current = ro
    for (const el of cardEls.current.values()) ro.observe(el)
    return () => {
      ro.disconnect()
      observer.current = null
    }
  }, [measure])
  const register = useCallback((id: string, el: HTMLElement | null) => {
    const prev = cardEls.current.get(id)
    if (prev && prev !== el) observer.current?.unobserve(prev)
    if (el) {
      cardEls.current.set(id, el)
      observer.current?.observe(el)
    } else cardEls.current.delete(id)
  }, [])
  useLayoutEffect(() => {
    if (active) measure()
  }, [active, measure])
  useEffect(() => {
    const el = vp.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      setVpSize({ w: el.clientWidth, h: el.clientHeight })
      if (el.clientWidth > 0) setVpReady(true)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [data != null])

  // the frame the analyst last selected or worked in, reported to the server as it changes: a model's card whose call
  // names no group goes there (tools.default_group). Clearing the selection reports nothing, so the last frame stays.
  const workFrame = useMemo(() => (board ? activeFrame(board, gsel, sel) : null), [board, gsel, sel])
  const reported = useRef<{ ws: string; group: string } | null>(null)
  useEffect(() => {
    if (!workFrame || (reported.current?.ws === ws && reported.current.group === workFrame)) return
    reported.current = { ws, group: workFrame }
    canvasApi.activeGroup(ws, workFrame).catch(() => {
      reported.current = null
    })
  }, [ws, workFrame])

  // the latest of everything, for the window listeners a press installs
  const live = useRef({ board, lay, view, sel, open })
  live.current = { board, lay, view, sel, open }

  // frames opened by a click on their collapsed deck or by a teleport (not by their title): each collapses again at a
  // click outside it. Kept for the page's life only.
  const peeked = useRef<Set<string>>(new Set())
  const peek = (ids: string[]) => {
    for (const g of ids) peeked.current.add(g)
    setOpen((cur) => new Set([...cur, ...ids]))
  }
  /** collapses the peeked frames that do not hold `at` (a frame, or null for the bare board) */
  const collapsePeeked = (at: string | null) => {
    const b = live.current.board
    if (!b || !peeked.current.size) return
    const drop = [...peeked.current].filter((g) => !(at && isWithin(b, at, g)))
    if (!drop.length) return
    for (const g of drop) peeked.current.delete(g)
    track('ui-click', { target: drop.map((g) => `group:${g}`).join(','), detail: { action: 'collapse', via: 'outside' } })
    setOpen((cur) => new Set([...cur].filter((g) => !drop.includes(g))))
  }
  const planeAt = (clientX: number, clientY: number): Pos => {
    const r = vp.current!.getBoundingClientRect()
    return toPlane(live.current.view, clientX - r.left, clientY - r.top)
  }

  // ---- the thread a card came from, and its unread dot ----

  const chatById = useMemo(() => new Map(chats.map((m) => [m.id, m] as const)), [chats])
  const threadOf = useCallback((cell: Cell) => cellThread(cell.created_by, chatById), [chatById])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const unread = useMemo(() => unreadAnchors(chats, readSeen(ws)), [chats, ws, active])
  const openThread = useCallback(
    (cell: Cell) => {
      const t = cellThread(cell.created_by, chatById)
      if (!t.chatId) return
      track('chat-open', { target: `chat:${t.chatId}`, detail: { via: 'cell-foot' } })
      bus.emit('openChat', { chatId: t.chatId })
    },
    [chatById],
  )
  const refresh = useCallback(() => void load(), [load])

  // ---- the card filter (cardFilter.ts) with the label filter: the cards neither leaves out ----

  const filterCards = useMemo(
    (): FilterCard[] =>
      board
        ? board.cells.map((c) => ({ id: c.id, kind: kindOf(c.cell), group: c.parent, maker: threadOf(c.cell).name, check: checkState(c.cell), starred: !!c.cell.starred, locked: !!c.cell.locked, text: searchText(c.cell.title, c.cell.takeaway) }))
        : [],
    [board, threadOf],
  )
  const kept = useMemo(() => bothKeep(keep, keptBy(filterCards, cardFilter)), [keep, filterCards, cardFilter])
  const canvasLabels = useMemo(
    (): CanvasLabel[] =>
      [...concepts.values()]
        .filter((k) => scopeForUnit(k.unit) === 'canvas')
        .map((k) => ({ concept: k.id, name: k.name, values: labelValues(k.labels, k.counts).map((value) => ({ value, count: k.counts?.[value] ?? 0 })) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [concepts],
  )
  const setLabelFilter = async (concept: string, value: string | null) => {
    try {
      if (value == null) {
        track('filter-clear', { target: `concept:${concept}`, detail: { scope: 'canvas', via: 'filter-menu' } })
        await api.deleteFilter(ws, 'canvas')
      } else {
        track('filter-set', { target: `concept:${concept}`, detail: { scope: 'canvas', value, via: 'filter-menu' } })
        await api.putFilter(ws, 'canvas', concept, value)
      }
    } catch (e) {
      fail(e)
    }
  }
  const ctx: CanvasCtx = useMemo(() => ({ ws, filters, keep: kept, concepts, threadOf, unread, refresh, openThread }), [ws, filters, kept, concepts, threadOf, unread, refresh, openThread])

  // ---- pan and zoom ----

  useEffect(() => {
    const el = vp.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      // a sideways turn over a table or a drawing wider than its card scrolls it, not the board
      if (!e.ctrlKey && !e.metaKey && takesSideways(e.target, e.deltaX, e.deltaY, el)) return
      e.preventDefault()
      const r = el.getBoundingClientRect()
      setView((v) => wheelView(v, e, e.clientX - r.left, e.clientY - r.top))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [setView, data != null])
  const zoomStep = (dir: 1 | -1) => {
    track('ui-click', { target: 'canvas:zoom', detail: { dir } })
    setView((v) => zoomTo(v, stepZoom(v.scale, dir), vpSize.w / 2, vpSize.h / 2))
  }
  const fit = () => {
    track('ui-click', { target: 'canvas:zoom', detail: { fit: true } })
    setView(fitView(content, vpSize.w, vpSize.h, 48, CONTROLS_W))
  }
  const space = useRef(false)
  const pan = (e: ReactMouseEvent) => {
    const x0 = e.clientX
    const y0 = e.clientY
    const v0 = live.current.view
    vp.current?.classList.add('is-panning')
    const mv = (ev: MouseEvent) => setView({ ...v0, x: v0.x + ev.clientX - x0, y: v0.y + ev.clientY - y0 })
    const up = () => {
      window.removeEventListener('mousemove', mv)
      window.removeEventListener('mouseup', up)
      vp.current?.classList.remove('is-panning')
    }
    window.addEventListener('mousemove', mv)
    window.addEventListener('mouseup', up)
  }

  // ---- presses: the board (marquee), a card (select, drag), a frame's title (move, nest, open) ----

  const onBoardDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.button === 1 || (e.button === 0 && space.current)) {
      e.preventDefault()
      return pan(e)
    }
    if (e.button !== 0 || pointKeyHeld(e)) return
    if ((e.target as HTMLElement).closest('[data-cellbox]')) return
    const p0 = planeAt(e.clientX, e.clientY)
    const add = e.shiftKey
    const before = add ? live.current.sel : []
    setGsel(null)
    setEditing(null)
    setRenaming(null)
    if (!add) {
      setSel([])
      setDetail(null)
      setLabelPanel(null)
    }
    setMarquee({ x: p0.x, y: p0.y, w: 0, h: 0 })
    let big = false
    const mv = (ev: MouseEvent) => {
      const p = planeAt(ev.clientX, ev.clientY)
      const box = { x: Math.min(p0.x, p.x), y: Math.min(p0.y, p.y), w: Math.abs(p.x - p0.x), h: Math.abs(p.y - p0.y) }
      big = big || (box.w + box.h) * live.current.view.scale > 6
      setMarquee(box)
      const { board: b, lay: l } = live.current
      if (big && b && l) {
        const hit = cardsIn(b, l, box)
        setSel(Array.from(new Set([...before, ...hit])))
      }
    }
    const up = () => {
      window.removeEventListener('mousemove', mv)
      window.removeEventListener('mouseup', up)
      setMarquee(null)
      const { board: b, lay: l, open: o } = live.current
      if (big || !b || !l) return
      // a click outside a frame its deck opened collapses it; a click on a collapsed frame (the edges of its deck among
      // it) opens it
      const g = frameAt(b, l, p0)
      collapsePeeked(g)
      if (g && !o.has(g)) {
        track('ui-click', { target: `group:${g}`, detail: { action: 'expand', via: 'region' } })
        peek([g])
      }
    }
    window.addEventListener('mousemove', mv)
    window.addEventListener('mouseup', up)
  }

  const onCardDown = (e: ReactMouseEvent<HTMLElement>, id: string) => {
    if (e.button === 1 || (e.button === 0 && space.current)) {
      e.preventDefault()
      e.stopPropagation()
      return pan(e)
    }
    // ⌘ belongs to the pointer (a thread on the card); a control in the card handles its own press
    if (e.button !== 0 || pointKeyHeld(e) || (e.target as HTMLElement).closest('button, a, textarea, input, select, iframe, .chip, .refchip')) return
    e.stopPropagation()
    e.preventDefault()
    const { board: b, lay: l, sel: s } = live.current
    const bc = b?.cellById.get(id)
    const r = l?.rects.get(id)
    if (!b || !l || !bc || !r) return
    setGsel(null)
    setRenaming(null)
    if (editing && editing.id !== id) setEditing(null)
    if (e.shiftKey) {
      setSel(s.includes(id) ? s.filter((x) => x !== id) : [...s, id])
      return
    }
    if (!s.includes(id)) setSel([id])
    const p0 = planeAt(e.clientX, e.clientY)
    let moved = false
    let last: Drag | null = null
    const mv = (ev: MouseEvent) => {
      const p = planeAt(ev.clientX, ev.clientY)
      if (!moved && Math.hypot(p.x - p0.x, p.y - p0.y) * live.current.view.scale < DRAG_SLOP) return
      if (!moved) setSel([id])
      moved = true
      const { board: b2, lay: l2 } = live.current
      if (!b2 || !l2) return
      const target = frameAt(b2, l2, p)
      const ins = target && !ev.altKey ? insertionAt(b2, l2, target, p, id) : null
      last = { t: 'c', id, x: r.x + p.x - p0.x, y: r.y + p.y - p0.y, target, ins, free: ev.altKey || !ins, move: !!target && target !== bc.parent }
      setDrag(last)
    }
    const up = () => {
      window.removeEventListener('mousemove', mv)
      window.removeEventListener('mouseup', up)
      setDrag(null)
      if (moved && last) return dropCard(last)
      if (moved) return
      // a click on a card is outside every other frame its deck opened; on a collapsed frame's card it opens the frame
      collapsePeeked(bc.parent)
      if (bc.parent && !live.current.open.has(bc.parent)) {
        track('ui-click', { target: `group:${bc.parent}`, detail: { action: 'expand', via: 'card' } })
        peek([bc.parent])
      }
    }
    window.addEventListener('mousemove', mv)
    window.addEventListener('mouseup', up)
  }

  const dropCard = (d: Drag) => {
    const { board: b, lay: l } = live.current
    if (!b || !l) return
    const me = b.cellById.get(d.id)
    if (!me) return
    const frame = d.target ? l.rects.get(d.target) : null
    track('ui-click', { target: `cell:${d.id}`, detail: { action: 'move', to: d.target, free: d.free, side: d.ins?.side } })
    if (d.target && frame && d.ins?.side && d.ins.ref) {
      // beside a sibling: the card is placed free at the sibling's side; on the left it takes the sibling's place and
      // the sibling moves right
      const ref = l.rects.get(d.ins.ref)!
      const y = ref.y - frame.y
      if (d.ins.side === 'R') {
        const pos = { x: ref.x + ref.w + GAP - frame.x, y }
        void change((x) => moveLocal(x, [d.id], d.target, undefined, pos), () => canvasApi.move(ws, { cells: [d.id], group: d.target, pos }))
      } else {
        const pos = { x: ref.x - frame.x, y }
        const refPos = { x: ref.x - frame.x + me.w + GAP, y }
        const refId = d.ins.ref
        void change(
          (x) => patchCellLocal(moveLocal(x, [d.id], d.target, undefined, pos), refId, { pos: refPos }),
          () => Promise.all([canvasApi.move(ws, { cells: [d.id], group: d.target, pos }), canvasApi.patchCell(ws, refId, { pos: refPos })]),
        )
      }
      return
    }
    if (d.target && d.ins) {
      const sibs = kidsOf(b, d.target).filter((k) => k.t === 'c' && !k.it.pos && k.it.id !== d.id && l.rects.has(k.it.id))
      const after = d.ins.index > 0 ? sibs[d.ins.index - 1].it.id : null
      void change((x) => moveLocal(x, [d.id], d.target, after, null), () => canvasApi.move(ws, { cells: [d.id], group: d.target, after }))
      return
    }
    const pos = frame ? { x: Math.round(d.x - frame.x), y: Math.round(d.y - frame.y) } : { x: Math.round(d.x), y: Math.round(d.y) }
    void change((x) => moveLocal(x, [d.id], d.target, undefined, pos), () => canvasApi.move(ws, { cells: [d.id], group: d.target, pos }))
  }

  const clickTimer = useRef<number | null>(null)
  const clickOn = useRef<string | null>(null)
  const onTitleDown = (e: ReactMouseEvent<HTMLElement>, gid: string) => {
    if (e.button !== 0 || pointKeyHeld(e) || (e.target as HTMLElement).closest('button, input')) return
    e.stopPropagation()
    e.preventDefault()
    const { board: b, lay: l } = live.current
    const g = b?.group.get(gid)
    const r = l?.rects.get(gid)
    if (!b || !l || !g || !r) return
    setGsel(gid)
    setSel([])
    setEditing(null)
    const p0 = planeAt(e.clientX, e.clientY)
    let moved = false
    let last: Drag | null = null
    const mv = (ev: MouseEvent) => {
      const p = planeAt(ev.clientX, ev.clientY)
      if (!moved && Math.hypot(p.x - p0.x, p.y - p0.y) * live.current.view.scale < DRAG_SLOP) return
      moved = true
      const { board: b2, lay: l2 } = live.current
      if (!b2 || !l2) return
      const target = frameAt(b2, l2, p, gid)
      last = { t: 'g', id: gid, x: r.x + p.x - p0.x, y: r.y + p.y - p0.y, target, ins: null, free: true, move: target !== g.parent }
      setDrag(last)
    }
    const up = () => {
      window.removeEventListener('mousemove', mv)
      window.removeEventListener('mouseup', up)
      setDrag(null)
      if (moved && last) return dropFrame(last)
      if (moved) return
      // a second click within DOUBLE_MS on the same title renames the frame; a single click opens or collapses it once no
      // second click follows. The browser's own double click is not used, so two slow clicks never also rename.
      if (clickTimer.current != null) {
        window.clearTimeout(clickTimer.current)
        clickTimer.current = null
        if (clickOn.current === gid) {
          setRenaming(gid)
          return
        }
      }
      clickOn.current = gid
      clickTimer.current = window.setTimeout(() => {
        clickTimer.current = null
        clickOn.current = null
        collapsePeeked(gid)
        peeked.current.delete(gid)
        track('ui-click', { target: `group:${gid}`, detail: { action: live.current.open.has(gid) ? 'collapse' : 'expand' } })
        setOpen((cur) => {
          const next = new Set(cur)
          if (next.has(gid)) next.delete(gid)
          else next.add(gid)
          return next
        })
      }, DOUBLE_MS)
    }
    window.addEventListener('mousemove', mv)
    window.addEventListener('mouseup', up)
  }

  const dropFrame = (d: Drag) => {
    const { board: b, lay: l } = live.current
    if (!b || !l) return
    const into = d.target ? l.rects.get(d.target) : null
    const pos = into ? { x: Math.round(d.x - into.x), y: Math.round(d.y - into.y) } : { x: Math.round(d.x), y: Math.round(d.y) }
    const parent = d.target
    track('ui-click', { target: `group:${d.id}`, detail: { action: 'move', into: parent, ...pos } })
    void change((x) => patchGroupLocal(x, d.id, { parent, pos, order: null }), () => canvasApi.patchGroup(ws, d.id, { parent, pos, order: null }))
  }

  // a card resizes from any edge or corner, the opposite one staying put: a free card moves its place as its left or top
  // edge is dragged; a card in a frame's flow keeps its place and grows or shrinks from its right or bottom. Only what
  // the edge changes is written.
  const onResizeStart = (e: ReactMouseEvent<HTMLElement>, id: string, edge: Edge = 'se') => {
    if (e.button !== 0 || pointKeyHeld(e)) return
    e.stopPropagation()
    e.preventDefault()
    const { board: b, lay: l } = live.current
    const bc = b?.cellById.get(id)
    const r = l?.rects.get(id)
    if (!bc || !r) return
    setSel([id])
    setGsel(null)
    const x0 = e.clientX
    const y0 = e.clientY
    const horiz = edge.includes('e') || edge.includes('w')
    const vert = edge.includes('n') || edge.includes('s')
    let last: Sizing | null = null
    const mv = (ev: MouseEvent) => {
      const z = live.current.view.scale
      const dx = (ev.clientX - x0) / z
      const dy = (ev.clientY - y0) / z
      const w = !horiz ? bc.w : clampWidth(bc.w + (edge.includes('w') ? -dx : dx))
      const h = !vert ? bc.h : clampHeight(r.h + (edge.includes('n') ? -dy : dy))
      let pos = bc.pos
      if (bc.pos && (edge.includes('w') || edge.includes('n'))) {
        pos = { x: edge.includes('w') ? Math.round(bc.pos.x + bc.w - w) : bc.pos.x, y: edge.includes('n') ? Math.round(bc.pos.y + r.h - (h ?? r.h)) : bc.pos.y }
      }
      last = { id, w, h, pos }
      setSizing(last)
    }
    const up = () => {
      window.removeEventListener('mousemove', mv)
      window.removeEventListener('mouseup', up)
      if (!last) return setSizing(null)
      const s = last
      const patch: { width?: number; height?: number; pos?: Pos } = {}
      if (horiz) patch.width = s.w
      if (vert && s.h != null) patch.height = s.h
      if (s.pos && s.pos !== bc.pos) patch.pos = s.pos
      track('cell-edit', { target: `cell:${id}`, detail: { field: 'size', edge, ...patch } })
      void change(
        (x) => patchCellLocal(x, id, patch),
        () => canvasApi.patchCell(ws, id, patch),
      ).finally(() => setSizing(null))
    }
    window.addEventListener('mousemove', mv)
    window.addEventListener('mouseup', up)
  }

  // ---- what the controls and the keys do ----

  const deleteSelection = () => {
    if (gsel) {
      const g = gsel
      track('ui-click', { target: `group:${g}`, detail: { action: 'delete' } })
      setGsel(null)
      setRenaming(null)
      void change((x) => removeLocal(x, [], [g]), () => canvasApi.deleteGroup(ws, g))
      return
    }
    if (!sel.length) return
    const ids = [...sel]
    track('ui-click', { target: ids.map((i) => `cell:${i}`).join(','), detail: { action: 'delete' } })
    setSel([])
    if (detail && ids.includes(detail)) setDetail(null)
    void change((x) => removeLocal(x, ids, []), () => Promise.all(ids.map((i) => api.deleteCell(ws, i))))
  }

  const groupSelection = async () => {
    if (!board || !lay || !data) return
    const picked = board.cells.filter((c) => sel.includes(c.id))
    if (picked.length < 2) return
    const parent = picked.every((c) => c.parent === picked[0].parent) ? picked[0].parent : null
    const title = nextGroupTitle(data.groups)
    track('ui-click', { target: picked.map((c) => `cell:${c.id}`).join(','), detail: { action: 'group' } })
    try {
      let made
      if (parent) {
        // in the frame's flow where the first of them was
        const flow = kidsOf(board, parent).filter((k) => k.t === 'c' && !k.it.pos).map((k) => k.it.id)
        const first = flow.findIndex((id) => sel.includes(id))
        made = await canvasApi.createGroup(ws, { title, parent, order: first < 0 ? null : first })
      } else {
        const box = extentOf(picked.map((c) => lay.rects.get(c.id)!).filter(Boolean))!
        made = await canvasApi.createGroup(ws, { title, pos: { x: Math.round(box.x - PAD), y: Math.round(box.y - HEAD) } })
      }
      await canvasApi.move(ws, { cells: picked.map((c) => c.id), group: made.id })
      setOpen((cur) => new Set([...cur, made.id]))
      setSel([])
      setGsel(made.id)
      setRenaming(made.id)
    } catch (e) {
      fail(e)
    } finally {
      void load()
    }
  }

  const addCell = async () => {
    if (!data) return
    track('ui-click', { target: 'canvas:cell', detail: { action: 'add' } })
    try {
      const g = analystGroup(data.groups) ?? (await api.createGroup(ws, { title: 'Your work', role: 'analyst' }))
      const cell = await api.addCell(ws, g.id, { kind: 'code', title: 'New card', code: '' })
      setOpen((cur) => new Set([...cur, g.id]))
      setSel([cell.id])
      setGsel(null)
      setEditing({ id: cell.id, field: 'title' })
      pendingRef.current = `card:${cell.id}`
      await load()
    } catch (e) {
      fail(e)
    }
  }

  const addGroup = async () => {
    if (!data) return
    track('ui-click', { target: 'canvas:group', detail: { action: 'add' } })
    try {
      const g = await canvasApi.createGroup(ws, { title: nextGroupTitle(data.groups) })
      setOpen((cur) => new Set([...cur, g.id]))
      setSel([])
      setGsel(g.id)
      setRenaming(g.id)
      pendingRef.current = `group:${g.id}`
      await load()
    } catch (e) {
      fail(e)
    }
  }

  const rename = (gid: string, title: string) => {
    setRenaming(null)
    const t = title.trim()
    const g = data?.groups.find((x) => x.id === gid)
    if (!t || !g || t === g.title) return
    track('ui-click', { target: `group:${gid}`, detail: { action: 'rename' } })
    void change((x) => patchGroupLocal(x, gid, { title: t }), () => canvasApi.patchGroup(ws, gid, { title: t }))
  }

  const askNew = useCallback(
    async (cellId: string, text: string) => {
      try {
        const el = anchorElement(`card:${cellId}`)
        const image = el ? await capturePng(el) : null
        const cell = data?.cells.find((c) => c.id === cellId)
        // the question goes with the thread, so no empty thread is left when no session listens
        const meta = await api.createThread(ws, { anchor: `card:${cellId}`, anchor_text: cell?.title || null, ...(el ? describeElement(el) : {}), image, text })
        setChats((cs) => (cs.some((m) => m.id === meta.id) ? cs : [...cs, meta]))
        bus.emit('openChat', { chatId: meta.id })
      } catch (e) {
        fail(e)
      }
    },
    [ws, data],
  )

  const onAction = (action: CardAction, id: string, el: HTMLElement | null) => {
    const cell = data?.cells.find((c) => c.id === id)
    if (!cell) return
    switch (action) {
      case 'detail':
        track('card-code-toggle', { target: `cell:${id}`, detail: { open: detail !== id } })
        setSel([id])
        setLabelPanel(null)
        setDetail((d) => (d === id ? null : id))
        return
      case 'ask':
        if (el) bus.emit('askAbout', { el })
        return
      case 'delete':
        track('ui-click', { target: `cell:${id}`, detail: { action: 'delete' } })
        setSel((s) => s.filter((x) => x !== id))
        if (detail === id) setDetail(null)
        void change((x) => removeLocal(x, [id], []), () => api.deleteCell(ws, id))
        return
      case 'star': {
        const starred = !cell.starred
        track('ui-click', { target: `cell:${id}`, detail: { action: starred ? 'star' : 'unstar' } })
        void change((x) => patchCellLocal(x, id, { starred }), () => canvasApi.patchCell(ws, id, { starred }))
        return
      }
      case 'lock': {
        // the server records the lock in the telemetry itself (notebook.edit_cell), so no row is posted here
        const locked = !cell.locked
        void change((x) => patchCellLocal(x, id, { locked }), () => canvasApi.patchCell(ws, id, { locked }))
        return
      }
    }
  }

  // the hooks every card gets, the same functions on every render (they call the latest handlers), so a card whose own
  // props did not change is not drawn again while another card drags
  const latest = useRef({ onCardDown, onResizeStart, onAction })
  latest.current = { onCardDown, onResizeStart, onAction }
  const cardHooks = useMemo(
    () => ({
      onPress: (e: ReactMouseEvent<HTMLElement>, id: string) => latest.current.onCardDown(e, id),
      onResizeStart: (e: ReactMouseEvent<HTMLElement>, id: string, edge: Edge) => latest.current.onResizeStart(e, id, edge),
      onAction: (action: CardAction, id: string, el: HTMLElement | null) => latest.current.onAction(action, id, el),
      onFocusMode: (id: string) => {
        track('ui-click', { target: `cell:${id}`, detail: { action: 'focus' } })
        setFocus(id)
      },
      onEdit: (id: string, field: CardField | null) => setEditing(field ? { id, field } : null),
    }),
    [],
  )

  // the card focus mode shows is the selected one, so Escape leaves the analyst at the card they stepped to
  useEffect(() => {
    if (focus) setSel([focus])
  }, [focus])

  // the focused card's frame, in order: the list at the left of focus mode and what ↑ ↓ step through
  const focusList = useMemo(() => {
    if (!focus || !board) return []
    const parent = board.cellById.get(focus)?.parent ?? null
    return kidsOf(board, parent).filter((k) => k.t === 'c').map((k) => k.it.cell as Cell)
  }, [focus, board])

  // the board's keys, while its pane has the focus
  useEffect(() => {
    if (!focused) return
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target)) return
      if (e.key === ' ' && !focus) {
        space.current = e.type === 'keydown'
        if (e.type === 'keydown') e.preventDefault()
        return
      }
      if (e.type !== 'keydown') return
      if (focus) {
        const i = focusList.findIndex((c) => c.id === focus)
        if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
          e.preventDefault()
          setFocus(focusList[Math.min(focusList.length - 1, i + 1)]?.id ?? focus)
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
          e.preventDefault()
          setFocus(focusList[Math.max(0, i - 1)]?.id ?? focus)
        } else if (e.key === 'Escape') setFocus(null)
        return
      }
      if (e.key === 'Escape') {
        setSel([])
        setGsel(null)
        setDetail(null)
        setLabelPanel(null)
        setEditing(null)
      } else if ((e.key === 'Backspace' || e.key === 'Delete') && (sel.length || gsel) && !renaming) {
        e.preventDefault()
        deleteSelection()
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'g' && sel.length > 1) {
        e.preventDefault()
        void groupSelection()
      } else if (e.key === 'Enter' && sel.length === 1) {
        e.preventDefault()
        setFocus(sel[0])
      } else if (e.key === 'Enter' && gsel && !sel.length && !renaming && board) {
        // a frame selected names no card: focus mode starts at its first card
        const first = firstCardOf(board, gsel)
        if (first) {
          e.preventDefault()
          track('ui-click', { target: `group:${gsel}`, detail: { action: 'focus', via: 'key' } })
          setFocus(first)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKey)
    }
  })

  // ---- a ref to a card, a frame or a label: open the frames it sits in, centre it once it is drawn, flash it; a ref
  // to a cell of a card's table opens the card at that cell, marked, and one to lines of a card's printed output opens
  // them where they are drawn (the card, or focus mode on it, else the card's details), marked ----

  const pendingRef = useRef<string | null>(null)
  // the ref waiting asks for focus mode on its frame's first card (a canvas group's chip, teleport's `focus`)
  const pendingFocus = useRef(false)
  const pendingSince = useRef(0)
  const settling = useRef<{ ref: string; timer: number } | null>(null)
  const [, bump] = useState(0)
  useEffect(
    () =>
      bus.on('openRef', (e) => {
        const p = parseRef(e.ref)
        if (!p || (p.kind !== 'cell' && p.kind !== 'group' && p.kind !== 'concept')) return
        pendingRef.current = e.ref
        pendingFocus.current = !!e.focus
        pendingSince.current = 0
        bump((n) => n + 1)
        // a render once the wait is over, so a card that never arrives is given up on even when nothing else changes
        window.setTimeout(() => bump((n) => n + 1), WAIT_MS + 100)
      }),
    [],
  )
  useEffect(() => {
    const ref = pendingRef.current
    if (!ref || !active || !board || !lay || !data) return
    const p = parseRef(ref)
    let id: string | null = null
    if (p?.kind === 'cell') id = p.cellId
    else if (p?.kind === 'group') id = p.groupId
    else if (p?.kind === 'concept') id = data.cells.find((c) => (c.payload as { concept?: unknown } | undefined)?.concept === p.conceptId)?.id ?? null
    // a label the workspace holds with no card of its own (the orientation's, backend concepts.apply_scoped) opens its
    // review in the side panel; one not listed yet may be a label whose card is on its way, and is waited for
    if (p?.kind === 'concept' && !id && concepts.has(p.conceptId)) {
      pendingRef.current = null
      pendingSince.current = 0
      setDetail(null)
      setLabelPanel(p.conceptId)
      return
    }
    // orientation scratch work is not on the board (backend notebook.canvas): the analyst is told so and the board opens
    // on the deck instead
    if (p?.kind === 'cell' && id && data.hidden?.includes(id)) {
      bus.emit('toast', { text: 'This card is scratch work of an older orientation, which is not on the canvas.', kind: 'info' })
      const deck = openingFrame(board, lay)
      pendingRef.current = deck ? `group:${deck}` : null
      pendingSince.current = 0
      bump((n) => n + 1)
      return
    }
    // a card or frame not on the board yet (the re-read under way) is waited for a while; one that never arrives is
    // reported as not on the canvas
    if (!id || (!board.cellById.has(id) && !board.group.has(id))) {
      if (!pendingSince.current) pendingSince.current = Date.now()
      if (Date.now() - pendingSince.current > WAIT_MS) {
        pendingRef.current = null
        pendingSince.current = 0
        const what = p?.kind === 'group' ? 'This group is' : p?.kind === 'concept' ? "This label's card is" : 'This card is'
        bus.emit('toast', { text: `${what} not on the canvas.`, kind: 'info' })
      }
      return
    }
    pendingSince.current = 0
    const closed = framesAbove(board, id).filter((g) => !open.has(g))
    if (closed.length) {
      peek(closed)
      return
    }
    const r = lay.rects.get(id)
    if (!r) {
      pendingRef.current = null
      return
    }
    // a chip for a frame opens focus mode on the frame's first card, with the board behind it opened on the frame, so
    // Escape leaves the analyst at the frame's top
    if (pendingFocus.current) {
      const frame = board.group.has(id) ? id : board.cellById.get(id)?.parent ?? null
      const first = frame ? firstCardOf(board, frame) : board.cellById.has(id) ? id : null
      const fr = frame ? lay.rects.get(frame) : null
      pendingRef.current = null
      pendingFocus.current = false
      if (fr) setView((v) => openOn(v, fr, vpSize.w, CONTROLS_W))
      if (first) setFocus(first)
      return
    }
    // placed again while the measures settle: a frame opens from its top, a card is centred (from its top when taller than
    // the view). The same view is not set twice, so this does not render in a loop
    setView((v) => {
      const at = readable(v)
      const next = p?.kind === 'group' ? openOn(v, r, vpSize.w, CONTROLS_W) : centerOn(at, r.x + r.w / 2, r.y + Math.min(r.h, vpSize.h / at.scale) / 2, vpSize.w, vpSize.h)
      return Math.abs(next.x - v.x) < 0.5 && Math.abs(next.y - v.y) < 0.5 && next.scale === v.scale ? v : next
    })
    if (settling.current?.ref === ref) return
    if (settling.current) window.clearTimeout(settling.current.timer)
    const cellId = board.cellById.has(id) ? id : null
    if (cellId) setSel([cellId])
    const el = cellId ? cardEls.current.get(cellId)?.querySelector<HTMLElement>('.canvas-card') : null
    // the view centres on a part of a card it opened when that part is outside the viewport (a card taller than it)
    const centreOnPart = (part: HTMLElement) => {
      const box = vp.current?.getBoundingClientRect()
      const at = part.getBoundingClientRect()
      if (!box || (at.top >= box.top && at.bottom <= box.bottom && at.left >= box.left && at.right <= box.right)) return
      const c = toPlane(live.current.view, at.left + at.width / 2 - box.left, at.top + at.height / 2 - box.top)
      setView((v) => centerOn(v, c.x, c.y, vpSize.w, vpSize.h))
    }
    if (el && p?.kind === 'cell' && p.col != null && p.row != null) {
      // a table's cell: its table scrolls to it (its rows shown past the cap when it is further down) and the cell is
      // marked rather than the card; the view then centres on the cell when the card is taller than the view
      const cited = { col: p.col, row: p.row }
      window.setTimeout(() => {
        void revealCell(el, cited.col, cited.row, '.outputs-html table').then((td) => {
          if (!td) return flashCard(el)
          centreOnPart(td)
        })
      }, 120)
    } else if (el && cellId && p?.kind === 'cell' && p.out != null && p.line != null) {
      // lines of a card's printed output: marked in focus mode when it shows the card and draws them, else in the card's
      // details when they are open, else on the card when it draws them, else in the details opened, which show every
      // output (a card draws one)
      const cited = { cell: cellId, out: p.out, line: p.line, end: p.endLine }
      const focused = focus
      const detailed = detail === cellId
      window.setTimeout(() => {
        // the lines in the output `root` draws, scrolled to inside `stop`
        const mark = (root: HTMLElement | null, stop = root) => {
          const box = root?.querySelector<HTMLElement>(`[data-out="${cited.out}"]`)
          return box && stop ? revealLines(box, cited.line, cited.end, stop) : null
        }
        const inFocus = focused === cited.cell ? document.querySelector<HTMLElement>(`.bfocus-card[data-cite-home="${cited.cell}"]`) : null
        if (inFocus && mark(inFocus, inFocus.closest<HTMLElement>('.bfocus'))) return
        if (focused) setFocus(null)
        const line = detailed ? null : mark(el)
        if (line) return centreOnPart(line)
        setLabelPanel(null)
        setDetail(cited.cell)
        setCite({ ...cited, seq: Date.now() })
      }, 120)
    } else if (el) flashCard(el)
    settling.current = {
      ref,
      timer: window.setTimeout(() => {
        if (pendingRef.current === ref) pendingRef.current = null
        settling.current = null
      }, SETTLE_MS),
    }
  })

  // ---- the landing on a switch to the tab while it has its dot (landing.ts). A card is seen once it has been in the
  // viewport while the tab is shown ----

  const seenKey = storageKey(ws, 'canvas-seen')
  const seen = useRef<readonly string[]>(readStorage<string[]>(seenKey, []))
  useEffect(() => {
    seen.current = readStorage<string[]>(seenKey, [])
  }, [seenKey])
  const arrived = useRef<string[]>([])
  const activeNow = useRef(active)
  activeNow.current = active
  useEffect(
    () =>
      bus.on('wsEvent', (ev) => {
        const e = ev as Record<string, unknown>
        if (activeNow.current || isReplay() || e.type !== 'cell' || e.op !== 'created' || typeof e.cell !== 'string') return
        arrived.current.push(e.cell)
      }),
    [],
  )
  const wasActive = useRef(active)
  const landing = useRef<string[] | null>(null)
  useEffect(() => {
    if (active && !wasActive.current) {
      landing.current = arrived.current
      arrived.current = []
    }
    wasActive.current = active
  }, [active])
  useEffect(() => {
    const got = landing.current
    if (!got || !active || !vpReady || !board || !lay) return
    landing.current = null
    // a teleport that brought the analyst here (a chip, a citation) says where to go
    if (pendingRef.current || !got.length) return
    const to = canvasLanding({ seen: new Set(seen.current), cards: board.cellById.keys(), arrived: got, start: openingFrame(board, lay) })
    if (to.kind === 'stay') return
    // the deck opens, so its cards read from the first (a frame so opened collapses again at a click outside it)
    if (to.kind === 'frame' && !open.has(to.id)) peek([to.id])
    pendingRef.current = to.kind === 'frame' ? `group:${to.id}` : `card:${to.id}`
    pendingFocus.current = false
    pendingSince.current = 0
    bump((n) => n + 1)
    window.setTimeout(() => bump((n) => n + 1), WAIT_MS + 100)
  })
  useEffect(() => {
    if (!active || !vpReady || !board || !lay) return
    const t = window.setTimeout(() => {
      const at = toPlane(view, 0, 0)
      const box = { x: at.x, y: at.y, w: vpSize.w / view.scale, h: vpSize.h / view.scale }
      const inView: string[] = []
      for (const id of board.cellById.keys()) {
        const r = lay.rects.get(id)
        if (r && overlaps(r, box)) inView.push(id)
      }
      const next = addSeen(seen.current, inView)
      if (next === seen.current) return
      seen.current = next
      writeStorage(seenKey, next)
    }, SEEN_MS)
    return () => window.clearTimeout(t)
  }, [active, vpReady, board, lay, view, vpSize.w, vpSize.h, seenKey])

  // ---- the first open: with no view kept, the board opens on its deck from the top, at the default zoom, once the deck
  // and the viewport are measured; a teleport waiting to land takes precedence ----

  useEffect(() => {
    if (placed.current || !active || !vpReady || !board || !lay) return
    if (pendingRef.current) {
      placed.current = true
      return
    }
    const id = openingFrame(board, lay)
    const r = id ? lay.rects.get(id) : null
    if (r) setView(openOn(DEFAULT_VIEW, r, vpSize.w, CONTROLS_W))
  }, [active, vpReady, board, lay, vpSize.w, setView])

  // ---- drawing ----

  const clearFilter = async () => {
    track('filter-clear', { target: canvasFilter ? `concept:${canvasFilter.concept}` : null, detail: { scope: 'canvas', via: 'chip' } })
    try {
      await api.deleteFilter(ws, 'canvas')
    } catch (e) {
      fail(e)
    }
  }
  const groupName = (id: string) => board?.group.get(id)?.name ?? 'group'
  const detailCell = detail ? data?.cells.find((c) => c.id === detail) ?? null : null
  const focusCell = focus ? data?.cells.find((c) => c.id === focus) ?? null : null
  const selected = useMemo(() => new Set(sel), [sel])
  const map = useMemo(() => minimapOf(content, view, vpSize.w, vpSize.h), [content, view, vpSize])
  const onMinimap = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.stopPropagation()
    e.preventDefault()
    const box = e.currentTarget.getBoundingClientRect()
    const go = (ev: { clientX: number; clientY: number }) => {
      const p = map.toPlane(ev.clientX - box.left, ev.clientY - box.top)
      setView((v) => centerOn(v, p.x, p.y, vpSize.w, vpSize.h))
    }
    go(e)
    const up = () => {
      window.removeEventListener('mousemove', go)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', go)
    window.addEventListener('mouseup', up)
  }
  // a control in a card that takes the keyboard's focus out of view pans the view to the card; the viewport itself
  // never scrolls (it is clipped, and a scroll that gets through anyway is put back)
  const onBoardFocus = (e: ReactFocusEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement
    const id = el.closest('.bcell')?.querySelector('[data-cell]')?.getAttribute('data-cell')
    const r = id ? lay?.rects.get(id) : null
    if (!r || !vp.current) return
    const at = el.getBoundingClientRect()
    const box = vp.current.getBoundingClientRect()
    if (at.left >= box.left && at.right <= box.right && at.top >= box.top && at.bottom <= box.bottom) return
    setView((cur) => centerOn(cur, r.x + r.w / 2, r.y + Math.min(r.h, vpSize.h / cur.scale) / 2, vpSize.w, vpSize.h))
  }
  // a card's page asks to bring a part of it into view (its record opened by a citation): the view pans to that part
  // when it lies outside the viewport, placing its top a third of the way down when it is taller than the viewport
  useEffect(
    () =>
      bus.on('revealBox', ({ rect, frame }) => {
        const box = vp.current?.getBoundingClientRect()
        if (!box || !vp.current?.contains(frame)) return
        if (rect.left >= box.left && rect.right <= box.right && rect.top >= box.top && rect.bottom <= box.bottom) return
        const top = rect.height > box.height ? rect.top + box.height / 6 : rect.top + rect.height / 2
        const c = toPlane(live.current.view, rect.left + rect.width / 2 - box.left, top - box.top)
        setView((v) => centerOn(v, c.x, c.y, vpSize.w, vpSize.h))
      }),
    [vpSize],
  )
  const onBoardScroll = (e: ReactUIEvent<HTMLDivElement>) => {
    e.currentTarget.scrollTop = 0
    e.currentTarget.scrollLeft = 0
  }
  // the status line counts what the board holds
  const drawn = useMemo(() => (board ? { cards: board.cells.length, groups: board.groups.length } : { cards: 0, groups: 0 }), [board])
  const away = !!content && offView(content, view, vpSize.w, vpSize.h)
  const pill = away && content ? pillAt(content, view, vpSize.w, vpSize.h) : null
  const planeStyle: CSSProperties = { transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }
  const dot = 24 * view.scale
  const gridStyle: CSSProperties = { backgroundSize: `${dot}px ${dot}px`, backgroundPosition: `${view.x}px ${view.y}px` }

  // where a thing is drawn: its layout place, or with the drag when it is the dragged thing or inside the dragged frame
  const dragged = drag ? lay?.rects.get(drag.id) : undefined
  const placeOf = (id: string, frameId: string | null, r: Rect): Rect => {
    if (!drag || !dragged || !board) return r
    const inDrag = drag.t === 'c' ? drag.id === id : isWithin(board, frameId, drag.id)
    return inDrag ? { ...r, x: r.x - dragged.x + drag.x, y: r.y - dragged.y + drag.y } : r
  }
  const targetName = drag?.target ? board?.group.get(drag.target)?.name ?? '' : ''
  const tag = drag && drag.t === 'c' && (drag.move || drag.free || !drag.target) ? (drag.free && drag.target ? `Place in ${targetName}` : drag.free ? 'Place freely' : drag.move ? `Move to ${targetName}` : 'Out of group') : null

  return (
    <div className={`board${drag ? ' is-dragging' : ''}`}>
      {(canvasFilter || activeParts(cardFilter).length > 0) && (
        <div className="board-band">
          {canvasFilter && <FilterChip concept={canvasFilter.concept} name={conceptName(concepts, canvasFilter.concept)} value={canvasFilter.value} count={keep?.size} onClear={() => void clearFilter()} />}
          {activeParts(cardFilter).map((part) => (
            <Chip key={part} kind="value" active count={keptBy(filterCards, cardFilter, part)?.size} trailingIcon="x" onClick={() => setCardFilter(clearPart(cardFilter, part))} aria-label={`Clear the filter ${partLabel(cardFilter, part, groupName)}`}>
              {partLabel(cardFilter, part, groupName)}
            </Chip>
          ))}
        </div>
      )}
      <div className="board-stage">
        {!data && !error && !missing && (
          <div className="board-state">
            <Spinner size={14} label="Loading the canvas" />
          </div>
        )}
        {error && <div className="board-state board-error">{error}</div>}
        {data && board && lay && (
          <CanvasContext.Provider value={ctx}>
            <ChipContext.Provider value={{ workspace: ws, broken: EMPTY, anchor: true }}>
              <div className="board-viewport" ref={vp} style={gridStyle} onMouseDown={onBoardDown} onFocus={onBoardFocus} onScroll={onBoardScroll}>
                <div className="board-plane" style={planeStyle}>
                  {[...board.groups]
                    .sort((a, b) => (lay.depth.get(a.id) ?? 0) - (lay.depth.get(b.id) ?? 0))
                    .map((g) => {
                      const r0 = lay.rects.get(g.id)
                      if (!r0) return null
                      const r = placeOf(g.id, g.id, r0)
                      const moving = !!drag && drag.t === 'g' && isWithin(board, g.id, drag.id)
                      const cls = ['frame']
                      if (lay.depth.get(g.id)) cls.push('is-nested')
                      if (drag?.target === g.id) cls.push('is-target')
                      if (drag?.target === g.id && drag.move) cls.push('is-into')
                      if (gsel === g.id) cls.push('is-selected')
                      if (moving) cls.push('is-moving')
                      return (
                        <div key={g.id} className={cls.join(' ')} style={{ left: r.x, top: r.y, width: r.w, height: r.h }} data-group={g.id} data-anchor={`group:${g.id}`} data-anchor-text={g.group.title}>
                          <div className="frame-title" data-cellbox="" onMouseDown={(e) => onTitleDown(e, g.id)} onDoubleClick={(e) => e.stopPropagation()}>
                            <Icon name="chevron-right" size={10} className={`frame-chev${open.has(g.id) ? ' is-open' : ''}`} />
                            {renaming === g.id ? (
                              <input
                                className="frame-rename"
                                defaultValue={g.group.title}
                                autoFocus
                                onFocus={(e) => e.currentTarget.select()}
                                onMouseDown={(e) => e.stopPropagation()}
                                onKeyDown={(e) => {
                                  e.stopPropagation()
                                  if (e.key === 'Enter') rename(g.id, e.currentTarget.value)
                                  if (e.key === 'Escape') setRenaming(null)
                                }}
                                onBlur={(e) => rename(g.id, e.currentTarget.value)}
                                aria-label="Name"
                              />
                            ) : (
                              <span className="frame-name">{g.name}</span>
                            )}
                            <span className="frame-count">{cardCount(board, g.id)}</span>
                            {gsel === g.id && renaming !== g.id && (
                              <TipButton tip="Delete group" className="frame-delete" onMouseDown={(e) => e.stopPropagation()} onClick={() => deleteSelection()}>
                                <Icon name="trash" size={13} />
                              </TipButton>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  {/* from the board as shown, so the card being resized follows the grip */}
                  {(shownBoard ?? board).cells.map((c) => {
                    const r0 = lay.rects.get(c.id)
                    if (!r0) return null
                    const r = placeOf(c.id, c.parent, r0)
                    const isSel = selected.has(c.id)
                    const isDragged = drag?.t === 'c' && drag.id === c.id
                    const inMoving = drag?.t === 'g' && isWithin(board, c.parent, drag.id)
                    const collapsed = !!c.parent && !open.has(c.parent)
                    return (
                      <CellCard
                        key={c.id}
                        cell={c.cell}
                        x={r.x}
                        y={r.y}
                        w={c.w}
                        h={c.h}
                        selected={isSel}
                        alone={isSel && sel.length === 1}
                        collapsed={collapsed}
                        deck={lay.decks.has(c.id)}
                        dragging={isDragged}
                        detailOpen={detail === c.id}
                        editing={editing?.id === c.id ? editing.field : null}
                        z={isDragged ? 50 : inMoving ? 45 : isSel ? 5 : 2}
                        register={register}
                        onPress={cardHooks.onPress}
                        onFocusMode={cardHooks.onFocusMode}
                        onResizeStart={cardHooks.onResizeStart}
                        onAction={cardHooks.onAction}
                        onEdit={cardHooks.onEdit}
                      />
                    )
                  })}
                  {drag?.ins && <div className="board-ins" style={{ left: drag.ins.bar.x, top: drag.ins.bar.y, width: drag.ins.bar.w, height: drag.ins.bar.h }} />}
                  {tag && drag && (
                    <div className="board-tag" style={{ left: drag.x + 8, top: drag.y - 30 }}>
                      {tag}
                    </div>
                  )}
                  {marquee && (marquee.w + marquee.h) * view.scale > 4 && <div className="board-marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} />}
                </div>
              </div>
              {pill && (
                <button type="button" className="board-pill" style={{ left: pill.x, top: pill.y }} onMouseDown={(e) => e.stopPropagation()} onClick={fit}>
                  <Icon name="arrow-right" size={12} style={{ transform: `rotate(${pill.deg}deg)` }} />
                  Content
                </button>
              )}
              <Controls
                board={board}
                lay={lay}
                view={view}
                map={map}
                selected={selected}
                several={sel.length}
                onCell={() => void addCell()}
                onGroup={() => void addGroup()}
                onGroupSelection={() => void groupSelection()}
                onZoom={zoomStep}
                onFit={fit}
                onMinimap={onMinimap}
                filter={cardFilter}
                onFilter={setCardFilter}
                onClear={clearCanvasFilter}
                cards={filterCards}
                groupName={groupName}
                labels={canvasLabels}
                label={canvasFilter ? { concept: canvasFilter.concept, value: canvasFilter.value } : null}
                onLabel={(concept, value) => void setLabelFilter(concept, value)}
                keep={kept}
                filterReady={filters != null}
              />
              {detailCell && <DetailPanel key={detailCell.id} cell={detailCell} cite={cite?.cell === detailCell.id ? cite : null} onClose={() => setDetail(null)} />}
              {labelPanel && !detailCell && <LabelPanel key={labelPanel} conceptId={labelPanel} onClose={() => setLabelPanel(null)} />}
              {focusCell && <Focus cell={focusCell} list={focusList} frame={(focusCell && board.group.get(board.cellById.get(focusCell.id)?.parent ?? '')?.name) || 'Canvas'} onPick={setFocus} onClose={() => setFocus(null)} onAskNew={(id, text) => void askNew(id, text)} />}
            </ChipContext.Provider>
          </CanvasContext.Provider>
        )}
        <div className="board-status">
          {board ? [`${drawn.cards} ${drawn.cards === 1 ? 'card' : 'cards'}`, `${drawn.groups} ${drawn.groups === 1 ? 'group' : 'groups'}`, sel.length ? `${sel.length} selected` : ''].filter(Boolean).join(' · ') : ''}
        </div>
      </div>
    </div>
  )
}

export type { Cell }
