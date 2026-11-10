// The charts in a figure style (src/lib/theme.ts FigureStyle): the chart tokens each style sets (styles/tokens.css),
// the Vega-Lite config drawn from them (lib/vizTheme vegaConfig), the changes thimble.chart's charts and a card's own
// Altair charts get in Blog and in Paper (lib/figureSpec), some of them compiled and drawn by Vega without a page, a
// matplotlib figure's text in the chart's faces (lib/svg), and the Blog style's chart face in sandboxed frames
// (lib/frame). All data is made up.
import { readFileSync } from 'node:fs'
import * as vega from 'vega'
import * as vl from 'vega-lite'
import { afterEach, expect, test } from 'vitest'
import { chartDefaults } from '../../src/lib/chartDefaults.ts'
import { figureSpec, LABEL_AT, LABEL_RANK, LABEL_TEXT, LINE_DOTS, NAME_ROOM, nameParams, PAPER_DASHES, valueFormat, VALUE_ROWS, valueTone } from '../../src/lib/figureSpec.ts'
import { FIGURE_FACES, pageFaces } from '../../src/lib/frame.ts'
import { restyle } from '../../src/lib/svg.ts'
import { figureStyle, vegaConfig, VIZ_SERIES } from '../../src/lib/vizTheme.ts'

type Spec = Record<string, any>
const CSS = readFileSync(new URL('../../src/styles/tokens.css', import.meta.url), 'utf8')

/** the declarations of each rule whose selector, its whitespace collapsed, is `selector`, later rules over earlier ones */
function rule(selector: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim() !== selector) continue
    for (const d of m[2].replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[d[1]] = d[2].trim()
  }
  return out
}
/** the tokens on a paper in a figure style, as the cascade gives them, their var() references followed */
function tokens(style: 'thimble' | 'blog' | 'paper', paper: 'warm' | 'dark' = 'warm'): Record<string, string> {
  const at = { ...rule(':root'), ...rule(":root, :root[data-accent='iris']"), ...(paper === 'dark' ? rule(":root[data-paper='dark']") : {}) }
  if (style !== 'thimble') Object.assign(at, rule(`:root[data-figures='${style}']`), rule(paper === 'dark' ? `:root[data-figures='${style}'][data-paper='dark']` : `:root[data-figures='${style}']:not([data-paper='dark'])`))
  const value = (name: string, depth = 0): string => (at[name] ?? '').replace(/var\((--[\w-]+)\)/g, (_, ref: string) => (depth < 8 ? value(ref, depth + 1) : ''))
  return Object.fromEntries(Object.keys(at).map((k) => [k, value(k)]))
}
/** the page's document as lib/vizTheme reads it, holding `values` */
function onPage(values: Record<string, string>): void {
  ;(globalThis as Spec).document = { documentElement: {} }
  ;(globalThis as Spec).getComputedStyle = () => ({ getPropertyValue: (n: string) => values[n] ?? '' })
}
afterEach(() => {
  delete (globalThis as Spec).document
  delete (globalThis as Spec).getComputedStyle
})

test("thimble's own style keeps the chart config as it was: mono labels, ticks, no figure style named", () => {
  onPage(tokens('thimble'))
  expect(figureStyle()).toBe('thimble')
  const c = vegaConfig() as Spec
  expect(c).toEqual(vegaConfig('thimble'))
  expect(c.axis.labelFont).toContain('Geist Mono')
  expect(c.axis.ticks).toBeUndefined()
  expect(c.axisX).toEqual({ grid: false })
  expect(c.legend.symbolType).toBe('square')
  expect(c.bar.cornerRadiusEnd).toBe(2)
  expect(c.range.category).toEqual(['#0471c8', '#e26101', '#018d82', '#c8367b', '#a08319', '#5e4bd6', '#306602'])
})

test("Blog draws blogpost-figure's chart: its series, a gray baseline and gridlines across only, no ticks, DM Sans throughout", () => {
  onPage(tokens('blog'))
  expect(figureStyle()).toBe('blog')
  const c = vegaConfig() as Spec
  expect(c.range.category).toEqual(['#b86046', '#40668c', '#0e6b54', '#6258d2', '#b58c60', '#585850', '#47267f'])
  expect(c.range.ramp.scheme).toEqual(['#f7e9e3', '#e0baaf', '#c7816c', '#b86046', '#8f4a35'])
  expect(c.range.diverging.scheme).toEqual(['#40668c', '#9db1c6', '#eae9e5', '#e0baaf', '#b86046'])
  expect(c.font).toMatch(/^'DM Sans'/)
  expect([c.axis.labelFont, c.axis.titleFont, c.legend.labelFont, c.text.font]).toEqual([c.font, c.font, c.font, c.font])
  expect(c.axis).toMatchObject({ ticks: false, domain: false, gridColor: '#eae9e5', labelColor: '#8a8a86', labelFontSize: 12, titleColor: '#5a5a57', titleFontSize: 13 })
  expect(c.axisX).toEqual({ grid: false, domain: true, domainColor: '#afafab' })
  expect(c.axisY).toEqual({ grid: true })
  // category names in ink, a horizontal bar chart's categories with no gridlines between them
  expect(c.axisXDiscrete.labelColor).toBe('#1f1f1e')
  expect(c.axisYDiscrete).toMatchObject({ grid: false, labelColor: '#1f1f1e' })
  expect(c.bar.cornerRadiusEnd).toBe(0)
  expect(c.rule.color).toBe('#2b2b2a')
})

test("Paper draws paper-figure's chart: Okabe-Ito, left and bottom axes with ticks, gridlines both ways, a plain sans at 9 and 8 pt", () => {
  onPage(tokens('paper'))
  const c = vegaConfig() as Spec
  expect(c.range.category).toEqual(['#0072b2', '#e69f00', '#009e73', '#cc79a7', '#56b4e9', '#d55e00', '#f0e442'])
  expect(c.range.ramp.scheme).toEqual(['#deebf7', '#9ecae1', '#4292c6', '#2171b5', '#08519c'])
  expect(c.font).toMatch(/^'Helvetica Neue'/)
  expect(c.axis).toMatchObject({ domain: true, ticks: true, tickSize: 4, grid: true, gridColor: '#e5e5e5', labelColor: '#262626', labelFontSize: 10.67, titleFontSize: 12 })
  expect(c.axisX).toEqual({ grid: true })
  // a legend of the marks' own symbols, so a line's shows its dash and shape
  expect(c.legend.symbolType).toBeUndefined()
})

test("on Dark a figure style keeps the paper's chrome and changes only the series and ramps, which run from near the paper", () => {
  const dark = tokens('thimble', 'dark')
  onPage(tokens('blog', 'dark'))
  const c = vegaConfig() as Spec
  expect(c.range.category[0]).toBe('#b86046')
  expect(c.range.ramp.scheme).toEqual(['#8f4a35', '#b86046', '#c7816c', '#e0baaf', '#f7e9e3'])
  expect(c.range.diverging.scheme[2]).toBe(dark['--viz-ink-4'])
  expect(c.axis.labelColor).toBe(dark['--viz-label'])
  expect(c.axis.gridColor).toBe(dark['--viz-grid'])
  expect(c.axisXDiscrete.labelColor).toBe(dark['--viz-ink-1'])
  onPage(tokens('paper', 'dark'))
  expect((vegaConfig() as Spec).axis.labelColor).toBe(dark['--viz-label'])
})

// thimble.chart's charts as the kernel writes them (backend kernel_thimble): rows inline, every mark's tooltip every column
const tip = (...cols: string[]) => cols.map((c) => ({ field: c, type: 'nominal', title: c }))
const SCHEMA = 'https://vega.github.io/schema/vega-lite/v6.json'
const methods = [
  { method: 'Baseline', 'honest %': 59 },
  { method: 'Distilled', 'honest %': 67.5 },
  { method: 'Ensemble', 'honest %': 88 },
]
const barsAcross = (): Spec => ({
  $schema: SCHEMA,
  data: { values: methods },
  mark: 'bar',
  encoding: { y: { field: 'method', type: 'nominal', title: 'method', sort: ['Ensemble', 'Distilled', 'Baseline'] }, x: { field: 'honest %', type: 'quantitative', title: 'honest %' }, tooltip: tip('method', 'honest %') },
})
const sizes = [2, 2, 9, 9].map((s, i) => ({ size: s, 'honest %': [59, 79, 67, 88][i], model: i % 2 ? 'With the method' : 'Untrained', lo: [54, 74, 62, 84][i], hi: [64, 84, 72, 92][i] }))
const groupedUp = (): Spec => ({
  $schema: SCHEMA,
  data: { values: sizes },
  mark: 'bar',
  encoding: {
    x: { field: 'size', type: 'ordinal', title: 'size', sort: [2, 9] },
    y: { field: 'honest %', type: 'quantitative', title: 'honest %' },
    color: { field: 'model', type: 'nominal', title: 'model', sort: ['With the method', 'Untrained'] },
    xOffset: { field: 'model', type: 'nominal', sort: ['With the method', 'Untrained'] },
    tooltip: tip('size', 'honest %', 'model'),
  },
})
const runs = ['Nova', 'Rho', 'Open'].flatMap((model, j) => [1, 2, 4, 8].map((k, i) => ({ k, 'pass rate': [30, 28, 3][j] + i * [10, 8, 3][j], model })))
const lines = (): Spec => ({
  $schema: SCHEMA,
  data: { values: runs },
  mark: { type: 'line', point: true },
  encoding: {
    x: { field: 'k', type: 'quantitative', title: 'k' },
    y: { field: 'pass rate', type: 'quantitative', title: 'pass rate' },
    color: { field: 'model', type: 'nominal', title: 'model', sort: ['Nova', 'Rho', 'Open'] },
    tooltip: tip('k', 'pass rate', 'model'),
  },
})
const PALETTE = ['#b86046', '#40668c']
const blog = (spec: Spec, width = 690) => figureSpec(spec, 'blog', { width, palette: PALETTE }) as Spec

// a card's own Altair charts as Altair writes them: the rows in a dataset the data names, a config of its own
const ALTAIR = 'https://vega.github.io/schema/vega-lite/v6.4.1.json'
const altair = (rows: unknown[], unit: Spec): Spec => ({ $schema: ALTAIR, config: { view: { continuousWidth: 300, continuousHeight: 300 } }, data: { name: 'data-1' }, datasets: { 'data-1': rows }, ...unit })
const STATES = ['open', 'merged', 'closed']
const prs = ['alpha', 'beta', 'gamma', 'delta'].flatMap((run, i) => STATES.map((state, j) => ({ run, state, PRs: [[156, 14, 6], [151, 7, 18], [139, 2, 35], [148, 4, 25]][i][j] })))
// the card check's rewrite of thimble.chart's grouped bars: bars across, side by side by an offset
const groupedAcross = (): Spec =>
  altair(prs, {
    mark: { type: 'bar' },
    encoding: {
      color: { field: 'state', sort: STATES, type: 'nominal' },
      tooltip: [{ field: 'run', type: 'nominal' }, { field: 'state', type: 'nominal' }, { field: 'PRs', type: 'quantitative' }],
      x: { field: 'PRs', title: 'PRs', type: 'quantitative' },
      y: { field: 'run', title: 'run', type: 'nominal' },
      yOffset: { field: 'state', sort: STATES, type: 'nominal' },
    },
  })

test("a figure style changes no chart in thimble's own style, and of a card's own charts none but those of one view", () => {
  const spec = barsAcross()
  expect(figureSpec(spec, 'thimble')).toBe(spec)
  expect(figureSpec(groupedAcross(), 'thimble')).toEqual(groupedAcross())
  // layers, panels, views side by side and selections take the style's config alone, in Blog and in Paper
  const { mark, encoding } = groupedAcross()
  const others: Spec[] = [
    altair(prs, { layer: [{ mark, encoding }, { mark: 'rule', encoding: { x: { datum: 100 } } }] }),
    altair(prs, { facet: { column: { field: 'run', type: 'nominal' } }, spec: { mark, encoding } }),
    altair(prs, { hconcat: [{ mark, encoding }, { mark, encoding }] }),
    altair(prs, { repeat: ['PRs'], spec: { mark, encoding } }),
    altair(prs, { mark, encoding, params: [{ name: 'pick', select: 'point' }] }),
    altair(runs, { mark: 'line', encoding: { x: { field: 'k', type: 'quantitative' }, y: { field: 'pass rate', type: 'quantitative' }, color: { field: 'model', type: 'nominal' }, row: { field: 'model', type: 'nominal' } } }),
  ]
  for (const other of others) {
    expect(figureSpec(other, 'blog', { width: 690 })).toBe(other)
    expect(figureSpec(other, 'paper', { width: 690 })).toBe(other)
  }
})

test('in Blog a bar carries its value at its end in its color, semibold, all with one precision, and a horizontal chart has gridlines down from x', () => {
  const s = blog(barsAcross())
  const [bars, values] = s.layer
  expect(bars.mark).toBe('bar')
  expect(bars.encoding.x.axis).toEqual({ grid: true })
  expect(values.mark).toMatchObject({ type: 'text', fontWeight: 600, fontSize: 15, baseline: 'middle', color: { expr: valueTone('"#b86046"') } })
  expect(values.mark.align.expr).toContain('datum["honest %"] < 0')
  expect(values.encoding.text).toEqual({ field: 'honest %', type: 'quantitative', format: ',.1f' })
  // the same axis as the bars', so the layers share it; the category axis has no title, its names say it
  expect(values.encoding.x).toEqual(bars.encoding.x)
  expect(values.encoding.y).toEqual(bars.encoding.y)
  expect(bars.encoding.y).toMatchObject({ field: 'method', title: null })
  expect(s.data).toEqual(barsAcross().data)
  // too many rows to name each value: the gridlines turn, and no value is written
  const many = barsAcross()
  many.data.values = Array.from({ length: VALUE_ROWS + 1 }, (_, i) => ({ method: `m${i}`, 'honest %': i }))
  expect(blog(many).layer).toBeUndefined()
  expect(blog(many).encoding.x.axis).toEqual({ grid: true })
})

test("in Blog bars side by side carry their values in their groups' colors under one legend, a row over the chart", () => {
  const s = blog(groupedUp())
  const [bars, values] = s.layer
  expect(bars.encoding.color.legend).toMatchObject({ title: null, orient: 'top', direction: 'horizontal', symbolType: 'square', labelColor: { expr: valueTone("scale('color', datum.value)") } })
  // each value in its bar's color from the bars' scale, which adds no legend beside theirs
  expect(values.mark.color).toEqual({ expr: valueTone(`scale('color', datum["model"])`) })
  expect(values.encoding.color).toBeUndefined()
  expect(values.encoding.xOffset).toEqual(bars.encoding.xOffset)
  expect(values.mark.dy.expr).toContain('datum["honest %"] < 0')
  // four bars need 4 x VALUE_ROOM px across: in less, no values
  expect(blog(groupedUp(), 100).layer).toBeUndefined()
  // a stack's segments carry none, and its legend is a row too
  const stacked = groupedUp()
  delete stacked.encoding.xOffset
  const st = blog(stacked)
  expect(st.layer).toBeUndefined()
  expect(st.encoding.color.legend.orient).toBe('top')
})

test('in Blog a bar with an interval carries its value past the end of its interval', () => {
  const { data, mark, encoding } = groupedUp()
  const rule = { mark: 'rule', encoding: { y: { field: 'lo', type: 'quantitative', title: 'honest %' }, y2: { field: 'hi' }, x: encoding.x, xOffset: encoding.xOffset, tooltip: encoding.tooltip } }
  const s = blog({ $schema: SCHEMA, data, layer: [{ mark, encoding }, rule] })
  expect(s.layer).toHaveLength(3)
  const values = s.layer[2]
  expect(values.transform).toEqual([{ calculate: 'datum["honest %"] < 0 ? min(datum["honest %"], datum["lo"]) : max(datum["honest %"], datum["hi"])', as: LABEL_AT }])
  expect(values.encoding.y.field).toBe(LABEL_AT)
  expect(values.encoding.text.field).toBe('honest %')
})

/** What Vega-Lite warns of when it compiles `spec` in `config`; it throws for a spec it cannot compile. */
function warnings(spec: unknown, config: Spec = {}): string[] {
  const said: string[] = []
  const logger = { level: () => logger, info: () => logger, debug: () => logger, error: (...m: unknown[]) => (said.push(m.join(' ')), logger), warn: (...m: unknown[]) => (said.push(m.join(' ')), logger) }
  vl.compile(spec as never, { config, logger: logger as never })
  return said
}

test("in Blog a card's own grouped bars get thimble.chart's: a legend row, values from the dataset, gridlines from x, no category title", () => {
  const s = blog(groupedAcross())
  expect(s.data).toEqual({ name: 'data-1' })
  expect(s.datasets).toEqual(groupedAcross().datasets)
  const [bars, values] = s.layer
  expect(bars.encoding.color.legend).toMatchObject({ title: null, orient: 'top', direction: 'horizontal', symbolType: 'square', labelColor: { expr: valueTone("scale('color', datum.value)") } })
  expect(bars.encoding.y).toEqual({ field: 'run', title: null, type: 'nominal' })
  expect(bars.encoding.x.axis).toEqual({ grid: true })
  // each bar's value in its state's color, side by side as the bars are, on the bars' axes
  expect(values.mark).toMatchObject({ type: 'text', fontWeight: 600, color: { expr: valueTone(`scale('color', datum["state"])`) } })
  expect(values.encoding).toEqual({ y: bars.encoding.y, x: bars.encoding.x, yOffset: bars.encoding.yOffset, text: { field: 'PRs', type: 'quantitative', format: ',.0f' } })
  expect(warnings(s, vegaConfig('blog'))).toEqual([])
})

test("in Blog a card's own bars carry values only where the spec's rows say each bar's value", () => {
  const { mark, encoding } = groupedAcross()
  // stacked: a legend row, no values
  const { yOffset: _o, ...stack } = encoding
  const stacked = blog(altair(prs, { mark, encoding: stack }))
  expect(stacked.layer).toBeUndefined()
  expect(stacked.encoding.color.legend.title).toBeNull()
  // rows the spec does not hold, or that a transform changes, or a count of rows: no values, the rest as ever
  const fetched = blog({ ...groupedAcross(), data: { url: 'data:text/csv,run' } })
  const filtered = blog({ ...groupedAcross(), transform: [{ filter: 'datum.PRs > 5' }] })
  const counted = blog(altair(prs, { mark, encoding: { y: encoding.y, x: { aggregate: 'count', type: 'quantitative' } } }))
  for (const s of [fetched, filtered, counted]) {
    expect(s.layer).toBeUndefined()
    expect(s.encoding.y.title).toBeNull()
    expect(s.encoding.x.axis).toEqual({ grid: true })
  }
  // two rows to a bar: no values
  expect(blog(altair([...prs, prs[0]], { mark, encoding })).layer).toBeUndefined()
  // colors that repeat the categories need no legend; one color of the mark's own colors the values
  const tickets = [{ team: 'north', n: 31 }, { team: 'south', n: 18 }]
  const same = blog(altair(tickets, { mark: { type: 'bar' }, encoding: { x: { field: 'team', type: 'nominal' }, y: { field: 'n', type: 'quantitative' }, color: { field: 'team', type: 'nominal' } } }))
  expect(same.layer[0].encoding.color.legend).toBeNull()
  const plain = blog(altair(tickets, { mark: { type: 'bar', color: '#40668c' }, encoding: { x: { field: 'team', type: 'nominal' }, y: { field: 'n', type: 'quantitative' } } }))
  expect(plain.layer[1].mark.color).toEqual({ expr: valueTone('"#40668c"') })
  expect(warnings(same, vegaConfig('blog'))).toEqual([])
})

test("in Blog each line is named in one column at the plot's right edge, at its end's height, in its color in place of the legend", () => {
  const s = blog(lines())
  const [line, names] = s.layer
  expect(line.encoding.color.legend).toBeNull()
  expect(names.mark).toMatchObject({ type: 'text', align: 'left', baseline: 'middle', dx: 8, fontWeight: 500 })
  expect(names.encoding.x).toEqual({ value: 'width' })
  // the line's own y and color, each name's row holding its line's end under the line's field
  expect(names.encoding.y).toEqual(line.encoding.y)
  expect(names.encoding.color).toEqual(line.encoding.color)
  expect(names.encoding.text).toEqual({ field: LABEL_TEXT, type: 'nominal' })
  // from the bottom of the plot up, each moved to the place a signal computes once the y scale is known
  expect(names.data.values.map((r: Spec) => [r.model, r['pass rate'], r[LABEL_RANK], r[LABEL_TEXT]])).toEqual([
    ['Open', 12, 0, 'Open'],
    ['Rho', 52, 1, 'Rho'],
    ['Nova', 60, 2, 'Nova'],
  ])
  expect(names.mark.dy.expr).toBe(`[thimble_name_0, thimble_name_1, thimble_name_2][datum["${LABEL_RANK}"]] - scale('y', datum["pass rate"])`)
  expect(s.params.map((p: Spec) => p.name)).toEqual(['thimble_name_up_0', 'thimble_name_up_1', 'thimble_name_up_2', 'thimble_name_2', 'thimble_name_1', 'thimble_name_0'])
  expect(warnings(s, vegaConfig('blog'))).toEqual([])
  // a single line carries its last value instead
  const one = lines()
  one.data.values = runs.filter((r) => r.model === 'Rho')
  delete one.encoding.color
  const single = blog(one).layer[1]
  expect(single.mark).toMatchObject({ fontWeight: 600, color: '#b86046' })
  expect(single.data.values[0][LABEL_TEXT]).toBe(52)
  expect(single.encoding.text.format).toBe(',.0f')
})

test('each name moves up past the one under it, then down under the one above it from the plot top: signals in that order', () => {
  expect(nameParams(['e0', 'e1', 'e2'], 20)).toEqual([
    { name: 'thimble_name_up_0', expr: 'e0' },
    { name: 'thimble_name_up_1', expr: 'min(e1, thimble_name_up_0 - 20)' },
    { name: 'thimble_name_up_2', expr: 'min(e2, thimble_name_up_1 - 20)' },
    { name: 'thimble_name_2', expr: 'max(thimble_name_up_2, 0)' },
    { name: 'thimble_name_1', expr: 'max(thimble_name_up_1, thimble_name_2 + 20)' },
    { name: 'thimble_name_0', expr: 'max(thimble_name_up_0, thimble_name_1 + 20)' },
  ])
})

/** The names a chart's text layer drew, as Vega lays the chart out without a page: each one's text and place, px. */
async function drawnNames(spec: unknown): Promise<{ text: string; x: number; y: number }[]> {
  const view = new vega.View(vega.parse(vl.compile(spec as never, { config: vegaConfig('blog') as never }).spec), { renderer: 'none' })
  await view.runAsync()
  const out: { text: string; x: number; y: number }[] = []
  const walk = (m: Spec) => {
    for (const it of m.items ?? []) {
      if (m.marktype === 'text' && m.role === 'mark') out.push({ text: String(it.text), x: it.x + (it.dx ?? 0), y: it.y + (it.dy ?? 0) })
      for (const c of it.items ?? []) walk(c)
    }
  }
  walk((view.scenegraph() as unknown as { root: Spec }).root)
  view.finalize()
  return out
}

test("in Blog the names of lines that end close together, or early, stand in one column a name's room apart", async () => {
  onPage(tokens('blog'))
  // five lines ending within a few px of each other at the top of a 300 px plot, one of them early
  const ends = [0.9, 0.905, 0.91, 0.912, 0.93]
  const steps = (i: number) => (i === 2 ? [0, 1, 2] : [0, 1, 2, 3, 4])
  const rows = ends.flatMap((end, i) => steps(i).map((k, _, all) => ({ step: k, score: (end * k) / (all.length - 1), run: `run ${i}` })))
  const drawn = await drawnNames(blog(altair(rows, { mark: { type: 'line' }, encoding: { x: { field: 'step', type: 'quantitative' }, y: { field: 'score', type: 'quantitative' }, color: { field: 'run', type: 'nominal' } } })))
  expect(drawn.map((d) => d.text).sort()).toEqual(['run 0', 'run 1', 'run 2', 'run 3', 'run 4'])
  // one column past the plot's right edge (Vega-Lite's 300 px), whatever x each line ends at
  expect(new Set(drawn.map((d) => d.x))).toEqual(new Set([300 + 8]))
  const ys = drawn.map((d) => d.y).sort((a, b) => a - b)
  for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(NAME_ROOM - 1e-9)
  expect(ys[0]).toBeGreaterThanOrEqual(0)
  // a single line's last value stands there too
  const single = await drawnNames(blog(altair(rows.filter((r) => r.run === 'run 4'), { mark: { type: 'line' }, encoding: { x: { field: 'step', type: 'quantitative' }, y: { field: 'score', type: 'quantitative' } } })))
  expect(single).toMatchObject([{ text: '0.930', x: 308 }])
})

test("in Blog a card's own lines are named as thimble.chart's are, and keep their legend, as a row, where the rows do not say where they end", () => {
  const encoding = { x: { field: 'k', type: 'quantitative' }, y: { field: 'pass rate', type: 'quantitative' }, color: { field: 'model', type: 'nominal' } }
  const named = blog(altair(runs, { mark: { type: 'line' }, encoding }))
  expect(named.layer[1].data.values.map((r: Spec) => r[LABEL_TEXT])).toEqual(['Open', 'Rho', 'Nova'])
  expect(named.data).toEqual({ name: 'data-1' })
  // rows the spec does not hold, a transform, a stack, or a log scale with an end it cannot place: the legend, as a row
  const kept = [
    blog({ ...altair(runs, { mark: 'line', encoding }), data: { url: 'data:text/csv,k' } }),
    blog(altair(runs, { mark: 'line', encoding, transform: [{ filter: 'datum.k > 1' }] })),
    blog(altair(runs, { mark: 'line', encoding: { ...encoding, y: { ...encoding.y, stack: 'zero' } } })),
    blog(altair([...runs, { k: 16, 'pass rate': 0, model: 'Open' }], { mark: 'line', encoding: { ...encoding, y: { ...encoding.y, scale: { type: 'log' } } } })),
  ]
  for (const s of kept) {
    expect(s.layer).toBeUndefined()
    expect(s.encoding.color.legend).toMatchObject({ title: null, orient: 'top', direction: 'horizontal' })
  }
})

test("in Blog a heatmap's cells carry their values, white on a dark cell and ink on a light one, in place of the color bar", () => {
  const cells = ['A', 'B'].flatMap((m) => ['bare', 'ablated'].map((c, i) => ({ condition: c, model: m, share: i * 90 + (m === 'B' ? 4 : 0) })))
  const heat: Spec = {
    $schema: SCHEMA,
    data: { values: cells },
    mark: 'rect',
    encoding: { x: { field: 'condition', type: 'nominal', title: 'condition' }, y: { field: 'model', type: 'nominal', title: 'model' }, color: { field: 'share', type: 'quantitative', title: 'share' }, tooltip: tip('condition', 'model', 'share') },
  }
  const [rects, values] = blog(heat).layer
  expect(rects.encoding.color.legend).toBeNull()
  // the cell's own color decides, so a value reads on either paper
  expect(values.mark.color.expr).toBe(`luminance(scale('color', datum["share"])) > 0.4 ? '#1f1f1e' : '#ffffff'`)
  expect(values.encoding.text).toEqual({ field: 'share', type: 'quantitative', format: ',.0f' })
})

test("in Paper the lines of a chart differ by Paper's dashes and by their dots' shape as well as by color, under one legend", () => {
  const s = figureSpec(lines(), 'paper') as Spec
  const by = { field: 'model', type: 'nominal', title: 'model', sort: ['Nova', 'Rho', 'Open'] }
  expect(s.encoding.strokeDash).toEqual({ ...by, scale: { range: PAPER_DASHES } })
  expect(s.encoding.shape).toEqual(by)
  expect(s.mark).toEqual({ type: 'line', point: true })
  expect(s.layer).toBeUndefined()
  // bars keep their look
  expect(figureSpec(groupedUp(), 'paper')).toEqual(groupedUp())
})

test("in Paper a line has dots only while it has at most LINE_DOTS values, and a card's own lines are drawn so too", () => {
  const long = Array.from({ length: LINE_DOTS + 1 }, (_, k) => ['a', 'b'].map((model) => ({ k, 'pass rate': k + (model === 'a' ? 0 : 3), model }))).flat()
  const encoding = { x: { field: 'k', type: 'quantitative' }, y: { field: 'pass rate', type: 'quantitative' }, color: { field: 'model', type: 'nominal' } }
  // a card's own short lines take dots of a shape per line
  const short = figureSpec(altair(runs, { mark: { type: 'line' }, encoding }), 'paper') as Spec
  expect(short.mark).toEqual({ type: 'line', point: true })
  expect(short.encoding.shape.field).toBe('model')
  expect(warnings(short, vegaConfig('paper'))).toEqual([])
  // long lines take none, even asked for, and their legend's swatches are long enough to show a whole dash
  const dense = figureSpec(altair(long, { mark: { type: 'line', point: true }, encoding }), 'paper') as Spec
  expect(dense.mark).toEqual({ type: 'line', point: false })
  expect(dense.encoding.shape).toBeUndefined()
  expect(dense.encoding.strokeDash.scale.range).toBe(PAPER_DASHES)
  expect(Math.sqrt(dense.encoding.color.legend.symbolSize)).toBeGreaterThanOrEqual(Math.max(...PAPER_DASHES.map((d) => d.reduce((a, b) => a + b, 0))))
  // a chart whose config turns its legends off (a Paper figure's) keeps them off
  const figure = figureSpec(altair(long, { mark: { type: 'line' }, encoding, config: { legend: { disable: true } } }), 'paper') as Spec
  expect(figure.encoding.color).toEqual(encoding.color)
  expect(vl.compile(figure as never).spec.legends ?? []).toEqual([])
  // rows the spec does not hold: the line keeps the dots it has
  const fetched = figureSpec({ ...altair(runs, { mark: 'line', encoding }), data: { url: 'data:text/csv,k' } }, 'paper') as Spec
  expect(fetched.mark).toBe('line')
  expect(fetched.encoding.shape).toBeUndefined()
})

test("Paper's dashes are seven, solid first, each its own, every dash and gap long enough to read at 2.5 in", () => {
  expect(PAPER_DASHES).toHaveLength(7)
  expect(PAPER_DASHES[0]).toEqual([1, 0])
  expect(new Set(PAPER_DASHES.map((d) => d.join(' '))).size).toBe(7)
  // Vega-Lite's own list ends in [1, 1] and [1, 2, 4, 2], whose 1 px dots and gaps fade a light line away
  for (const d of PAPER_DASHES.slice(1)) for (const part of d) expect(part).toBeGreaterThanOrEqual(2)
})

test("values are written in their axis's format, else with the decimals the largest needs and no more than any has", () => {
  const def = (axis?: Spec): Spec => ({ field: 'v', type: 'quantitative', ...(axis ? { axis } : {}) })
  const rows = (...vs: number[]) => vs.map((v) => ({ v }))
  expect(valueFormat(def({ format: ',d' }), rows(1.5))).toBe(',d')
  expect(valueFormat(def(), rows(41.2, 63, 83.1))).toBe(',.1f')
  expect(valueFormat(def(), rows(1234.5, 99))).toBe(',.0f')
  expect(valueFormat(def(), rows(0.25, 0.5))).toBe(',.2f')
  expect(valueFormat(def(), rows(0.123456789))).toBe(',.3f')
})

test('in Blog a legend the chart names no side for is a row over the chart; otherwise it goes under a card-wide chart', () => {
  const spec = groupedUp()
  expect((chartDefaults(spec, { width: 690, legend: 'top' }) as Spec).config.legend.orient).toBe('top')
  expect((chartDefaults(spec, { width: 690 }) as Spec).config.legend.orient).toBe('bottom')
})

test("a matplotlib figure's text takes the chart's faces, which are the page's own in thimble's style", () => {
  expect(restyle("font: 11px 'Hanken Grotesk'")).toBe(' font: 11px var(--viz-font)')
  expect(restyle("font-family: 'DejaVu Sans Mono'; fill: #0471c8")).toBe(' font-family: var(--viz-font-label); fill: var(--viz-1)')
  const thimble = tokens('thimble')
  expect([thimble['--viz-font'], thimble['--viz-font-label']]).toEqual([thimble['--font-body'], thimble['--font-mono']])
  expect(tokens('blog')['--viz-font-label']).toBe(tokens('blog')['--viz-font'])
})

test('the series order every style draws in is seven colors long', () => {
  for (const style of ['thimble', 'blog', 'paper'] as const) expect(new Set(VIZ_SERIES.map((n) => tokens(style)[n])).size).toBe(7)
})

/** an @font-face rule as the browser writes one back, for a family's subset and weight */
const face = (family: string, subset: string, weight = 400) =>
  `@font-face { font-family: "${family}"; font-style: normal; font-display: swap; font-weight: ${weight}; src: url("/assets/${family.toLowerCase().replace(/ /g, '-')}-${subset}-${weight}-normal.woff2") format("woff2"); }`

test("a frame takes the page's two faces, and the Blog style's chart face beside them only while that style is on", () => {
  const rules = ['Hanken Grotesk', 'Geist Mono', 'DM Sans', 'Source Serif 4'].flatMap((f) => [face(f, 'latin'), face(f, 'latin-ext'), face(f, 'cyrillic')])
  const families = (got: { decls: string }[]) => [...new Set(got.map((g) => /font-family:\s*"([^"]+)"/.exec(g.decls)?.[1]))]
  expect(families(pageFaces(rules))).toEqual(['Hanken Grotesk', 'Geist Mono'])
  expect(FIGURE_FACES.thimble).toEqual([])
  expect(FIGURE_FACES.paper).toEqual([])
  const blogFaces = pageFaces(rules, ['Hanken Grotesk', 'Geist Mono', ...FIGURE_FACES.blog])
  expect(families(blogFaces)).toEqual(['Hanken Grotesk', 'Geist Mono', 'DM Sans'])
  // the latin subsets only, each without its src, which the frame gives as data
  expect(blogFaces.filter((g) => g.decls.includes('DM Sans')).map((g) => g.url)).toEqual(['/assets/dm-sans-latin-400-normal.woff2', '/assets/dm-sans-latin-ext-400-normal.woff2'])
  expect(blogFaces.every((g) => !g.decls.includes('src:'))).toBe(true)
})
