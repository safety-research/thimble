// Where Claude Code places thimble's panel (fixtures.ts placing plays its rule): an open it was asked for (the hook of
// `/thimble`, the handler of a Button pressed) at any width, any other only from 144 columns (110 for a pane opened
// before). The row above the prompt offers a panel that waits and says why; its `open panel` opens it from the press,
// as `/thimble` does; the row goes once Claude Code draws the pane. `claude plugin test mods/thimble-term`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { pendingOf } from '../hooks/term'
import { CWD, WS, placing, shown, world } from './fixtures'
import type { World } from './fixtures'

type M = Mounted<'terminal'>
type E = Engine

const PANEL = 'thimble-term'
const aboveAt = (columns: number) => ({ plugin: PANEL, component: 'AbovePrompt', requestId: 'above', surface: 'terminal', viewport: { columns, rows: 40 }, props: { hasSurvey: false, isWorking: false, view: {} } }) as never
const paneAt = (columns: number) => ({ plugin: PANEL, component: 'Pane', requestId: PANEL, surface: 'terminal', viewport: { columns, rows: 40 }, props: { title: 'Home', isFocused: false, bodyColumns: columns - 4, placement: 'inline', scroll: { bodyRows: 36 }, view: {} } }) as never
const MESSAGE = (requestId: string, text: string) => ({ plugin: PANEL, component: 'AssistantMessage', requestId, surface: 'terminal', viewport: { columns: 100, rows: 40 }, props: { text, isFirstOfReply: true } }) as never

async function start($: E, w: World): Promise<void> {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
}

/** Home opened by main's set_layout (a ui.jsonl record the session's timer follows): an open no one asked for. */
async function homeFromMain(w: World): Promise<void> {
  w.states.ui = [{ n: 1, kind: 'layout', args: { layout: 'one', surfaces: ['canvas'] } }]
  w.stamps.set(`${WS}/ui.jsonl`, 7)
  await w.clock.advance(1100)
}

test('Claude Code leaves home undrawn when main opens it on a terminal 120 columns wide: the row says why; `open panel` opens it from its press', async ($, on) => {
  const w = world(on)
  const pl = placing(w, 120)
  await start($, w)
  await homeFromMain(w)
  expect(pl.log).toEqual([{ id: PANEL, asked: false, placed: false }])
  const above = (await $.ui.mount(aboveAt(120))) as unknown as M
  expect(shown(await above.find({ type: 'Box', key: 'above-panel' }))).toBe('  panelHome is ready · opens on its own at 144 columns (24 more)open paneldismiss')
  // the press hands back the open, so Claude Code counts it as the person's and places it at this width
  await above.press({ key: 'above-panel-open' })
  expect(pl.log.at(-1)).toEqual({ id: PANEL, asked: true, placed: true })
  expect(pl.waiting.size).toBe(0)
  expect(await above.find({ type: 'Box', key: 'above-panel' })).toBeUndefined()
  await above.unmount()
})

test('`/thimble` and a press in main\'s chat open the panel at 90 columns; a click in a card, which Claude Code does not count as asked, waits and the row offers it', async ($, on) => {
  const w = world(on)
  const pl = placing(w, 90)
  await start($, w)
  const close = async () => {
    const pane = (await $.ui.mount(paneAt(90))) as unknown as M
    await pane.press({ key: 'hk-close' })
    await pane.unmount()
    await w.clock.settle()
  }
  // the hook of a command the person typed: asked
  pl.asking = true
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  pl.asking = false
  expect(pl.log.at(-1)).toEqual({ id: PANEL, asked: true, placed: true })
  await close()
  // `ask about this answer ›` under a reply that cites and shows a card: its press hands back the open of the new
  // thread's form
  const text = 'The README says [[4,579|README.md#L3]] pages.'
  await $.turn.start({ text: 'How many?', turnId: 't1' } as never)
  await $.session.append({ door: 'response', origin: { kind: 'model', model: 'm' }, uuid: 'r1', message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] } } as never).catch(() => undefined)
  await $.tool.call({ tool: 'mcp__plugin_thimble_thimble__add_card', tool_use_id: 'u1' } as never)
  await $.turn.complete({ turnId: 't1', answer: 'x', durationMs: 5, reason: 'answer', isAborted: false } as never)
  await w.clock.advance(300)
  const reply = (await $.ui.mount(MESSAGE('r1', text))) as unknown as M
  await reply.press({ key: 'ask-answer-r1' })
  expect(pl.log.at(-1)).toEqual({ id: PANEL, asked: true, placed: true })
  await close()
  // a click on a value in the card's Client posts a message, not a press: Claude Code places that open only from 110
  // columns (the pane was opened before), and the row offers it
  await reply.post({ origin: 'c1', gestures: [{ seq: 1, gesture: 'primary', target: { kind: 'citation', ref: 'README.md#L3', text: '4,579' }, ev: { type: 'press', button: 'left', shift: false, ctrl: false, alt: false } }] }, { in: 'card-t0-ff73e071' })
  await reply.unmount()
  await w.clock.settle()
  expect(pl.log.at(-1)).toEqual({ id: PANEL, asked: false, placed: false })
  const above = (await $.ui.mount(aboveAt(90))) as unknown as M
  expect(shown(await above.find({ type: 'Box', key: 'above-panel' }))).toBe('  panelCitation is ready · opens on its own at 110 columns (20 more)open paneldismiss')
  await above.press({ key: 'above-panel-open' })
  expect(pl.log.at(-1)).toEqual({ id: PANEL, asked: true, placed: true })
  expect(await above.find({ type: 'Box', key: 'above-panel' })).toBeUndefined()
  await above.unmount()
})

test('the row goes once Claude Code draws the pane that waited (the terminal widened past 144 columns), though nothing else redraws it', async ($, on) => {
  const w = world(on)
  const pl = placing(w, 120)
  await start($, w)
  await homeFromMain(w)
  const above = (await $.ui.mount(aboveAt(120))) as unknown as M
  expect(shown(await above.find({ type: 'Box', key: 'above-panel' }))).toContain('Home is ready')
  // Claude Code places the waiting pane a moment after the resize, and draws it: the row drawn before still offers it
  pl.widen(150)
  expect(pl.waiting.size).toBe(0)
  const pane = (await $.ui.mount(paneAt(150))) as unknown as M
  await w.clock.settle()
  expect(await above.find({ type: 'Box', key: 'above-panel' })).toBeUndefined()
  await pane.unmount()
  await above.unmount()
})

test('the row asks Claude Code again by itself once the terminal is as wide as it places the pane at', async ($, on) => {
  const w = world(on)
  const pl = placing(w, 120)
  await start($, w)
  await homeFromMain(w)
  // the terminal is 150 wide now; Claude Code's own look at the new width has not come yet
  pl.columns = 150
  const above = (await $.ui.mount(aboveAt(150))) as unknown as M
  await w.clock.settle()
  expect(pl.log.at(-1)).toEqual({ id: PANEL, asked: false, placed: true })
  expect(await above.find({ type: 'Box', key: 'above-panel' })).toBeUndefined()
  await above.unmount()
})

test('`dismiss` closes the panel that waits, and the row goes', async ($, on) => {
  const w = world(on)
  placing(w, 100)
  await start($, w)
  await homeFromMain(w)
  const above = (await $.ui.mount(aboveAt(100))) as unknown as M
  await above.press({ key: 'above-panel-dismiss' })
  expect(w.closed).toEqual([PANEL])
  expect(await above.find({ type: 'Box', key: 'above-panel' })).toBeUndefined()
  await above.unmount()
})

test("why a pane waits, from Claude Code's answer: the width it places panes it was not asked for from, or no screen that draws them", () => {
  expect(pendingOf('Home', 'unasked below 110 columns (96 now, an id the person opened before): placed when the person opens it, or when the terminal is widened to 110 columns')).toEqual({ title: 'Home', floor: 110, columns: 96 })
  expect(pendingOf('Files', 'no attached surface places panes (desktop-1): placed when a surface that does attaches, or once they detach')).toEqual({ title: 'Files', noScreen: true })
  expect(pendingOf('Citation', 'refused')).toEqual({ title: 'Citation' })
})
