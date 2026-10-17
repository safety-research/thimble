// Labels as home's Labels section and the labels list draw them (home.ts labelBlocks): a row per label with its bar in
// one column and of one width and its total right-aligned in one column, its kind and files dim where they fit, then
// its legend, each value with its count in aligned columns, `▒ unsure` and `░ no fit` among them, then `+N more`.
// `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { homeLayout, labelBlocks, labelParts, plainLines } from '../home'
import type { HomeData, HomeLabel } from '../home'
import { noFitValues } from '../labels'
import { COLORS } from '../paint'
import type { Line } from '../draw'

// three labels like the owner's: a code label with seven values (`other` among them) and records no value names, a
// regex label cue/none, a prompt label run on a sample with records it is unsure of
const CODE: HomeLabel = {
  slug: 'a1',
  name: 'data source cited',
  kind: 'code',
  trial: false,
  paths: ['revisions.jsonl'],
  running: false,
  ran: true,
  state: '',
  values: ['DataUSA workforce', 'Census ACS tables', 'BLS employment', 'FRED series', 'World Bank indicators', 'state open data', 'other'],
  counts: { 'DataUSA workforce': 4210, 'Census ACS tables': 2380, 'BLS employment': 1877, 'FRED series': 1020, 'World Bank indicators': 612, 'state open data': 245, other: 3127 },
  colors: { 'DataUSA workforce': 1, 'Census ACS tables': 2, 'BLS employment': 3, 'FRED series': 4, 'World Bank indicators': 5, 'state open data': 6, other: 0 },
  noFit: 3127 + 1100,
  unsure: 0,
}
const REGEX: HomeLabel = { slug: 'b2', name: 'links through a fetch proxy', kind: 'regex', trial: false, paths: ['revisions.jsonl'], running: false, ran: true, state: '', values: ['cue', 'none'], counts: { cue: 5191, none: 9400 }, colors: { cue: 12, none: 0 }, noFit: 0, unsure: 0 }
const PROMPT: HomeLabel = { slug: 'c3', name: 'message to agents', kind: 'prompt', trial: true, paths: ['board.jsonl'], running: false, ran: true, state: '', values: ['yes', 'no'], counts: { yes: 17, no: 25 }, colors: { yes: 9, no: 0 }, noFit: 2, unsure: 6 }
const LABELS = [CODE, REGEX, PROMPT]

const text = (l: Line) => l.map(s => s.s).join('')
/** The cell a line's first segment of `mark` starts at. */
const at = (l: Line, test: (s: Line[number]) => boolean) => {
  let x = 0
  for (const s of l) {
    if (test(s)) return x
    x += [...s.s].length
  }
  return -1
}
const isBar = (s: Line[number]) => /^[█▒░]+$/.test(s.s)

test('no fit: the quiet values of a label with two or more that say something, as the backend counts them', () => {
  expect([...noFitValues(CODE.values)]).toEqual(['other'])
  // a label with one value that says something: its quiet value is an answer
  expect([...noFitValues(['cue', 'none'])]).toEqual([])
  expect([...noFitValues(['yes', 'no'])]).toEqual([])
  expect([...noFitValues(['positive', 'negative', 'None'])]).toEqual(['None'])
})

test("a label's parts: its values, then the records no value names as `no fit`; its unsure ones among the values that answer", () => {
  const code = labelParts(CODE)
  expect(code.parts.map(p => [p.name, p.n, p.mark])).toEqual([
    ['DataUSA workforce', 4210, '█'],
    ['Census ACS tables', 2380, '█'],
    ['BLS employment', 1877, '█'],
    ['FRED series', 1020, '█'],
    ['World Bank indicators', 612, '█'],
    ['state open data', 245, '█'],
    ['other', 3127, '█'],
    ['no fit', 1100, '░'],
  ])
  expect(code.total).toBe(14571)
  expect(code.parts.find(p => p.name === 'no fit')!.fg).toBe(COLORS.dim)
  const prompt = labelParts(PROMPT)
  expect(prompt.unsure).toBe(6)
  expect(prompt.total).toBe(44)
  // a value off the label's list is a part of its own, gray
  const off = labelParts({ ...REGEX, counts: { ...REGEX.counts, maybe: 4 }, noFit: 4 })
  expect(off.parts.map(p => [p.name, p.n])).toEqual([['cue', 5191], ['none', 9400], ['maybe', 4]])
  expect(off.parts.at(-1)!.fg).toBe(COLORS.dim)
})

// a panel 96 and 150 columns wide, whose type area is 4 columns narrower (panel.tsx drawPanel)
for (const [panel, w] of [[96, 92], [150, 146]] as const) {
  test(`in a panel ${panel} columns wide every bar starts at one column and is as wide, the totals end at the right edge, the legends' counts align`, () => {
    const blocks = labelBlocks(LABELS, w)
    const starts = blocks.map(b => at(b.name, isBar))
    expect(new Set(starts).size).toBe(1)
    const widths = blocks.map(b => b.name.filter(isBar).reduce((k, s) => k + [...s.s].length, 0))
    expect(new Set(widths).size).toBe(1)
    expect(widths[0]).toBe(w === 92 ? 28 : 40)
    for (const b of blocks) expect([...text(b.name)].length).toBe(w)
    expect(blocks.map(b => text(b.name).trimEnd().split(/\s+/).at(-1))).toEqual(['14,571', '14,591', '44'])
    // the kind and files dim in one column after the longest name
    const metas = blocks.map(b => at(b.name, s => s.fg === COLORS.dim && /code|regex|prompt/.test(s.s)))
    expect(new Set(metas).size).toBe(1)
    expect(text(blocks[0]!.name)).toMatch(/^● data source cited +code · revisions\.jsonl +[█▒░]+ +14,571$/)
    // no record rows: only the legend, values with their counts, then unsure and no fit
    expect(text(blocks[1]!.legend[0]!)).toMatch(/^ {2}● cue +5,191 {3}● none +9,400$/)
    expect(text(blocks[2]!.legend[0]!)).toMatch(/^ {2}● yes +17 {3}● no +25 {3}▒ unsure +6 {3}░ no fit +2$/)
    // the code label's legend: two rows at most, its columns in one place on each, no value cut inside a word
    const legend = blocks[0]!.legend.map(text)
    expect(legend.length).toBeLessThanOrEqual(2)
    for (const l of legend) expect([...l].length).toBeLessThanOrEqual(w)
    const cols = (l: string) => [...l.matchAll(/[●░▒] /g)].map(m => m.index)
    expect(cols(legend[1]!).every((x, i) => x === cols(legend[0]!)[i])).toBe(true)
    for (const name of legend.join(' ').match(/[●░▒] [^\d+]+?(?= {2,}\d)/g) ?? []) {
      const v = name.slice(2).trim()
      expect(CODE.values.includes(v) || v === 'no fit' || (v.endsWith('…') && CODE.values.some(x => x.startsWith(`${v.slice(0, -1)} `)))).toBe(true)
    }
    // the values left out are counted, and the biggest stay: `other` and `no fit` show in the narrower panel too
    if (w === 92) expect(legend.at(-1)).toMatch(/\+\d more$/)
    else expect(legend.join('\n')).not.toContain('more')
    expect(legend.join('\n')).toContain('other')
    expect(legend.join('\n')).toContain('no fit')
  })
}

test('the bar: each value in its color by its share, the unsure records hatched in the colors of the values that answer, no fit light gray', () => {
  const [, , prompt] = labelBlocks(LABELS, 92)
  const bar = prompt!.name.filter(isBar)
  expect(bar.map(s => s.s[0])).toEqual(['█', '▒', '█', '▒', '░'])
  expect(bar[0]!.fg).toBe(bar[1]!.fg)
  expect(bar[4]!.fg).toBe(COLORS.dim)
  // yes 17, no 25 and no fit 2 of 44 in 28 cells (10.8, 15.9 and 1.3, the cells left over to the largest remainders);
  // 6 unsure of the 42 that answer, 4 of their 27 cells, shared by their cells
  const cells = (i: number) => [...bar[i]!.s].length
  expect(cells(0) + cells(1)).toBe(11)
  expect(cells(2) + cells(3)).toBe(16)
  expect(cells(4)).toBe(1)
  expect([cells(1), cells(3)]).toEqual([2, 2])
})

test("the kind and files are left out where they do not fit; a label with no run says so where its bar stands; one that is new says so after its total", () => {
  const narrow = labelBlocks(LABELS, 56)
  expect(narrow.map(b => text(b.name))).toEqual([expect.stringMatching(/^● data source cited +█/), expect.stringMatching(/^● links through a fetch proxy +█/), expect.stringMatching(/^● message to agents +█/)])
  const idle: HomeLabel = { ...PROMPT, slug: 'd4', name: 'asks for help', counts: {}, noFit: 0, unsure: 0, ran: false, trial: false, state: 'not run yet' }
  const fresh: HomeLabel = { ...REGEX, fresh: true }
  const [a, b, c] = labelBlocks([CODE, fresh, idle], 92)
  // the kind and files in the column after the longest name, as far as the bars leave room
  expect(text(c!.name)).toMatch(/^○ asks for help +prompt +not run yet {5}$/)
  expect(c!.legend).toEqual([])
  expect(text(b!.name)).toMatch(/14,591 {2}new$/)
  expect(text(a!.name)).toMatch(/14,571 {5}$/)
  expect(at(a!.name, isBar)).toBe(at(b!.name, isBar))
})

test("home's Labels section draws each label as the labels list does, its row and its legend a click on the label", () => {
  const d: HomeData = { views: [], reports: [], threads: [], cardGroups: [], labels: LABELS, coverage: null }
  const lay = homeLayout(d, { folded: [], unfolded: [], more: [], pick: '' }, 92)
  const rows = plainLines(lay.lines)
  const head = rows.findIndex(r => r.startsWith('Labels (3)'))
  expect(rows.slice(head + 1, head + 8)).toEqual([
    expect.stringMatching(/^● data source cited +code · revisions\.jsonl +[█▒░]{28} {2}14,571$/),
    expect.stringMatching(/^ {2}● DataUSA workforce +4,210 {3}● Census ACS tables +2,380 {3}● BLS employment +1,877$/),
    expect.stringMatching(/^ {2}● other +3,127 {3}░ no fit +1,100 {3}\+3 more$/),
    expect.stringMatching(/^● links through a fetch proxy +regex · revisions\.jsonl +[█▒░]{28} {2}14,591$/),
    expect.stringMatching(/^ {2}● cue +5,191 {3}● none +9,400$/),
    expect.stringMatching(/^● message to agents +prompt · a sample of 44 +[█▒░]{28} {6}44$/),
    expect.stringMatching(/^ {2}● yes +17 {3}● no +25 {3}▒ unsure +6 {3}░ no fit +2$/),
  ])
  // the keys choose the labels' rows; each of its rows opens the label
  expect(lay.picks.map(p => p.key)).toEqual(['label:a1', 'label:b2', 'label:c3'])
  const legendRow = lay.hits.find(h => h.y === head + 3)
  expect(legendRow?.act).toEqual({ op: 'open', open: { kind: 'label', name: 'data source cited' } })
})
