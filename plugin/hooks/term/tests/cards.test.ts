// The card pane: how the card's last run ended, `run again` (r) asking main to run it, and what its code printed; a
// card's takeaway one blank row under its label row; every citation inside a card in the citation's purple.
// `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { cardOfCell } from '../cell'
import type { ThimbleCell } from '../cell'
import { cardLayout } from '../draw'
import { COLORS } from '../paint'
import { CELLS, CWD, shown, world } from './fixtures'
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

// the card's region (a Client), a blank row, then the takeaway
const GAP = /"client":\{"plugin":"thimble"\}\},\{"type":"Text","children":\[" "\]\},\{"type":"Box".*The dse wiki has the most revisions\./

test('a card with a label: a blank row between the label row and the takeaway', async ($, on) => {
  const w = world(on)
  Object.assign(w.cells.b0bar000!, { labels: ['d9b51617'], takeaway: 'The dse wiki has the most revisions.' })
  await start($, w)
  await turn($, w, 'b0bar000')
  const ui = (await $.ui.mount(MESSAGE('r1', 'Here.'))) as unknown as M
  const json = JSON.stringify(await ui.drawn())
  // the card's region ends with its label row; then the blank row; then the takeaway
  expect(json).toMatch(GAP)
  await ui.resize({ columns: 110, rows: 20, in: 'card-t0-b0bar000' })
  expect(shown(await ui.drawn({ in: 'card-t0-b0bar000' }))).toMatch(/label {2}links through a fetch proxy ↗ {2}● proxy-link {2}● none$/)
  await ui.unmount()
})

test('a card with no label: its takeaway right under the card', async ($, on) => {
  const w = world(on)
  w.cells.b0bar000!.takeaway = 'The dse wiki has the most revisions.'
  await start($, w)
  await turn($, w, 'b0bar000')
  const ui = (await $.ui.mount(MESSAGE('r1', 'Here.'))) as unknown as M
  const json = JSON.stringify(await ui.drawn())
  expect(json).toContain('The dse wiki has the most revisions.')
  expect(json).not.toMatch(GAP)
  await ui.unmount()
})

test("inside a card every citation and evidence link is in the citation's purple: an example's ↗ and place, a timeline's ↗; one underline color", () => {
  // MATT-NOTES "Mockup feedback": "no two underline colors"; the link color stays for actions (↗ open, buttons)
  const example = cardOfCell({ id: 'x0quot00', notebook: 'g1', kind: 'example', title: 'Was anything force-pushed?', takeaway: '', labels: [], created_by: 'main', status: 'ok', payload: { refs: [{ ref: 'events.jsonl#L197', quote: '{"forced": true}' }] } } as unknown as ThimbleCell).card
  const segs = cardLayout(example, 80, -1).lines.flat()
  expect(segs.find(g => g.s === '↗')).toEqual({ s: '↗', fg: COLORS.cite })
  expect(segs.find(g => g.s.startsWith('events.jsonl'))).toEqual({ s: 'events.jsonl line 197', fg: COLORS.cite, u: true })
  expect(segs.some(g => g.fg === COLORS.link)).toBe(false)
  const timeline = cardOfCell({ ...(CELLS.e0time00 as object), outputs: [{ 'application/vnd.thimble.timeline+json': { events: [{ time: '2026-05-24', label: 'first saves', ref: 'events.jsonl#L3' }, { time: '2026-06-18', label: 'peak afternoon' }] } }] } as unknown as ThimbleCell).card
  const marks = cardLayout(timeline, 60, -1).lines.flat().filter(g => g.s === '↗')
  expect(marks).toEqual([{ s: '↗', fg: COLORS.cite }])
})
