// A view built for the browser has no terminal page (bug hunt C12): its first open in the terminal asks thimble to
// build one (`thimble act view-term-page`, views.ensure_page), once per open, while the panel says it builds; when it
// is not built, the panel says why with the fix, and `r` builds again a terminal page whose build failed.
// `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { CWD, WS, shown, takesKeys, world } from './fixtures'
import type { World } from './fixtures'

type M = Mounted<'terminal'>
type E = Engine

const PANE = { plugin: 'thimble', component: 'Pane', requestId: 'thimble', surface: 'terminal', viewport: { columns: 120, rows: 64 }, props: { title: 'thimble', isFocused: true, bodyColumns: 96, placement: 'dock', scroll: { bodyRows: 60 }, view: {} } } as never
const BOARD = { slug: 'board', name: 'Board', status: 'built', ts: '2026-10-07T02:00:00Z', files: ['board.jsonl'], page: 'missing' }
const T = { timeoutMs: 30_000 }

/** The panel on the Board view: home, Views, its row, as the analyst opens it. */
async function openBoard($: E, w: World): Promise<M> {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  await takesKeys($)
  let pane = (await $.ui.mount(PANE)) as unknown as M
  const rows = ((await pane.drawn({ in: 'm:home' })) as { children?: unknown[] }).children ?? []
  const y = rows.findIndex(r => shown(r).includes('Views (1)'))
  expect(y).toBeGreaterThan(0)
  await pane.pointer({ type: 'down', x: 4, y, button: 'left', in: 'm:home' } as never)
  await w.clock.settle()
  await takesKeys($)
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  await pane.press({ key: 'view-open-0' })
  await w.clock.settle()
  await pane.unmount()
  return (await $.ui.mount(PANE)) as unknown as M
}

const asks = (w: World) => w.acts.filter(a => a.kind === 'view-term-page')

test('a view built for the browser asks thimble once to build its terminal page on its first open, and says it builds', T, async ($, on) => {
  const w = world(on)
  w.states.home = { ...w.states.home, views: [BOARD] } as never
  let pane = await openBoard($, w)
  await w.clock.settle()
  expect(shown(await pane.drawn())).toContain('building the terminal page… The browser draws this view now: o or ↗ opens it there.')
  // drawn again, it asks no more
  for (let i = 0; i < 2; i++) {
    await pane.unmount()
    pane = (await $.ui.mount(PANE)) as unknown as M
    await w.clock.settle()
  }
  expect(asks(w)).toEqual([{ kind: 'view-term-page', payload: { slug: 'board' } }])
  await pane.unmount()
})

test("when the terminal page is not built the panel says why, with the fix; `r` builds again one whose build failed", T, async ($, on) => {
  const w = world(on)
  w.states.home = { ...w.states.home, views: [BOARD] } as never
  const why = 'Its page for the terminal panel cannot be built here. Terminal views need Node 22+, and this machine has no Node.'
  w.answers = { 'view-term-page': { queued: false, reason: why } }
  let pane = await openBoard($, w)
  await w.clock.settle()
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  let text = shown(await pane.drawn())
  expect(text).toContain(`× ${why}`)
  expect(text).not.toContain('building the terminal page')
  // its build failed: home's row says so, and r builds it again
  w.states.home = { ...w.states.home, views: [{ ...BOARD, page: 'failed', page_why: 'its program drew nothing.' }] } as never
  w.stamps.set(`${WS}/views/proposals.json`, 3)
  await w.clock.advance(1100)
  await w.clock.settle()
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  text = shown(await pane.drawn())
  expect(text).toContain('× The build of its terminal page failed: its program drew nothing. r builds it again.')
  expect(text).toContain('r to build it again · o to open it in the browser')
  await pane.press({ key: 'hk-page-retry' })
  await w.clock.settle()
  expect(w.acts).toContainEqual({ kind: 'view-retry', payload: { slug: 'board' } })
  expect(w.toasts).toContain('thimble: building the terminal page again')
  await pane.unmount()
})
