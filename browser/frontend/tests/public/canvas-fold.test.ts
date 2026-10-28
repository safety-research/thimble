// What a frame's caret folds, and a path of frames around one card (src/canvas/layout.ts layoutBoard): every caret
// folds something. A collapsed frame's lone card folds to its question; a collapsed frame with no card of its own shows
// its title alone; a frame that holds nothing has no caret. A frame that holds no card of its own and one frame in its
// flow shares that frame's box, so one card in a path of three frames stands in one box, under one title row.
import { describe, expect, test } from 'vitest'
import * as layout from '../../src/canvas/layout.ts'
import { boardOf, frameAt, GAP, HEAD, layoutBoard, MIN_FRAME_H, PAD, ROOT_GAP, TITLE } from '../../src/canvas/layout.ts'
import type { CanvasResponse, Cell, Group } from '../../src/lib/types.ts'

const group = (id: string, extra: Partial<Group> = {}): Group => ({ id, title: id, parent: null, kind: 'sequence', anchor: null, chat: null, role: 'analyst', ...extra })
const card = (id: string, notebook: string): Cell => ({ id, notebook, kind: 'note', title: id, takeaway: '', created_by: 'user', ts: '', payload: { text: id }, pos: null }) as unknown as Cell
const heights: Record<string, number> = { a: 300, b: 200, s: 240, x: 180 }
const lay = (d: CanvasResponse, open: string[]) => layoutBoard(boardOf(d), new Set(open), heights)

// `one` holds the card a; `path` holds `mid`, which holds `leaf`, which holds the card s (the three frames a group path
// such as `Analysis / Spike / Detail` makes); `two` holds b and x; `empty` holds nothing
const DATA: CanvasResponse = {
  groups: [group('one'), group('path', { kind: 'split' }), group('mid', { kind: 'split', parent: 'path' }), group('leaf', { parent: 'mid' }), group('two'), group('empty')],
  cells: [card('a', 'one'), card('s', 'leaf'), card('b', 'two'), card('x', 'two')],
}
const ALL = DATA.groups.map((g) => g.id)
const without = (id: string) => ALL.filter((g) => g !== id)

describe("a frame's caret folds something", () => {
  test("a collapsed frame's lone card folds to its question, and the frame with it", () => {
    const open = lay(DATA, ALL).rects
    const shut = lay(DATA, without('one')).rects
    expect(open.get('a')!.h).toBe(300)
    expect(shut.get('a')!.h).toBeLessThan(100)
    expect(shut.get('one')!.h).toBeLessThan(open.get('one')!.h)
    // the card is still drawn, where it was
    expect([shut.get('a')!.x, shut.get('a')!.y]).toEqual([open.get('a')!.x, open.get('a')!.y])
  })

  test('a collapsed frame with no card of its own shows its title alone: the frames in it fold too, and no box is drawn under its title', () => {
    const shut = lay(DATA, without('path'))
    // its rect is 0 tall: the root frame after it stands ROOT_GAP below its title, not below an empty box
    expect(shut.rects.get('path')!.h).toBe(0)
    expect(shut.rects.get('two')!.y - shut.rects.get('path')!.y).toBe(ROOT_GAP)
    expect(shut.bare.has('path')).toBe(true)
    expect(shut.rects.has('mid')).toBe(false)
    expect(shut.rects.has('s')).toBe(false)
  })

  test('in the column of the frame around it, such a frame takes its title row alone', () => {
    // `one` holds the card a, then `inner`, which holds `deep`, which holds the card z
    const d = { groups: [...DATA.groups, group('inner', { parent: 'one' }), group('deep', { parent: 'inner' })], cells: [...DATA.cells, card('z', 'deep')] }
    const shut = lay(d, [...ALL, 'deep'])
    const a = shut.rects.get('a')!
    const inner = shut.rects.get('inner')!
    const one = shut.rects.get('one')!
    expect(inner.h).toBe(0)
    expect(inner.y).toBe(a.y + a.h + GAP + TITLE)
    expect(one.y + one.h).toBe(inner.y + PAD)
    expect(shut.bare.has('inner')).toBe(true)
  })

  test('a frame that shares its box with such a frame is its title alone with it, both named in its title row', () => {
    const shut = lay(DATA, without('mid'))
    expect(shut.rects.get('path')!.h).toBe(0)
    expect([shut.bare.has('path'), shut.bare.has('mid')]).toEqual([true, true])
    expect(layout.pathOf(shut, 'path')).toEqual(['path', 'mid'])
  })

  test('a collapsed frame that holds nothing keeps its box, which a card is dropped in', () => {
    const shut = lay(DATA, without('empty'))
    expect(shut.rects.get('empty')!.h).toBe(MIN_FRAME_H)
    expect(shut.bare.has('empty')).toBe(false)
  })

  test('a collapsed frame of several cards is the deck it was: its first card whole, the edges of the others under it', () => {
    const shut = lay(DATA, without('two'))
    expect(shut.rects.get('b')!.h).toBe(200)
    expect(shut.rects.has('x')).toBe(false)
    expect(shut.decks.has('b')).toBe(true)
  })

  test('a frame that holds nothing has nothing to fold', () => {
    const b = boardOf(DATA)
    expect(['one', 'path', 'mid', 'leaf', 'two'].map((g) => layout.foldable(b, g))).toEqual([true, true, true, true, true])
    expect(layout.foldable(b, 'empty')).toBe(false)
  })
})

describe('one card in a path of frames', () => {
  test('stands in one box: the frames of the path share the box of the frame that holds the card', () => {
    const l = lay(DATA, ALL)
    const leaf = l.rects.get('leaf')!
    expect(l.rects.get('path')).toEqual(leaf)
    expect(l.rects.get('mid')).toEqual(leaf)
    // one frame's padding around the card, not three
    const s = l.rects.get('s')!
    expect([s.x - leaf.x, s.y - leaf.y]).toEqual([PAD, HEAD])
    expect(leaf.w).toBe(s.w + 2 * PAD)
    expect(leaf.h).toBe(s.h + HEAD + PAD)
    expect(layout.pathOf(l, 'path')).toEqual(['path', 'mid', 'leaf'])
  })

  test('a card dropped on the box goes to the frame that holds the card', () => {
    const b = boardOf(DATA)
    const l = layoutBoard(b, new Set(ALL), heights)
    const s = l.rects.get('s')!
    expect(frameAt(b, l, { x: s.x + 10, y: s.y + s.h + GAP / 2 })).toBe('leaf')
  })

  test('a frame of the path that holds a card of its own, or a second frame, keeps its own box', () => {
    const own = lay({ ...DATA, cells: [...DATA.cells, card('m', 'mid')] }, ALL)
    expect(own.rects.get('mid')).not.toEqual(own.rects.get('leaf'))
    expect(own.rects.get('path')).toEqual(own.rects.get('mid'))
    const second = lay({ groups: [...DATA.groups, group('side', { parent: 'mid' })], cells: [...DATA.cells, card('z', 'side')] }, [...ALL, 'side'])
    const mid = second.rects.get('mid')!
    expect(mid).not.toEqual(second.rects.get('leaf'))
    expect(second.rects.get('leaf')!.y - mid.y).toBe(HEAD + TITLE)
  })
})
