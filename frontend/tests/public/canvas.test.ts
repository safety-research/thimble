// The canvas board (src/canvas/layout.ts): the groups and cards the server stores become frames and cards on a plane.
// Checked as properties rather than pixels: every card of an open frame is drawn, inside its frame and clear of its
// neighbours, a column stacks and a row runs across, a card the analyst placed or resized keeps its place and width,
// and the local edits a drag makes before the server answers put the cards where the routes will, and a card or frame
// opened by ref comes up at a zoom that reads. Also the card filter (src/canvas/cardFilter.ts), whose choice is read
// back from the server's canvas filter, and a card's check state as the filter reads it (src/lib/cardCheck.ts
// checkState).
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  boardOf,
  CARD_W,
  cardCount,
  DEFAULT_VIEW,
  frameAt,
  insertionAt,
  isWithin,
  kidsOf,
  layoutBoard,
  LOOSE_LOCAL,
  moveLocal,
  openOn,
  overlaps,
  readable,
  READABLE_SCALE,
  removeLocal,
  RUNNABLE,
  type Rect,
} from '../../src/canvas/layout.ts'
import { bothKeep, cardParts, keepShown, keptBy, NO_FILTER, readFilter, searchText, type CardFilter, type FilterCard } from '../../src/canvas/cardFilter.ts'
import { CHECK_STATES, CHECK_WORDS, checkState } from '../../src/lib/cardCheck.ts'
import type { CanvasResponse } from '../../src/lib/types.ts'

const group = (id: string, extra: object = {}) => ({ id, title: id, parent: null, kind: 'sequence', anchor: null, chat: null, role: 'analyst', n_cells: 0, pos: null, order: null, ...extra })
const cell = (id: string, notebook: string, extra: object = {}) => ({ id, notebook, kind: 'code', title: `q ${id}`, created_by: 'user', ts: '2026-08-30T14:00:00Z', ...extra })
const canvas = (d: { groups: object[]; cells: object[] }) => d as unknown as CanvasResponse

// a row (split) holding two columns, the analyst's column with a thread's frame in it, an empty thread's group that
// has no card yet, and a loose card placed on the board
const DATA = canvas({
  groups: [
    group('orient', { title: 'Orientation', kind: 'split', role: 'exploration' }),
    group('left', { parent: 'orient', role: 'exploration' }),
    group('right', { parent: 'orient', role: 'working' }),
    group('mine', { title: 'Your work' }),
    group('spike', { title: 'main/why-the-spike', parent: 'mine', anchor: 'y2', chat: 't1', kind: 'split' }),
    group('empty', { title: 'main/nothing-yet', anchor: 'y1', chat: 't2' }),
    group('loose', { title: 'Loose cards', kind: 'loose' }),
  ],
  cells: [
    cell('f1', 'left'),
    cell('f2', 'left'),
    cell('s1', 'right'),
    cell('s2', 'right'),
    cell('s3', 'right'),
    cell('y1', 'mine'),
    cell('y2', 'mine', { width: 500 }),
    cell('p1', 'spike'),
    cell('p2', 'spike'),
    cell('l1', 'loose', { pos: { x: 3000, y: 40 } }),
  ],
})
const H = { f1: 200, f2: 100, s1: 150, s2: 100, s3: 120, y1: 100, y2: 140, p1: 80, p2: 90, l1: 60 }
const OPEN = new Set(['orient', 'left', 'right', 'mine', 'spike'])
const inside = (a: Rect, b: Rect) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h

describe('the board', () => {
  test('a frame per group but the loose one, an empty thread left out, a thread frame named without its main/', () => {
    const b = boardOf(DATA)
    expect(b.groups.map((g) => g.id)).toEqual(['orient', 'left', 'right', 'mine', 'spike'])
    expect(b.groups.map((g) => g.flow)).toEqual(['row', 'col', 'col', 'col', 'row'])
    expect(b.group.get('spike')?.name).toBe('why-the-spike')
    expect(b.group.get('spike')?.thread).toBe(true)
    expect(b.cellById.get('l1')?.parent).toBeNull()
    expect(['f1', 'y1', 'y2'].map((id) => b.cellById.get(id)?.w)).toEqual([CARD_W, CARD_W, 500])
  })

  test('a group whose parent is not drawn is a root, and a loop of parents ends at a root', () => {
    const odd = boardOf(canvas({ groups: [group('a', { parent: 'b' }), group('b', { parent: 'a' }), group('c', { parent: 'gone' })], cells: [] }))
    expect(odd.groups.every((g) => g.parent === null || odd.group.has(g.parent))).toBe(true)
    expect(odd.group.get('c')?.parent).toBeNull()
  })

  test('a frame lists its cards as stored, a nested group after `order` of them, the placed ones last', () => {
    const data = canvas({
      groups: [group('g'), group('k1', { parent: 'g', order: 1 }), group('k2', { parent: 'g' }), group('k3', { parent: 'g', order: 0 }), group('kf', { parent: 'g', pos: { x: 5, y: 5 } })],
      cells: [cell('a', 'g'), cell('b', 'g', { pos: { x: 9, y: 9 } }), cell('c', 'g'), cell('d', 'g')],
    })
    expect(kidsOf(boardOf(data), 'g').map((k) => k.it.id)).toEqual(['k3', 'a', 'k1', 'c', 'd', 'k2', 'b', 'kf'])
  })

  test('a thread frame no one placed sits right after its anchor card', () => {
    const b = boardOf(canvas({ groups: [group('mine'), group('t', { title: 'main/why', parent: 'mine', anchor: 'y1', chat: 'c1' })], cells: [cell('y1', 'mine'), cell('y2', 'mine'), cell('p1', 't')] }))
    expect(kidsOf(b, 'mine').map((k) => k.it.id)).toEqual(['y1', 't', 'y2'])
  })
})

describe('the layout', () => {
  const b = boardOf(DATA)
  const lay = layoutBoard(b, OPEN, H)
  const r = (id: string) => {
    const rect = lay.rects.get(id)
    if (!rect) throw new Error(`${id} is not drawn`)
    return rect
  }

  test('every card of an open frame is drawn at its measured height, inside its frame', () => {
    for (const c of b.cells) {
      expect(r(c.id).h, c.id).toBe(H[c.id as keyof typeof H])
      if (c.parent) expect(inside(r(c.id), r(c.parent)), `${c.id} inside ${c.parent}`).toBe(true)
    }
    for (const g of b.groups) if (g.parent) expect(inside(r(g.id), r(g.parent)), `${g.id} inside ${g.parent}`).toBe(true)
    expect(lay.rects.has('empty')).toBe(false)
  })

  test('no two things in one frame overlap, and root frames do not overlap each other', () => {
    for (const parent of [null, ...b.groups.map((g) => g.id)]) {
      const kids = kidsOf(b, parent).map((k) => k.it.id).filter((id) => lay.rects.has(id))
      for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) expect(overlaps(r(kids[i]), r(kids[j])), `${kids[i]} and ${kids[j]}`).toBe(false)
    }
  })

  test('a column stacks its cards in order, a row runs them across', () => {
    expect(r('f1').x).toBe(r('f2').x)
    expect(r('f2').y).toBeGreaterThanOrEqual(r('f1').y + r('f1').h)
    expect([r('s1').x, r('s2').x]).toEqual([r('s3').x, r('s3').x])
    expect(r('s3').y).toBeGreaterThan(r('s2').y)
    expect(r('p1').y).toBe(r('p2').y)
    expect(r('p2').x).toBeGreaterThanOrEqual(r('p1').x + r('p1').w)
    expect(r('right').x).toBeGreaterThanOrEqual(r('left').x + r('left').w)
  })

  test('a loose card sits where it was put, and a resized card keeps its width', () => {
    expect(r('l1')).toEqual({ x: 3000, y: 40, w: CARD_W, h: 60 })
    expect(r('y2').w).toBe(500)
  })

  test('a stored position places a card free inside its frame, which grows to hold it', () => {
    const moved = canvas({ ...DATA, cells: DATA.cells.map((c) => (c.id === 'f2' ? { ...c, pos: { x: 900, y: 30 } } : c)) })
    const l = layoutBoard(boardOf(moved), OPEN, H)
    const f2 = l.rects.get('f2')!
    const left = l.rects.get('left')!
    expect([f2.x - left.x, f2.y - left.y]).toEqual([900, 30])
    expect(inside(f2, left)).toBe(true)
  })

  test('a collapsed frame shows its first card over the stacked edges of the rest, and is shorter for it', () => {
    const shut = layoutBoard(b, new Set(), H)
    expect(shut.rects.has('f1') && !shut.rects.has('f2')).toBe(true)
    expect([...shut.decks].sort()).toEqual(['f1', 'p1', 's1', 'y1'])
    expect(shut.rects.get('left')!.h).toBeLessThan(r('left').h)
    expect(cardCount(b, 'left')).toBe(2)
  })

  test('the frame under the pointer is the innermost one, and a dragged frame is no target for itself', () => {
    const f1 = r('f1')
    expect(frameAt(b, lay, { x: f1.x + 5, y: f1.y + 5 })).toBe('left')
    expect(frameAt(b, lay, { x: f1.x + 5, y: f1.y + 5 }, 'orient')).toBeNull()
    expect(frameAt(b, lay, { x: -500, y: -500 })).toBeNull()
    expect(isWithin(b, 'left', 'orient')).toBe(true)
    expect(isWithin(b, 'orient', 'left')).toBe(false)
  })

  test('a card dropped above the first card goes first, and between two cards goes between them', () => {
    const f1 = r('f1')
    const f2 = r('f2')
    expect(insertionAt(b, lay, 'left', { x: f1.x + 100, y: f1.y - 8 }, 'f2')?.index).toBe(0)
    expect(insertionAt(b, lay, 'left', { x: f1.x + 100, y: f2.y - 10 }, 'y1')?.index).toBe(1)
    expect(insertionAt(b, lay, 'left', { x: f1.x + 100, y: f1.y + 100 }, 'y1')).toBeNull()
  })
})

describe('local edits', () => {
  const inGroup = (d: CanvasResponse, g: string) => d.cells.filter((c) => c.notebook === g).map((c) => c.id)

  test('a move puts cards after the named card, first for null, last for undefined, and free on the board with a position', () => {
    expect(inGroup(moveLocal(DATA, ['y1'], 'left', 'f1', null), 'left')).toEqual(['f1', 'y1', 'f2'])
    expect(inGroup(moveLocal(DATA, ['f2'], 'left', null, null), 'left')).toEqual(['f2', 'f1'])
    expect(inGroup(moveLocal(DATA, ['y1', 'y2'], 'right', undefined, null), 'right')).toEqual(['s1', 's2', 's3', 'y1', 'y2'])
    const free = moveLocal(DATA, ['f1'], null, undefined, { x: 3, y: 4 }).cells.find((c) => c.id === 'f1')
    expect([free?.notebook, free?.pos]).toEqual(['loose', { x: 3, y: 4 }])
    const bare = canvas({ groups: [group('g')], cells: [cell('a', 'g')] })
    const made = moveLocal(bare, ['a'], null, undefined, { x: 0, y: 0 })
    expect(made.cells[0].notebook).toBe(LOOSE_LOCAL)
    expect(made.groups.find((g) => g.id === LOOSE_LOCAL)?.kind).toBe('loose')
  })

  test('removing a group removes the groups and cards inside it', () => {
    const gone = removeLocal(DATA, ['y1'], ['orient'])
    expect(gone.groups.map((g) => g.id)).toEqual(['mine', 'spike', 'empty', 'loose'])
    expect(gone.cells.map((c) => c.id)).toEqual(['y2', 'p1', 'p2', 'l1'])
  })
})

test('the kinds that run code are the ones the server runs (backend/app/notebook.py RUNNABLE_KINDS)', () => {
  const py = readFileSync(path.resolve(__dirname, '../../../backend/app/notebook.py'), 'utf8')
  const tuple = /^RUNNABLE_KINDS = \(([^)]*)\)/m.exec(py)
  expect(tuple).not.toBeNull()
  const server = [...tuple![1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]).sort()
  expect([...RUNNABLE].sort()).toEqual(server)
})

describe('the card filter', () => {
  const cards: FilterCard[] = [
    { id: 'a', kind: 'plot', group: 'left', maker: 'orient', check: 'verified', starred: true, locked: false, text: searchText('Merge time', '') },
    { id: 'b', kind: 'table', group: 'left', maker: 'main', check: 'failed', starred: false, locked: true, text: searchText('PRs per agent', '[[31|card:b#x/y]] merged') },
    { id: 'c', kind: 'plot', group: 'mine', maker: 'main', check: 'unverified', starred: false, locked: false, text: searchText('Tests per run', '') },
    { id: 'd', kind: 'note', group: null, maker: 'main', check: 'unchecked', starred: true, locked: false, text: searchText('Open questions', '') },
  ]
  const f = (extra: Partial<CardFilter>) => ({ ...NO_FILTER, ...extra })

  test('any choice within a part keeps a card, every set part across them must, and no filter keeps all', () => {
    expect(keptBy(cards, NO_FILTER)).toBeNull()
    expect([...keptBy(cards, f({ kinds: ['plot', 'note'] }))!]).toEqual(['a', 'c', 'd'])
    expect([...keptBy(cards, f({ kinds: ['plot'], makers: ['main'] }))!]).toEqual(['c'])
    expect([...keptBy(cards, f({ groups: ['left'] }))!]).toEqual(['a', 'b'])
    expect([...keptBy(cards, f({ starred: true }))!]).toEqual(['a', 'd'])
    expect([...keptBy(cards, f({ checks: ['failed', 'unchecked'] }))!]).toEqual(['b', 'd'])
    expect([...keptBy(cards, f({ checks: ['verified'], kinds: ['plot'] }))!]).toEqual(['a'])
    expect([...bothKeep(new Set(['a', 'b']), new Set(['b', 'c']))!]).toEqual(['b'])
    expect(bothKeep(null, null)).toBeNull()
  })

  test('words keep the cards whose question or takeaway holds each of them, a citation read as its label', () => {
    expect([...keptBy(cards, f({ text: 'MERGE' }))!]).toEqual(['a', 'b'])
    expect([...keptBy(cards, f({ text: 'merged 31' }))!]).toEqual(['b'])
    expect([...keptBy(cards, f({ text: 'card' }))!]).toEqual([])
    expect([...keptBy(cards, f({ text: 'erge' }))!]).toEqual([])
    expect(keptBy(cards, f({ text: '  ' }))).toBeNull()
  })

  test('the server is sent every part, and its answer leaves a filter that keeps the same cards as shown', () => {
    expect(cardParts(f({ groups: ['left'], text: ' merge  time ' }))).toEqual({ kinds: [], groups: ['left'], makers: [], checks: [], starred: false, locked: false, text: 'merge time' })
    const typed = f({ text: 'merge ' })
    expect(keepShown(typed, f({ text: 'merge' }))).toBe(typed)
    expect(keepShown(typed, f({ text: 'merge', starred: true }))).toEqual(f({ text: 'merge', starred: true }))
  })

  test("a card's check state is what its check mark shows: verified, unverified, failed or not checked", () => {
    const card = { kind: 'table', takeaway: 'Eight posts.', code: 'df', title: 'Posts' }
    expect(checkState({ ...card, check: { status: 'ok' } })).toBe('verified')
    expect(checkState({ ...card, check: { status: 'fixed' } })).toBe('verified')
    expect(checkState({ ...card, check: { status: 'pending', phase: 'queued' } })).toBe('unverified')
    expect(checkState({ ...card, check: { status: 'stopped' } })).toBe('unverified')
    expect(checkState({ ...card, check: { status: 'error', reason: 'the drawing timed out' } })).toBe('failed')
    expect(checkState(card)).toBe('unchecked')
    expect(checkState({ ...card, kind: 'label', check: { status: 'ok' } })).toBe('unchecked')
    const fix = { id: 'f1', ts: 't', state: 'applied', fields: ['takeaway'], before: { takeaway: '8 posts.' }, after: { takeaway: 'Eight posts.' } }
    expect(checkState({ ...card, fixes: [fix] })).toBe('verified')
    expect(checkState({ ...card, takeaway: 'Edited since.', fixes: [fix] })).toBe('unchecked')
    expect(CHECK_STATES.map((s) => CHECK_WORDS[s])).toEqual(['Verified', 'Unverified', 'Failed', 'Not checked'])
  })

  test('a stored choice is read back only where it fits', () => {
    expect(readFilter({ kinds: ['plot', 3], starred: 'yes', locked: true })).toEqual(f({ kinds: ['plot'], locked: true }))
    expect(readFilter({ checks: ['unchecked', 7] })).toEqual(f({ checks: ['unchecked'] }))
    expect(readFilter(null)).toEqual(NO_FILTER)
    expect(readFilter('garbage')).toEqual(NO_FILTER)
  })
})

describe('opening a card or a frame by ref', () => {
  test('a view zoomed out past reading opens at the readable zoom, and one zoomed in keeps its own', () => {
    expect(READABLE_SCALE).toBe(DEFAULT_VIEW.scale)
    expect(readable({ x: 5, y: 7, scale: 0.2 })).toEqual({ x: 5, y: 7, scale: READABLE_SCALE })
    expect(readable({ x: 5, y: 7, scale: 1.5 }).scale).toBe(1.5)
    // a frame opened from Fit's far-out view comes up at the readable zoom, its top inside the viewport
    const frame: Rect = { x: 1000, y: 2000, w: 760, h: 3000 }
    const at = openOn({ x: 0, y: 0, scale: 0.2 }, frame, 1440)
    expect(at.scale).toBe(READABLE_SCALE)
    expect(at.y + frame.y * at.scale).toBeGreaterThan(0)
  })
})
