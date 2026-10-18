// The Coverage view (coverageview.tsx; SPEC-v2 J5): what Claude read or searched, its rows from `thimble state coverage
// --session <sid>` (C7) in one name column, read and searched each a count and a percent, each row's unit named in the
// row, one total of the corpus by size; and the rows' parts, whose percents are coverage.py's. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { LEGEND, coverageLines, coverageTitle, cutPath, drillFolder, folderWords, measure, percent, unitWord } from '../coverageview'
import type { CoverageRow } from '../coverageview'
import { coverageWords } from '../band'
import { COVERAGE_TOP, CWD, SUMMARY, covRow, paneAt, panelWorld, words } from './fixtures-panel'
import type { PanelWorld } from './fixtures-panel'

type M = Mounted<'terminal'>
type E = Engine

async function start($: E, w: PanelWorld): Promise<void> {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
}

async function pane($: E, body = 96, rows = 40): Promise<M> {
  return (await $.ui.mount(paneAt(body, rows))) as unknown as M
}

/** The panel's rows of text as one of its Clients draws them. */
async function listText(m: M, key: string): Promise<string[]> {
  const el = (await m.find({ type: 'Client', key })) as unknown as { props: { props: { lines: { s: string }[][] } } } | undefined
  return (el?.props.props.lines ?? []).map(l => l.map(x => x.s).join('').replace(/\s+$/, ''))
}

/** A Client's lines as segments, to read their colors. */
async function listSegs(m: M, key: string): Promise<{ s: string; fg?: string }[][]> {
  const el = (await m.find({ type: 'Client', key })) as unknown as { props: { props: { lines: { s: string; fg?: string }[][] } } } | undefined
  return el?.props.props.lines ?? []
}

const plain = (l: { s: string }[]) => l.map(x => x.s).join('')

test('the coverage view: one name column, read and searched as counts and percents, the total with its unit; one total of the corpus by size; no size column, no never column, no summary sentence; the words name Claude', { timeoutMs: 30_000 }, async ($, on) => {
  const w = panelWorld(on)
  w.t.coverageSummary = SUMMARY
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: 'coverage' } as never)
  await w.clock.settle()
  const m = await pane($)
  const head = await listText(m, 'm:coverage-head')
  expect(head[0]).toMatch(/^ {4}folder · files +read +searched +total$/)
  const top = await listText(m, 'm:coverage-list')
  // a file at the top by its name alone, never `(top level)` or `.`; a database's rows are entries
  expect(top[0]).toMatch(/^❯ {3}forge\.db +0 +0% +587 +100% +587 entries$/)
  // a nested row: its folder before its name or pattern, in the one column
  expect(top[1]).toMatch(/^ {2}▸ agents\/ agent-\*\.jsonl +1,204 +2% +400 +0\.8% +48,310 lines$/)
  // screenshots count files, not lines
  expect(top[2]).toMatch(/^ {2}▸ images\/day-1\/ \.png +1 +3% +0 +0% +30 files$/)
  expect(top[3]).toMatch(/^ {4}events\.jsonl +140 +100% +0 +0% +140 lines$/)
  expect(top[4]).toMatch(/^ {2}▸ run_\*\.jsonl +0 +0% +0 +0% +600 lines$/)
  // every row names its unit at its end, one unit a row; no size
  for (const l of top) expect(l).toMatch(/\d (lines?|entry|entries|files?)$/)
  // one total, by size: the bytes read and searched with their shares, the corpus's size at the right; no total per unit
  const totals = await listText(m, 'm:coverage-totals')
  expect(totals[0]).toMatch(/^ {4}─+$/)
  expect(totals[1]).toMatch(/^ {4}total +2\.1 MB +15% +340 KB +2% +14\.0 MB$/)
  expect(totals.length).toBe(2)
  // the size's unit stands in the units' column
  expect(totals[1]!.lastIndexOf('MB')).toBe(top[1]!.lastIndexOf('lines'))
  const totalSegs = (await listSegs(m, 'm:coverage-totals'))[1]!
  for (const l of top) expect(l).not.toMatch(/ (MB|KB|GB|B)$/)
  const drawn = words(await m.drawn())
  for (const gone of ['never', 'seen', 'record', '(top level)', 'size', ' new', SUMMARY.line]) expect(drawn).not.toContain(gone)
  expect(drawn).not.toMatch(/saw \d|of records \(/)
  expect(drawn).toContain('what Claude read or searched in this session')
  // read in the first series color, searched in the second; a zero stays dim; the header names them in those colors
  const segs = await listSegs(m, 'm:coverage-list')
  const headSegs = (await listSegs(m, 'm:coverage-head'))[0]!
  const agents = segs[1]!
  expect(agents.find(x => /1,204 +2%/.test(x.s))?.fg).toBe(headSegs.find(x => x.s.trim() === 'read')?.fg)
  expect(agents.find(x => /400 +0\.8%/.test(x.s))?.fg).toBe(headSegs.find(x => x.s.trim() === 'searched')?.fg)
  expect(agents.find(x => /1,204/.test(x.s))?.fg).not.toBe(agents.find(x => /400 +0\.8%/.test(x.s))?.fg)
  expect(segs[0]!.find(x => /^ +0 +0%$/.test(x.s))?.fg).toBe('inactive')
  // the total's read and searched in the same colors
  expect(totalSegs.find(x => /2\.1 MB +15%/.test(x.s))?.fg).toBe(headSegs.find(x => x.s.trim() === 'read')?.fg)
  expect(totalSegs.find(x => /340 KB +2%/.test(x.s))?.fg).toBe(headSegs.find(x => x.s.trim() === 'searched')?.fg)
  // the folder before a nested row's name is dim; the name is not
  expect(agents.find(x => x.s === 'agents/')?.fg).toBe('inactive')
  expect(agents.find(x => x.s.startsWith('agent-*.jsonl'))?.fg).not.toBe('inactive')
  // a wide pane: the legend under the subtitle, read and searched in their colors, the rest dim
  const legend = await listSegs(m, 'coverage-legend')
  expect(legend.map(plain)).toEqual([LEGEND])
  expect(LEGEND).toBe("read: pulled into Claude's context · searched: grep, a script, or a label reviewed it")
  expect(legend[0]!.find(x => x.s === 'read')?.fg).toBe(headSegs.find(x => x.s.trim() === 'read')?.fg)
  expect(legend[0]!.find(x => x.s === 'searched')?.fg).toBe(headSegs.find(x => x.s.trim() === 'searched')?.fg)
  expect(legend[0]!.filter(x => x.s !== 'read' && x.s !== 'searched').every(x => x.fg === 'inactive')).toBe(true)
  expect(w.calls.find(c => c[1] === 'state' && c[2] === 'coverage')).toEqual(expect.arrayContaining(['--session']))
  await m.unmount()
})

test("the rows' parts: units by row and their singular forms, percents as coverage.py says them, folders in words, paths cut in their middle, titles, the total by size, the summary line's words", () => {
  expect(drillFolder('', { folder: 'agents/' })).toBe('agents')
  expect(drillFolder('runs', { folder: 'r1/' })).toBe('runs/r1')
  expect(drillFolder('runs', { folder: 'runs/r1/' })).toBe('runs/r1')
  // the same forms as coverage.py percent (test_percent_forms)
  expect([percent(0, 100), percent(5, 0), percent(1, 3_000_000), percent(4_401, 13_200_000), percent(3, 1_000), percent(99, 10_000), percent(99, 100_000), percent(17, 100), percent(25, 1_000), percent(995, 1_000), percent(1_000, 1_000)])
    .toEqual(['0%', '0%', '<0.01%', '0.03%', '0.3%', '0.9%', '0.09%', '17%', '3%', '99%', '100%'])
  expect([unitWord('lines', 1), unitWord('entries', 1), unitWord('files', 1)]).toEqual(['line', 'entry', 'file'])
  expect([unitWord('lines', 0), unitWord('entries', 2), unitWord('files', 1_031_999)]).toEqual(['lines', 'entries', 'files'])
  // the top level has no words: a file there shows its name alone
  expect(folderWords('')).toBe('')
  expect(folderWords('.')).toBe('')
  expect(folderWords('agents')).toBe('agents/')
  expect(cutPath('images/computer-use-turns/2025-04-02/', 24)).toBe('images/…/2025-04-02/')
  expect(cutPath('agents/', 24)).toBe('agents/')
  expect(coverageTitle('', null)).toBe('Coverage')
  expect(coverageTitle('agents', null)).toBe('agents/')
  expect(coverageTitle('', 'run_*.jsonl')).toBe('run_*.jsonl')
  expect(coverageTitle('logs', '.txt')).toBe('logs/.txt')
  expect(coverageTitle('images/computer-use-turns/2025-04-02', '*.png')).toBe('2025-04-02/*.png')
  // a row's one unit: entries for a database (null while counted), lines for line-based text, files for the others
  const db = COVERAGE_TOP[0]!
  expect(measure(db)).toEqual({ unit: 'entries', seen: 0, searched: 587, total: 587 })
  expect(measure(COVERAGE_TOP[1]!)).toEqual({ unit: 'lines', seen: 1204, searched: 400, total: 48_310 })
  expect(measure(COVERAGE_TOP[2]!)).toEqual({ unit: 'files', seen: 1, searched: 0, total: 30 })
  expect(measure({ ...db, records_total: null })).toEqual({ unit: 'entries', seen: 0, searched: 587, total: null })
  // one of each: the singular in the row
  const size = { read: 600, searched: 0, total: 1_000 }
  const ones = coverageLines([covRow({ key: 'v', path: 'villages.jsonl', name: 'villages.jsonl', records_total: 1 }), covRow({ key: 'm', path: 'm.json', name: 'm.json', unit: 'entries', records_total: 1 }), covRow({ key: 'r', path: 'README.md', name: 'README.md', unit: 'files' })], '', 90, { size })
  expect(ones.lines.map(l => plain(l).trimEnd().split(/\s+/).at(-1))).toEqual(['line', 'entry', 'file'])
  // no number mixes two units: each row names one, and the total names none of them
  for (const l of ones.lines) expect(plain(l).match(/\b(lines?|entry|entries|files?)\b/g)?.length).toBe(1)
  expect(ones.totals.length).toBe(2)
  expect(plain(ones.totals[1]!).trimEnd()).toMatch(/^ {4}total +600 B +60% +0 B +0% +1 KB$/)
  // a decimal under 1%, sizes in GB, the corpus total in a folder
  const big = coverageLines(COVERAGE_TOP, '', 100, { size: { read: 3_200_000_000, searched: 1_000_000, total: 640_000_000_000 }, drilled: true })
  expect(plain(big.totals[1]!).trimEnd()).toMatch(/^ {4}corpus total +3\.2 GB +0\.5% +1\.0 MB +<0\.01% +640\.0 GB$/)
  // no size yet (no index): no total
  expect(coverageLines(COVERAGE_TOP, '', 100, { size: null }).totals).toEqual([])
  // while lines or entries are counted the row says so and shows no share; the total by size stands
  const counting = coverageLines([{ ...db, records_total: null }], db.key, 90, { size })
  expect(plain(counting.lines[0]!)).toMatch(/forge\.db +0 +587 +counting/)
  expect(plain(counting.totals[1]!).trimEnd()).toMatch(/total +600 B +60% +0 B +0% +1 KB$/)
  // no line wider than its type area, at any width; one name column at every width
  for (const cols of [120, 90, 70, 58, 44, 36]) {
    const lay = coverageLines(COVERAGE_TOP, '', cols, { size: SUMMARY.size })
    for (const l of [...lay.head, ...lay.lines, ...lay.totals]) expect([...plain(l)].length).toBeLessThanOrEqual(cols + 2)
    expect(plain(lay.head[0]!)).toMatch(/^ {4}folder · files/)
    expect(lay.wide).toBe(cols >= 70)
  }
  // the summary line's coverage words: the read share of the data by size, a decimal under 1%; the files read while
  // there is no index
  expect(coverageWords(SUMMARY)).toBe('15%')
  expect(coverageWords({ ...SUMMARY, size: { read: 4_000, searched: 9_000_000, total: 1_000_000 } })).toBe('0.4%')
  expect(coverageWords({ ...SUMMARY, size: { read: 1, searched: 0, total: 3_000_000 } })).toBe('<0.01%')
  expect(coverageWords({ ...SUMMARY, size: null, records: { seen: 0, total: 0, counted: false } })).toBe('3 of 13 files')
  const old: CoverageRow = covRow({ key: 'x', unit: undefined, records_seen: 5, records_total: 10 })
  expect(measure(old).unit).toBe('lines')
})
