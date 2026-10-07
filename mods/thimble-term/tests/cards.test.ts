// Cards as thimble-term draws them: the title a hot spot, the card
// pane's last run, `run again` and its code's output, a card's label rows and colours from the labels it read, a
// timeline's start time said once, a label that is not in the workspace. `claude plugin test mods/thimble-term`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { cardOfCell } from '../hooks/cell'
import type { ThimbleCell } from '../hooks/cell'
import { cardLayout } from '../hooks/draw'
import { CELLS, CWD, WS, shown, world } from './fixtures'
import type { World } from './fixtures'

type M = Mounted<'terminal'>
type E = Engine

const MESSAGE = (requestId: string, text: string) =>
  ({ plugin: 'thimble-term', component: 'AssistantMessage', requestId, surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { text, isFirstOfReply: true } }) as never
const PANE = { plugin: 'thimble-term', component: 'Pane', requestId: 'thimble-term', surface: 'terminal', viewport: { columns: 120, rows: 40 }, props: { title: 'thimble', isFocused: true, bodyColumns: 96, placement: 'dock', scroll: { bodyRows: 36 }, view: {} } } as never

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

test("a card's title is a hot spot: in inverse under the pointer, a press asks a side thread about the card", async ($, on) => {
  const w = world(on)
  await start($, w)
  await turn($, w, 'a0frame0')
  const ui = (await $.ui.mount(MESSAGE('r1', 'Here.'))) as unknown as M
  const key = 'card-t0-a0frame0'
  await ui.pointer({ type: 'move', x: 3, y: 0, in: key } as never)
  const rows = ((await ui.drawn({ in: key })) as { children?: unknown[] }).children ?? []
  expect(JSON.stringify(rows[0])).toContain('"bold":true,"inverse":true')
  await ui.pointer({ type: 'down', x: 3, y: 0, button: 'left', in: key } as never)
  await ui.pointer({ type: 'up', x: 3, y: 0, button: 'left', in: key } as never)
  await ui.unmount()
  await w.clock.settle()
  const pane = (await $.ui.mount(PANE)) as unknown as M
  expect(shown(await pane.drawn())).toContain('New thread')
  await pane.unmount()
})

test("the card pane says how the card's last run ended; `run again` (r) asks main to run it; its code shows what it printed", async ($, on) => {
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

test("a broken card's pane says its last run failed, in red", async ($, on) => {
  const w = world(on)
  Object.assign(w.cells.x0err000!, { code: "df['wiki']" })
  await start($, w)
  await turn($, w, 'x0err000')
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  let pane = (await $.ui.mount(PANE)) as unknown as M
  const rows = ((await pane.drawn({ in: 'm:home' })) as { children?: unknown[] }).children ?? []
  await pane.pointer({ type: 'down', x: 6, y: rows.findIndex(r => shown(r).includes('Broken')), button: 'left', in: 'm:home' } as never)
  await w.clock.settle()
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  expect(JSON.stringify(await pane.drawn())).toContain('{"type":"Text","props":{"color":"error"},"children":["last run failed"]}')
  await pane.unmount()
})

test("a card whose script read a label shows the label's row, its values in their colours, `changed since` once the label changed", async ($, on) => {
  const w = world(on)
  Object.assign(w.cells.b0bar000!, { labels: ['d9b51617'], label_revs: { d9b51617: 3 } })
  w.states.labels = [{ ...w.states.labels[0]!, rev: 5 } as never]
  await start($, w)
  await turn($, w, 'b0bar000')
  const ui = (await $.ui.mount(MESSAGE('r1', 'Here.'))) as unknown as M
  const key = 'card-t0-b0bar000'
  await ui.resize({ columns: 110, rows: 20, in: key })
  const card = shown(await ui.drawn({ in: key }))
  expect(card).toMatch(/label {2}links through a fetch proxy ↗ {2}● proxy-link {2}● none {2}changed since/)
  await ui.unmount()
})

test("a timeline's axis names both its ends or neither: neither when the list under it starts and ends with them", () => {
  const { card } = cardOfCell(CELLS.e0time00 as unknown as ThimbleCell)
  const lines = cardLayout(card, 60, -1).lines.map(l => l.map(s => s.s).join(''))
  expect(lines.filter(l => l.includes('24 May')).length).toBe(1)
  expect(lines.filter(l => l.includes('18 Jun')).length).toBe(1)
  expect(lines[1]).toMatch(/^24 May {2}● first saves/)
  // listed in another order (by size), the list does not name the ends where an axis's reader looks: both under it
  const sorted = cardOfCell({ ...(CELLS.e0time00 as object), outputs: [{ 'application/vnd.thimble.timeline+json': { events: [{ time: '2026-06-02', label: 'most' }, { time: '2026-05-24', label: 'first saves' }, { time: '2026-06-18', label: 'peak afternoon' }] } }] } as unknown as ThimbleCell).card
  const axis = cardLayout(sorted, 60, -1).lines.map(l => l.map(s => s.s).join(''))
  expect(axis[1]).toMatch(/^24 May +18 Jun$/)
  expect(axis[1]!.length).toBe(60)
})

test('a press on a label that is not in the workspace says so in a toast and opens nothing', async ($, on) => {
  const w = world(on)
  await start($, w)
  await turn($, w, 'l0label0')
  const ui = (await $.ui.mount(MESSAGE('r1', 'Here.'))) as unknown as M
  await ui.post({ type: 'label-open', slug: 'gone0000', origin: 'y', gestures: [] }, { in: 'card-t0-l0label0' })
  await ui.unmount()
  await w.clock.settle()
  expect(w.toasts).toContain('thimble: that label is no longer in this workspace')
  expect(w.toasts.join(' ')).not.toContain('gone0000')
  expect(w.opened).toEqual([])
  void WS
})

test("a press on a label made after the labels were read opens it: the list is read again before it says the label is gone", async ($, on) => {
  const w = world(on)
  const made = w.states.labels.splice(0)
  await start($, w)
  // home reads the labels while there are none
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  w.states.labels.push(...made)
  await turn($, w, 'l0label0')
  const ui = (await $.ui.mount(MESSAGE('r1', 'Here.'))) as unknown as M
  await ui.post({ type: 'label-open', slug: 'd9b51617', origin: 'y', gestures: [] }, { in: 'card-t0-l0label0' })
  await ui.unmount()
  await w.clock.settle()
  expect(w.toasts.filter(t => t.includes('label'))).toEqual([])
  expect(w.panes.at(-1)?.title).toBe('Label: links through a fetch proxy')
})

test("a card whose check ended in an error says so in the card pane's subtitle, in red, with why; a check that read it says nothing", async ($, on) => {
  const w = world(on)
  // the live check's card (New 15): its check ran past its time, its last run was fine
  Object.assign(w.cells.a0frame0!, { check: { id: 'chk_1', status: 'error', reason: 'it ran past its 75 s at high effort', stages: {} } })
  Object.assign(w.cells.ff73e071!, { check: { id: 'chk_2', status: 'ok', stages: {} } })
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: 'card a0frame0' } as never)
  await w.clock.settle()
  let pane = (await $.ui.mount(PANE)) as unknown as M
  const json = JSON.stringify(await pane.drawn())
  expect(json).toContain('{"type":"Text","props":{"color":"error"},"children":["its check ended in an error: it ran past its 75 s at high effort"]}')
  expect(shown(await pane.drawn())).toContain('last run ok')
  await pane.unmount()
  await $.command.run({ command: 'thimble:thimble', args: 'card ff73e071' } as never)
  await w.clock.settle()
  pane = (await $.ui.mount(PANE)) as unknown as M
  expect(shown(await pane.drawn())).not.toContain('its check')
  await pane.unmount()
})
