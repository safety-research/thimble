// A card as a figure (src/figures/figure.ts, the pure parts of figures/Figure.tsx): the headline's plain text, a Paper
// figure's size and chart, the body a figure draws and a report's caption. All data is made up.
import { expect, test } from 'vitest'
import { BLOG_CHART_W, captionParts, chartOf, drawingSize, figureCell, figureText, headline, PAPER_ONE, PAPER_TWO, paperSize, paperSpec } from '../../src/figures/figure.ts'
import type { Cell } from '../../src/lib/types.ts'

const MIME = 'application/vnd.vegalite.v6.json'
const SCHEMA = 'https://vega.github.io/schema/vega-lite/v6.json'
const card = (spec: Record<string, unknown>, more: Partial<Cell> = {}): Cell => ({ id: 'c1', kind: 'plot', title: 'Runs per day?', takeaway: '', outputs: [{ [MIME]: spec, 'text/plain': 'chart' }], ...more }) as unknown as Cell
const bars = (n: number, more: Record<string, unknown> = {}) => ({
  $schema: SCHEMA,
  title: 'Accuracy by size',
  data: { values: Array.from({ length: n }, (_, i) => ({ size: 2 ** i, accuracy: 40 + i })) },
  mark: 'bar',
  encoding: { x: { field: 'size', type: 'ordinal' }, y: { field: 'accuracy', type: 'quantitative' } },
  ...more,
})

test("a takeaway as a headline: each cited value its words, each bare ref gone, the markdown its words", () => {
  expect(figureText('The [[ensemble|card:a1]] answers **88%** of `prompts` [[card:a1#out]], more than [the baseline](https://x.test).')).toBe('The ensemble answers 88% of prompts, more than the baseline.')
  expect(figureText(null)).toBe('')
  // blogpost-figure's titles end in no period; a question keeps its mark, an ellipsis its dots
  expect(headline('Most runs end on day 2.')).toBe('Most runs end on day 2')
  expect(headline('Did the method help?')).toBe('Did the method help?')
  expect(headline('It goes on...')).toBe('It goes on...')
})

test('a Paper figure takes one column, or two for a chart in panels, side by side with others, or of more than six categories across', () => {
  expect(paperSize(card(bars(6)))).toBe(PAPER_ONE)
  expect(paperSize(card(bars(7)))).toBe(PAPER_TWO)
  expect(paperSize(card({ ...bars(3), encoding: { ...bars(3).encoding, row: { field: 'size', type: 'nominal' } } }))).toBe(PAPER_TWO)
  expect(paperSize(card({ $schema: SCHEMA, hconcat: [bars(2), bars(2)] }))).toBe(PAPER_TWO)
  // categories set along y (a horizontal bar chart) take one column
  const across = bars(9)
  expect(paperSize(card({ ...across, encoding: { y: across.encoding.x, x: across.encoding.y } }))).toBe(PAPER_ONE)
  // a layer's categories count
  expect(paperSize(card({ $schema: SCHEMA, data: bars(8).data, layer: [{ mark: 'bar', encoding: bars(8).encoding }, { mark: 'rule' }] }))).toBe(PAPER_TWO)
})

test("a drawn figure's size is read from its SVG, and a wide one takes two Paper columns", () => {
  const svg = (w: string, h: string): Cell => ({ id: 'm', kind: 'plot', title: '', outputs: [{ 'image/svg+xml': `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 1 1"></svg>` }] }) as unknown as Cell
  // matplotlib writes points, 4/3 px each
  const drawn = drawingSize(svg('518.4pt', '288pt'))!
  expect([drawn.width, drawn.height].map(Math.round)).toEqual([691, 384])
  expect(drawingSize(svg('600', '400'))).toEqual({ width: 600, height: 400 })
  expect(paperSize(svg('518.4pt', '288pt'))).toBe(PAPER_TWO)
  expect(paperSize(svg('300pt', '300pt'))).toBe(PAPER_ONE)
  expect(drawingSize(card(bars(2)))).toBeNull()
})

test('a chart as a Paper figure: no title, no legend, fitted whole to its size; a composite keeps its views', () => {
  const s = paperSpec({ ...bars(3), config: { legend: { orient: 'bottom' } } }, PAPER_ONE)
  expect(s.title).toBeUndefined()
  expect(s.config).toEqual({ legend: { orient: 'bottom', disable: true } })
  expect([s.width, s.height, s.autosize]).toEqual([240, 240, { type: 'fit', contains: 'padding' }])
  const composite = paperSpec({ $schema: SCHEMA, hconcat: [bars(2), bars(2)] }, PAPER_TWO)
  expect(composite.width).toBeUndefined()
  expect(composite.config).toEqual({ legend: { disable: true } })
})

test("a figure's body is the card's chart alone: a card of code shows no code, and its charts change as asked", () => {
  const code = card(bars(2), { kind: 'code', code: 'thimble.chart("bar", df)' })
  expect(figureCell(code).code).toBe('')
  expect(figureCell(card(bars(2))).code).toBeUndefined()
  const changed = figureCell(code, (spec) => ({ ...spec, width: 99 }))
  expect(chartOf(changed)?.spec.width).toBe(99)
  expect(chartOf(code)?.spec.width).toBeUndefined()
  expect(changed.outputs?.[0]?.['text/plain']).toBe('chart')
  expect(BLOG_CHART_W).toBe(720)
})

test("a Paper figure's caption in a report: Figure N., the takeaway in plain words ending in one period, then the question", () => {
  expect(captionParts(3, 'Most runs end on [[day 2|card:c1]].', 'When do runs end?')).toEqual({ lead: 'Figure 3.', takeaway: 'Most runs end on day 2.', question: 'When do runs end?' })
  expect(captionParts(1, '', 'When do runs end?')).toEqual({ lead: 'Figure 1.', takeaway: '', question: 'When do runs end?' })
  // a takeaway that ends in its own question mark takes no period after it
  expect(captionParts(2, 'Do most runs end on day 2?', 'When do runs end?').takeaway).toBe('Do most runs end on day 2?')
})
