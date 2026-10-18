// A side thread's question shows that it is starting, with the time so far, from the moment it is asked until its first
// step.
// `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { CWD, shown, takesKeys, world } from './fixtures'
import type { World } from './fixtures'

type M = Mounted<'terminal'>
type E = Engine

const PANE = { plugin: 'thimble', component: 'Pane', requestId: 'thimble', surface: 'terminal', viewport: { columns: 120, rows: 124 }, props: { title: 'thimble', isFocused: true, bodyColumns: 96, placement: 'dock', scroll: { bodyRows: 120 }, view: {} } } as never

async function start($: E, w: World): Promise<void> {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
}

/** Thread `t2` open in the panel, drawn once its chat is read. */
async function openThread($: E, w: World): Promise<M> {
  await $.command.run({ command: 'thimble:thimble', args: 'threads' } as never)
  await w.clock.settle()
  await takesKeys($)
  let pane = (await $.ui.mount(PANE)) as unknown as M
  await pane.press({ key: 'thread-open-t2' })
  await w.clock.settle()
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  return pane
}

const iso = (ms: number) => new Date(ms).toISOString()

test("a thread's question with no step yet reads `◌ starting · 12s`, the time counting each second, until its first tool call", { timeoutMs: 30_000 }, async ($, on) => {
  const w = world(on)
  // asked 12 seconds ago; main has not handed it to the thread's agent yet
  const asked = [{ type: 'user', ts: iso(w.clock.now() - 12_000), text: 'any disputes?' }]
  w.chats.t2 = { meta: { ...w.states.threads[2] }, events: asked, total: asked.length }
  await start($, w)
  let pane = await openThread($, w)
  let text = shown(await pane.drawn())
  expect(text).toContain('any disputes?')
  expect(text).toContain('⏺ ◌ starting · 12s')
  expect(text).not.toContain('0 tool calls')
  expect(text).not.toContain('answering')
  // the clock draws it again each second
  await pane.unmount()
  await w.clock.advance(5_000)
  pane = (await $.ui.mount(PANE)) as unknown as M
  expect(shown(await pane.drawn())).toContain('⏺ ◌ starting · 17s')
  await pane.unmount()
  // its first step: what it does from then on
  const stepped = [...asked, { type: 'tool_use', id: 'u1', name: 'Bash', input: {} }]
  w.chats.t2 = { meta: { ...w.states.threads[2] }, events: stepped, total: stepped.length }
  pane = await openThread($, w)
  text = shown(await pane.drawn())
  expect(text).toContain('⏺ ◌ 1 tool call')
  expect(text).not.toContain('starting')
  await pane.unmount()
})

test('in the list of threads, a thread whose question has taken no step yet reads `◌ starting` with its time, never `◌ 0 tool calls`', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world(on)
  // asked a minute ago
  const asked = [{ type: 'user', ts: iso(w.clock.now() - 64_000), text: 'any disputes?' }]
  w.chats.t2 = { meta: { ...w.states.threads[2] }, events: asked, total: asked.length }
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: 'threads' } as never)
  await w.clock.settle()
  await takesKeys($)
  let pane = (await $.ui.mount(PANE)) as unknown as M
  await pane.unmount()
  await w.clock.advance(1_100)
  pane = (await $.ui.mount(PANE)) as unknown as M
  // the list's rows are drawn by a Client of their own (lines.tsx)
  const json = JSON.stringify(await pane.drawn())
  const keys = [...json.matchAll(/"type":"Client","props":\{"key":"([^"]+)"/g)].map(x => x[1]!)
  const text = (await Promise.all(keys.map(k => pane.drawn({ in: k }).then(shown, () => '')))).join('\n')
  expect(text).toContain('"any disputes?"')
  expect(text).toMatch(/◌ starting · 1m [56]s/)
  expect(text).not.toContain('0 tool calls')
  await pane.unmount()
})
