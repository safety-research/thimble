// @vitest-environment jsdom
// The running line of a card on the board (src/canvas/Cell.tsx, CardFace.tsx): a card whose code runs says `running`,
// with no stop of its own. A card's run is not always the work of the chat that made it (the analyst runs a card again
// from its details, and a card runs again when a label it reads changes), so a stop there would end main's turn or a
// side thread's fork the run has nothing to do with; main and its threads stop from their message box's Stop.
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { CellCard } from '../../src/canvas/Cell.tsx'
import { CanvasContext } from '../../src/canvas/context.ts'
import type { CellThread } from '../../src/canvas/layout.ts'
import type { Cell } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const posted: string[] = []
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})
beforeEach(() => {
  posted.length = 0
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if ((init?.method ?? 'GET') !== 'GET' && !String(url).includes('/telemetry')) posted.push(`${init?.method} ${url}`)
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

const cell = (over: Partial<Cell>): Cell =>
  ({ id: 'c1', kind: 'code', title: 'How many events per agent?', created_by: 'user', ts: '2026-10-15T10:00:00Z', code: 'import time; time.sleep(600)', outputs: [], status: 'running', ...over }) as Cell

function card(c: Cell, thread: CellThread) {
  const noop = () => undefined
  return mount(
    <CanvasContext.Provider value={{ ws: 'ws', filters: null, keep: null, concepts: new Map(), threadOf: () => thread, unread: new Set(), refresh: noop, openThread: noop }}>
      <CellCard
        cell={c} x={0} y={0} w={420} h={null} selected={false} alone={false} collapsed={false} deck={false} dragging={false}
        detailOpen={false} editing={null} z={1} register={noop} onPress={noop} onFocusMode={noop} onResizeStart={noop}
        onAction={noop} onEdit={noop}
      />
    </CanvasContext.Provider>,
  )
}

test.each([
  ['the analyst made, run again from its details', cell({ created_by: 'user' }), { chatId: 'main', name: 'main', writable: true }],
  ['main made, run again for a changed label', cell({ created_by: 'terminal', regenerating_for: ['k1'] }), { chatId: 'main', name: 'main', writable: true }],
  ['a side thread made', cell({ created_by: 'chat:th1' }), { chatId: 'th1', name: 'runs-per-agent', writable: true }],
])("a running card %s says running, with no stop that would end main's turn or a thread's fork", async (_, c, thread) => {
  const el = await card(c, thread)
  await settle()
  const line = el.querySelector<HTMLElement>('.bcell-run')
  expect(line?.textContent).toContain('running')
  expect(line?.querySelectorAll('button')).toHaveLength(0)
  expect([...el.querySelectorAll('button')].map((b) => b.textContent?.trim())).not.toContain('stop')
  expect(posted).toEqual([])
})
