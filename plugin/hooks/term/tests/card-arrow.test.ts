// A card's ↗ (SPEC-v2 J3, 5.5 item 5): in fullscreen its border row ends with a ↗ that opens the card in the browser;
// a custom card says the browser draws it, with the same ↗; the main screen (no clicks) draws no Button.
// `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { aTurn, call, shown, startSession } from './fixtures'
import type { World } from './fixtures'
import { panelWorld } from './fixtures-panel'

type M = Mounted<'terminal'>
const SLOW = { timeoutMs: 30000 }
const MESSAGE = (row: string, fullscreen: boolean) =>
  ({ plugin: 'thimble', component: 'AssistantMessage', requestId: row, surface: 'terminal', viewport: { columns: 140, rows: 40, isFullscreen: fullscreen }, props: { text: 'Here is the count.', isFirstOfReply: true } }) as never

async function withCard($: Engine, w: World, id: string): Promise<void> {
  w.toolText = `card:${id}\n[out0: table]`
  await startSession($, w)
  await aTurn($, w, 'r1', 'Here is the count.', async () => {
    await call($, 'mcp__plugin_thimble_thimble__add_card', { question: 'q', code: 'df' })
  })
  await w.clock.advance(300)
}

test("in fullscreen a card's border row ends with a ↗ that opens the card in the browser", SLOW, async ($, on) => {
  const w = panelWorld(on)
  await withCard($, w, 'ff73e071')
  const ui = (await $.ui.mount(MESSAGE('r1', true))) as unknown as M
  const json = JSON.stringify(await ui.drawn())
  expect(json).toMatch(/"key":"arrow-t0-ff73e071","position":"absolute","top":0/)
  await ui.press({ key: 'open-t0-ff73e071' })
  await w.clock.settle()
  // the press (offramp.ts): `thimble open` on the card's ref
  expect(w.pressed.at(-1)).toEqual(expect.arrayContaining(['--ref', 'card:ff73e071']))
  await ui.unmount()
  // the main screen takes no clicks: no ↗ there
  const classic = (await $.ui.mount(MESSAGE('r1', false))) as unknown as M
  expect(JSON.stringify(await classic.drawn())).not.toContain('open-t0-ff73e071')
  await classic.unmount()
})

test('a custom card says the browser draws it, with the same ↗', SLOW, async ($, on) => {
  const w = panelWorld(on)
  await withCard($, w, 'c0cust00')
  const ui = (await $.ui.mount(MESSAGE('r1', true))) as unknown as M
  const text = shown(await ui.drawn())
  expect(text).toContain('How concentrated were the saves?')
  expect(text).toContain('a custom card · the browser draws it')
  expect(text).not.toContain('45%')
  await ui.press({ key: 'custom-open-t0-c0cust00' })
  await w.clock.settle()
  expect(w.pressed.at(-1)).toEqual(expect.arrayContaining(['--ref', 'card:c0cust00']))
  await ui.unmount()
  const classic = (await $.ui.mount(MESSAGE('r1', false))) as unknown as M
  expect(shown(await classic.drawn())).toContain('a custom card · the browser draws it ↗')
  await classic.unmount()
})
