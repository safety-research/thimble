// A faceted chart (Altair's `.facet(column=…)`) draws as a picture per panel, never as the long table of its rows; a
// heatmap as its grid of shaded cells; a chart the terminal has no picture of as a short note with a link to the
// browser once its rows are too many for a short table (bug hunt J10). `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { BROWSER_CHART, cardOfCell } from '../cell'
import type { ThimbleCell } from '../cell'
import { cardLayout } from '../draw'
import type { BarRow, CardData, Line } from '../draw'

const MODELS = ['model-b', 'model-a', 'model-c']
const STATES = ['testing', 'reading', 'waiting']
const cell = (id: string, spec: unknown) => ({ id, title: 'What does each model do over the shift?', outputs: [{ 'application/vnd.vegalite.v6.json': spec }] }) as unknown as ThimbleCell
const text = (l: Line) => l.map(s => s.s).join('')
// as Altair writes `chart.facet(column=alt.Column('model:N'))`: the rows in the top-level datasets, the chart in `spec`
const faceted = (rows: Record<string, unknown>[], spec: unknown) => ({ data: { name: 'd0' }, facet: { column: { field: 'model', type: 'nominal', title: null } }, spec, datasets: { d0: rows } })

// each model's share of agents in each state per hour: 3 models x 24 hours x 3 states, stacked by `order`
const SHARES = MODELS.flatMap((model, m) =>
  Array.from({ length: 24 }, (_, h) => {
    const t = Math.min(1, h / (10 + 4 * m))
    return [1 - t, t * 0.6, t * 0.4].map((share, k) => ({ model, hour: h / 2, state: STATES[k], share, order: k }))
  }).flat(),
)
const AREA = faceted(SHARES, {
  mark: { type: 'area' },
  encoding: { x: { field: 'hour', type: 'quantitative' }, y: { field: 'share', type: 'quantitative' }, color: { field: 'state', type: 'nominal', sort: STATES }, order: { field: 'order', type: 'quantitative' } },
})
// each run's open tickets over the shift, per model
const OPEN = MODELS.flatMap((model, m) => ['plain', 'with notes'].flatMap(run => Array.from({ length: 40 }, (_, k) => ({ model, run, hour: k / 4, open: Math.max(0, 120 - k * (3 + m) - (run === 'plain' ? 0 : 10)) }))))
const LINES = faceted(OPEN, { mark: { type: 'line' }, encoding: { x: { field: 'hour', type: 'quantitative' }, y: { field: 'open', type: 'quantitative' }, color: { field: 'run', type: 'nominal' } } })
// agents by the hour their session ended, per model; model-c has no agent ending at hour 1
const ENDS = MODELS.flatMap(model => [0, 1, 2].filter(h => !(model === 'model-c' && h === 1)).map(h => ({ model, 'hour bin': h, agents: 3 + h, how: h === 2 ? 'cut off' : 'ended itself' })))
const BARS = faceted(ENDS, { mark: { type: 'bar' }, encoding: { x: { field: 'hour bin', type: 'ordinal' }, y: { field: 'agents', type: 'quantitative' }, color: { field: 'how', type: 'nominal' } } })

test('a faceted chart draws a picture in each panel, side by side where they fit, never its rows as a table', () => {
  for (const [id, spec, kind] of [['f0area00', AREA, 'line'], ['f0line00', LINES, 'line'], ['f0bars00', BARS, 'bar']] as const) {
    const { card } = cardOfCell(cell(id, spec))
    expect(card.kind).toBe('panels')
    // a panel per model, in the order Vega-Lite sorts them (A to Z), each a card of the chart's kind
    expect(card.panels!.map(p => p.title)).toEqual(['model-a', 'model-b', 'model-c'])
    expect(card.panels!.every(p => p.card.kind === kind)).toBe(true)
    const wide = cardLayout(card, 150, -1).lines.map(text)
    // no table: no header of the rows' columns and no `… N more` rows
    expect(wide.some(l => /^model +hour|… \d+ more/.test(l))).toBe(false)
    // three panels side by side on 150 columns, one under another on 60
    expect(wide[0]).toMatch(/^model-a +model-b +model-c *$/)
    const narrow = cardLayout(card, 60, -1).lines.map(text)
    expect(narrow.filter(l => /^model-[abc] *$/.test(l))).toHaveLength(3)
    expect(narrow.every(l => [...l].length <= 60)).toBe(true)
  }
})

test("a faceted stacked area draws each panel's bands in one set of hues, stacked by its order field, with one key under all panels", () => {
  const { card } = cardOfCell(cell('f0area00', AREA))
  const panel = card.panels![0]!.card
  expect(panel.stack).toBe('zero')
  expect(panel.series!.map(s => s.name)).toEqual(STATES)
  const lay = cardLayout(card, 150, -1)
  const lines = lay.lines.map(text)
  // filled bands, not braille lines
  expect(lines.slice(1, 9).every(l => l.includes('█'))).toBe(true)
  expect(lines.join('\n')).not.toMatch(/[⠁-⣿]/)
  // one key, under the panels, each state in the same hue as its band
  const keys = lay.lines.filter(l => l.some(s => s.s === '● '))
  expect(keys.map(text)).toEqual(['● testing  ● reading  ● waiting'])
  const hue = new Map(keys[0]!.flatMap((s, i) => (s.s === '● ' ? [[text([keys[0]![i + 1]!]).trim(), s.fg]] : [])))
  // at hour 0 every agent tests: each row's first cell of the plot is the first state's, top to bottom
  expect(lay.lines.slice(1, 9).every(l => l.find(s => s.s === '█')?.fg === hue.get('testing'))).toBe(true)
  // a mark's readout names its panel
  expect(lay.items[0]!.label.startsWith('model-a · ')).toBe(true)
})

test('panels share their scales: the same y ticks in each line panel, and every bar label in each bar panel', () => {
  const lines = cardLayout(cardOfCell(cell('f0line00', LINES)).card, 150, -1).lines.map(text)
  const ticks = (l: string) => [...l.matchAll(/(\d+) ┤/g)].map(m => m[1])
  const row = lines.find(l => ticks(l).length === 3)!
  expect(new Set(ticks(row)).size).toBe(1)
  const bars = cardOfCell(cell('f0bars00', BARS)).card
  // model-c has no agent at hour 1: its panel still lists it, at 0, so the panels' rows line up
  expect((bars.panels![2]!.card.rows as BarRow[]).map(r => `${r.label}:${r.value}`)).toEqual(['0:3', '1:0', '2:5'])
})

test('a heatmap draws as its grid of shaded cells, in its axes order, with a readout per cell', () => {
  const sites = ['alpha.example', 'beta.example', 'gamma.example']
  const days = ['Day 1 (40 saves)', 'Day 2 (12 saves)', 'Day 3 (300 saves)', 'Day 4 (9 saves)']
  const rows = days.flatMap((day, d) => sites.map((site, s) => ({ day, site, share: s === d % 3 ? 0.5 + d / 10 : 0 })))
  const spec = { mark: 'rect', data: { values: rows }, encoding: { x: { field: 'day', type: 'nominal', sort: days }, y: { field: 'site', type: 'nominal', sort: sites }, color: { field: 'share', type: 'quantitative' } } }
  const { card } = cardOfCell(cell('h0heat00', spec))
  expect(card.kind).toBe('heat')
  const lay = cardLayout(card, 90, -1)
  const lines = lay.lines.map(text)
  expect(lines).toHaveLength(3 + 3 + 1)
  expect(lines[0]).toMatch(/^alpha\.example +▓+ +· +· +█+$/)
  expect(lines[2]).toMatch(/^gamma\.example +· +· +█+ +·/)
  // the days' names under their columns, wrapped; the key from the least share to the most
  expect(lines[3]).toMatch(/Day 1 +Day 2 +Day 3 +Day 4/)
  expect(lines.at(-1)).toBe('0 ·░▒▓█ 0.8  share')
  expect(lay.items.find(i => i.label === 'gamma.example · Day 3 (300 saves)')).toMatchObject({ value: '0.7 share' })
})

test('a chart with no picture in the terminal: its rows as a table while they are few, else a note that the browser shows it', () => {
  const pie = (n: number) => ({ mark: { type: 'arc' }, data: { values: Array.from({ length: n }, (_, i) => ({ kind: `kind-${i}`, n: i + 1 })) }, encoding: { theta: { field: 'n', type: 'quantitative' }, color: { field: 'kind', type: 'nominal' } } })
  const few = cardOfCell(cell('p0pie000', pie(4))).card
  expect(few.kind).toBe('table')
  const many: CardData = cardOfCell(cell('p0pie001', pie(120))).card
  expect(many).toMatchObject({ kind: 'note', note: BROWSER_CHART, browser: true })
  expect(cardLayout(many, 80, -1).lines.map(text)).toEqual([BROWSER_CHART])
})
