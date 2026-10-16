// `/thimble card <n>`: the n-th card of the last turn, or a card by its id, opened in the card pane.
// `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { CWD, world } from './fixtures'
import type { World } from './fixtures'

type E = Engine

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

test('`/thimble card <n>` opens the n-th card of the last turn in the card pane; an id opens that card', { timeoutMs: 30_000 }, async ($, on) => {
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
