// The board's root column (src/canvas/layout.ts layoutBoard): main's single cards stand loose and a sequence of cards
// gets a frame at the root, so the column holds both. They stand in the order they were made, so the board reads in
// time order: a frame made after a loose card stands below it. The loose cards keep their stored order among
// themselves, and a frame or card the analyst placed stays where they put it.
import { describe, expect, test } from 'vitest'
import { boardOf, GAP, layoutBoard, ROOT_GAP, ROOT_X, ROOT_Y, TITLE } from '../../src/canvas/layout.ts'
import type { CanvasResponse, Cell, Group, Pos } from '../../src/lib/types.ts'

/** a card's stamp, to the second (backend notebook.new_cell); a group's, to the microsecond (notebook.create_notebook) */
const sec = (s: number) => `2026-10-28T05:00:${String(s).padStart(2, '0')}+00:00`
const usec = (s: number) => `2026-10-28T05:00:${String(s).padStart(2, '0')}.250000+00:00`
const frame = (id: string, ts: string | undefined, extra: Partial<Group> = {}): Group => ({ id, title: id, parent: null, kind: 'sequence', anchor: null, chat: null, role: 'analyst', ts, ...extra })
const card = (id: string, notebook: string, made: string, pos: Pos | null = null): Cell =>
  ({ id, notebook, kind: 'note', title: id, takeaway: '', created_by: 'terminal', created_ts: made, ts: made, payload: { text: id }, pos }) as unknown as Cell
const LOOSE = frame('l', usec(0), { kind: 'loose' })
const H = 200
const heights: Record<string, number> = { a: H, b: H, c: H, q1: H, q2: H }
const rectsOf = (d: CanvasResponse, open: string[] = ['q']) => layoutBoard(boardOf(d), new Set(open), heights).rects

describe('the root column', () => {
  test('a loose card, then a sequence frame, then another loose card stand in the order they were made', () => {
    const d: CanvasResponse = {
      groups: [LOOSE, frame('q', usec(2))],
      cells: [card('a', 'l', sec(1)), card('b', 'l', sec(5)), card('q1', 'q', sec(2)), card('q2', 'q', sec(3))],
    } as CanvasResponse
    const r = rectsOf(d)
    const a = r.get('a')!
    const q = r.get('q')!
    expect(a).toMatchObject({ x: ROOT_X, y: ROOT_Y })
    // the frame's title has the gap between two roots under the card, as under a frame
    expect(q).toMatchObject({ x: ROOT_X, y: a.y + H + ROOT_GAP })
    expect(q.y - TITLE).toBeGreaterThan(a.y + a.h)
    expect(r.get('b')).toMatchObject({ x: ROOT_X, y: q.y + q.h + ROOT_GAP })
  })

  test('frames and loose cards interleave by when each was made, loose cards GAP apart', () => {
    const d: CanvasResponse = {
      groups: [LOOSE, frame('q', usec(2)), frame('p', usec(6))],
      cells: [card('a', 'l', sec(1)), card('b', 'l', sec(4)), card('c', 'l', sec(5)), card('q1', 'q', sec(2))],
    } as CanvasResponse
    const r = rectsOf(d, ['q', 'p'])
    const ys = ['a', 'q', 'b', 'c', 'p'].map((id) => r.get(id)!.y)
    expect([...ys].sort((x, y) => x - y)).toEqual(ys)
    expect(r.get('c')!.y).toBe(r.get('b')!.y + H + GAP)
    expect(r.get('p')!.y).toBe(r.get('c')!.y + H + ROOT_GAP)
  })

  test('the loose cards keep their stored order among themselves', () => {
    // main moved b before a (edit_card after): the column shows them as stored
    const d: CanvasResponse = { groups: [LOOSE], cells: [card('b', 'l', sec(5)), card('a', 'l', sec(1))] } as CanvasResponse
    const r = rectsOf(d)
    expect(r.get('b')!.y).toBe(ROOT_Y)
    expect(r.get('a')!.y).toBe(ROOT_Y + H + GAP)
  })

  test('a frame or a loose card the analyst placed stays where they put it', () => {
    const d: CanvasResponse = {
      groups: [LOOSE, frame('q', usec(2), { pos: { x: 1600, y: 0 } })],
      cells: [card('a', 'l', sec(1)), card('c', 'l', sec(3), { x: 900, y: 40 }), card('b', 'l', sec(5)), card('q1', 'q', sec(2))],
    } as CanvasResponse
    const r = rectsOf(d)
    expect(r.get('q')).toMatchObject({ x: 1600, y: 0 })
    expect(r.get('c')).toMatchObject({ x: 900, y: 40 })
    expect(r.get('a')).toMatchObject({ x: ROOT_X, y: ROOT_Y })
    expect(r.get('b')!.x).toBe(ROOT_X)
    expect(r.get('b')!.y).toBeGreaterThan(r.get('a')!.y + H)
  })

  test('with no stamps to go by, the frames come first, as stored', () => {
    const d: CanvasResponse = { groups: [{ ...LOOSE, ts: undefined }, frame('q', undefined)], cells: [card('a', 'l', ''), card('q1', 'q', '')] } as CanvasResponse
    const r = rectsOf(d)
    expect(r.get('q')!.y).toBe(ROOT_Y)
    expect(r.get('a')!.y).toBe(ROOT_Y + r.get('q')!.h + ROOT_GAP)
  })
})
