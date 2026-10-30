// @vitest-environment jsdom
// The chips of files shown together tell them apart as an example card's addresses do (src/lib/refs runFolder):
// in a reply, the citations of two trials' trajectories in a job folder named by its date name each its trial, not
// the date; and under an example card, a citation in its takeaway reads as the card's address over the same record.
import { act } from 'react'
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { CellCard } from '../../src/canvas/Cell.tsx'
import { CanvasContext } from '../../src/canvas/context.ts'
import { ChatMarkdown, ChipContext } from '../../src/chat/markdown.tsx'
import { api } from '../../src/lib/api.ts'
import type { Cell, ResolvedRef } from '../../src/lib/types.ts'
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
  vi.spyOn(api, 'resolveRef').mockImplementation(async (_ws, ref) => ({ ref, kind: 'record', path: ref.split('#')[0], excerpt: 'The forecast says rain until noon.' }) as unknown as ResolvedRef)
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** a trial's trajectory in a job folder named by its date, at line `n` */
const trial = (t: string, n: number) => `jobs/2026-05-02__09-00-00/${t}/agent/trajectory.json#L${n}`

test("a reply's citations of two trials in a dated job folder name the trials", async () => {
  const text = `The lake trial moved the picnic to the afternoon [[${trial('picnic-lake__RvtmQxa', 5)}]], and the hill trial kept the morning [[${trial('picnic-hill__GdsaPwe', 5)}]].`
  const el = await mount(
    <ChipContext.Provider value={{ workspace: 'ws', broken: new Set() }}>
      <ChatMarkdown text={text} />
    </ChipContext.Provider>,
  )
  const names = [...el.querySelectorAll('.refchip[data-ref]')].map((c) => c.getAttribute('aria-label'))
  expect(names).toEqual(['picnic-lake__RvtmQxa › … › trajectory.json L5', 'picnic-hill__GdsaPwe › … › trajectory.json L5'])
})

test("a citation in an example card's takeaway reads as the card's address over the same record", async () => {
  const lake = trial('picnic-lake__RvtmQxa', 5)
  const cell = {
    id: 'c1', kind: 'example', title: 'When did each agent plan the picnic?', created_by: 'main', ts: '2026-05-02T10:00:00Z',
    payload: { refs: [lake, trial('picnic-hill__GdsaPwe', 5)] },
    takeaway: `Only the lake trial [[moved the picnic to the afternoon|${lake}]].`,
  } as unknown as Cell
  const noop = () => undefined
  const el = await mount(
    <CanvasContext.Provider value={{ ws: 'ws', filters: null, keep: null, concepts: new Map(), threadOf: () => ({ chatId: 'main', name: 'main', writable: true }), unread: new Set(), refresh: noop, openThread: noop }}>
      <CellCard
        cell={cell} x={0} y={0} w={480} h={null} selected={false} alone={false} collapsed={false} deck={false} dragging={false}
        detailOpen={false} editing={null} z={1} register={noop} onPress={noop} onFocusMode={noop} onResizeStart={noop}
        onAction={noop} onEdit={noop}
      />
    </CanvasContext.Provider>,
  )
  await settle()
  const addresses = [...el.querySelectorAll('.bcell-address .chip-text')].map((a) => a.textContent)
  expect(addresses).toEqual(['picnic-lake__RvtmQxa › … › trajectory.json L5', 'picnic-hill__GdsaPwe › … › trajectory.json L5'])
  // the takeaway's citation names its record in its hover as the address over that record does
  const cite = el.querySelector<HTMLElement>('.bcell-take .refchip-value')!
  await act(async () => {
    cite.focus()
    await new Promise((r) => setTimeout(r, 200))
  })
  expect(document.body.querySelector('.refchip-pop-head .chip-text')?.textContent).toBe(addresses[0])
})
