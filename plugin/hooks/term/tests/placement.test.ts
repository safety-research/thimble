// Where Claude Code places thimble's panel (fixtures.ts placing plays its rule): home opened by main waits undrawn on a
// narrow terminal, and the row above the prompt says why, with `open panel`. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { CWD, WS, placing, shown, world } from './fixtures'
import type { World } from './fixtures'

type M = Mounted<'terminal'>
type E = Engine

const PANEL = 'thimble'
const aboveAt = (columns: number) => ({ plugin: PANEL, component: 'AbovePrompt', requestId: 'above', surface: 'terminal', viewport: { columns, rows: 40 }, props: { hasSurvey: false, isWorking: false, view: {} } }) as never

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

test('Claude Code leaves home undrawn when main opens it on a terminal 120 columns wide: the row says why; `open panel` opens it from its press', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world(on)
  const pl = placing(w, 120)
  await start($, w)
  await homeFromMain(w)
  expect(pl.log).toEqual([{ id: PANEL, asked: false, placed: false }])
  const above = (await $.ui.mount(aboveAt(120))) as unknown as M
  expect(shown(await above.find({ type: 'Box', key: 'above-panel' }))).toBe('  panelHome is readyopen paneldismiss')
  // the press hands back the open, so Claude Code counts it as the person's and places it at this width
  await above.press({ key: 'above-panel-open' })
  expect(pl.log.at(-1)).toEqual({ id: PANEL, asked: true, placed: true })
  expect(pl.waiting.size).toBe(0)
  expect(await above.find({ type: 'Box', key: 'above-panel' })).toBeUndefined()
  await above.unmount()
})
