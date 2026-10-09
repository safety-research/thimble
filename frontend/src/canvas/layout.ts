// The board's layout math, pure.
//
// The board is an infinite plane of frames (groups) and cards (cells). A frame's children are laid out by its flow (a
// column, or a row for a split group) in order: the group's cards, with a nested group after `order` of them. A child
// with a `pos` is placed free inside the frame. A collapsed frame shows its nested groups and its first card, with the
// edges of the others stacked under it. Root frames sit at their `pos`, or below the root before them; loose cards sit
// at their own `pos`. Empty thread groups are not drawn. `View` is the plane's pan and zoom.
import type { ChipTone } from '../components/Chip'
import { isUnread, type SeenMap } from '../chat/seen'
import type { CanvasResponse, Cell, ChatMeta, Filters, FilterScope, Group, LabelRow, Pos } from '../lib/types'

// ---- the frame's metrics ----

/** a frame's padding at the sides and bottom, and above its first row */
export const PAD = 20
export const HEAD = 20
/** the gap between two children in the flow */
export const GAP = 20
/** the room a nested frame's title takes above it */
export const TITLE = 26
/** a frame is never smaller than this */
export const MIN_FRAME_W = 260
export const MIN_FRAME_H = HEAD + 40
/** the room under a collapsed frame's card for the stacked edges */
export const DECK = 14
/** where the first root frame sits, and the gap under a root before the next one */
export const ROOT_X = 40
export const ROOT_Y = 60
export const ROOT_GAP = 80
/** the height a card is taken to have before it is measured */
export const UNMEASURED_H = 160
/** A card's default width, the same in every frame, and the report's text column (tokens.css --w-card). At the default
 * 80% zoom a frame's column fits the canvas of a 1280px window beside the chat. */
export const CARD_W = 720
export const MIN_W = 220
export const MAX_W = 1200
export const MIN_H = 100
/** a click waits this long for a second one before it acts alone: a frame's title opens or collapses, a card's text
 * edits; the second within it is a double click (a rename, focus mode) */
export const DOUBLE_MS = 220

export type Flow = 'col' | 'row'

export const clampWidth = (w: number): number => Math.min(MAX_W, Math.max(MIN_W, Math.round(w)))
export const clampHeight = (h: number): number => Math.max(MIN_H, Math.round(h))

/** A group that belongs to a thread: its chat's cards land in it, beside its anchor card. */
export const isThreadGroup = (g: Pick<Group, 'anchor' | 'chat'>): boolean => !!(g.anchor || g.chat)

/** A split group is a row; every other group a column. */
export const flowOf = (g: Pick<Group, 'kind'>): Flow => (g.kind === 'split' ? 'row' : 'col')

/** A frame on the board. */
export interface BoardGroup {
  id: string
  group: Group
  /** the frame it is nested in; null at the root */
  parent: string | null
  flow: Flow
  pos: Pos | null
  order: number | null
  thread: boolean
  /** its name on the board: a thread's frame drops the `main/` of its path */
  name: string
}

/** A card on the board. */
export interface BoardCell {
  id: string
  cell: Cell
  /** its frame; null for a loose card */
  parent: string | null
  pos: Pos | null
  w: number
  /** its own height; null for the content's */
  h: number | null
}

export interface Board {
  groups: BoardGroup[]
  cells: BoardCell[]
  group: ReadonlyMap<string, BoardGroup>
  cellById: ReadonlyMap<string, BoardCell>
}

/**
 * The board from the canvas route: a frame per group (the loose group draws none: its cards are loose, at the root),
 * a nested group whose parent is not drawn at the root, and a thread's group only while something is in it.
 */
export function boardOf(data: CanvasResponse): Board {
  const loose = new Set(data.groups.filter((g) => g.kind === 'loose').map((g) => g.id))
  const all = new Map(data.groups.filter((g) => !loose.has(g.id)).map((g) => [g.id, g] as const))
  const cellsIn = new Map<string, number>()
  for (const c of data.cells) cellsIn.set(c.notebook, (cellsIn.get(c.notebook) ?? 0) + 1)
  const kidsOf = new Map<string, string[]>()
  for (const g of all.values()) if (g.parent && all.has(g.parent) && g.parent !== g.id) kidsOf.set(g.parent, [...(kidsOf.get(g.parent) ?? []), g.id])
  // a thread's frame is drawn while it or a frame in it holds a card
  const full = (id: string, seen = new Set<string>()): boolean => {
    if (seen.has(id)) return false
    seen.add(id)
    return (cellsIn.get(id) ?? 0) > 0 || (kidsOf.get(id) ?? []).some((k) => full(k, seen))
  }
  const drawn = new Set([...all.values()].filter((g) => !isThreadGroup(g) || full(g.id)).map((g) => g.id))
  // a parent chain that loops, or runs through a group not drawn, ends at the root
  const parentOf = (g: Group): string | null => {
    const p = g.parent
    if (!p || !drawn.has(p) || p === g.id) return null
    const seen = new Set([g.id])
    let q: string | null = p
    while (q) {
      if (seen.has(q)) return null
      seen.add(q)
      q = all.get(q)?.parent ?? null
      if (q && !drawn.has(q)) q = null
    }
    return p
  }
  const groups: BoardGroup[] = []
  for (const g of data.groups) {
    if (!drawn.has(g.id)) continue
    const thread = isThreadGroup(g)
    groups.push({ id: g.id, group: g, parent: parentOf(g), flow: flowOf(g), pos: g.pos ?? null, order: g.order ?? null, thread, name: thread ? g.title.replace(/^main\//, '') : g.title })
  }
  const group = new Map(groups.map((g) => [g.id, g] as const))
  const cells: BoardCell[] = []
  for (const c of data.cells) {
    const parent = group.has(c.notebook) ? c.notebook : null
    if (!parent && !loose.has(c.notebook)) continue
    // a stored width is the analyst's resize (only the resize grip writes one); none takes the default
    cells.push({ id: c.id, cell: c, parent, pos: c.pos ?? null, w: c.width ? clampWidth(c.width) : CARD_W, h: c.height ? clampHeight(c.height) : null })
  }
  // a thread's frame that no one has placed sits right after its anchor card in the anchor's frame
  for (const g of groups) {
    if (!g.thread || g.pos || g.order != null || !g.parent || !g.group.anchor) continue
    const flow = cells.filter((c) => c.parent === g.parent && !c.pos)
    const at = flow.findIndex((c) => c.id === g.group.anchor)
    if (at >= 0) g.order = at + 1
  }
  return { groups, cells, group, cellById: new Map(cells.map((c) => [c.id, c] as const)) }
}

export type Kid = { t: 'g'; it: BoardGroup } | { t: 'c'; it: BoardCell }

/**
 * A frame's children in order: its cards as stored, with each nested group after `order` of the cards in the flow
 * (null: after all, in their own order), then the children placed free.
 */
export function kidsOf(board: Board, parent: string | null): Kid[] {
  const cells = board.cells.filter((c) => c.parent === parent)
  const groups = board.groups.filter((g) => g.parent === parent)
  const flowCells = cells.filter((c) => !c.pos)
  const flowGroups = groups.filter((g) => !g.pos).map((g, i) => ({ g, i })).sort((a, b) => (a.g.order ?? Infinity) - (b.g.order ?? Infinity) || a.i - b.i).map((x) => x.g)
  const out: Kid[] = []
  let gi = 0
  for (let i = 0; i <= flowCells.length; i++) {
    while (gi < flowGroups.length && (flowGroups[gi].order ?? Infinity) <= i) out.push({ t: 'g', it: flowGroups[gi++] })
    if (i < flowCells.length) out.push({ t: 'c', it: flowCells[i] })
  }
  while (gi < flowGroups.length) out.push({ t: 'g', it: flowGroups[gi++] })
  for (const c of cells) if (c.pos) out.push({ t: 'c', it: c })
  for (const g of groups) if (g.pos) out.push({ t: 'g', it: g })
  return out
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Layout {
  /** every drawn frame and card, in plane pixels */
  rects: Map<string, Rect>
  /** the cards drawn with the edges of the others under them (the first card of a collapsed frame of several) */
  decks: Set<string>
  /** each frame's depth, 0 at the root */
  depth: Map<string, number>
}

/** A card's height: its own, else the measured content, else a guess until it is measured. */
export const cellHeight = (c: BoardCell, heights: Readonly<Record<string, number>>): number => c.h ?? heights[c.id] ?? UNMEASURED_H

/**
 * Where every frame and card sits. `open` names the expanded frames; `heights` the measured height of each card with
 * no height of its own. Pure, so a drag and a reload agree.
 */
export function layoutBoard(board: Board, open: ReadonlySet<string>, heights: Readonly<Record<string, number>>): Layout {
  const rel = new Map<string, Pos>()
  const size = new Map<string, { w: number; h: number }>()
  const decks = new Set<string>()
  const shown = (g: BoardGroup): Kid[] => {
    const all = kidsOf(board, g.id)
    if (open.has(g.id)) return all
    // collapsed: the nested groups and the first card, in their flow order, each at its flow place
    const first = all.find((k) => k.t === 'c' && !k.it.pos) ?? all.find((k) => k.t === 'c')
    const kept: Kid[] = all.filter((k) => k.t === 'g' || k === first)
    return kept.map((k) => (k.t === 'g' ? { t: 'g', it: { ...k.it, pos: null } } : { t: 'c', it: { ...k.it, pos: null } }))
  }
  const measure = (g: BoardGroup): { w: number; h: number } => {
    const ks = shown(g)
    let x = PAD
    let y = HEAD
    let maxW = 0
    let maxH = 0
    for (const k of ks) {
      const s = k.t === 'g' ? measure(k.it) : { w: k.it.w, h: cellHeight(k.it, heights) }
      const title = k.t === 'g' ? TITLE : 0
      let p: Pos
      if (k.it.pos) p = k.it.pos
      else if (g.flow === 'row') {
        p = { x, y: HEAD + title }
        x += s.w + GAP
      } else {
        p = { x: PAD, y: y + title }
        y += s.h + GAP + title
      }
      rel.set(k.it.id, p)
      maxW = Math.max(maxW, p.x + s.w)
      maxH = Math.max(maxH, p.y + s.h)
    }
    const cards = board.cells.filter((c) => c.parent === g.id).length
    const deck = !open.has(g.id) && cards > 1
    if (deck) {
      const first = ks.find((k) => k.t === 'c')
      if (first) decks.add(first.it.id)
    }
    const sz = { w: Math.max(MIN_FRAME_W, maxW + PAD), h: Math.max(MIN_FRAME_H, maxH + PAD + (deck ? DECK : 0)) }
    size.set(g.id, sz)
    return sz
  }
  const roots = board.groups.filter((g) => !g.parent)
  for (const g of roots) measure(g)
  const rects = new Map<string, Rect>()
  const depth = new Map<string, number>()
  const place = (g: BoardGroup, x: number, y: number, d: number) => {
    const sz = size.get(g.id)!
    rects.set(g.id, { x, y, w: sz.w, h: sz.h })
    depth.set(g.id, d)
    for (const k of shown(g)) {
      const p = rel.get(k.it.id)!
      if (k.t === 'g') place(k.it, x + p.x, y + p.y, d + 1)
      else rects.set(k.it.id, { x: x + p.x, y: y + p.y, w: k.it.w, h: cellHeight(k.it, heights) })
    }
  }
  let topY = ROOT_Y
  for (const g of roots) {
    const p = g.pos ?? { x: ROOT_X, y: topY }
    place(g, p.x, p.y, 0)
    topY = Math.max(topY, p.y + size.get(g.id)!.h + ROOT_GAP)
  }
  for (const c of board.cells) {
    if (c.parent) continue
    const p = c.pos ?? { x: ROOT_X, y: topY }
    const h = cellHeight(c, heights)
    rects.set(c.id, { x: p.x, y: p.y, w: c.w, h })
    if (!c.pos) topY += h + GAP
  }
  return { rects, decks, depth }
}

/** Whether frame `id` is `of` or nested anywhere under it. */
export function isWithin(board: Board, id: string | null, of: string): boolean {
  const seen = new Set<string>()
  let g = id ? board.group.get(id) : undefined
  while (g && !seen.has(g.id)) {
    if (g.id === of) return true
    seen.add(g.id)
    g = g.parent ? board.group.get(g.parent) : undefined
  }
  return false
}

export const contains = (r: Rect, p: Pos): boolean => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h
export const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y

/** The innermost drawn frame under the point, leaving out `exclude` and everything in it (a frame being dragged). */
export function frameAt(board: Board, lay: Layout, p: Pos, exclude: string | null = null): string | null {
  let best: string | null = null
  let bestDepth = -1
  for (const g of board.groups) {
    const r = lay.rects.get(g.id)
    if (!r || !contains(r, p) || (exclude && isWithin(board, g.id, exclude))) continue
    const d = lay.depth.get(g.id) ?? 0
    if (d > bestDepth) {
      best = g.id
      bestDepth = d
    }
  }
  return best
}

/** Snap distance, in plane pixels, for the insertion bar. */
export const SNAP = 36

/**
 * Where a dragged card would land in a frame's flow: `index` among the frame's other flow cards, and the accent bar
 * (x, y, w, h) in the gap; or beside a sibling (`side` L or R of `ref`), which places the card free there. Null when
 * the pointer is not within SNAP of a gap or a side.
 */
export interface Insertion {
  index: number
  side?: 'L' | 'R'
  ref?: string
  bar: Rect
}

export function insertionAt(board: Board, lay: Layout, target: string, p: Pos, dragged: string): Insertion | null {
  const g = board.group.get(target)
  if (!g) return null
  const sibs = kidsOf(board, target).filter((k): k is { t: 'c'; it: BoardCell } => k.t === 'c' && !k.it.pos && k.it.id !== dragged && lay.rects.has(k.it.id))
  const half = GAP / 2
  // beside a sibling, in a column: the pointer level with the card and near one of its sides
  if (g.flow === 'col') {
    for (const [i, s] of sibs.entries()) {
      const r = lay.rects.get(s.it.id)!
      if (p.y < r.y || p.y > r.y + r.h) continue
      if (Math.abs(p.x - (r.x - half)) < SNAP) return { index: i, side: 'L', ref: s.it.id, bar: { x: r.x - half - 1, y: r.y, w: 2, h: r.h } }
      if (Math.abs(p.x - (r.x + r.w + half)) < SNAP) return { index: i + 1, side: 'R', ref: s.it.id, bar: { x: r.x + r.w + half - 1, y: r.y, w: 2, h: r.h } }
    }
  }
  let best: (Insertion & { d: number }) | null = null
  for (const [i, s] of sibs.entries()) {
    const r = lay.rects.get(s.it.id)!
    const inY = p.y >= r.y && p.y <= r.y + r.h
    const inX = p.x >= r.x && p.x <= r.x + r.w
    const cands: (Insertion & { d: number })[] =
      g.flow === 'row'
        ? [
            { index: i, bar: { x: r.x - half - 1, y: r.y, w: 2, h: r.h }, d: Math.abs(p.x - (r.x - half)) + (inY ? 0 : 999) },
            { index: i + 1, bar: { x: r.x + r.w + half - 1, y: r.y, w: 2, h: r.h }, d: Math.abs(p.x - (r.x + r.w + half)) + (inY ? 0 : 999) },
          ]
        : [
            { index: i, bar: { x: r.x, y: r.y - half - 1, w: r.w, h: 2 }, d: Math.abs(p.y - (r.y - half)) + (inX ? 0 : 999) },
            { index: i + 1, bar: { x: r.x, y: r.y + r.h + half - 1, w: r.w, h: 2 }, d: Math.abs(p.y - (r.y + r.h + half)) + (inX ? 0 : 999) },
          ]
    for (const c of cands) if (c.d < SNAP && (!best || c.d < best.d)) best = c
  }
  if (!best) return null
  const { d: _d, ...ins } = best
  return ins
}

/** The ids of the drawn cards a marquee touches. */
export function cardsIn(board: Board, lay: Layout, box: Rect): string[] {
  return board.cells.filter((c) => {
    const r = lay.rects.get(c.id)
    return !!r && overlaps(r, box)
  }).map((c) => c.id)
}

/** The smallest box around `rects`; null for none. */
export function extentOf(rects: Iterable<Rect>): Rect | null {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const b of rects) {
    x0 = Math.min(x0, b.x)
    y0 = Math.min(y0, b.y)
    x1 = Math.max(x1, b.x + b.w)
    y1 = Math.max(y1, b.y + b.h)
  }
  return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

// ---- edits to the canvas data, made at once while the route runs (the reload that follows agrees with them) ----

/** the id a loose group has locally until the move route has made the real one */
export const LOOSE_LOCAL = '__loose'

/**
 * The canvas with cards moved as `POST /cells/move` moves them: into `group` (null: the loose group) after the card
 * `after` names (null first, undefined last) or free at `pos`, keeping their order.
 */
export function moveLocal(data: CanvasResponse, ids: readonly string[], group: string | null, after: string | null | undefined, pos: Pos | null): CanvasResponse {
  let groups = data.groups
  let target = group
  if (target == null) {
    target = groups.find((g) => g.kind === 'loose')?.id ?? LOOSE_LOCAL
    if (!groups.some((g) => g.id === target)) groups = [...groups, { id: target, title: '', parent: null, kind: 'loose', anchor: null, chat: null, role: 'analyst' }]
  }
  const moving = ids.map((id) => data.cells.find((c) => c.id === id)).filter((c): c is Cell => !!c)
  const moved = moving.map((c) => ({ ...c, notebook: target!, pos }))
  const rest = data.cells.filter((c) => !ids.includes(c.id))
  let at: number
  if (after) at = rest.findIndex((c) => c.id === after) + 1
  else {
    const mine = rest.map((c, i) => (c.notebook === target ? i : -1)).filter((i) => i >= 0)
    at = after === null ? mine[0] ?? rest.length : mine.length ? mine[mine.length - 1] + 1 : rest.length
  }
  if (at <= 0 && after) at = rest.length
  return { groups, cells: [...rest.slice(0, at), ...moved, ...rest.slice(at)] }
}

/** The canvas with a group's fields changed. */
export const patchGroupLocal = (data: CanvasResponse, id: string, patch: Partial<Group>): CanvasResponse => ({ ...data, groups: data.groups.map((g) => (g.id === id ? { ...g, ...patch } : g)) })

/** The canvas with a card's fields changed. */
export const patchCellLocal = (data: CanvasResponse, id: string, patch: Partial<Cell>): CanvasResponse => ({ ...data, cells: data.cells.map((c) => (c.id === id ? { ...c, ...patch } : c)) })

/** The canvas without these cards, and without these groups and everything in them. */
export function removeLocal(data: CanvasResponse, cells: readonly string[], groups: readonly string[]): CanvasResponse {
  const gone = new Set<string>()
  const drop = (id: string) => {
    if (gone.has(id)) return
    gone.add(id)
    for (const g of data.groups) if (g.parent === id) drop(g.id)
  }
  for (const g of groups) drop(g)
  return { groups: data.groups.filter((g) => !gone.has(g.id)), cells: data.cells.filter((c) => !cells.includes(c.id) && !gone.has(c.notebook)) }
}

/** The analyst's own group, where a new card goes: role analyst, a root, no thread; with several, the one with the most cards. */
export function analystGroup(groups: readonly Group[]): Group | null {
  const own = groups.filter((g) => (g.role || 'analyst') === 'analyst' && !isThreadGroup(g) && !g.parent && g.kind !== 'loose')
  if (!own.length) return null
  return [...own].sort((a, b) => (b.n_cells ?? 0) - (a.n_cells ?? 0))[0]
}

/**
 * The frame the analyst has active: the frame whose title is selected, else the frame of the selected cards when they
 * all sit in one; null otherwise. The server puts a model's card there when the call names no group.
 */
export function activeFrame(board: Board, frame: string | null, cards: readonly string[]): string | null {
  if (frame) return board.group.has(frame) ? frame : null
  const parents = new Set(cards.map((id) => board.cellById.get(id)?.parent ?? null))
  if (parents.size !== 1) return null
  const [p] = parents
  return p && board.group.has(p) ? p : null
}

/** `Group N` for a new group: one past the highest N the groups have. */
export function nextGroupTitle(groups: readonly Pick<Group, 'title'>[]): string {
  const n = Math.max(0, ...groups.map((g) => Number(/^Group (\d+)$/.exec(g.title)?.[1] ?? 0)))
  return `Group ${n + 1}`
}

/** How many cards are in a frame and every frame under it, leaving out the frames in `hide` (not drawn). */
export function cardCount(board: Board, id: string): number {
  return board.cells.filter((c) => c.parent && isWithin(board, c.parent, id)).length
}

// ---- the minimap: a fixed scale over the content and a margin, centred in the box, the viewfinder held inside it ----

export const MINIMAP = { w: 180, h: 116, pad: 4, margin: 200 }

export interface Minimap {
  /** plane point -> minimap point */
  x: (px: number) => number
  y: (py: number) => number
  k: number
  /** the minimap point -> plane point */
  toPlane: (mx: number, my: number) => Pos
  /** the viewfinder, held inside the minimap */
  view: Rect
}

export function minimapOf(content: Rect | null, view: View, vw: number, vh: number): Minimap {
  const c = content ?? { x: 0, y: 0, w: vw, h: vh }
  const X0 = Math.min(0, c.x) - MINIMAP.margin
  const Y0 = Math.min(0, c.y) - MINIMAP.margin
  const X1 = c.x + c.w + MINIMAP.margin
  const Y1 = c.y + c.h + MINIMAP.margin
  const inner = { w: MINIMAP.w - 2 * MINIMAP.pad, h: MINIMAP.h - 2 * MINIMAP.pad }
  const k = Math.min(inner.w / (X1 - X0), inner.h / (Y1 - Y0))
  // the side the content does not fill is split evenly, so a tall board sits in the middle and not in a corner
  const ox = MINIMAP.pad + (inner.w - (X1 - X0) * k) / 2
  const oy = MINIMAP.pad + (inner.h - (Y1 - Y0) * k) / 2
  const x = (px: number) => ox + (px - X0) * k
  const y = (py: number) => oy + (py - Y0) * k
  const v = toPlane(view, 0, 0)
  const rw = Math.max(10, Math.min(inner.w, (vw / view.scale) * k))
  const rh = Math.max(8, Math.min(inner.h, (vh / view.scale) * k))
  return {
    x,
    y,
    k,
    toPlane: (mx, my) => ({ x: X0 + (mx - ox) / k, y: Y0 + (my - oy) / k }),
    view: { x: Math.max(2, Math.min(MINIMAP.w - 2 - rw, x(v.x))), y: Math.max(2, Math.min(MINIMAP.h - 2 - rh, y(v.y))), w: rw, h: rh },
  }
}

// ---- the plane's pan and zoom ----

export interface View {
  /** where the plane's origin sits in the viewport, in screen px */
  x: number
  y: number
  scale: number
}

/** the board opens at 80% */
export const DEFAULT_VIEW: View = { x: 0, y: 40, scale: 0.8 }
export const MIN_SCALE = 0.2
export const MAX_SCALE = 2
export const ZOOM_STEP = 0.1
/** the lowest zoom Fit goes to, so that it shows a board whole that MIN_SCALE does not; zooming out goes no further
 * than the view already is, and zooming in goes back up through MIN_SCALE */
export const FIT_MIN_SCALE = 0.02

/** `s` held to [min, MAX_SCALE]; 1 for anything that is not a number. */
export const clampScale = (s: number, min = MIN_SCALE): number => Math.min(MAX_SCALE, Math.max(min, Number.isFinite(s) ? s : 1))

/** The zoom control's reading: the zoom as a whole percentage. */
export const zoomLabel = (scale: number): string => `${Math.round(scale * 100)}%`

/** The view after zooming to `scale` about the screen point (px, py), which stays put. */
export function zoomTo(view: View, scale: number, px: number, py: number): View {
  const s = clampScale(scale, Math.min(MIN_SCALE, view.scale))
  const k = s / view.scale
  return { scale: s, x: px - (px - view.x) * k, y: py - (py - view.y) * k }
}

/** One step of the − and + buttons: a tenth, on the tenths; − below MIN_SCALE, where only Fit goes, keeps the zoom. */
export const stepZoom = (scale: number, dir: 1 | -1): number =>
  dir < 0 && scale <= MIN_SCALE ? scale : clampScale(Math.round((scale + dir * ZOOM_STEP) * 10) / 10)

export const panBy = (view: View, dx: number, dy: number): View => ({ ...view, x: view.x + dx, y: view.y + dy })
export const toPlane = (view: View, px: number, py: number): Pos => ({ x: (px - view.x) / view.scale, y: (py - view.y) / view.scale })
export const toScreen = (view: View, x: number, y: number): Pos => ({ x: x * view.scale + view.x, y: y * view.scale + view.y })

export interface WheelLike {
  deltaX: number
  deltaY: number
  /** 0 pixels, 1 lines, 2 pages (WheelEvent.deltaMode) */
  deltaMode?: number
  ctrlKey?: boolean
  metaKey?: boolean
}

/** zoom per wheel pixel */
export const WHEEL_ZOOM = 0.002

/** A wheel gesture: ⌘ or ctrl (a pinch arrives as ctrl) zooms about the pointer at (px, py); anything else pans. */
export function wheelView(view: View, e: WheelLike, px: number, py: number): View {
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1
  const dx = e.deltaX * unit
  const dy = e.deltaY * unit
  if (e.ctrlKey || e.metaKey) return zoomTo(view, view.scale * Math.exp(-dy * WHEEL_ZOOM), px, py)
  return panBy(view, -dx, -dy)
}

/** The view that shows `content` whole in the viewport (vw × vh, less `right` for the controls), centred, at most 100%
 * and at least FIT_MIN_SCALE. */
export function fitView(content: Rect | null, vw: number, vh: number, pad = 48, right = 0): View {
  if (!content || content.w <= 0 || content.h <= 0) return DEFAULT_VIEW
  const w = Math.max(100, vw - right)
  const scale = clampScale(Math.min((w - 2 * pad) / content.w, (vh - 2 * pad) / content.h, 1), FIT_MIN_SCALE)
  const x = content.w * scale > w - 2 * pad ? pad - content.x * scale : (w - content.w * scale) / 2 - content.x * scale
  const y = content.h * scale > vh - 2 * pad ? pad - content.y * scale : (vh - content.h * scale) / 2 - content.y * scale
  return { scale, x, y }
}

/** The same zoom, panned so the plane point (x, y) sits at the viewport's centre. */
export const centerOn = (view: View, x: number, y: number, vw: number, vh: number): View => ({ ...view, x: vw / 2 - x * view.scale, y: vh / 2 - y * view.scale })

/** The zoom the canvas opens a frame or a card at, at least: the default's, where a card's text reads. A view zoomed in
 * further keeps its own zoom. */
export const READABLE_SCALE = DEFAULT_VIEW.scale
/** the screen room above a frame's title when the view opens on the frame, and beside it when it is wider than the room */
export const OPEN_MARGIN = 32

/** `view` at a zoom that reads: its own, or READABLE_SCALE when it is zoomed out further. */
export const readable = (view: View): View => (view.scale >= READABLE_SCALE ? view : { ...view, scale: READABLE_SCALE })

/**
 * The view that opens on the frame at `r` from its top, at a readable zoom, its title OPEN_MARGIN below the viewport's
 * top, centred across the viewport less `right` (or at its left margin when wider). Pure.
 */
export function openOn(view: View, r: Rect, vw: number, right = 0): View {
  const { scale } = readable(view)
  const room = Math.max(100, vw - right)
  const w = r.w * scale
  const x = w + 2 * OPEN_MARGIN > room ? OPEN_MARGIN - r.x * scale : (room - w) / 2 - r.x * scale
  return { scale, x, y: OPEN_MARGIN + TITLE * scale - r.y * scale }
}

/** The frame the canvas first opens on: the orientation's deck (the root frame of role exploration), else the root frame
 * drawn highest; null for a board with no frame. Pure. */
export function openingFrame(board: Board, lay: Layout): string | null {
  const roots = board.groups.filter((g) => !g.parent && lay.rects.has(g.id))
  const deck = roots.find((g) => g.group.role === 'exploration')
  if (deck) return deck.id
  const top = roots.map((g) => ({ id: g.id, y: lay.rects.get(g.id)!.y })).sort((a, b) => a.y - b.y)[0]
  return top?.id ?? null
}

/** Whether the viewport shows none of `content`. */
export function offView(content: Rect | null, view: View, vw: number, vh: number): boolean {
  if (!content) return false
  const v = { ...toPlane(view, 0, 0), w: vw / view.scale, h: vh / view.scale }
  return !overlaps(v, content)
}

/**
 * Where the "Content" pill sits: on the viewport's edge, in the direction of the content's centre, `inset` px in; and
 * the arrow's angle in degrees.
 */
export function pillAt(content: Rect, view: View, vw: number, vh: number, inset = 40): { x: number; y: number; deg: number } {
  const v = toPlane(view, 0, 0)
  const dx = content.x + content.w / 2 - (v.x + vw / view.scale / 2)
  const dy = content.y + content.h / 2 - (v.y + vh / view.scale / 2)
  const ang = Math.atan2(dy, dx)
  const t = Math.min(Math.abs((vw / 2 - inset) / (Math.cos(ang) || 1e-6)), Math.abs((vh / 2 - inset) / (Math.sin(ang) || 1e-6)))
  return { x: vw / 2 + Math.cos(ang) * t, y: vh / 2 + Math.sin(ang) * t, deg: (ang * 180) / Math.PI }
}

// ---- refs, threads, filters and small helpers ----

/** `card:<id>` (or `cell:<id>`), a bare id, or a card ref with a suffix -> the card id; null for anything that is not one card. */
export function anchorCellId(anchor: string | null | undefined): string | null {
  const a = (anchor ?? '').trim()
  if (!a) return null
  if (a.includes(',')) return anchorCellId(a.split(',')[0])
  const m = /^(?:card|cell):([A-Za-z0-9_-]+)/.exec(a)
  if (m) return m[1]
  return /^[A-Za-z0-9_-]+$/.test(a) && !a.includes(':') ? a : null
}

/** A frame's first card, in its order (kidsOf): where focus mode opens when the way in names the frame rather than a
 * card (a chip, Enter on the frame); null for a frame with no card of its own. */
export function firstCardOf(board: Board, frame: string): string | null {
  const k = kidsOf(board, frame).find((x) => x.t === 'c')
  return k ? k.it.id : null
}

/** The frames a card or a frame sits in, outermost first (the frames to open to show it). */
export function framesAbove(board: Board, id: string): string[] {
  const start = board.cellById.get(id)?.parent ?? board.group.get(id)?.parent ?? null
  const out: string[] = []
  const seen = new Set<string>()
  let g = start ? board.group.get(start) : undefined
  while (g && !seen.has(g.id)) {
    seen.add(g.id)
    out.unshift(g.id)
    g = g.parent ? board.group.get(g.parent) : undefined
  }
  return out
}

/** The cards of the threads anchored on each card that have a reply the analyst has not read: the cards carry the dot. */
export function unreadAnchors(chats: readonly ChatMeta[], seen: SeenMap): Set<string> {
  const out = new Set<string>()
  for (const m of chats) {
    if (m.kind !== 'thread') continue
    const id = anchorCellId(m.anchor)
    if (id && isUnread(seen, m.id, m.n_messages)) out.add(id)
  }
  return out
}

/** The set of card ids a label's rows name (`card:<id>` or `cell:<id>`, with or without a suffix). */
export function filterSet(rows: readonly Pick<LabelRow, 'ref'>[]): Set<string> {
  const out = new Set<string>()
  for (const r of rows) {
    const id = anchorCellId(r.ref)
    if (id && (r.ref.startsWith('card:') || r.ref.startsWith('cell:'))) out.add(id)
  }
  return out
}

/** The filter scope a label's unit implies. */
export function scopeForUnit(unit: string | undefined): FilterScope | null {
  switch (unit) {
    case 'record':
      return 'files'
    case 'cell':
      return 'canvas'
    case 'span':
      return 'report'
    default:
      return null
  }
}

/** Whether `filters[scope]` is exactly this concept and value. */
export const filterIs = (filters: Filters | null | undefined, scope: FilterScope, concept: string, value: string): boolean => filters?.[scope]?.concept === concept && filters?.[scope]?.value === value

/** The chip tone for a `whoMade` word: thimble accent, orient warning, the analyst and anyone else neutral. */
export const WHO_TONE: Readonly<Record<string, ChipTone>> = { thimble: 'accent', orient: 'warning' }
export const whoTone = (who: string): ChipTone => WHO_TONE[who] ?? 'neutral'

/** `you` for the analyst, `thimble` for a chat, `orient` for the orientation, else the creator as written. */
export function whoMade(createdBy: string | null | undefined): string {
  const c = createdBy ?? ''
  if (!c || c === 'user' || c === 'terminal') return 'you'
  if (c.startsWith('chat:')) return 'thimble'
  return c
}

/** The thread a card came from: its chat, and its name as the card's foot shows it. */
export interface CellThread {
  /** the chat to go back to; null when the maker is not a chat */
  chatId: string | null
  /** `main`, a thread's name, or an agent's role (`orient`), in mono */
  name: string
  /** main or a thread: a chat the analyst can write to */
  writable: boolean
}

/**
 * The analyst's own cards and a chat's cards say which thread made them (the analyst's say `main`, an agent's its role:
 * `orient`); anything else is named as written and has no chat to open.
 */
export function cellThread(createdBy: string | null | undefined, chats: ReadonlyMap<string, Pick<ChatMeta, 'kind' | 'role' | 'title'>>): CellThread {
  const c = createdBy ?? ''
  const chatId = c.startsWith('chat:') ? c.slice(5) : !c || c === 'user' || c === 'terminal' ? 'main' : null
  if (!chatId) return { chatId: null, name: c, writable: false }
  if (chatId === 'main') return { chatId, name: 'main', writable: true }
  const m = chats.get(chatId)
  if (!m) return { chatId, name: chatId, writable: false }
  if (m.kind === 'agent') return { chatId, name: m.role || m.title || chatId, writable: false }
  return { chatId, name: m.title || chatId, writable: m.kind === 'thread' || m.kind === 'main' }
}

/** HH:MM of an ISO timestamp in the browser's zone; '' for none, the raw text for an unreadable one. */
export { hhmm } from '../lib/time'

export const kindOf = (c: Cell): string => (c.kind === 'md' ? 'note' : c.kind || 'code')
export const RUNNABLE = new Set(['plot', 'table', 'code', 'timeline', 'diagram'])
/** A card the kernel runs: a runnable kind with code, or without a dataset payload. */
export const isRunnable = (c: Cell): boolean => {
  const k = kindOf(c)
  if (!RUNNABLE.has(k)) return false
  if (k === 'timeline' || k === 'diagram') return !!c.code || (c.payload as { dataset?: unknown } | undefined)?.dataset == null
  return true
}

// ---- the comments beside the cards ----

/** a comment's width on the plane, the gap between its card's outermost frame and it, the gap between two stacked
 * comments, and how far below its card's top a comment on the card sits */
export const COMMENT_W = 300
export const COMMENT_GAP_X = 18
export const COMMENT_GAP_Y = 8
export const COMMENT_LIFT = 14
/** how far above its step's row a comment on a step sits */
export const COMMENT_STEP_LIFT = 4

/** A comment to place: its card, its height, and where in the card it points (`dy`, plane px below the card's top:
 * COMMENT_LIFT for the card, its step row's offset less COMMENT_STEP_LIFT for a step). */
export interface CommentSpot {
  id: string
  card: string
  dy: number
  h: number
}

/** Where a comment sits on the plane (`x`, `y`, its top left), and the point of its card it points at (`ax`, `ay`: the
 * card's right edge, level with the comment's wanted top). */
export interface CommentPlace {
  x: number
  y: number
  ax: number
  ay: number
}

/** The frame at the root of the frames a card is in, or null for a loose card. */
export function rootFrameOf(board: Board, card: string): string | null {
  let g = board.cellById.get(card)?.parent ?? null
  const seen = new Set<string>()
  while (g && !seen.has(g)) {
    seen.add(g)
    const up = board.group.get(g)?.parent ?? null
    if (!up) return g
    g = up
  }
  return g
}

/**
 * Where each comment sits beside the canvas: COMMENT_GAP_X right of its card's outermost frame (a loose card's own
 * right edge), at its card's top plus its `dy`; the comments of one column (one x) are stacked in the order of their
 * wanted tops, each pushed below the one before it by COMMENT_GAP_Y, so none overlap. A comment whose card is not
 * drawn gets no place. Pure.
 */
export function commentPlaces(board: Board, lay: Layout, spots: readonly CommentSpot[]): Map<string, CommentPlace> {
  const columns = new Map<string, { id: string; want: number; h: number; x: number; ax: number }[]>()
  for (const s of spots) {
    const r = lay.rects.get(s.card)
    if (!r) continue
    const root = rootFrameOf(board, s.card)
    const outer = (root && lay.rects.get(root)) || r
    const x = outer.x + outer.w + COMMENT_GAP_X
    // the comments at one x make one column, beside one frame or beside frames and loose cards that end at one edge
    const key = String(Math.round(x))
    const list = columns.get(key) ?? []
    list.push({ id: s.id, want: r.y + s.dy, h: s.h, x, ax: r.x + r.w })
    columns.set(key, list)
  }
  const out = new Map<string, CommentPlace>()
  for (const list of columns.values()) {
    list.sort((a, b) => a.want - b.want)
    let low = -Infinity
    for (const it of list) {
      const y = Math.max(it.want, low)
      out.set(it.id, { x: it.x, y, ax: it.ax, ay: it.want })
      low = y + it.h + COMMENT_GAP_Y
    }
  }
  return out
}
