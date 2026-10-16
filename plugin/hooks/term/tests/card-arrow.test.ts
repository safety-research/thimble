// A card's ↗ (SPEC-v2 J3, 5.5 item 5): in fullscreen its border row ends with a ↗ that opens the card in the browser;
// a custom card draws its words or table and a `view in browser ↗` link; the main screen (no clicks) draws no Button.
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

test('a custom card draws its words and a `view in browser` link that opens it there', SLOW, async ($, on) => {
  const w = panelWorld(on)
  w.cells.c0cust00!.takeaway = 'Most saves came at once.'
  await withCard($, w, 'c0cust00')
  const ui = (await $.ui.mount(MESSAGE('r1', true))) as unknown as M
  // the card's region: its question, then its words
  const card = shown(await ui.drawn({ in: 'card-t0-c0cust00' }))
  expect(card).toContain('How concentrated were the saves?')
  expect(card).toContain('45%')
  expect(card).toContain('of all saves landed in one afternoon')
  const text = shown(await ui.drawn())
  expect(text).not.toContain('the browser draws it')
  // under it the link, then a blank row, then the takeaway
  expect(text).toMatch(/view in browser ↗ +Most saves came at once\./)
  await ui.press({ key: 'custom-open-t0-c0cust00' })
  await w.clock.settle()
  expect(w.pressed.at(-1)).toEqual(expect.arrayContaining(['--ref', 'card:c0cust00']))
  await ui.unmount()
  const classic = (await $.ui.mount(MESSAGE('r1', false))) as unknown as M
  expect(shown(await classic.drawn({ in: 'card-t0-c0cust00' }))).toContain('45%')
  expect(shown(await classic.drawn())).toContain('view in browser ↗')
  expect(JSON.stringify(await classic.drawn())).not.toContain('custom-open-t0-c0cust00')
  await classic.unmount()
})
