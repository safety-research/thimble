// A side thread's agent in view (Claude Code's agent list, Enter on it): one row above the prompt says which thread it
// is, that what the analyst types there goes to that thread and its answers show in the thread, with `back to main`.
// Any other agent's view keeps Claude Code's band, and main's view has no such row.
// `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { CWD, panelWorld, words } from './fixtures-panel'
import type { World } from './fixtures-panel'

type M = Mounted<'terminal'>
type E = Engine

const FORK = 'a3f0c2d9e81b4a57'
const viewOf = (columns: number, agentId?: string) =>
  ({ plugin: 'thimble', component: 'AbovePrompt', requestId: 'above', surface: 'terminal', viewport: { columns, rows: 40 }, props: { hasSurvey: false, isWorking: false, view: agentId ? { agentId } : {}, bodyColumns: columns } }) as never

async function start($: E, w: World): Promise<void> {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
}

test("a side thread's agent in view: `thread`, which thread it is and where its answers show, `back to main` puts main back in view", { timeoutMs: 30_000 }, async ($, on) => {
  const w = panelWorld(on)
  w.states.threads = w.states.threads.map(t => (t.id === 't2' ? { ...t, question: 'which pages were deleted, and by whom?', fork_name: 'which-pages-were', fork: { agent_id: FORK, tool_use_id: 'toolu_x', session: 's1' } } : t)) as never
  const viewed: unknown[] = []
  on('ui.view', ($$, e) => {
    viewed.push(e)
    return { value: {} } as never
  })
  await start($, w)
  const m = (await $.ui.mount(viewOf(200, FORK))) as unknown as M
  const row = await m.find({ type: 'Box', key: 'above-fork' })
  expect(words(row)).toContain('  thread')
  expect(words(row)).toContain('This is side thread "which pages were deleted, and by whom?". What you type here goes to it, and its answers show in the thread.')
  expect(words(row)).toContain('back to main')
  expect(words(row)).toContain('open the thread')
  // none of thimble's other rows: no thimble line in an agent's view
  expect(await m.find({ type: 'Box', key: 'above-summary' })).toBeUndefined()
  await m.unmount()
  // beside the docked panel the words stay whole, wrapped
  const narrow = (await $.ui.mount(viewOf(100, FORK))) as unknown as M
  expect(words(await narrow.find({ type: 'Box', key: 'above-fork' }))).toContain('What you type here goes to it, and its answers show in the thread.')
  expect(words(await narrow.find({ type: 'Box', key: 'above-fork' }))).not.toContain('…')
  await narrow.unmount()
  const m2 = (await $.ui.mount(viewOf(200, FORK))) as unknown as M
  await m2.press({ key: 'above-fork-main' })
  await w.clock.settle()
  expect(viewed).toHaveLength(1)
  expect(JSON.stringify(viewed[0])).not.toContain('agentId')
  await m2.unmount()
})

test("another agent's view keeps Claude Code's band; main's view has no thread row", { timeoutMs: 30_000 }, async ($, on) => {
  const w = panelWorld(on)
  w.states.threads = w.states.threads.map(t => (t.id === 't2' ? { ...t, fork: { agent_id: FORK } } : t)) as never
  await start($, w)
  const other = (await $.ui.mount(viewOf(200, 'b7e6d5c4b3a29180'))) as unknown as M
  expect(await other.find({ type: 'Box', key: 'above-fork' })).toBeUndefined()
  expect(await other.find({ type: 'Box', key: 'above-summary' })).toBeUndefined()
  await other.unmount()
  const main = (await $.ui.mount(viewOf(200))) as unknown as M
  expect(await main.find({ type: 'Box', key: 'above-fork' })).toBeUndefined()
  expect(await main.find({ type: 'Box', key: 'above-summary' })).toBeDefined()
  await main.unmount()
})
