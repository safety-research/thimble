// Cards never cover each other (src/canvas/layout.ts placeFree, placeBeside, clearPos): a card dropped free moves
// straight down to the first place where it overlaps no other card and no frame it is not in, and a card dropped
// beside a sibling stands level with the sibling as the frame is laid out once the card has left its place, the cards
// after them in the flow staying below them.
import { describe, expect, test } from 'vitest'
import { boardOf, CARD_W, GAP, HEAD, layoutBoard, moveLocal, overlaps, PAD, patchCellLocal, placeBeside, placeFree, ROOT_X, ROOT_Y, TITLE, type Rect } from '../../src/canvas/layout.ts'
import type { CanvasResponse, Cell, Group, Pos } from '../../src/lib/types.ts'

const group = (id: string, extra: Partial<Group> = {}): Group => ({ id, title: id, parent: null, kind: 'sequence', anchor: null, chat: null, role: 'analyst', ...extra })
const card = (id: string, notebook: string, pos: Pos | null = null): Cell => ({ id, notebook, kind: 'note', title: id, takeaway: '', created_by: 'user', ts: '', payload: { text: id }, pos }) as unknown as Cell
// every card 200 px tall, as measured
const H = 200
const heights = { a: H, b: H, c: H, x: H }
const open = new Set(['g'])

/** Your work holds a, b and c in its column; x is a loose card far off. */
function canvas(cells: Cell[] = [card('a', 'g'), card('b', 'g'), card('c', 'g')]): CanvasResponse {
  return { groups: [group('g'), group('loose', { kind: 'loose' })], cells: [...cells, card('x', 'loose', { x: 3000, y: 3000 })] }
}

const rects = (d: CanvasResponse) => layoutBoard(boardOf(d), open, heights).rects
/** The cards drawn, and every pair of them that overlap. */
function covered(d: CanvasResponse): string[] {
  const r = rects(d)
  const ids = d.cells.map((c) => c.id).filter((id) => r.has(id))
  const out: string[] = []
  for (const [i, a] of ids.entries()) for (const b of ids.slice(i + 1)) if (overlaps(r.get(a) as Rect, r.get(b) as Rect)) out.push(`${a}/${b}`)
  return out
}

// the column: a at the frame's top, b and c each GAP below the card before
const top = (i: number) => ROOT_Y + HEAD + i * (H + GAP)

describe('a card dropped free', () => {
  test('where it covers nothing stays where it was dropped', () => {
    const at = { x: PAD + CARD_W + GAP, y: 40 }
    expect(placeFree(canvas(), 'x', 'g', at, open, heights)).toEqual(at)
  })

  test('on a card moves straight down past every card it would cover', () => {
    // dropped over b; just below b it would cover c, so it goes below c
    const pos = placeFree(canvas(), 'x', 'g', { x: PAD + 100, y: top(1) + 50 - ROOT_Y }, open, heights)
    expect(pos).toEqual({ x: PAD + 100, y: top(2) + H + GAP - ROOT_Y })
    expect(covered(moveLocal(canvas(), ['x'], 'g', undefined, pos))).toEqual([])
  })

  test('stops at the first place that is clear, in a gap between two cards', () => {
    // c stands free far below b, so the room under b is clear
    const d = canvas([card('a', 'g'), card('b', 'g'), card('c', 'g', { x: PAD, y: 1000 })])
    const pos = placeFree(d, 'x', 'g', { x: PAD, y: top(1) + 10 - ROOT_Y }, open, heights)
    expect(pos).toEqual({ x: PAD, y: top(1) + H + GAP - ROOT_Y })
    expect(covered(moveLocal(d, ['x'], 'g', undefined, pos))).toEqual([])
  })

  test('at the foot of its frame stays in it, the frame below moving down as its frame grows', () => {
    // Notes stands below Your work; the card goes GAP below c, not below Notes
    const d = { ...canvas(), groups: [...canvas().groups, group('h')], cells: [...canvas().cells, card('d', 'h')] }
    const pos = placeFree(d, 'x', 'g', { x: PAD, y: top(2) + 10 - ROOT_Y }, open, heights)
    expect(pos).toEqual({ x: PAD, y: top(2) + H + GAP - ROOT_Y })
    expect(covered(moveLocal(d, ['x'], 'g', undefined, pos))).toEqual([])
  })

  test('on the board, over a frame and its title, moves below the frame', () => {
    const frame = rects(canvas()).get('g') as Rect
    const pos = placeFree(canvas(), 'x', null, { x: ROOT_X + 100, y: ROOT_Y - TITLE - 50 }, open, heights)
    expect(pos).toEqual({ x: ROOT_X + 100, y: frame.y + frame.h + GAP })
  })
})

describe('a card dropped beside a sibling', () => {
  test('on the right stands level with the sibling as it stands once the card has left the column above it', () => {
    // a leaves the top of the column, so c moves up to b's place
    const at = placeBeside(canvas(), 'a', 'g', 'c', 'R', open, heights)
    expect(at).toEqual({ pos: { x: PAD + CARD_W + GAP, y: HEAD + (H + GAP) } })
    const d = moveLocal(canvas(), ['a'], 'g', undefined, at.pos)
    expect(rects(d).get('a')?.y).toBe(rects(d).get('c')?.y)
    expect(covered(d)).toEqual([])
  })

  test('on the left takes the sibling\'s place in the column, the sibling moving right, and the cards after them stay below', () => {
    const at = placeBeside(canvas(), 'x', 'g', 'b', 'L', open, heights)
    expect(at).toEqual({ pos: null, after: 'a', ref: { x: PAD + CARD_W + GAP, y: HEAD + (H + GAP) } })
    const d = patchCellLocal(moveLocal(canvas(), ['x'], 'g', at.after, null), 'b', { pos: at.ref })
    const r = rects(d)
    expect(r.get('x')?.y).toBe(top(1))
    expect(r.get('b')?.y).toBe(top(1))
    expect(r.get('c')?.y).toBe(top(2))
    expect(covered(d)).toEqual([])
  })

  test('on the left of the first card goes first in the column', () => {
    expect(placeBeside(canvas(), 'x', 'g', 'a', 'L', open, heights).after).toBeNull()
  })

  test('on the right, where a card already stands free, moves down clear of it', () => {
    const d = canvas([card('a', 'g'), card('b', 'g'), card('c', 'g', { x: PAD + CARD_W + GAP, y: HEAD })])
    const at = placeBeside(d, 'x', 'g', 'a', 'R', open, heights)
    expect(at.pos).toEqual({ x: PAD + CARD_W + GAP, y: HEAD + H + GAP })
    expect(covered(moveLocal(d, ['x'], 'g', undefined, at.pos))).toEqual([])
  })
})
