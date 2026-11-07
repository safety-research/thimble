// The bar above the prompt, through the whole hooks module: after an answer it names v, coverage and the labels, and r
// opens the coverage pane drawn from `thimble coverage --json`. All data is made up. `claude plugin test plugin`.
import { expect, mock } from 'claude-code/testing'

import { test } from './kit'
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

/** A made-up session: the folder's coverage counts as `coverage` says (a JSON text), with two labels. `opens`: each pane
 *  the plugin opened. */
function world(on: Any, coverage: string) {
  mock.env(on, { THIMBLE_HOME: '/made-up/.thimble', HOME: '/made-up/home', TMPDIR: '/made-up/tmp', PATH: '/usr/bin', THIMBLE_ROOT: '/made-up/data' })
  const clock = mock.clock(on, { now: 0 })
  const opens: Any[] = []
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
  on('ui.open', (_$: unknown, e: { id: string }) => { opens.push(e); return { value: { isPlaced: true } } })
  on('ui.panes', () => ({ value: opens.map(e => ({ id: e.id, title: e.id })) }))
  on('command.register', () => ({ value: { command: 'thimble-settings' } }))
  on('process.run', (_$: unknown, e: { argv: string[] }) => {
    const out = (exitCode: number, stdout: string, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv.includes('coverage')) return out(0, coverage)
    if (e.argv.includes('label')) return out(0, '[{"name": "failing"}, {"name": "slow"}]')
    return out(0, '')
  })
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }) as never)
  on('prompt.submit', (_$: unknown, e: { text: string }) => ({ text: e.text }))
  on('turn.complete', (_$: unknown, e: Any) => ({ text: e.answer }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the engine'] }) as never)
  return { clock, opens }
}

test('after an answer the bar names v, coverage and the labels; r opens the coverage pane, whose folders open', async ($, on) => {
  const w = world(on, JSON.stringify(COVERAGE))
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
  await $.session.append({ message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'Two runs failed.' }] }, door: 'response', origin: { kind: 'model', model: 'claude-made-up' }, uuid: 'row-answer-1' } as never)
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'Two runs failed.', durationMs: 10, isAborted: false } as never)
  await w.clock.advance(100)
  const line = textOf(await $.ui.render(BAND))
  expect(line).toContain('thimble')
  expect(line).toContain('v visualize')
  expect(line).toContain('r coverage 43% (3/7 files)')
  expect(line).toContain('l 2 labels')

  // r at the empty prompt opens the pane once no letter followed it
  const r = (await $.prompt.edit({ origin: { kind: 'composer' }, key: { key: 'r' }, text: '', cursor: 0, start: 0, end: 0, inputText: 'r' } as never)) as Any
  expect(r.text).toBe('')
  await w.clock.advance(400)
  expect(w.opens.map(e => e.id)).toContain('thimble')
  // it takes the keys, so j k ↵ of its key row act in it and do not type into the prompt; esc closes it
  expect(w.opens.at(-1)).toMatchObject({ id: 'thimble', focus: true, closeOnEscape: true })
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

/** The node of a drawing whose key is `key`, or null. */
function byKey(n: Any, key: string): Any {
  if (!n || typeof n !== 'object') return null
  if (Array.isArray(n)) { for (const x of n) { const f = byKey(x, key); if (f) return f } return null }
  if (n.props?.key === key) return n
  return byKey(n.props?.children, key) ?? byKey(n.children, key)
}

// A bar too narrow for one row: the counts give way so that it keeps one row. Where it takes a second row anyway, for
// the right's items, they come back on that row when they fit there, and stay gone where they would take one more row
test("a bar that takes a second row for the right's items anyway gives the counts that gave way their room on it; where they would take one more row, they stay gone", async ($, on) => {
  const w = world(on, JSON.stringify(COVERAGE))
  on('turn.start', (_$: unknown, e: Any) => ({ turnId: e.turnId }))
  // the look at the answer has not answered: the bar names w for the claims it will find
  on('model.fork', () => ({ value: { isAnswered: false, reason: 'empty-reply' } }))
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
  await $.prompt.submit({ text: 'why did it fail?', origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: 'why did it fail?', turnId: 't1' } as never)
  await $.session.append({ message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'Two runs failed.' }] }, door: 'response', origin: { kind: 'model', model: 'claude-made-up' }, uuid: 'row-t1' } as never)
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'Two runs failed.', durationMs: 10, isAborted: false } as never)
  await w.clock.advance(20000)
  // the bar's rows in a terminal `term` columns wide (the band 5 narrower), each row's words
  const bar = async (term: number) => {
    const band = await $.ui.render({ ...(BAND as Any), props: { ...(BAND as Any).props, bodyColumns: term - 5 }, viewport: { columns: term, rows: 40, isFullscreen: true } } as never)
    const first = byKey(band, 'bar')
    return [[textOf(byKey(first, 'bar-left')), textOf(byKey(first, 'bar-right'))].filter(Boolean).join(' | '), ...['bar-1', 'bar-right-0'].map(k => byKey(band, k)).filter(Boolean).map(textOf)]
  }
  expect(await bar(160)).toEqual(['thimble  v visualize · s simplify | w claims · r coverage 43% (3/7 files) · l 2 labels'])
  // 45 columns: the keys fill the first row, and w goes on a row of its own, where both counts fit
  expect(await bar(45)).toEqual(['thimble  v visualize · s simplify', 'w claims · r coverage 43% · l 2 labels'])
  // 40 columns: coverage, which gave way last, comes back first
  expect(await bar(40)).toEqual(['thimble  v visualize · s simplify', 'w claims · r coverage 43%'])
  // 35 columns: the keys take two rows, w beside the first; a row of the counts' own would be a third, so they stay gone
  expect(await bar(35)).toEqual(['thimble  v visualize | w claims', '         s simplify'])
})
