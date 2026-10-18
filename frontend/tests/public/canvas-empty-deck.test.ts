// An orientation's deck that holds no card is not drawn on the canvas, as a thread's empty group is not: an orientation
// that failed or was stopped before its first card left an empty "Orientation 0" frame at the top (bug hunt L15).
import { describe, expect, test } from 'vitest'
import { boardOf } from '../../src/canvas/layout.ts'
import type { CanvasResponse } from '../../src/lib/types.ts'

const group = (id: string, title: string, role: string, parent: string | null = null) => ({ id, title, role, parent, kind: 'sequence', anchor: null, chat: null })
const card = (id: string, notebook: string) => ({ id, notebook, kind: 'note', title: `How many teapots in ${id}?`, created_by: 'model', ts: '2026-10-10T12:00:00+00:00', payload: {}, text: '' })
const canvas = (groups: object[], cells: object[]) => ({ groups, cells }) as unknown as CanvasResponse

describe('the orientation deck on the canvas', () => {
  test('is left out while it holds no card', () => {
    const b = boardOf(canvas([group('deck', 'Orientation', 'exploration'), group('work', 'Your work', 'analyst')], [card('t1', 'work')]))
    expect(b.groups.map((g) => g.id)).toEqual(['work'])
  })

  test('is drawn once it holds a card, also in a group nested in it', () => {
    const own = boardOf(canvas([group('deck', 'Orientation', 'exploration')], [card('t1', 'deck')]))
    expect(own.groups.map((g) => g.id)).toEqual(['deck'])
    const nested = boardOf(canvas([group('deck', 'Orientation', 'exploration'), group('part', 'Teapot shelves', 'exploration', 'deck')], [card('t2', 'part')]))
    expect(nested.groups.map((g) => g.id)).toEqual(['deck', 'part'])
  })

  test("an empty group of the analyst's own stays drawn", () => {
    const b = boardOf(canvas([group('g1', 'Group 1', 'analyst')], []))
    expect(b.groups.map((g) => g.id)).toEqual(['g1'])
  })
})
