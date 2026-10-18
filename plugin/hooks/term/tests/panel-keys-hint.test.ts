// Bug hunt L12: the panel's hint row says where its keys go. A view with no list (a card, a citation) puts the focus ring
// on a resting place it draws, never leaves it where Claude Code had it (at times its entry box, which then took `x`
// while the hint said `x to close`); and while the prompt holds text, which keeps the keys there whatever the person
// clicks, the hint says to empty it first. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { ENTRY_KEY } from '../entry'
import { DRAFT_HINT, RING_REST, UNFOCUSED_HINT } from '../panel'
import { CWD, shown, world } from './fixtures'
import type { World } from './fixtures'

type M = Mounted<'terminal'>
type E = Engine

const paneOf = (focused = true) => ({ plugin: 'thimble', component: 'Pane', requestId: 'thimble', surface: 'terminal', viewport: { columns: 120, rows: 64 }, props: { title: 'thimble', isFocused: focused, bodyColumns: 96, placement: 'dock', scroll: { bodyRows: 60 }, view: {} } }) as never

async function start($: E, w: World): Promise<void> {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
}

/** The card page of `id`, opened as `/thimble card <id>` opens it, once the panel asked for its keys. */
async function cardPage($: E, w: World, id: string): Promise<M> {
  await $.command.run({ command: 'thimble:thimble', args: `card ${id}` } as never)
  await w.clock.settle()
  let pane = (await $.ui.mount(paneOf())) as unknown as M
  await w.clock.advance(150)
  await w.clock.settle()
  await pane.unmount()
  pane = (await $.ui.mount(paneOf())) as unknown as M
  return pane
}

test('bug hunt L12: a card page draws a resting place for the focus ring, no text field, which the panel puts the ring on as it opens, so its letters are the hotkeys its hint row names; a list keeps its own keys', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world(on)
  await start($, w)
  const pane = await cardPage($, w, 'ff73e071')
  expect(shown(await pane.drawn())).toContain('home › card')
  expect(await pane.find({ type: 'Button', key: RING_REST })).toBeDefined()
  expect(ENTRY_KEY.test(RING_REST)).toBe(false)
  expect(shown(await pane.find({ key: 'h-hints' }))).toContain('a to ask · x to close')
  await pane.unmount()
  // home draws a list: its relay holds the ring, and no resting place is drawn
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  const home = (await $.ui.mount(paneOf())) as unknown as M
  expect(await home.find({ type: 'Button', key: RING_REST })).toBeUndefined()
  await home.unmount()
})

test('bug hunt L12: while the panel is without its keys and the prompt holds text, the hint row says to empty the prompt, then click the panel; with an empty prompt, to click it', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world(on)
  await start($, w)
  await (await cardPage($, w, 'ff73e071')).unmount()
  // the prompt has the keys over text the person typed there
  w.paneFocused = false
  w.draft = 'xa'
  let pane = (await $.ui.mount(paneOf(false))) as unknown as M
  expect(shown(await pane.find({ key: 'h-hints' })).trim()).toBe(DRAFT_HINT)
  await pane.unmount()
  // the prompt emptied: a click on the panel gives it the keys
  w.draft = ''
  pane = (await $.ui.mount(paneOf(false))) as unknown as M
  expect(shown(await pane.find({ key: 'h-hints' })).trim()).toBe(UNFOCUSED_HINT)
  await pane.unmount()
})
