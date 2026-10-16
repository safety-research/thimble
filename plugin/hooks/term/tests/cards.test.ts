// The card pane: how the card's last run ended, `run again` (r) asking main to run it, and what its code printed.
// `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { CWD, shown, world } from './fixtures'
import type { World } from './fixtures'

type M = Mounted<'terminal'>
type E = Engine

const MESSAGE = (requestId: string, text: string) =>
  ({ plugin: 'thimble', component: 'AssistantMessage', requestId, surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { text, isFirstOfReply: true } }) as never
const PANE = { plugin: 'thimble', component: 'Pane', requestId: 'thimble', surface: 'terminal', viewport: { columns: 120, rows: 40 }, props: { title: 'thimble', isFocused: true, bodyColumns: 96, placement: 'dock', scroll: { bodyRows: 36 }, view: {} } } as never

async function start($: E, w: World): Promise<void> {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
}

async function turn($: E, w: World, card: string): Promise<void> {
  w.toolText = `card:${card}\n[out0: table]`
  await $.turn.start({ text: 'How many?', turnId: 't1' } as never)
  await $.session.append({ door: 'response', origin: { kind: 'model', model: 'm' }, uuid: 'r1', message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'Here.' }] } } as never).catch(() => undefined)
  await $.tool.call({ tool: 'mcp__plugin_thimble_thimble__add_card', tool_use_id: 'u1' } as never)
  await $.turn.complete({ turnId: 't1', answer: 'Here.', durationMs: 5, reason: 'answer', isAborted: false } as never)
  await w.clock.advance(300)
}

test("the card pane says how the card's last run ended; `run again` (r) asks main to run it; its code shows what it printed", { timeoutMs: 30_000 }, async ($, on) => {
  const w = world(on)
  Object.assign(w.cells.k0code00!, { code: "print('revisions.jsonl', 14591)" })
  await start($, w)
  await turn($, w, 'k0code00')
  const ui = (await $.ui.mount(MESSAGE('r1', 'Here.'))) as unknown as M
  await ui.unmount()
  // home lists the card; open its pane from the home panel's row
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  let pane = (await $.ui.mount(PANE)) as unknown as M
  const rows = ((await pane.drawn({ in: 'm:home' })) as { children?: unknown[] }).children ?? []
  const y = rows.findIndex(r => shown(r).includes('How many lines?'))
  expect(y).toBeGreaterThan(0)
  await pane.pointer({ type: 'down', x: 6, y, button: 'left', in: 'm:home' } as never)
  await w.clock.settle()
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  let text = shown(await pane.drawn())
  expect(text).toContain('How many lines?')
  expect(text).toContain('code · made by main · last run ok')
  expect(text).toContain('run again')
  expect(text).toContain('c for its code · r to run again · a to ask · b to go back · x to close')
  await pane.press({ key: 'card-again' })
  expect(w.submitted.at(-1)).toBe('Run this card again with Bash: thimble-run card k0code00')
  // its code, then what its last run printed
  await pane.press({ key: 'card-code' })
  await w.clock.settle()
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  text = shown(await pane.drawn())
  expect(text).toContain('card "How many lines?" · code')
  expect(text).toContain('output')
  expect(text).toContain('events.jsonl 19913')
  expect(text).toContain('c for the card · r to run again · a to ask · b to go back · x to close')
  await pane.unmount()
})
