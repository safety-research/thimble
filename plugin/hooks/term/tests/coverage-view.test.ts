// The Coverage view (coverageview.tsx; SPEC-v2 J5 with the owner's notes of 10-16, "Coverage + checks feedback"): its
// rows from `thimble state coverage --session <sid>` (C7), folder, then type or pattern, then file; seen and searched
// each a count and a percent in their colors; each row's unit named in the row (records for data files, files for
// images, binaries and documents), never both in one number; no never column, no `new`, no summary sentence; a totals
// row under the list with the corpus's denominators, one line per unit. Enter drills into a folder or a group (the same
// view one level down) and b comes back; Enter on a file opens 0.8.0's file view; o and the title row's ↗ open Files in
// the browser at the folder. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { coverageLines, coverageTitle, cutPath, drillFolder, folderWords, measure, percent, sizeWords, unitWord } from '../coverageview'
import type { CoverageRow } from '../coverageview'
import { coverageWords } from '../band'
import { COVERAGE_TOP, CWD, PANEL, SUMMARY, covRow, paneAt, panelWorld, takesKeys, words } from './fixtures-panel'
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

/** A click on the row of the list that shows `text`, as the pointer over the list's Client. */
async function rowClick(m: M, w: PanelWorld, text: string): Promise<void> {
  const y = (await listText(m, 'm:coverage-list')).findIndex(l => l.includes(text))
  expect(y).toBeGreaterThanOrEqual(0)
  await m.pointer({ type: 'down', x: 6, y, button: 'left', in: 'm:coverage-list' } as never)
  await w.clock.settle()
}

test('the coverage view: folder, files, seen and searched as counts and percents, the total with its unit, the size; a totals row of the corpus; no never column, no summary sentence', { timeoutMs: 30_000 }, async ($, on) => {
  const w = panelWorld(on)
  w.t.coverageSummary = SUMMARY
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: 'coverage' } as never)
  await w.clock.settle()
  const m = await pane($)
  const head = await listText(m, 'm:coverage-head')
  expect(head[0]).toMatch(/^ {4}folder +files +seen +searched +total +size$/)
  const top = await listText(m, 'm:coverage-list')
  // a file at the top: (top level), never `.`; a database's rows are records
  expect(top[0]).toMatch(/^❯ {3}\(top level\) +forge\.db +0 +0% +587 +100% +587 records +2\.1 MB$/)
  expect(top[1]).toMatch(/^ {2}▸ agents\/ +agent-\*\.jsonl +1,204 +2% +400 +0\.8% +48,310 records +1\.2 MB$/)
  // screenshots count files, not lines
  expect(top[2]).toMatch(/^ {2}▸ images\/day-1\/ +\.png +1 +3% +0 +0% +30 files +900 KB$/)
  expect(top[3]).toMatch(/^ {4}\(top level\) +events\.jsonl +140 +100% +0 +0% +140 records +40 KB$/)
  expect(top[4]).toMatch(/^ {2}▸ \(top level\) +run_\*\.jsonl +0 +0% +0 +0% +600 records +30 KB$/)
  // every row names its unit in its total, one unit a row
  for (const l of top) expect(l).toMatch(/ (records?|files?) +\S+ [KMG]?B$/)
  const totals = await listText(m, 'm:coverage-totals')
  expect(totals[0]).toMatch(/^ {4}─+$/)
  expect(totals[1]).toMatch(/^ {4}total +1,344 +3% +400 +0\.8% +48,450 records$/)
  expect(totals[2]).toMatch(/^ {4} +1 +3% +0 +0% +31 files$/)
  const drawn = words(await m.drawn())
  expect(drawn).not.toContain('never')
  expect(drawn).not.toMatch(/saw \d|of records \(/)
  expect(drawn).not.toContain(SUMMARY.line)
  expect(drawn).not.toContain(' new')
  expect(drawn).toContain("what this session's tool calls saw or searched")
  // seen in the first series color, searched in the second; a zero stays dim; the header names them in those colors
  const segs = await listSegs(m, 'm:coverage-list')
  const headSegs = (await listSegs(m, 'm:coverage-head'))[0]!
  const agents = segs[1]!
  expect(agents.find(x => /1,204 +2%/.test(x.s))?.fg).toBe(headSegs.find(x => x.s.trim() === 'seen')?.fg)
  expect(agents.find(x => /400 +0\.8%/.test(x.s))?.fg).toBe(headSegs.find(x => x.s.trim() === 'searched')?.fg)
  expect(agents.find(x => /1,204/.test(x.s))?.fg).not.toBe(agents.find(x => /400 +0\.8%/.test(x.s))?.fg)
  expect(segs[0]!.find(x => /^ +0 +0%$/.test(x.s))?.fg).toBe('inactive')
  expect(w.calls.find(c => c[1] === 'state' && c[2] === 'coverage')).toEqual(expect.arrayContaining(['--session']))
  await m.unmount()
})

test("Enter on a folder drills in, on a pattern lists its files, b comes back; the trail names each level; the totals stay the corpus's", { timeoutMs: 30_000 }, async ($, on) => {
  const w = panelWorld(on)
  w.t.coverageSummary = SUMMARY
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: 'coverage' } as never)
  await w.clock.settle()
  const m = await pane($)
  // a click on agents/: its files
  await rowClick(m, w, 'agents/')
  expect(w.calls.at(-1)).toEqual(expect.arrayContaining(['coverage', '--folder', 'agents']))
  const files = await listText(m, 'm:coverage-list')
  expect(files.map(r => r.replace(/^. /, '').trim().split(/\s+/).slice(0, 2).join(' '))).toEqual(['agents/ agent-01.jsonl', 'agents/ agent-02.jsonl', 'agents/ agent-03.jsonl'])
  expect(words(await m.find({ type: 'Box', key: 'way' }))).toContain('home › coverage › agents/')
  expect((await listText(m, 'm:coverage-totals'))[1]).toMatch(/^ {4}corpus total +1,344/)
  // b: back at the top; then the pattern's row: its files, the ones left out said in words
  await m.press({ key: 'hk-back' })
  await w.clock.settle()
  expect((await listText(m, 'm:coverage-list'))[1]).toContain('agents/')
  await rowClick(m, w, 'run_*.jsonl')
  expect(w.calls.at(-1)).toEqual(expect.arrayContaining(['coverage', '--match', 'run_*.jsonl']))
  expect(words(await m.find({ type: 'Box', key: 'way' }))).toContain('home › coverage › run_*.jsonl')
  const runs = await listText(m, 'm:coverage-list')
  expect(runs.slice(0, 3).map(r => r.replace(/^. /, '').trim().split(/\s+/).slice(0, 3).join(' '))).toEqual(['(top level) run_0000.jsonl', '(top level) run_0001.jsonl', '(top level) run_0002.jsonl'])
  expect(runs[3]).toMatch(/… 297 more not listed here \(the list holds the first 3\)/)
  await m.press({ key: 'hk-back' })
  await w.clock.settle()
  expect((await listText(m, 'm:coverage-list'))[1]).toContain('agents/')
  await m.unmount()
})

test("Enter on a file opens 0.8.0's file view; o and the title row's ↗ open Files in the browser at the folder", { timeoutMs: 30_000 }, async ($, on) => {
  const w = panelWorld(on)
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: 'coverage agents' } as never)
  await w.clock.settle()
  const m = await pane($)
  await m.press({ key: 'hk-browser' })
  await w.clock.settle()
  expect(w.pressed.at(-1)).toEqual(expect.arrayContaining(['open', '--ref', 'files:agents']))
  await m.press({ key: 'way-browser' })
  await w.clock.settle()
  // the second press within 5 s of the first on the same object opens nothing more
  expect(w.pressed.length).toBe(1)
  await takesKeys($)
  await $.ui.input({ plugin: PANEL, key: 'keys-pick', text: '', kind: 'submit' } as never)
  await w.clock.settle()
  const p = w.panes.at(-1)!
  expect(p.title).toBe('agent-01.jsonl')
  await m.unmount()
})

test('a narrow pane keeps every name whole: the size goes, then folder and files share a column, then each row takes two lines; the counts go last; the percents and each unit stay', { timeoutMs: 30_000 }, async ($, on) => {
  const w = panelWorld(on)
  w.t.coverageSummary = SUMMARY
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: 'coverage' } as never)
  await w.clock.settle()
  for (const [body, rowsPer, counts] of [[72, 1, true], [60, 2, true], [46, 2, true], [38, 2, false]] as const) {
    const m = await pane($, body)
    const head = await listText(m, 'm:coverage-head')
    const top = await listText(m, 'm:coverage-list')
    const totals = await listText(m, 'm:coverage-totals')
    for (const l of [...head, ...top, ...totals]) expect([...l].length).toBeLessThanOrEqual(body + 2)
    expect(head.length).toBe(rowsPer)
    const i = top.findIndex(l => /agents\/ +agent-\*\.jsonl/.test(l))
    expect(i).toBe(rowsPer)
    const nums = rowsPer === 1 ? top[i]! : top[i + 1]!
    expect(nums).toMatch(counts ? /1,204 +2% +400 +0\.8% +48,310 records$/ : /^ +2% +0\.8% +48,310 records$/)
    const img = top.findIndex(l => /images\/day-1\/ +\.png/.test(l))
    expect(rowsPer === 1 ? top[img] : top[img + 1]).toMatch(/3% +(0 +)?0% +30 files$/)
    expect(totals.join('\n')).toMatch(/48,450 records/)
    expect(totals.join('\n')).toMatch(/31 files/)
    await m.unmount()
  }
})

test('a long list scrolls under its header, and the totals stay under it', { timeoutMs: 30_000 }, async ($, on) => {
  const w = panelWorld(on)
  w.t.coverageSummary = SUMMARY
  w.coverage[''] = { rows: Array.from({ length: 60 }, (_, i) => covRow({ key: `t${i}`, path: `t-${i}.md`, name: `t-${i}.md`, ext: '.md', unit: 'files', bytes: 1000 - i })) }
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: 'coverage' } as never)
  await w.clock.settle()
  const m = await pane($, 96, 30)
  const list = await listText(m, 'm:coverage-list')
  expect(list.length).toBeLessThan(30)
  expect(list.at(-1)).toMatch(/↓ \d+ more/)
  expect((await listText(m, 'm:coverage-head'))[0]).toMatch(/folder +files +seen/)
  expect((await listText(m, 'm:coverage-totals'))[1]).toMatch(/total .* records$/)
  await m.unmount()
  // two lines a row in a narrow pane: the list is cut between rows, and its count rows count rows
  const n = await pane($, 46, 30)
  const two = await listText(n, 'm:coverage-list')
  const more = Number(/↓ (\d+) more/.exec(two.at(-1)!)?.[1])
  expect(two.at(-2)).toMatch(/ (files?|records?)$/)
  const shown = two.filter(l => /\.md$/.test(l.trim())).length
  expect(two.filter(l => / (files?|records?)$/.test(l)).length).toBe(shown)
  expect(shown + more).toBe(60)
  await n.unmount()
})

test("the rows' parts: units by row, percents as coverage.py says them, folders in words, paths cut in their middle, titles, the summary line's words", () => {
  expect(drillFolder('', { folder: 'agents/' })).toBe('agents')
  expect(drillFolder('runs', { folder: 'r1/' })).toBe('runs/r1')
  expect(drillFolder('runs', { folder: 'runs/r1/' })).toBe('runs/r1')
  expect(sizeWords(1_200_000)).toBe('1.2 MB')
  expect(sizeWords(40_000)).toBe('40 KB')
  // the same forms as coverage.py percent (test_percent_forms)
  expect([percent(0, 100), percent(5, 0), percent(1, 3_000_000), percent(4_401, 13_200_000), percent(3, 1_000), percent(99, 10_000), percent(99, 100_000), percent(17, 100), percent(25, 1_000), percent(995, 1_000), percent(1_000, 1_000)])
    .toEqual(['0%', '0%', '<0.01%', '0.03%', '0.3%', '0.9%', '0.09%', '17%', '3%', '99%', '100%'])
  expect([unitWord('records', 1), unitWord('files', 1), unitWord('files', 0), unitWord('records', 2)]).toEqual(['record', 'file', 'files', 'records'])
  expect(folderWords('')).toBe('(top level)')
  expect(folderWords('.')).toBe('(top level)')
  expect(folderWords('agents')).toBe('agents/')
  expect(cutPath('images/computer-use-turns/2025-04-02/', 24)).toBe('images/…/2025-04-02/')
  expect(cutPath('agents/', 24)).toBe('agents/')
  expect(coverageTitle('', null)).toBe('Coverage')
  expect(coverageTitle('agents', null)).toBe('agents/')
  expect(coverageTitle('', 'run_*.jsonl')).toBe('run_*.jsonl')
  expect(coverageTitle('logs', '.txt')).toBe('logs/.txt')
  expect(coverageTitle('images/computer-use-turns/2025-04-02', '*.png')).toBe('2025-04-02/*.png')
  // a row's one unit: records for a data file (null while counted), files for the others
  const db = COVERAGE_TOP[0]!
  expect(measure(db)).toEqual({ unit: 'records', seen: 0, searched: 587, total: 587 })
  expect(measure(COVERAGE_TOP[2]!)).toEqual({ unit: 'files', seen: 1, searched: 0, total: 30 })
  expect(measure({ ...db, records_total: null })).toEqual({ unit: 'records', seen: 0, searched: 587, total: null })
  // while records are counted the row and the totals say so, and show no share
  const counting = coverageLines([{ ...db, records_total: null }], db.key, 90, { totals: [{ unit: 'records', seen: 0, searched: 0, total: 0, counted: false, files: 1, files_seen: 0, files_searched: 1 }] })
  expect(plain(counting.lines[0]!)).toMatch(/forge\.db +0 +587 +counting/)
  expect(plain(counting.totals[1]!).trimEnd()).toMatch(/total +counting$/)
  // no line wider than its type area, at any width
  for (const cols of [120, 90, 70, 58, 44, 36]) {
    const lay = coverageLines(COVERAGE_TOP, '', cols, { totals: SUMMARY.totals })
    for (const l of [...lay.head, ...lay.lines, ...lay.totals]) expect([...plain(l)].length).toBeLessThanOrEqual(cols + 2)
  }
  // the summary line's coverage words: the totals' first share, files while the records are counted
  expect(coverageWords(SUMMARY)).toBe('3%')
  expect(coverageWords({ ...SUMMARY, totals: [{ unit: 'records', seen: 0, searched: 0, total: 0, counted: false, files: 13, files_seen: 3, files_searched: 1 }] })).toBe('3 of 13 files')
  expect(coverageWords({ ...SUMMARY, totals: [{ unit: 'files', seen: 2, searched: 0, total: 1_032_000 }] })).toBe('<0.01%')
  const old: CoverageRow = covRow({ key: 'x', unit: undefined, records_seen: 5, records_total: 10 })
  expect(measure(old).unit).toBe('records')
})
