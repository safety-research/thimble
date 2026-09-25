// The main area's layout (src/shell/panes.ts): a tree of splits whose panes each show one surface or none. A surface
// shows in at most one pane; splitting at an edge moves a surface another pane shows; dropping on a pane's centre
// swaps the two panes; closing hands the room to the sibling and the focus to the pane focused before; the presets
// keep the surfaces shown; a request to show a surface focuses the pane that shows it, else takes another pane than the
// one it came from; the geometry keeps every pane at its least size; a stored layout is read back or refused. A chip
// asks the shell for its surface, except a file's, which Files asks for once it knows the place (a view a pane shows on
// its own may take it); a layout main asked for reaches the bus from the stream.
import { describe, expect, test } from 'vitest'
import { bus } from '../../src/lib/bus.ts'
import { dispatch } from '../../src/lib/events.ts'
import { teleport } from '../../src/lib/teleport.ts'
import {
  arrange,
  close,
  drop,
  GAP,
  isNarrow,
  leaves,
  MIN,
  paneOf,
  parsePanes,
  place,
  preset,
  presetOf,
  previewOf,
  readSurface,
  ratioAt,
  resize,
  show,
  shownSurfaces,
  single,
  split,
  splittable,
  zoneAt,
  type Panes,
} from '../../src/shell/panes.ts'

const ALL = ['files', 'canvas', 'report']
const surfaces = (p: Panes) => leaves(p.root).map((l) => l.surface)

describe('splitting, placing and closing', () => {
  test('a surface dropped on an edge splits the pane, on the side of that edge, and the new pane takes the focus', () => {
    const one = single('report')
    const right = split(one, 'p1', 'right', 'files')
    expect(surfaces(right)).toEqual(['report', 'files'])
    expect(right.root).toMatchObject({ kind: 'split', dir: 'row', ratio: 0.5 })
    expect(right.focus).toBe(paneOf(right, 'files')!.id)
    const top = split(one, 'p1', 'top', 'canvas')
    expect(surfaces(top)).toEqual(['canvas', 'report'])
    expect(top.root).toMatchObject({ dir: 'col' })
    expect(one, 'the layout given is left as it was').toEqual(single('report'))
  })

  test('a surface another pane shows moves: its old pane closes, so no surface shows twice', () => {
    const two = split(single('report'), 'p1', 'right', 'files')
    const moved = split(two, paneOf(two, 'report')!.id, 'bottom', 'files')
    expect(surfaces(moved)).toEqual(['report', 'files'])
    expect(moved.root).toMatchObject({ dir: 'col' })
    expect(new Set(surfaces(moved)).size).toBe(surfaces(moved).length)
  })

  test('a pane dropped on its own edge or centre changes nothing', () => {
    const two = split(single('report'), 'p1', 'right', 'files')
    const files = paneOf(two, 'files')!.id
    expect(split(two, files, 'left', 'files')).toBe(two)
    expect(drop(two, files, 'center', 'files')).toBeNull()
    expect(drop(two, files, 'left', 'files')).toBeNull()
  })

  test("dropping on a pane's centre shows the surface there; two panes trade surfaces when both show one", () => {
    const two = split(single('report'), 'p1', 'right', 'files')
    const swapped = place(two, paneOf(two, 'report')!.id, 'files')
    expect(surfaces(swapped)).toEqual(['files', 'report'])
    const replaced = drop(two, paneOf(two, 'report')!.id, 'center', 'canvas')!
    expect(surfaces(replaced)).toEqual(['canvas', 'files'])
    expect(replaced.focus).toBe(paneOf(replaced, 'canvas')!.id)
  })

  test("closing a pane gives its room to its sibling and the focus to the pane focused before; the last pane stays", () => {
    const three = preset(single('files'), 'three', ALL)
    const [a, b, c] = leaves(three.root).map((l) => l.id)
    const focusedC = { ...three, focus: c }
    const closed = close(focusedC, c, [a, b])
    expect(surfaces(closed)).toEqual(['files', 'canvas'])
    expect(closed.focus).toBe(a)
    expect(closed.root).toMatchObject({ dir: 'row' })
    expect(close(single('files'), 'p1')).toEqual(single('files'))
    expect(close(three, b).focus, 'closing another pane keeps the focus').toBe(three.focus)
  })

  test('a split is resized by its path, inside (0, 1)', () => {
    const q = preset(single('files'), 'quadrants', ALL)
    const r = resize(q, 'b', 0.3)
    expect(r.root.kind === 'split' && r.root.b.kind === 'split' && r.root.b.ratio).toBe(0.3)
    expect(resize(q, '', 2).root).toMatchObject({ ratio: 0.95 })
    expect(resize(q, 'b', 0.5), 'an unchanged ratio returns the same layout').toBe(q)
  })
})

describe('the presets', () => {
  test('each preset has its shape, and presetOf reads it back', () => {
    for (const name of ['one', 'columns', 'rows', 'three', 'quadrants'] as const) expect(presetOf(preset(single('canvas'), name, ALL))).toBe(name)
    const dragged = split(preset(single('files'), 'columns', ALL), 'p1', 'bottom', 'report')
    expect(presetOf(dragged)).toBeNull()
  })

  test('the surfaces shown keep their order and the focus; the others fill the rest; a pane with none left is empty', () => {
    const two = { ...split(single('report'), 'p1', 'right', 'files') }
    const q = preset(two, 'quadrants', ALL)
    expect(surfaces(q)).toEqual(['report', 'files', 'canvas', null])
    expect(paneOf(q, 'files')!.id).toBe(q.focus)
    const one = preset(q, 'one', ALL)
    expect(surfaces(one)).toEqual(['files'])
  })

  test('the focused surface stays when the preset has fewer panes than are shown', () => {
    const q = preset(single('files'), 'quadrants', [...ALL, 'view:board'])
    const onBoard = { ...q, focus: paneOf(q, 'view:board')!.id }
    const cols = preset(onBoard, 'columns', [...ALL, 'view:board'])
    expect(surfaces(cols)).toEqual(['files', 'view:board'])
    expect(cols.focus).toBe(paneOf(cols, 'view:board')!.id)
  })

  test('a layout asked for from the chat shows the surfaces it names, in that order', () => {
    const asked = preset(single('canvas'), 'columns', ALL, ['files', 'report'])
    expect(surfaces(asked)).toEqual(['files', 'report'])
    expect(asked.focus).toBe(paneOf(asked, 'files')!.id)
    const unknown = preset(single('canvas'), 'columns', ALL, ['view:gone', 'report'])
    expect(surfaces(unknown)).toEqual(['report', 'files'])
  })
})

describe('where a surface shows when something asks for it', () => {
  const two = { ...preset(single('report'), 'columns', ALL, ['report', 'canvas']) }
  const reportPane = paneOf(two, 'report')!.id
  const canvasPane = paneOf(two, 'canvas')!.id

  test('the pane that shows it takes the focus, and nothing else changes', () => {
    const shown = show({ ...two, focus: reportPane }, 'canvas', reportPane)
    expect(surfaces(shown)).toEqual(['report', 'canvas'])
    expect(shown.focus).toBe(canvasPane)
  })

  test('a citation clicked in one pane opens in another pane, which the analyst focused last, not in the one being read', () => {
    const fromReport = show({ ...two, focus: reportPane }, 'files', reportPane, [canvasPane])
    expect(surfaces(fromReport)).toEqual(['report', 'files'])
    expect(fromReport.focus).toBe(paneOf(fromReport, 'files')!.id)
  })

  test('from outside the panes (a tab, the chat), the focused pane shows it; an empty pane is taken first', () => {
    expect(surfaces(show({ ...two, focus: reportPane }, 'files'))).toEqual(['files', 'canvas'])
    const q = preset(two, 'quadrants', ALL)
    expect(surfaces(show(q, 'view:board'))).toEqual(['report', 'canvas', 'files', 'view:board'])
  })

  test("the tab read is the focused pane's surface, and Files for a view drawn alone", () => {
    const cols = preset(single('files'), 'columns', [...ALL, 'view:board'], ['view:board', 'report'])
    expect(readSurface(cols, false)).toBe('view:board')
    expect(readSurface(cols, true)).toBe('files')
    expect(readSurface(single('canvas'), true)).toBe('canvas')
  })

  test('one pane: the pane shows it, as the tabs always did', () => {
    expect(surfaces(show(single('canvas'), 'files', 'p1'))).toEqual(['files'])
  })

  test('the narrow area shows the focused pane alone', () => {
    const q = preset(single('files'), 'quadrants', ALL)
    expect(shownSurfaces(q)).toEqual(['files', 'canvas', 'report'])
    expect(shownSurfaces({ ...q, focus: paneOf(q, 'report')!.id }, true)).toEqual(['report'])
    expect(isNarrow(600, 800)).toBe(true)
    expect(isNarrow(900, 700)).toBe(false)
  })
})

describe('the geometry', () => {
  test('two panes share the width less the gap; the divider is the gap between them', () => {
    const cols = preset(single('files'), 'columns', ALL)
    const { panes, dividers } = arrange(cols.root, { x: 0, y: 0, w: 1012, h: 700 })
    expect(panes.map((p) => [p.x, p.w])).toEqual([
      [0, 500],
      [512, 500],
    ])
    expect(dividers).toHaveLength(1)
    expect(dividers[0]).toMatchObject({ x: 500, w: GAP, h: 700, dir: 'row', path: '' })
  })

  test('a quadrant layout has a divider per split, and every pane inside the box', () => {
    const q = preset(single('files'), 'quadrants', ALL)
    const { panes, dividers } = arrange(q.root, { x: 0, y: 0, w: 1000, h: 800 })
    expect(panes).toHaveLength(4)
    expect(dividers.map((d) => d.path).sort()).toEqual(['', 'a', 'b'])
    for (const p of panes) expect(p.x + p.w <= 1000 && p.y + p.h <= 800).toBe(true)
  })

  test('a window made smaller squeezes the larger pane first, keeping each pane at its least size while the room holds both', () => {
    const tall = resize(preset(single('files'), 'rows', ALL), '', 0.95)
    const [top, bottom] = arrange(tall.root, { x: 0, y: 0, w: 800, h: 500 }).panes
    expect(bottom.h).toBe(MIN.h)
    expect(top.h + GAP + bottom.h).toBe(500)
    // three columns made by dragging, each in the least width its split allows
    const three = split(split(single('files'), 'p1', 'right', 'canvas'), 'p2', 'right', 'report')
    const cols = arrange(resize(three, '', 0.05).root, { x: 0, y: 0, w: 900, h: 600 }).panes
    for (const p of cols) expect(p.w).toBeGreaterThanOrEqual(MIN.w)
  })

  test("an area too small for the layout's panes at their least size shows the focused pane alone", () => {
    const three = split(split(single('files'), 'p1', 'right', 'canvas'), 'p2', 'right', 'report')
    expect(isNarrow(3 * MIN.w + 2 * GAP, 700, three.root)).toBe(false)
    expect(isNarrow(3 * MIN.w + 2 * GAP - 1, 700, three.root)).toBe(true)
    expect(isNarrow(3 * MIN.w + 2 * GAP - 1, 700)).toBe(false)
  })

  test('a divider dragged far keeps each side at its least size', () => {
    const three = preset(single('files'), 'three', ALL)
    const d = arrange(three.root, { x: 0, y: 0, w: 1200, h: 800 }).dividers.find((x) => x.path === '')!
    expect(ratioAt(d, 0)).toBeCloseTo(MIN.w / d.room)
    expect(ratioAt(d, 5000)).toBeCloseTo(1 - MIN.w / d.room)
    expect(ratioAt(d, d.from + GAP / 2 + d.room / 2)).toBeCloseTo(0.5)
  })

  test('a drop near an edge splits there when the pane has room; otherwise, and in the middle, it replaces', () => {
    const r = { x: 0, y: 0, w: 900, h: 600 }
    expect(zoneAt(r, 20, 300)).toBe('left')
    expect(zoneAt(r, 880, 300)).toBe('right')
    expect(zoneAt(r, 450, 20)).toBe('top')
    expect(zoneAt(r, 450, 590)).toBe('bottom')
    expect(zoneAt(r, 450, 300)).toBe('center')
    const slim = { x: 0, y: 0, w: 400, h: 600 }
    expect(splittable(slim, 'left')).toBe(false)
    expect(zoneAt(slim, 10, 300)).toBe('center')
    expect(previewOf(r, 'right')).toEqual({ x: 456, y: 0, w: 444, h: 600 })
  })
})

describe('the stored layout', () => {
  test('a layout survives storage as JSON', () => {
    const q = resize(preset(single('files'), 'quadrants', ALL), 'a', 0.4)
    expect(parsePanes(JSON.parse(JSON.stringify(q)))).toEqual(q)
  })

  test('a layout of six panes nested five splits deep, made by dragging views out one after another, survives storage', () => {
    let p = single('files')
    const steps: [string, 'right' | 'bottom', string][] = [
      ['files', 'right', 'canvas'],
      ['canvas', 'bottom', 'report'],
      ['report', 'right', 'view:a'],
      ['view:a', 'bottom', 'view:b'],
      ['view:b', 'right', 'view:c'],
    ]
    for (const [at, edge, s] of steps) p = split(p, paneOf(p, at)!.id, edge, s)
    expect(surfaces(p)).toEqual(['files', 'canvas', 'report', 'view:a', 'view:b', 'view:c'])
    expect(parsePanes(JSON.parse(JSON.stringify(p)))).toEqual(p)
  })

  test('what is not a layout is refused; a repeated surface leaves the later pane empty; a lost focus goes to the first pane', () => {
    expect(parsePanes(null)).toBeNull()
    expect(parsePanes({ root: { kind: 'split', dir: 'diagonal' } })).toBeNull()
    const dup = parsePanes({
      root: { kind: 'split', dir: 'row', ratio: 7, a: { kind: 'pane', id: 'p1', surface: 'files' }, b: { kind: 'pane', id: 'p1', surface: 'files' } },
      focus: 'p9',
    })!
    expect(surfaces(dup)).toEqual(['files', null])
    expect(new Set(leaves(dup.root).map((l) => l.id)).size).toBe(2)
    expect(dup.root).toMatchObject({ ratio: 0.5 })
    expect(dup.focus).toBe('p1')
  })
})

describe('the asks that reach the shell', () => {
  const heard = (fn: () => void) => {
    const got: { tab: string }[] = []
    const off = bus.on('showTab', (e) => got.push(e))
    fn()
    off()
    return got.map((e) => e.tab)
  }

  test("a chip asks for its surface; a file's chip leaves the asking to Files", () => {
    expect(heard(() => teleport('card:c1'))).toEqual(['canvas'])
    expect(heard(() => teleport('report:report'))).toEqual(['report'])
    expect(heard(() => teleport('board.jsonl#L3'))).toEqual([])
    expect(heard(() => teleport('view:threads/t1'))).toEqual([])
  })

  test("the stream's layout record reaches the bus with its preset and surfaces; one with no preset does not", () => {
    const got: unknown[] = []
    const off = bus.on('layout', (e) => got.push(e))
    dispatch({ type: 'layout', layout: 'columns', surfaces: ['files', 'report', 3] } as never)
    dispatch({ type: 'layout', layout: 'grid', surfaces: ['files'] } as never)
    off()
    expect(got).toEqual([{ layout: 'columns', surfaces: ['files', 'report'] }])
  })
})
