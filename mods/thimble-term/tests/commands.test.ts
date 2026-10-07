// `/thimble <what>` in terminal mode: keyboard ways to what the chat and the panel draw (thimble-cc-mod's /thimble-threads,
// /thimble-cite, /thimble-card, /thimble-files, /thimble-reports). `claude plugin test mods/thimble-term`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { CWD, shown, world } from './fixtures'
import type { World } from './fixtures'

type M = Mounted<'terminal'>
type E = Engine

const PANE = { plugin: 'thimble-term', component: 'Pane', requestId: 'thimble-term', surface: 'terminal', viewport: { columns: 120, rows: 40 }, props: { title: 'thimble', isFocused: true, bodyColumns: 96, placement: 'dock', scroll: { bodyRows: 36 }, view: {} } } as never

async function start($: E, w: World): Promise<void> {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
}

const run = async ($: E, args: string) => ((await $.command.run({ command: 'thimble:thimble', args } as never)) as { text?: string }).text

async function turn($: E, w: World): Promise<void> {
  w.toolText = 'card:ff73e071\n[out0: table]'
  await $.turn.start({ text: 'How many?', turnId: 't1' } as never)
  await $.session.append({ door: 'response', origin: { kind: 'model', model: 'm' }, uuid: 'r1', message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'The README says [[4,579|README.md#L3]] pages, and dse holds [[3908|card:ff73e071#pages/dse]].' }] } } as never).catch(() => undefined)
  await $.tool.call({ tool: 'mcp__plugin_thimble_thimble__add_card', tool_use_id: 'u1' } as never)
  await $.turn.complete({ turnId: 't1', answer: 'x', durationMs: 5, reason: 'answer', isAborted: false } as never)
  await w.clock.advance(300)
}

test('`/thimble threads` opens the threads panel and says how many there are; `/thimble documents` the documents', async ($, on) => {
  const w = world(on)
  await start($, w)
  expect(await run($, 'threads')).toBe('thimble: 2 side threads')
  await w.clock.settle()
  const pane = (await $.ui.mount(PANE)) as unknown as M
  expect(shown(await pane.drawn())).toContain('Threads')
  await pane.unmount()
  expect(await run($, 'documents')).toBe('thimble: 1 document')
  expect(w.panes.at(-1)!.title).toBe('Documents')
  // the line shows as thimble's, not under the plugin's name
  const row = await $.ui.mount({ plugin: 'thimble-term', component: 'CommandOutput', requestId: 'c1', surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { command: 'thimble:thimble', args: 'threads', text: 'thimble-term: thimble: 2 side threads', isErrored: false } } as never)
  expect(shown(await row.drawn())).toBe('thimble: 2 side threads')
  await row.unmount()
})

test('`/thimble cite <n>` opens the n-th citation of the last reply; without n it says how many', async ($, on) => {
  const w = world(on)
  await start($, w)
  await turn($, w)
  expect(await run($, 'cite')).toBe('thimble: the last reply has 2 citations: `/thimble cite <1-2>` opens one')
  expect(await run($, 'cite 2')).toBe('thimble: citation 2 of 2')
  await w.clock.settle()
  expect(w.panes.at(-1)!.title).toBe('Citation')
  const pane = (await $.ui.mount(PANE)) as unknown as M
  expect(shown(await pane.drawn())).toContain('found on the card')
  await pane.unmount()
})

test('`/thimble card <n>` opens the n-th card of the last turn in the card pane; an id opens that card', async ($, on) => {
  const w = world(on)
  await start($, w)
  await turn($, w)
  expect(await run($, 'card')).toBe('thimble: the last turn has 1 card: `/thimble card <1-1>` opens one')
  expect(await run($, 'card 1')).toBe('thimble: card 1 of 1')
  expect(w.panes.at(-1)!.title).toBe('What does the export hold per wiki?')
  expect(await run($, 'card a0frame0')).toBe('thimble: the card is open')
  expect(w.panes.at(-1)!.title).toBe('How many records does each file hold?')
  expect(await run($, 'card zz000000')).toBe('thimble: no such card in this workspace')
})

test('`/thimble files [path[:line]]` opens the file browser, or a file at a record', async ($, on) => {
  const w = world(on)
  await start($, w)
  expect(await run($, 'files')).toBe('thimble: the file browser is open')
  expect(w.panes.at(-1)!.title).toBe('Files')
  expect(await run($, 'files README.md:3')).toBe('thimble: README.md line 3 is open')
  await w.clock.settle()
  const pane = (await $.ui.mount(PANE)) as unknown as M
  expect(shown(await pane.drawn({ in: 'file-detail' }))).toBe('↗ README.md line 3  ?')
  await pane.unmount()
  expect(await run($, 'what')).toContain('`/thimble threads`')
})
