// The main area's panes: a tree of splits whose leaves are panes, each showing one surface or none (Files, Canvas,
// Report, or `view:<slug>`). A surface shows in at most one pane, since each is one mounted component that keeps its
// state. A split lays its two children out as a `row` or `col`, the first taking `ratio` of the room. Every function
// here is pure and returns a new layout.

export type SurfaceId = string
export const BASE_SURFACES = ['files', 'canvas', 'report'] as const
export type BaseSurface = (typeof BASE_SURFACES)[number]
export type Dir = 'row' | 'col'
export type Edge = 'left' | 'right' | 'top' | 'bottom'
export type Zone = Edge | 'center'

export interface PaneLeaf {
  kind: 'pane'
  id: string
  surface: SurfaceId | null
}
export interface PaneSplit {
  kind: 'split'
  dir: Dir
  ratio: number
  a: PaneNode
  b: PaneNode
}
export type PaneNode = PaneLeaf | PaneSplit
export interface Panes {
  root: PaneNode
  focus: string
}

export const PRESETS = ['one', 'columns', 'rows', 'three', 'quadrants'] as const
export type Preset = (typeof PRESETS)[number]
const SLOTS: Record<Preset, number> = { one: 1, columns: 2, rows: 2, three: 3, quadrants: 4 }

/** The gap between panes, which is also the divider's grab strip, in px. */
export const GAP = 12
/** The smallest a pane is drawn: a split or a drag never makes one smaller. */
export const MIN = { w: 240, h: 160 }
/** Below this width or height the area shows the focused pane alone, the layout kept for a larger window. */
export const NARROW = { w: 640, h: 380 }
/** How far in from a pane's edge, as a share of its width or height, a drop splits the pane rather than replacing it. */
const EDGE_SHARE = 0.26

export const isView = (s: SurfaceId | null | undefined): boolean => typeof s === 'string' && s.startsWith('view:')
export const viewSurface = (slug: string): `view:${string}` => `view:${slug}`
export const slugOfSurface = (s: SurfaceId): string | null => (isView(s) ? s.slice(5) : null)

const leaf = (id: string, surface: SurfaceId | null): PaneLeaf => ({ kind: 'pane', id, surface })

/** One pane showing `surface`. */
export function single(surface: SurfaceId | null): Panes {
  return { root: leaf('p1', surface), focus: 'p1' }
}

/** The panes in reading order: left before right, top before bottom. */
export function leaves(node: PaneNode): PaneLeaf[] {
  return node.kind === 'pane' ? [node] : [...leaves(node.a), ...leaves(node.b)]
}

export function findPane(p: Panes, id: string): PaneLeaf | null {
  return leaves(p.root).find((l) => l.id === id) ?? null
}

/** The pane that shows `surface`, or null when none does. */
export function paneOf(p: Panes, surface: SurfaceId): PaneLeaf | null {
  return leaves(p.root).find((l) => l.surface === surface) ?? null
}

export function focused(p: Panes): PaneLeaf {
  return findPane(p, p.focus) ?? leaves(p.root)[0]
}

/** The surfaces the panes show, in reading order; with `narrow`, the focused pane's alone, as the area then draws it. */
export function shownSurfaces(p: Panes, narrow = false): SurfaceId[] {
  const ls = narrow ? [focused(p)] : leaves(p.root)
  return ls.map((l) => l.surface).filter((s): s is SurfaceId => s != null)
}

/** The surface the top bar's tabs mark as read: the focused pane's, and Files for a view drawn alone. */
export function readSurface(p: Panes, alone: boolean): SurfaceId | null {
  const s = focused(p).surface
  return alone && isView(s) ? 'files' : s
}

export function focusPane(p: Panes, id: string): Panes {
  return p.focus === id || !findPane(p, id) ? p : { ...p, focus: id }
}

function newId(root: PaneNode): string {
  const n = Math.max(0, ...leaves(root).map((l) => Number(/^p(\d+)$/.exec(l.id)?.[1] ?? 0)))
  return `p${n + 1}`
}

function mapLeaf(node: PaneNode, id: string, fn: (l: PaneLeaf) => PaneNode): PaneNode {
  if (node.kind === 'pane') return node.id === id ? fn(node) : node
  const a = mapLeaf(node.a, id, fn)
  const b = mapLeaf(node.b, id, fn)
  return a === node.a && b === node.b ? node : { ...node, a, b }
}

function mapLeaves(node: PaneNode, fn: (l: PaneLeaf) => PaneLeaf): PaneNode {
  if (node.kind === 'pane') return fn(node)
  const a = mapLeaves(node.a, fn)
  const b = mapLeaves(node.b, fn)
  return a === node.a && b === node.b ? node : { ...node, a, b }
}

/** The tree without the pane `id`, its sibling taking the split's place; null when `id` was the only pane. */
function removeLeaf(node: PaneNode, id: string): PaneNode | null {
  if (node.kind === 'pane') return node.id === id ? null : node
  const a = removeLeaf(node.a, id)
  const b = removeLeaf(node.b, id)
  if (!a) return b
  if (!b) return a
  return a === node.a && b === node.b ? node : { ...node, a, b }
}

/** Pane `target` shows `surface`. When another pane shows it, the two panes trade surfaces, so a pane dragged onto the
 * centre of another swaps places with it. The target takes the focus. */
export function place(p: Panes, target: string, surface: SurfaceId): Panes {
  const t = findPane(p, target)
  if (!t) return p
  if (t.surface === surface) return focusPane(p, target)
  const from = paneOf(p, surface)
  const root = mapLeaves(p.root, (l) => (l.id === target ? { ...l, surface } : from && l.id === from.id ? { ...l, surface: t.surface } : l))
  return { root, focus: target }
}

/** Pane `target` split at `edge`, the new pane beside it showing `surface`. A surface another pane shows moves: that
 * pane closes. A pane dropped on its own edge stays as it is. The new pane takes the focus. */
export function split(p: Panes, target: string, edge: Edge, surface: SurfaceId): Panes {
  if (!findPane(p, target)) return p
  const from = paneOf(p, surface)
  if (from?.id === target) return p
  const root = from ? removeLeaf(p.root, from.id) ?? p.root : p.root
  const id = newId(p.root)
  const added = leaf(id, surface)
  const dir: Dir = edge === 'left' || edge === 'right' ? 'row' : 'col'
  const first = edge === 'left' || edge === 'top'
  return { root: mapLeaf(root, target, (t) => ({ kind: 'split', dir, ratio: 0.5, a: first ? added : t, b: first ? t : added })), focus: id }
}

/** Pane `id` closed, its sibling taking its room. The last pane stays. A closed focused pane hands the focus to the
 * pane focused before it (`recent`, most recent first), else the first pane. */
export function close(p: Panes, id: string, recent: readonly string[] = []): Panes {
  const root = removeLeaf(p.root, id)
  if (!root || root === p.root) return p
  const ids = new Set(leaves(root).map((l) => l.id))
  const focus = p.focus !== id && ids.has(p.focus) ? p.focus : recent.find((r) => ids.has(r)) ?? leaves(root)[0].id
  return { root, focus }
}

/** The split at `path` (its steps from the root, `a` or `b` each) given `ratio`, kept inside (0, 1). */
export function resize(p: Panes, path: string, ratio: number): Panes {
  const r = Math.min(0.95, Math.max(0.05, ratio))
  const go = (node: PaneNode, rest: string): PaneNode => {
    if (node.kind === 'pane') return node
    if (!rest) return node.ratio === r ? node : { ...node, ratio: r }
    const side = rest[0] === 'a' ? 'a' : 'b'
    const next = go(node[side], rest.slice(1))
    return next === node[side] ? node : { ...node, [side]: next }
  }
  const root = go(p.root, path)
  return root === p.root ? p : { ...p, root }
}

/** Where `surface` shows when something asks for it. The pane that shows it takes the focus; otherwise an empty pane,
 * else (when asked from pane `from`) the most recently focused other pane, else the focused pane. */
export function show(p: Panes, surface: SurfaceId, from: string | null = null, recent: readonly string[] = []): Panes {
  const at = paneOf(p, surface)
  if (at) return focusPane(p, at.id)
  const ls = leaves(p.root)
  const empty = ls.find((l) => l.surface == null)
  if (empty) return place(p, empty.id, surface)
  let target = p.focus
  if (from && ls.length > 1 && ls.some((l) => l.id === from)) {
    const others = ls.map((l) => l.id).filter((id) => id !== from)
    target = [...recent, p.focus].find((id) => id !== from && others.includes(id)) ?? others[0]
  }
  return place(p, target, surface)
}

function shape(preset: Preset, ls: PaneLeaf[]): PaneNode {
  const s = (dir: Dir, a: PaneNode, b: PaneNode): PaneSplit => ({ kind: 'split', dir, ratio: 0.5, a, b })
  switch (preset) {
    case 'one':
      return ls[0]
    case 'columns':
      return s('row', ls[0], ls[1])
    case 'rows':
      return s('col', ls[0], ls[1])
    case 'three':
      return s('row', ls[0], s('col', ls[1], ls[2]))
    case 'quadrants':
      return s('col', s('row', ls[0], ls[1]), s('row', ls[2], ls[3]))
  }
}

/** The layout of a preset: `columns`, `rows`, `three` or `quadrants`. With `order` the panes show those surfaces in
 * reading order; otherwise the current surfaces keep their order and the rest of `available` fill in. The focused
 * surface keeps the focus. */
export function preset(p: Panes, name: Preset, available: readonly SurfaceId[], order?: readonly SurfaceId[]): Panes {
  const n = SLOTS[name]
  const now = focused(p).surface
  const shownNow = shownSurfaces(p)
  let seq: SurfaceId[]
  if (order) seq = unique([...order.filter((s) => available.includes(s) || shownNow.includes(s)), ...available])
  else {
    seq = unique([...(name === 'one' && now ? [now] : []), ...shownNow, ...available])
    if (now && seq.indexOf(now) >= n) seq.splice(n - 1, 0, now)
    seq = unique(seq)
  }
  const ls = Array.from({ length: n }, (_, i) => leaf(`p${i + 1}`, seq[i] ?? null))
  const keep = ls.find((l) => l.surface != null && l.surface === (order ? order[0] : now))
  return { root: shape(name, ls), focus: keep?.id ?? 'p1' }
}

function unique<T>(xs: readonly T[]): T[] {
  return [...new Set(xs)]
}

/** The preset whose shape the layout has, whatever its ratios; null for a shape made by dragging. */
export function presetOf(p: Panes): Preset | null {
  const r = p.root
  const isLeaf = (n: PaneNode) => n.kind === 'pane'
  if (r.kind === 'pane') return 'one'
  if (isLeaf(r.a) && isLeaf(r.b)) return r.dir === 'row' ? 'columns' : 'rows'
  if (r.dir === 'row' && isLeaf(r.a) && r.b.kind === 'split' && r.b.dir === 'col' && isLeaf(r.b.a) && isLeaf(r.b.b)) return 'three'
  if (r.dir === 'col' && r.a.kind === 'split' && r.b.kind === 'split' && r.a.dir === 'row' && r.b.dir === 'row' && [r.a.a, r.a.b, r.b.a, r.b.b].every(isLeaf)) return 'quadrants'
  return null
}

// -------- geometry --------

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}
export interface PaneRect extends Rect {
  id: string
  surface: SurfaceId | null
}
export interface Divider extends Rect {
  /** the split's steps from the root (resize) */
  path: string
  dir: Dir
  /** where the split's first child starts along its axis, and the room its two children share (its span less the gap) */
  from: number
  room: number
  /** the least room each child needs along the axis (minSpan) */
  minA: number
  minB: number
}

/** The least span `node` needs along `dir`'s axis (widths for a row, heights for a column), with every pane at MIN. */
export function minSpan(node: PaneNode, dir: Dir): number {
  const own = dir === 'row' ? MIN.w : MIN.h
  if (node.kind === 'pane') return own
  const a = minSpan(node.a, dir)
  const b = minSpan(node.b, dir)
  return node.dir === dir ? a + GAP + b : Math.max(a, b)
}

/** Each pane's rectangle and each split's divider inside `box`, in whole px. A split's ratio is adjusted as needed to
 * keep both children at their least span (minSpan) while the room holds both. */
export function arrange(root: PaneNode, box: Rect): { panes: PaneRect[]; dividers: Divider[] } {
  const panes: PaneRect[] = []
  const dividers: Divider[] = []
  const go = (node: PaneNode, r: Rect, path: string) => {
    if (node.kind === 'pane') {
      panes.push({ id: node.id, surface: node.surface, ...r })
      return
    }
    const row = node.dir === 'row'
    const span = row ? r.w : r.h
    const room = Math.max(0, span - GAP)
    const minA = minSpan(node.a, node.dir)
    const minB = minSpan(node.b, node.dir)
    let first = Math.round(room * node.ratio)
    if (room >= minA + minB) first = Math.min(room - minB, Math.max(minA, first))
    const start = row ? r.x : r.y
    const a: Rect = row ? { ...r, w: first } : { ...r, h: first }
    const b: Rect = row ? { ...r, x: r.x + first + GAP, w: room - first } : { ...r, y: r.y + first + GAP, h: room - first }
    dividers.push({
      path,
      dir: node.dir,
      from: start,
      room,
      minA,
      minB,
      ...(row ? { x: r.x + first, y: r.y, w: GAP, h: r.h } : { x: r.x, y: r.y + first, w: r.w, h: GAP }),
    })
    go(node.a, a, path + 'a')
    go(node.b, b, path + 'b')
  }
  go(root, box, '')
  return { panes, dividers }
}

/** The ratio a divider dragged to `at` (a coordinate along its axis) gives its split, each child kept at its least span
 * while the room allows. */
export function ratioAt(d: Divider, at: number): number {
  if (d.room <= 0) return 0.5
  const lo = d.minA / d.room
  const hi = 1 - d.minB / d.room
  const r = (at - d.from - GAP / 2) / d.room
  return lo > hi ? 0.5 : Math.min(hi, Math.max(lo, r))
}

/** Whether a pane drawn at `r` has room to split at `edge` into two panes of at least MIN. */
export function splittable(r: Rect, edge: Edge): boolean {
  return edge === 'left' || edge === 'right' ? r.w >= 2 * MIN.w + GAP : r.h >= 2 * MIN.h + GAP
}

/** Where a drop at (`x`, `y`) inside pane rectangle `r` lands: an edge when the point is near it and the pane has room
 * to split there, else the centre. */
export function zoneAt(r: Rect, x: number, y: number): Zone {
  const fx = (x - r.x) / Math.max(1, r.w)
  const fy = (y - r.y) / Math.max(1, r.h)
  const near: [Edge, number][] = [
    ['left', fx],
    ['right', 1 - fx],
    ['top', fy],
    ['bottom', 1 - fy],
  ]
  near.sort((m, n) => m[1] - n[1])
  const [edge, d] = near[0]
  return d < EDGE_SHARE && splittable(r, edge) ? edge : 'center'
}

/** The part of pane rectangle `r` a drop on `zone` gives the dropped surface, drawn while dragging. */
export function previewOf(r: Rect, zone: Zone): Rect {
  const hw = Math.round((r.w - GAP) / 2)
  const hh = Math.round((r.h - GAP) / 2)
  switch (zone) {
    case 'left':
      return { ...r, w: hw }
    case 'right':
      return { ...r, x: r.x + r.w - hw, w: hw }
    case 'top':
      return { ...r, h: hh }
    case 'bottom':
      return { ...r, y: r.y + r.h - hh, h: hh }
    case 'center':
      return r
  }
}

/** Whether the area is too small for more than one pane (NARROW), or, given the layout's `root`, too small to draw each
 * of its panes at MIN. */
export const isNarrow = (w: number, h: number, root?: PaneNode): boolean =>
  w < NARROW.w || h < NARROW.h || (!!root && (minSpan(root, 'row') > w || minSpan(root, 'col') > h))

/** What dropping `surface` on `zone` of pane `target` does, or null when it changes nothing (a pane dropped on
 * itself). */
export function drop(p: Panes, target: string, zone: Zone, surface: SurfaceId): Panes | null {
  const t = findPane(p, target)
  if (!t) return null
  if (t.surface === surface) return null
  const next = zone === 'center' ? place(p, target, surface) : split(p, target, zone, surface)
  return next === p ? null : next
}

// -------- storage --------

/** How deep a stored split may nest: only a guard against malformed stored values. */
const MAX_DEPTH = 32

/** A layout read back from storage, or null when `raw` is not one. Bad ratios become even, duplicate surfaces and
 * pane ids are fixed, and an unknown focus goes to the first pane. */
export function parsePanes(raw: unknown): Panes | null {
  if (!raw || typeof raw !== 'object') return null
  const seen = new Set<string>()
  const ids = new Set<string>()
  let n = 0
  const node = (v: unknown, depth: number): PaneNode | null => {
    if (!v || typeof v !== 'object' || depth > MAX_DEPTH) return null
    const o = v as Record<string, unknown>
    if (o.kind === 'pane') {
      let id = typeof o.id === 'string' && /^p\d+$/.test(o.id) && !ids.has(o.id) ? o.id : ''
      while (!id || ids.has(id)) id = `p${++n + 100}`
      ids.add(id)
      let surface = typeof o.surface === 'string' && o.surface ? o.surface : null
      if (surface && seen.has(surface)) surface = null
      if (surface) seen.add(surface)
      return leaf(id, surface)
    }
    if (o.kind === 'split' && (o.dir === 'row' || o.dir === 'col')) {
      const a = node(o.a, depth + 1)
      const b = node(o.b, depth + 1)
      if (!a || !b) return null
      const ratio = typeof o.ratio === 'number' && o.ratio > 0 && o.ratio < 1 ? o.ratio : 0.5
      return { kind: 'split', dir: o.dir, ratio, a, b }
    }
    return null
  }
  const root = node((raw as { root?: unknown }).root, 0)
  if (!root) return null
  const f = (raw as { focus?: unknown }).focus
  return { root, focus: typeof f === 'string' && ids.has(f) ? f : leaves(root)[0].id }
}
