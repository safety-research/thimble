// A card as a figure (src/figures/figure.ts, the pure parts of figures/Figure.tsx): the headline's plain text and its
// first sentence, a Paper figure's size and chart, the body a figure draws and a report's caption. All data is made up.
import { expect, test } from 'vitest'
import { BLOG_CHART_W, captionParts, chartOf, drawingSize, figureCell, figureText, firstSentence, headline, PAPER_ONE, PAPER_TWO, paperSize, paperSpec, takeawayHeadline } from '../../src/figures/figure.ts'
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
// a horizontal bar chart of runs by name, as thimble.chart draws text categories
const lying = (names: string[], more: Record<string, unknown> = {}) => ({
  $schema: SCHEMA,
  data: { values: names.map((run, i) => ({ run, merged: 14 - i })) },
  mark: 'bar',
  encoding: { y: { field: 'run', type: 'nominal' }, x: { field: 'merged', type: 'quantitative' } },
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

test("a Blog figure's headline is the takeaway's first sentence, which ends where a sentence ends and not before", () => {
  // a period inside a number, or after an abbreviation followed by a capital or a number, ends no sentence
  expect(firstSentence('Most PRs stayed open in every run: 156, 151, 139 and 148. The managed runs closed 35 and 25.')).toBe('Most PRs stayed open in every run: 156, 151, 139 and 148.')
  expect(firstSentence('The ensemble scores 0.91 vs. 0.84, e.g. on GPT-style prompts, see Fig. 2. It costs less.')).toBe('The ensemble scores 0.91 vs. 0.84, e.g. on GPT-style prompts, see Fig. 2.')
  expect(firstSentence('Runs merged 14 vs. 7 on approx. 30 PRs. The rest stayed open.')).toBe('Runs merged 14 vs. 7 on approx. 30 PRs.')
  // a unit ends a sentence as any word does
  expect(firstSentence('Median latency was 30 ms. The slowest run took 120 ms.')).toBe('Median latency was 30 ms.')
  // a sentence may start with a name from the data in lowercase, but not with a plain word
  expect(firstSentence('All four runs climbed fast, then slowed. emergent_prs climbed again later.')).toBe('All four runs climbed fast, then slowed.')
  expect(firstSentence('Each run took 6 hrs. less than planned, and none failed.')).toBe('Each run took 6 hrs. less than planned, and none failed.')
  // a question, and a stop inside quotes or brackets
  expect(firstSentence('Did the manager help? Not much: 2 merges against 14.')).toBe('Did the manager help?')
  expect(firstSentence('The agents wrote "done." Then they stopped.')).toBe('The agents wrote "done."')
  expect(firstSentence('Run b merged most (14 PRs.) Run a merged 7.')).toBe('Run b merged most (14 PRs.)')
  // a first sentence too short to state a finding goes on into the next; one sentence is all of it
  expect(firstSentence('Yes. The managed runs merged more.')).toBe('Yes. The managed runs merged more.')
  expect(firstSentence('  Most runs end on day 2.  ')).toBe('Most runs end on day 2.')
  expect(firstSentence('')).toBe('')
  // the headline: the first sentence in plain words, with no period at its end
  expect(takeawayHeadline('The emergent_prs run merged the most PRs, [14](#). The others merged [7](#) and [[2|card:c1]].')).toBe('The emergent_prs run merged the most PRs, 14')
  expect(takeawayHeadline('Did **the manager** help? Not much.')).toBe('Did the manager help?')
  expect(takeawayHeadline(null)).toBe('')
})

test('a Paper figure takes one column, or two for a chart in panels, side by side with others, or of more than six categories across', () => {
  expect(paperSize(card(bars(6)))).toBe(PAPER_ONE)
  expect(paperSize(card(bars(7)))).toBe(PAPER_TWO)
  expect(paperSize(card({ ...bars(3), encoding: { ...bars(3).encoding, row: { field: 'size', type: 'nominal' } } }))).toBe(PAPER_TWO)
  expect(paperSize(card({ $schema: SCHEMA, hconcat: [bars(2), bars(2)] }))).toBe(PAPER_TWO)
  // a layer's categories count
  expect(paperSize(card({ $schema: SCHEMA, data: bars(8).data, layer: [{ mark: 'bar', encoding: bars(8).encoding }, { mark: 'rule' }] }))).toBe(PAPER_TWO)
})

test('a horizontal bar chart takes two Paper columns for long category names or more than six of them, in the export and the report alike', () => {
  expect(paperSize(card(lying(['a', 'b', 'c', 'd'])))).toBe(PAPER_ONE)
  expect(paperSize(card(lying(['run 1', 'run 22', 'abcdefghi'])))).toBe(PAPER_ONE)
  // a name of ten characters or more leaves too little room for the plot in one column
  expect(paperSize(card(lying(['abcdefghij', 'b'])))).toBe(PAPER_TWO)
  expect(paperSize(card(lying(['emergent_prs', 'emergent_prs_issues', 'managed_prs', 'managed_prs_issues'])))).toBe(PAPER_TWO)
  // more than six categories down y, short names and all
  const sizes = bars(9)
  expect(paperSize(card({ ...sizes, encoding: { y: sizes.encoding.x, x: sizes.encoding.y } }))).toBe(PAPER_TWO)
  expect(paperSize(card(lying(['a', 'b', 'c', 'd', 'e', 'f'])))).toBe(PAPER_ONE)
  // a layered chart (a bar's value beside it), whose layers take the chart's rows
  const labelled = lying(['emergent_prs', 'managed_prs'])
  expect(paperSize(card({ $schema: SCHEMA, data: labelled.data, encoding: labelled.encoding, layer: [{ mark: 'bar' }, { mark: 'text' }] }))).toBe(PAPER_TWO)
  // a vertical bar chart of long names, which a card draws lying down (lib/chartDefaults)
  const upright = lying(['emergent_prs_issues', 'managed_prs_issues'])
  expect(paperSize(card({ ...upright, encoding: { x: upright.encoding.y, y: upright.encoding.x } }))).toBe(PAPER_TWO)
  // grouped bars as Altair writes them, the rows in a named dataset
  const rows = ['emergent_prs', 'managed_prs'].flatMap((run) => ['open', 'merged'].map((state) => ({ run, state, PRs: 10 })))
  const altair = {
    $schema: SCHEMA,
    data: { name: 'data-1a2b' },
    datasets: { 'data-1a2b': rows },
    mark: { type: 'bar' },
    encoding: { y: { field: 'run', type: 'nominal' }, x: { field: 'PRs', type: 'quantitative' }, yOffset: { field: 'state', type: 'nominal' }, color: { field: 'state', type: 'nominal' } },
  }
  expect(paperSize(card(altair))).toBe(PAPER_TWO)
  expect(paperSize(card({ ...altair, datasets: { 'data-1a2b': rows.map((r) => ({ ...r, run: r.run.slice(0, 3) })) } }))).toBe(PAPER_ONE)
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
