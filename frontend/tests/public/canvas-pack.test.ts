// The board takes the shape of the room Fit shows it in (src/canvas/layout.ts columnsOf, layoutBoard): the root frames
// and loose cards no one placed flow down side-by-side columns in their order, and so do the nested groups of a frame,
// beside the frame's own cards when they follow them. The board here is a long session of 30 cards in 11 groups, each
// card at the height it was drawn: the orientation's deck of 8, the analyst's frame with 2 cards and 6 nested groups (one
// of 7 cards), two threads' frames beside their cards, and a frame of figures. Every root frame stood below the one
// before, so Fit showed it at 6% on a 1366 × 768 screen and 9% on 1920 × 1080; a new user called the canvas "a bit of a
// maze". The deck of 8 alone is 4,600 px tall, so no placement of the frames fits this board above about 13.5% on
// 1366 × 768.
import { describe, expect, test } from 'vitest'
import { boardOf, COMMENT_ROOM, COMMENT_W, commentPlaces, extentOf, fitView, isWithin, layoutBoard, overlaps, ROOT_GAP, ROOT_X, ROOT_Y, TITLE, type Layout, type Rect } from '../../src/canvas/layout.ts'
import type { CanvasResponse, Cell, Group, Pos } from '../../src/lib/types.ts'

const group = (id: string, parent: string | null, extra: Partial<Group> = {}): Group => ({ id, title: id, parent, kind: 'sequence', anchor: null, chat: null, role: 'analyst', ...extra })
const card = (id: string, notebook: string, pos: Pos | null = null): Cell => ({ id, notebook, kind: 'note', title: id, takeaway: '', created_by: 'user', ts: '', payload: { text: id }, pos }) as unknown as Cell

// each group's cards, by their drawn heights, in the canvas's order
const SHAPE: [Group, number[]][] = [
  [group('deck', null, { role: 'exploration' }), [360, 609, 443, 646, 473, 773, 399, 684]],
  [group('work', null), [778, 409]],
  [group('t1', 'work', { anchor: 'work-0', chat: 't1' }), [248]],
  [group('n1', 'work'), [291, 674, 726, 609, 289]],
  [group('n2', 'work'), [298]],
  [group('n3', 'work'), [267, 460, 668, 436, 609, 818, 668]],
  [group('t2', 'n3', { anchor: 'n3-3', chat: 't2' }), [299]],
  [group('n4', 'work'), [600, 487]],
  [group('n5', 'work'), [298]],
  [group('n6', 'work'), [706]],
  [group('figs', null), [324]],
]
const heights: Record<string, number> = Object.fromEntries(SHAPE.flatMap(([g, hs]) => hs.map((h, i) => [`${g.id}-${i}`, h])))
const BOARD: CanvasResponse = { groups: SHAPE.map(([g]) => g), cells: SHAPE.flatMap(([g, hs]) => hs.map((_, i) => card(`${g.id}-${i}`, g.id))) }
const open = { has: () => true }
// the canvas beside the chat on each screen, and the controls' column Fit leaves clear (Canvas.tsx CONTROLS_W)
const SCREENS = { '1366 × 768': [1022, 716], '1920 × 1080': [1576, 1028] } as const
const CONTROLS = 210

const fitOn = (lay: Layout, [w, h]: readonly [number, number]) => fitView(extentOf(lay.rects.values()), w, h, 48, CONTROLS).scale

/** The pairs of drawn things that cover each other: two cards, a card and a frame it is not in, two frames neither of
 * which holds the other (a frame with its title's room above it). */
function covered(data: CanvasResponse, lay: Layout): string[] {
  const board = boardOf(data)
  const withTitle = (r: Rect): Rect => ({ x: r.x, y: r.y - TITLE, w: r.w, h: r.h + TITLE })
  const cards = board.cells.filter((c) => lay.rects.has(c.id))
  const frames = board.groups.filter((g) => lay.rects.has(g.id))
  const out: string[] = []
  for (const [i, a] of cards.entries()) for (const b of cards.slice(i + 1)) if (overlaps(lay.rects.get(a.id)!, lay.rects.get(b.id)!)) out.push(`${a.id}/${b.id}`)
  for (const c of cards) for (const g of frames) if (!isWithin(board, c.parent, g.id) && overlaps(lay.rects.get(c.id)!, withTitle(lay.rects.get(g.id)!))) out.push(`${c.id}/${g.id}`)
  for (const [i, a] of frames.entries())
    for (const b of frames.slice(i + 1)) if (!isWithin(board, a.id, b.id) && !isWithin(board, b.id, a.id) && overlaps(withTitle(lay.rects.get(a.id)!), withTitle(lay.rects.get(b.id)!))) out.push(`${a.id}/${b.id}`)
  return out
}

const inside = (r: Rect, f: Rect) => r.x >= f.x && r.y >= f.y && r.x + r.w <= f.x + f.w && r.y + r.h <= f.y + f.h

describe('a long session of 30 cards in 11 groups', () => {
  const lay = layoutBoard(boardOf(BOARD), open, heights)

  test('fits at least twice as large as one column of frames did', () => {
    expect(fitOn(lay, SCREENS['1366 × 768'])).toBeGreaterThanOrEqual(0.12)
    expect(fitOn(lay, SCREENS['1920 × 1080'])).toBeGreaterThanOrEqual(0.18)
  })

  test('shows every card in its frame, and nothing covers anything', () => {
    const board = boardOf(BOARD)
    for (const c of board.cells) {
      expect(lay.rects.has(c.id), c.id).toBe(true)
      expect(inside(lay.rects.get(c.id)!, lay.rects.get(c.parent!)!), `${c.id} in ${c.parent}`).toBe(true)
    }
    for (const g of board.groups) if (g.parent) expect(inside(lay.rects.get(g.id)!, lay.rects.get(g.parent)!), `${g.id} in ${g.parent}`).toBe(true)
    expect(covered(BOARD, lay)).toEqual([])
  })

  test('keeps the frames in their order, down each column and then across, a thread beside its card', () => {
    const after = (a: string, b: string) => {
      const [p, q] = [lay.rects.get(a)!, lay.rects.get(b)!]
      return q.x > p.x + 0.5 || (Math.abs(q.x - p.x) <= 0.5 && q.y > p.y)
    }
    for (const run of [['deck', 'work', 'figs'], ['n1', 'n2', 'n3', 'n4', 'n5', 'n6']]) for (let i = 1; i < run.length; i++) expect(after(run[i - 1], run[i]), `${run[i]} after ${run[i - 1]}`).toBe(true)
    expect(lay.rects.get('deck')).toMatchObject({ x: ROOT_X, y: ROOT_Y })
    const [anchor, thread] = [lay.rects.get('work-0')!, lay.rects.get('t1')!]
    expect(thread.x).toBeGreaterThan(anchor.x + anchor.w)
    expect(thread.y - TITLE).toBe(anchor.y)
  })
})

describe('the frames and cards placed by hand', () => {
  test('stay where they were put, and the columns move down past them', () => {
    // the figures' frame dropped over the top of the deck, and a loose card beside it
    const data: CanvasResponse = {
      groups: [...BOARD.groups.map((g) => (g.id === 'figs' ? { ...g, pos: { x: 100, y: 300 } } : g)), group('loose', null, { kind: 'loose' })],
      cells: [...BOARD.cells, card('free', 'loose', { x: 900, y: 120 })],
    }
    const lay = layoutBoard(boardOf(data), open, { ...heights, free: 300 })
    expect(lay.rects.get('figs')).toMatchObject({ x: 100, y: 300 })
    expect(lay.rects.get('free')).toMatchObject({ x: 900, y: 120 })
    expect(lay.rects.get('deck')!.y).toBeGreaterThan(300)
    expect(covered(data, lay)).toEqual([])
  })
})

describe('the comments beside the cards', () => {
  test('stand in room their column keeps, covering no frame or card', () => {
    const notes = new Set(['n3-1', 'deck-2'])
    const lay = layoutBoard(boardOf(BOARD), open, heights, notes)
    expect(covered(BOARD, lay)).toEqual([])
    const places = commentPlaces(boardOf(BOARD), lay, [
      { id: 'a', card: 'n3-1', dy: 14, h: 120 },
      { id: 'b', card: 'deck-2', dy: 14, h: 120 },
    ])
    for (const [id, p] of places) {
      const note = { x: p.x, y: p.y, w: COMMENT_W, h: 120 }
      for (const [k, r] of lay.rects) expect(overlaps(note, { x: r.x, y: r.y - TITLE, w: r.w, h: r.h + TITLE }), `comment ${id} over ${k}`).toBe(false)
    }
    // the deck's column keeps the room at its right; without comments the next column stands ROOT_GAP from it
    const [deck, work] = [lay.rects.get('deck')!, lay.rects.get('work')!]
    expect(work.x).toBeGreaterThanOrEqual(deck.x + deck.w + COMMENT_ROOM + ROOT_GAP)
    const bare = layoutBoard(boardOf(BOARD), open, heights)
    expect(bare.rects.get('work')!.x).toBe(bare.rects.get('deck')!.x + bare.rects.get('deck')!.w + ROOT_GAP)
  })
})
