// The bar above the prompt and its panes, through the whole hooks module: its items per switch and state, a failure's
// line and its f key, and the coverage pane drawn from `thimble coverage --json`. All data is made up.
// `claude plugin test plugin`.
import { expect, mock, test } from 'claude-code/testing'

import { barRows } from '../bar/bar'
import { failNotice, promptTyped } from '../bar/notice'
import { promptStub } from './stubs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const BAND = { plugin: 'thimble', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 100, scroll: { offset: 0, bodyRows: 12 }, view: {} }, viewport: { columns: 100, rows: 40, isFullscreen: true } } as never
const PANE = { plugin: 'thimble', component: 'Pane', surface: 'terminal', requestId: 'thimble', props: { title: 'Coverage', isFocused: false, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } } as never

/** A made-up folder of 7 files: Claude read one and searched two more; an `ls` listed one of the others. */
const COVERAGE = {
  root: '/made-up/data',
  total: { files: 7, touched_files: 3, seen_files: 1 },
  groups: [
    { folder: 'runs/', files: 4, touched: 2, seen_files: 1, read_share: 0.25, counted_share: 0.5, by_status: { seen: 1, searched: 1, listed: 1, untouched: 1 }, units: [{ unit: 'records', units: 40, seen: 5, model: 0, searched: 10, computed: 0 }] },
    { folder: './', files: 3, touched: 1, read_share: 0, counted_share: 0.2, units: [{ unit: 'lines', units: 30, seen: 0, model: 0, computed: 6 }] },
  ],
  files: [
    { path: 'runs/r1.jsonl', folder: 'runs/', unit: 'records', units: 10, seen: true, seen_units: 5, read_share: 0.5, counted_share: 0.5, said: 'read 5 of 10 records (50%)', ranges: [[1, 5]] },
    { path: 'runs/r2.jsonl', folder: 'runs/', unit: 'records', units: 10, seen: false, seen_units: 0, searched: true, searched_units: 10, searched_by: ['grep'], read_share: 0, counted_share: 1, said: 'searched 10 of 10 records', ranges: [] },
    { path: 'notes.md', folder: './', unit: 'lines', units: 10, seen: false, computed_units: 6, computed_over_units: 6, computed_by: ['wc'], read_share: 0, counted_share: 0.6, said: 'computed over', ranges: [] },
  ],
  untouched: { path: ['runs/r3.jsonl', 'runs/r4.jsonl', 'a.md', 'b.md'], unit: ['records', 'records', 'lines', 'lines'], units: [4, 4, 3, 3], by: ['ls', '', '', ''] },
}

function textOf(n: Any): string {
  if (n == null || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  return textOf(n.props?.children) + textOf(n.children)
}

/** A made-up session: the folder's coverage counts as `coverage` says (a JSON text, or a failure), with two labels. */
function world(on: Any, coverage: { ok: boolean; out: string }) {
  mock.env(on, { THIMBLE_HOME: '/made-up/.thimble', HOME: '/made-up/home', TMPDIR: '/made-up/tmp', PATH: '/usr/bin', THIMBLE_ROOT: '/made-up/data' })
  const clock = mock.clock(on, { now: 0 })
  const submitted: string[] = []
  const opened: string[] = []
  on('session.id', () => ({ value: 's-bar' }))
  on('session.cwd', () => ({ value: '/made-up/data' }))
  on('session.root', () => ({ value: '/made-up/data' }))
  on('session.messages', () => ({ value: [] }))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: promptStub(e.path) ?? '' }))
  on('tool.register', () => ({ value: undefined }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('fs.stat', () => ({ value: { kind: 'missing', size: 0 } }))
  on('env.set', () => ({ value: {} }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', (_$: unknown, e: { id: string }) => { opened.push(e.id); return { value: { isPlaced: true } } })
  on('ui.panes', () => ({ value: opened.map(id => ({ id, title: id })) }))
  on('command.register', () => ({ value: { command: 'thimble-settings' } }))
  on('process.run', (_$: unknown, e: { argv: string[] }) => {
    const out = (exitCode: number, stdout: string, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv.includes('coverage')) return coverage.ok ? out(0, coverage.out) : out(1, '', coverage.out)
    if (e.argv.includes('label')) return out(0, '[{"name": "failing"}, {"name": "slow"}]')
    return out(0, '')
  })
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }) as never)
  on('prompt.submit', (_$: unknown, e: { text: string }) => { submitted.push(e.text); return { text: e.text } })
  on('turn.complete', (_$: unknown, e: Any) => ({ text: e.answer }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the engine'] }) as never)
  return { clock, submitted, opened }
}

test('after an answer the bar names v, coverage and the labels; r opens the coverage pane, whose folders open', async ($, on) => {
  const w = world(on, { ok: true, out: JSON.stringify(COVERAGE) })
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
  await $.session.append({ message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'Two runs failed.' }] }, door: 'response', origin: { kind: 'model', model: 'claude-made-up' }, uuid: 'row-answer-1' } as never)
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'Two runs failed.', durationMs: 10, isAborted: false } as never)
  await w.clock.advance(100)
  const line = textOf(await $.ui.render(BAND))
  expect(line).toContain('thimble')
  expect(line).toContain('v card')
  expect(line).toContain('r coverage 43% (3/7 files)')
  expect(line).toContain('l 2 labels')

  // r at the empty prompt opens the pane once no letter followed it
  const r = (await $.prompt.edit({ origin: { kind: 'composer' }, key: { key: 'r' }, text: '', cursor: 0, start: 0, end: 0, inputText: 'r' } as never)) as Any
  expect(r.text).toBe('')
  await w.clock.advance(400)
  expect(w.opened).toContain('thimble')
  const pane = await $.ui.mount(PANE)
  // one bar for the folder and its key: 1 file read into Claude's context, 2 more computed over or searched
  expect((await pane.find({ type: 'Text', text: /files touched/ }))?.text).toMatch(/3\/7 files touched · 43%/)
  expect((await pane.find({ type: 'Text', text: /read into Claude's context/ }))?.text).toContain("read into Claude's context 1")
  expect((await pane.find({ type: 'Text', text: /computed over or searched/ }))?.text).toContain('not in its context 2')
  // the top folder Claude touched most is open: its files, one line each, the files touched after the name
  expect((await pane.find({ key: 'file:runs/r1.jsonl' }))?.text).toMatch(/r1\.jsonl +█+ +1\/1/)
  expect((await pane.find({ key: 'file:runs/r3.jsonl' }))?.text).toMatch(/r3\.jsonl +░+ +0\/1/)
  // a press closes it, and again opens it
  await pane.press({ key: 'dir:runs/' })
  expect(await pane.find({ key: 'file:runs/r1.jsonl' })).toBeUndefined()
  await pane.press({ key: 'dir:runs/' })
  // a file picked shows what touched it, in its own unit
  await pane.press({ key: 'file:runs/r1.jsonl' })
  expect(await pane.find({ type: 'Text', text: /in Claude's context +5\/10 records +50%/ })).toBeDefined()
  // j moves the selection; r closes the pane
  await pane.press({ key: 'key-j' })
  expect(await pane.find({ type: 'Text', text: /in Claude's context +0\/10 records/ })).toBeDefined()
  await pane.unmount()
})

test('a letter right after r is a word: both go back to the prompt and no pane opens', async ($, on) => {
  const w = world(on, { ok: true, out: JSON.stringify(COVERAGE) })
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'Two runs failed.', durationMs: 10, isAborted: false } as never)
  await w.clock.advance(100)
  await $.prompt.edit({ origin: { kind: 'composer' }, key: { key: 'r' }, text: '', cursor: 0, start: 0, end: 0, inputText: 'r' } as never)
  await w.clock.advance(50)
  const e = (await $.prompt.edit({ origin: { kind: 'composer' }, key: { key: 'e' }, text: '', cursor: 0, start: 0, end: 0, inputText: 'e' } as never)) as Any
  expect(e.text).toBe('re')
  await w.clock.advance(400)
  expect(w.opened).not.toContain('thimble')
})

test('a failure shows its line with f and F, and f asks Claude for the fix', async ($, on) => {
  const w = world(on, { ok: false, out: 'a made-up reason' })
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
  // the bar's first drawing counts once
  await $.ui.render(BAND)
  await w.clock.advance(100)
  const line = textOf(await $.ui.render(BAND))
  expect(line).toContain('Coverage could not be counted: a made-up reason')
  expect(line).toContain('f fix this')
  expect(line).toContain('F report only')
  await $.prompt.edit({ origin: { kind: 'composer' }, key: { key: 'f' }, text: '', cursor: 0, start: 0, end: 0, inputText: 'f' } as never)
  await w.clock.advance(400)
  expect(w.submitted.some(t => t.includes('pressed f (fix this)') && t.includes('a made-up reason'))).toBe(true)
  // the request went: the line is gone
  expect(textOf(await $.ui.render(BAND))).not.toContain('f fix this')
})

test('a coverage record that cannot be read is named in words, and the labels still count', async ($, on) => {
  const w = world(on, { ok: true, out: '{"root":"/made-up/data","files":[{"path":"a.tx' })
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
  await $.ui.render(BAND)
  await w.clock.advance(100)
  const line = textOf(await $.ui.render(BAND))
  expect(line).toContain('Coverage could not be counted: thimble coverage gave no record thimble could read.')
  expect(line).not.toContain('"root"')
  expect(line).toContain('2 labels')
})

/** Elements as plain data, for drawing the bar without a surface. */
const ELS = { Box: (p: Any) => ({ type: 'Box', props: p }), Text: (p: Any) => ({ type: 'Text', props: p }), Button: (p: Any) => ({ type: 'Button', props: p }) }

/** An engine whose state holds `state`. */
function stateOnly(state: Record<string, unknown>): Any {
  const key = (k: Any) => [k.key, k.id].filter(Boolean).join(':')
  return {
    state: { get: async (k: Any) => ({ value: state[key(k)] }), set: async (k: Any, v: unknown) => { state[key(k)] = v } },
    clock: { now: async () => 0, after: () => ({ cancel() {} }) },
  }
}

test('each switch takes its items off the bar, and v waits while a design runs', async () => {
  const state: Record<string, unknown> = { answerRow: 'row-made-up', counts: { coverage: '43% (3/7 files)', labels: 2, gen: 1, error: null } }
  const all = (on: (k: string) => boolean) => barRows(stateOnly(state), ELS, 100, { on, preview: true }).then(textOf)
  expect(await all(() => true)).toContain('v card')
  expect(await all(() => true)).toContain('r coverage 43% (3/7 files) · l 2 labels')
  expect(await all(k => k !== 'counts')).not.toContain('coverage')
  expect(await all(k => k !== 'counts')).not.toContain('labels')
  expect(await all(k => k !== 'cards')).not.toContain('v card')
  // outside a preview, v shows only while no design runs
  state.designNow = 'd1'
  state['designs:d1'] = { status: 'running' }
  expect(textOf(await barRows(stateOnly(state), ELS, 100, { on: () => true }))).not.toContain('v card')
  state['designs:d1'] = { status: 'done' }
  expect(textOf(await barRows(stateOnly(state), ELS, 100, { on: () => true }))).toContain('v card')
  // a narrow bar drops the labels first, then the file counts
  const narrow = textOf(await barRows(stateOnly(state), ELS, 40, { on: () => true }))
  expect(narrow).toContain('r coverage 43%')
  expect(narrow).not.toContain('labels')
})

test('a failure while the person tries a fix keeps the fix line and its keys; the next prompt takes the failure away only', async () => {
  const state: Record<string, unknown> = { fixLine: { slug: 'made-up-fix', title: 'Titles in teal' } }
  const $ = stateOnly(state)
  failNotice($, 'A made-up card failed.')
  await new Promise(r => setTimeout(r, 1))
  const both = textOf(await barRows($, ELS, 100, { on: () => true }))
  expect(both).toContain('A made-up card failed.')
  expect(both).toContain('f fix this')
  expect(both).toContain('✓ Your thimble has the fix: Titles in teal')
  expect(both).toContain('p submit · u undo')
  await promptTyped($)
  const after = textOf(await barRows($, ELS, 100, { on: () => true }))
  expect(after).not.toContain('A made-up card failed.')
  expect(after).toContain('p submit · u undo')
})

test('in a narrow coverage pane a long folder name is cut in its middle and its row keeps its count on one line', async ($, on) => {
  const long = (run: string) => ({ folder: `runs/${run}/`, files: 57, touched: 1, read_share: 0, counted_share: 0.02, units: [{ unit: 'records', units: 1000, seen: 0, model: 0, searched: 20, computed: 0 }] })
  const runs = ['sweep1-fable-managed_prs_issues', 'sweep2-opus-managed_prs_issues', 'a-run-whose-name-is-far-too-long-for-any-column-at-all']
  const cov = { root: '/made-up/data', total: { files: 171, touched_files: 3, seen_files: 0 }, groups: runs.map(long), files: [], untouched: { path: [] } }
  const w = world(on, { ok: true, out: JSON.stringify(cov) })
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'Done.', durationMs: 10, isAborted: false } as never)
  await w.clock.advance(100)
  await $.prompt.edit({ origin: { kind: 'composer' }, key: { key: 'r' }, text: '', cursor: 0, start: 0, end: 0, inputText: 'r' } as never)
  await w.clock.advance(400)
  const W = 72
  const pane = await $.ui.mount({ ...(PANE as Any), props: { ...(PANE as Any).props, bodyColumns: W } } as never)
  const widths = new Set<number>()
  for (const run of runs) {
    const row = (await pane.find({ key: `dir:runs/${run}/` }))?.text ?? ''
    expect(row).toContain('1/57')
    expect(row.length).toBeLessThanOrEqual(W)
    widths.add(row.indexOf('1/57'))
    expect(await pane.find({ key: `dir:runs/${run}/:name` })).toBeUndefined()
  }
  // the counts stand in one column; a name that fits stays whole, one too long keeps its start and its end
  expect(widths.size).toBe(1)
  expect((await pane.find({ key: 'dir:runs/sweep1-fable-managed_prs_issues/' }))?.text).toContain('sweep1-fable-managed_prs_issues/')
  expect((await pane.find({ key: `dir:runs/${runs[2]}/` }))?.text).toMatch(/a-run-wh.*….*at-all\//)
  await pane.unmount()
})
