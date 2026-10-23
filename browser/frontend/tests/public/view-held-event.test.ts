// A `view` event of one of the orientation's proposals before its view first passes (backend views._emit `held`): the
// stream hands it on with `held`, so the proposal's chip follows its build (lib/proposals applyViewEvent), while the
// views bar's view-ready toast leaves it alone (files/viewReady). Live checks L19 and L25: these chips showed no build
// state, or stayed "queued", until a reload.
import { afterEach, expect, test, vi } from 'vitest'
import { bus } from '../../src/lib/bus.ts'
import { dispatch } from '../../src/lib/events.ts'

afterEach(() => vi.restoreAllMocks())

test("a held proposal's view event reaches the bus with held, another one without", () => {
  const got: { slug: string; status: string; held?: boolean }[] = []
  const off = bus.on('view', (e) => got.push(e))
  dispatch({ type: 'view', slug: 'page-counts', status: 'building', held: true } as never)
  dispatch({ type: 'view', slug: 'posts', status: 'built' } as never)
  off()
  expect(got.map((e) => [e.slug, e.status, e.held])).toEqual([['page-counts', 'building', true], ['posts', 'built', undefined]])
})
