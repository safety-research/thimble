// A line chart of many lines draws in the terminal: a `detail` field draws a line per value in its color value's hue, a
// chart of more colors than the palette's names its highest lines and mutes the rest, a card keeps few enough points to
// fit Claude Code's room for a reply's tree, and a card too large for that room draws as its rows, so it never leaves an
// empty box or cuts the cards and words after it (bug hunt K2: 33 lines drew as `… 1 more characters, not drawn`, and
// the table and the sentence after it drew empty). `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { MAX_LINE_POINTS, cardOfCell } from '../cell'
import type { ThimbleCell } from '../cell'
import { cardLayout } from '../draw'
import type { Line } from '../draw'
import { COLORS } from '../paint'
import { CARDS_ROOM, propsSize } from '../reply'
import { CWD, shown, world } from './fixtures'
import type { World } from './fixtures'

type M = Mounted<'terminal'>
const MESSAGE = (requestId: string, text: string) =>
  ({ plugin: 'thimble', component: 'AssistantMessage', requestId, surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { text, isFirstOfReply: true } }) as never

const TEAMS = ['red', 'green', 'blue']
const RUNS = Array.from({ length: 30 }, (_, i) => `run-${String(i + 1).padStart(2, '0')}`)
// each run's tasks done so far, a point a minute for 8 hours
const ROWS = RUNS.flatMap((run, i) => Array.from({ length: 480 }, (_, k) => ({ run, team: TEAMS[i % 3], hours: k / 60 + i / 7919, done: Math.round(k * (1 + i / 10)) })))
const lines = (color: string, detail?: string) => ({
  mark: { type: 'line' },
  encoding: { x: { field: 'hours', type: 'quantitative' }, y: { field: 'done', type: 'quantitative' }, color: { field: color, type: 'nominal' }, ...(detail ? { detail: { field: detail, type: 'nominal' } } : {}) },
  data: { name: 'd9' },
  datasets: { d9: ROWS },
})
const plot = (id: string, spec: unknown) =>
  ({ id, kind: 'plot', title: 'How did the tasks each run did add up over the hours?', takeaway: '', labels: [], created_by: 'main', ts: '2026-10-06T10:00:00+00:00', status: 'ok', outputs: [{ 'application/vnd.vegalite.v6.json': spec, 'text/plain': '<VegaLite 6 object>' }] }) as unknown as ThimbleCell
const TABLE = {
  id: 'k2table0', kind: 'table', title: 'Which runs did the most?', takeaway: '', labels: [], created_by: 'main', ts: '2026-10-06T10:00:00+00:00', status: 'ok',
  outputs: [{ 'application/vnd.thimble.frame+json': { columns: ['run', 'done'], types: { run: 'nominal', done: 'quantitative' }, index: null, label: 'run', rows: [['run-30', 1867], ['run-29', 1803]], total: 2, view: { columns: ['done'], formats: { done: ',d' }, more: 0 } }, 'text/plain': 'run done' }],
}
const text = (l: Line) => l.map(s => s.s).join('')
/** The colors of a card's key, by the words after each `●`. */
const keyOf = (l: Line[]) => new Map(l.flatMap(line => line.flatMap((s, i) => (s.s === '● ' && line[i + 1] ? [[line[i + 1]!.s.trim(), s.fg] as const] : []))))

test("a line chart with a `detail` field draws a line per value, each in its color value's hue, with the color's key", () => {
  const { card } = cardOfCell(plot('k2lines0', lines('team', 'run')))
  expect(card.kind).toBe('line')
  expect(card.series!.map(s => s.name)).toEqual(RUNS)
  expect(card.series!.map(s => s.group)).toEqual(RUNS.map((_, i) => TEAMS[i % 3]))
  // each line's points start at 0: a line per run, never one line zigzagging across a team's runs
  expect(card.series!.every(s => s.points[0]![1] === 0)).toBe(true)
  const lay = cardLayout(card, 120, -1)
  const key = keyOf(lay.lines)
  expect([...key.keys()]).toEqual(TEAMS)
  // every braille cell in one of the teams' hues
  const hues = new Set(lay.lines.flatMap(l => l.filter(s => /[⠁-⣿]/.test(s.s)).map(s => s.fg)))
  expect([...hues].every(h => [...key.values()].includes(h))).toBe(true)
  // a mark's readout names its run
  expect(lay.items.some(i => i.value.startsWith('run-30 '))).toBe(true)
})

test('a line card keeps at most about MAX_LINE_POINTS points, its first and last and its highest of each line', () => {
  const { card } = cardOfCell(plot('k2lines0', lines('team', 'run')))
  const points = card.series!.reduce((a, s) => a + s.points.length, 0)
  expect(points).toBeLessThanOrEqual(MAX_LINE_POINTS + 2 * RUNS.length)
  const last = card.series!.at(-1)!
  expect(last.points[0]![0]).toBe(ROWS.find(r => r.run === 'run-30')!.hours)
  expect(last.points.at(-1)![1]).toBe(Math.max(...ROWS.filter(r => r.run === 'run-30').map(r => r.done)))
  // its drawing data fits the room a reply's tree has for its cards
  expect(propsSize({ card, cols: 130, meta: {} }).chars).toBeLessThan(CARDS_ROOM / 2)
})

test('a line chart of more colors than the palette has names the lines that reach highest and mutes the others', () => {
  const { card } = cardOfCell(plot('k2lines1', lines('run')))
  expect(card.series).toHaveLength(30)
  const lay = cardLayout(card, 140, -1)
  const key = keyOf(lay.lines)
  // the 13 runs that did the most, in the key's order, each in a hue of its own; the rest counted, muted
  expect([...key.keys()]).toEqual([...RUNS.slice(17), '17 more'])
  expect(new Set(RUNS.slice(17).map(r => key.get(r))).size).toBe(13)
  expect(key.get('17 more')).toBe(COLORS.dim)
  expect(lay.lines.some(l => l.some(s => /[⠁-⣿]/.test(s.s) && s.fg === COLORS.dim))).toBe(true)
})

async function turn($: Engine, w: World, cards: string[], answer: string): Promise<void> {
  await $.turn.start({ text: 'Chart it.', turnId: 't1' } as never)
  await $.session.append({ door: 'response', origin: { kind: 'model', model: 'm' }, uuid: 'r1', message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: answer }] } } as never).catch(() => undefined)
  for (const [i, id] of cards.entries()) {
    w.toolText = `card:${id}\n[out0: chart]`
    await $.tool.call({ tool: 'mcp__plugin_thimble_thimble__add_card', tool_use_id: `u${i}` } as never)
  }
  await $.turn.complete({ turnId: 't1', answer, durationMs: 5, reason: 'answer', isAborted: false } as never)
  await w.clock.advance(300)
}

const ANSWER = 'Here are the lines and the table. Together the two busiest runs did 13% of the tasks.'

test('under an answer, a chart of many lines draws as a card one points at, and the card and the words after it draw whole', { timeoutMs: 60_000 }, async ($, on) => {
  const w = world(on)
  w.cells.k2lines0 = plot('k2lines0', lines('team', 'run')) as never
  w.cells.k2table0 = TABLE as never
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
  await turn($, w, ['k2lines0', 'k2table0'], ANSWER)
  const ui = (await $.ui.mount(MESSAGE('r1', ANSWER))) as unknown as M
  const drawn = await ui.drawn()
  const words = shown(drawn)
  expect(words).not.toContain('not drawn')
  expect(words).toContain('13% of the tasks')
  expect(words).toContain('ask about this answer')
  // both cards are cards the pointer reads (Clients, card.tsx), the table's rows in its own
  const json = JSON.stringify(drawn)
  expect(json).toContain('card-t0-k2lines0')
  expect(json).toContain('card-t1-k2table0')
  expect(json).toContain('run-30')
  await ui.unmount()
})

test('a card too large for the room a reply has for its cards draws as its rows, and the cards after it draw too', { timeoutMs: 60_000 }, async ($, on) => {
  const w = world(on)
  // a code card that printed 4,000 lines
  const printed = Array.from({ length: 4000 }, (_, i) => `line ${i + 1}: the run wrote its tasks to the log and went on`).join('\n')
  w.cells.k2print0 = { id: 'k2print0', kind: 'code', title: 'What did the run print?', takeaway: '', labels: [], created_by: 'main', ts: '2026-10-06T10:00:00+00:00', status: 'ok', outputs: [{ _stream: 'stdout', 'text/plain': printed }] } as never
  w.cells.k2table0 = TABLE as never
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
  await turn($, w, ['k2print0', 'k2table0'], ANSWER)
  const ui = (await $.ui.mount(MESSAGE('r1', ANSWER))) as unknown as M
  const drawn = await ui.drawn()
  const words = shown(drawn)
  expect(words).toContain('line 1: the run wrote its tasks')
  expect(words).toContain('3976 more lines')
  expect(JSON.stringify(drawn)).toContain('card-t1-k2table0')
  expect(words).toContain('13% of the tasks')
  expect(words).toContain('ask about this answer')
  await ui.unmount()
})
