// @vitest-environment jsdom
// A card whose run failed (src/canvas/bodies.tsx, src/components/Outputs.tsx ErrorOut): its body is the error's one
// line, its name and its message's first line, without the traceback, and the card says it failed, so an attempt that
// failed while Claude goes on with the card is no wall of red. An error drawn anywhere but on a card (the card's
// details) shows whole.
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { CellCard } from '../../src/canvas/Cell.tsx'
import { CanvasContext } from '../../src/canvas/context.ts'
import { ERROR_MIME, Output } from '../../src/components/Outputs.tsx'
import type { Cell, MimeBundle } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})
beforeEach(() => {
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

const ERR = {
  [ERROR_MIME]: {
    ename: 'ValueError',
    evalue: "No runs match the filter.\nThe column 'status' holds only 'pass' and 'fail'.",
    traceback: ['\u001b[0;31mValueError\u001b[0m Traceback (most recent call last)', "Cell In[2], line 6\n----> 6 rate = failures(runs, status='flaky')"],
  },
} as unknown as MimeBundle
const failed = { id: 'c1', kind: 'table', title: 'Which nightly runs failed?', created_by: 'main', ts: '2026-10-15T10:00:00Z', code: "failures(runs, status='flaky')", outputs: [ERR], status: 'error' } as Cell

function card(c: Cell) {
  const noop = () => undefined
  return mount(
    <CanvasContext.Provider value={{ ws: 'ws', filters: null, keep: null, concepts: new Map(), threadOf: () => ({ chatId: 'main', name: 'main', writable: true }), unread: new Set(), refresh: noop, openThread: noop }}>
      <CellCard
        cell={c} x={0} y={0} w={420} h={null} selected={false} alone={false} collapsed={false} deck={false} dragging={false}
        detailOpen={false} editing={null} z={1} register={noop} onPress={noop} onFocusMode={noop} onResizeStart={noop}
        onAction={noop} onEdit={noop}
      />
    </CanvasContext.Provider>,
  )
}

test("a failed card's body is the error's one line, without its traceback, and the card says it failed", async () => {
  const el = await card(failed)
  await settle()
  const error = () => el.querySelector<HTMLElement>('.bcell-output .outputs-error')!.textContent
  expect(error()).toBe('ValueError: No runs match the filter.')
  expect(el.querySelector('.bcell-failed')?.textContent).toContain('failed')
})

test('an error drawn off a card shows whole', async () => {
  const el = await mount(<Output bundle={ERR} />)
  expect(el.textContent).toContain("----> 6 rate = failures(runs, status='flaky')")
})
