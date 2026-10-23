// @vitest-environment jsdom
// A card selected alone edits its takeaway on a click on its words, but a click on a citation in it (a mark, as a card's
// value is cited) opens the citation's evidence and never the editor; a double click on it does not open focus mode.
import { act } from 'react'
import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import { CellCard } from '../../src/canvas/Cell.tsx'
import { CanvasContext } from '../../src/canvas/context.ts'
import { DOUBLE_MS } from '../../src/canvas/layout.ts'
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

const cell = {
  id: 'c1', kind: 'note', title: 'Who merged most?', takeaway: 'agent-03 merged [[12|card:c1#merged/agent-03]] PRs.',
  created_by: 'model', ts: '2026-10-06T00:00:00Z', payload: { text: 'x' }, status: 'ok',
} as Cell
const ctx = { ws: 'ws', filters: null, keep: null, concepts: new Map(), threadOf: () => ({ chatId: null, name: '', writable: false }), unread: new Set<string>(), refresh: () => undefined, openThread: () => undefined }

async function card() {
  const onEdit = vi.fn()
  const onFocusMode = vi.fn()
  const el = await mount(
    <CanvasContext.Provider value={ctx}>
      <CellCard
        cell={cell} x={0} y={0} w={420} h={null} selected alone collapsed={false} deck={false} dragging={false} detailOpen={false} editing={null} z={1}
        register={() => undefined} onPress={() => undefined} onFocusMode={onFocusMode} onResizeStart={() => undefined} onAction={() => undefined} onEdit={onEdit}
      />
    </CanvasContext.Provider>,
  )
  return { el, onEdit, onFocusMode }
}

async function press(target: Element, detail = 1) {
  await act(async () => {
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, detail }))
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, detail }))
  })
  await act(async () => new Promise((r) => setTimeout(r, DOUBLE_MS + 40)))
}

test("a click on a takeaway's citation opens its evidence, not the editor", async () => {
  const { el, onEdit } = await card()
  const words = el.querySelector<HTMLElement>('.bcell-take .mark-words')!
  expect(words.textContent).toBe('12')
  await press(words)
  expect(onEdit).not.toHaveBeenCalled()
  expect(document.querySelector('.refchip-pop.mark-pop')).not.toBeNull()
})

test("a click on the takeaway's words edits it", async () => {
  const { el, onEdit } = await card()
  await press(el.querySelector<HTMLElement>('.bcell-take-text p')!)
  expect(onEdit).toHaveBeenCalledWith('c1', 'takeaway')
})

test("a double click on a takeaway's citation does not open focus mode", async () => {
  const { el, onFocusMode } = await card()
  await act(async () => el.querySelector<HTMLElement>('.bcell-take .mark-words')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 })))
  expect(onFocusMode).not.toHaveBeenCalled()
})
