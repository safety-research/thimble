// @vitest-environment jsdom
// A card whose side thread was stopped before it wrote the card's takeaway (backend notebook.UNFINISHED, set by the
// thread's Stop) says so in its takeaway's place, so the canvas and what main tells the analyst match (bug hunt round 9,
// J5: the half-made chart showed no word of it, and main said the thread made no card); a takeaway written later takes
// that place.
import { afterEach, beforeAll, expect, test } from 'vitest'
import { CardFace, UNFINISHED_LINE } from '../../src/canvas/CardFace.tsx'
import { CanvasContext } from '../../src/canvas/context.ts'
import type { Cell } from '../../src/lib/types.ts'
import { mount, unmountAll } from './mount.tsx'

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})
afterEach(unmountAll)

const cell = (over: Partial<Cell>): Cell => ({ id: 'kinds-saves', notebook: 'g', kind: 'note', title: 'What kinds of saves did the reverts undo?', takeaway: '', created_by: 'chat:t1', ts: '2026-10-17T20:59:20Z', payload: { text: 'a chart' }, ...over }) as Cell

const face = (c: Cell) =>
  mount(
    <CanvasContext.Provider value={{ ws: 'ws', filters: null, keep: null, concepts: new Map(), threadOf: () => ({ chatId: null, name: '', writable: false }), unread: new Set(), refresh: () => undefined, openThread: () => undefined }}>
      <CardFace cell={c} width={400} label={{ concept: null, error: null, reload: async () => undefined, set: () => undefined }} />
    </CanvasContext.Provider>,
  )

test('a card its stopped thread left without a takeaway says it is unfinished, until a takeaway takes its place', async () => {
  expect(UNFINISHED_LINE).toBe('Unfinished: its side thread was stopped before it wrote a takeaway.')
  let el = await face(cell({ unfinished: 'stopped' }))
  expect(el.querySelector('.bcell-take-unfinished')?.textContent).toBe(UNFINISHED_LINE)
  unmountAll()
  el = await face(cell({ unfinished: undefined }))
  expect(el.querySelector('.bcell-take-unfinished')).toBeNull()
  unmountAll()
  el = await face(cell({ unfinished: 'stopped', takeaway: 'Mostly link lists.' }))
  expect(el.querySelector('.bcell-take-unfinished')).toBeNull()
  expect(el.querySelector('.bcell-take-text')?.textContent).toBe('Mostly link lists.')
})
