// The bar above the prompt and its panes, through the whole hooks module: its items per switch and state, a failure's
// line, and the coverage pane drawn from `thimble coverage --json`. All data is made up.
// `claude plugin test plugin`.
import { expect, mock, test } from 'claude-code/testing'

import { barRows } from '../bar/bar'
import { busyWhile } from '../bar/busy'
import { introKeys } from '../bar/intro'
import { failNotice, noticeLine, promptTyped } from '../bar/notice'
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

/** A made-up session: the folder's coverage counts as `coverage` says (a JSON text, or a failure), with two labels.
 *  `ran`: each command's argv. */
function world(on: Any, coverage: { ok: boolean; out: string }) {
  mock.env(on, { THIMBLE_HOME: '/made-up/.thimble', HOME: '/made-up/home', TMPDIR: '/made-up/tmp', PATH: '/usr/bin', THIMBLE_ROOT: '/made-up/data' })
  const clock = mock.clock(on, { now: 0 })
  const submitted: string[] = []
  const opened: string[] = []
  const opens: Any[] = []
  const ran: string[][] = []
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
  on('ui.open', (_$: unknown, e: { id: string }) => { opened.push(e.id); opens.push(e); return { value: { isPlaced: true } } })
  on('ui.panes', () => ({ value: opened.map(id => ({ id, title: id })) }))
  on('command.register', () => ({ value: { command: 'thimble-settings' } }))
  on('process.run', (_$: unknown, e: { argv: string[] }) => {
    const out = (exitCode: number, stdout: string, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
    ran.push(e.argv)
    if (e.argv.includes('coverage')) return coverage.ok ? out(0, coverage.out) : out(1, '', coverage.out)
    if (e.argv.includes('label')) return out(0, '[{"name": "failing"}, {"name": "slow"}]')
    return out(0, '')
  })
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }) as never)
  on('prompt.submit', (_$: unknown, e: { text: string }) => { submitted.push(e.text); return { text: e.text } })
  on('turn.complete', (_$: unknown, e: Any) => ({ text: e.answer }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the engine'] }) as never)
  return { clock, submitted, opened, opens, ran }
}

test('after an answer the bar names v, coverage and the labels; r opens the coverage pane, whose folders open', async ($, on) => {
  const w = world(on, { ok: true, out: JSON.stringify(COVERAGE) })
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
  expect(w.opened).toContain('thimble')
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

test("a drawing never starts a count, since Claude Code stops a drawing's calls when a newer one replaces it; the session's start counts once", async ($, on) => {
  const w = world(on, { ok: true, out: JSON.stringify(COVERAGE) })
  const counted = () => w.ran.filter(a => a.includes('coverage')).length
  await $.ui.render(BAND)
  await w.clock.advance(100)
  await $.ui.render(BAND)
  await w.clock.advance(100)
  expect(counted()).toBe(0)
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
  await w.clock.advance(100)
  expect(counted()).toBe(1)
  expect(textOf(await $.ui.render(BAND))).toContain('r coverage 43% (3/7 files)')
  await w.clock.advance(100)
  expect(counted()).toBe(1)
})

test('an empty folder: the count ends well with nothing to count, so the bar names no coverage and no failure line shows', async ($, on) => {
  // the kernel printed nothing and ended well
  const w = world(on, { ok: true, out: '' })
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
  await w.clock.advance(100)
  expect(w.ran.some(a => a.includes('coverage'))).toBe(true)
  const line = textOf(await $.ui.render(BAND))
  expect(line).toContain('l 2 labels')
  expect(line).not.toContain('coverage')
  expect(line).not.toContain('could not be counted')
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
  expect(await all(() => true)).toContain('v visualize')
  expect(await all(() => true)).toContain('r coverage 43% (3/7 files) · l 2 labels')
  // Coverage and Labels each take their own item off the bar
  expect(await all(k => k !== 'coverage')).not.toContain('coverage')
  expect(await all(k => k !== 'coverage')).toContain('l 2 labels')
  expect(await all(k => k !== 'labels')).not.toContain('labels')
  expect(await all(k => k !== 'labels')).toContain('r coverage 43% (3/7 files)')
  expect(await all(k => k !== 'cards')).not.toContain('v visualize')
  // outside a preview, v shows only while no design runs
  state.designNow = 'd1'
  state['designs:d1'] = { status: 'running' }
  expect(textOf(await barRows(stateOnly(state), ELS, 100, { on: () => true }))).not.toContain('v visualize')
  state['designs:d1'] = { status: 'done' }
  expect(textOf(await barRows(stateOnly(state), ELS, 100, { on: () => true }))).toContain('v visualize')
  // a narrow bar drops the labels first, then the file counts
  const narrow = textOf(await barRows(stateOnly(state), ELS, 40, { on: () => true }))
  expect(narrow).toContain('r coverage 43%')
  expect(narrow).not.toContain('labels')
})

test('a failure is a line above the bar in red, a notice one not in red; the next prompt takes either away', async () => {
  const state: Record<string, unknown> = {}
  const $ = stateOnly(state)
  failNotice($, 'A made-up card failed.')
  await new Promise(r => setTimeout(r, 1))
  const rows = await barRows($, ELS, 100, { on: () => true })
  expect(rows.length).toBe(2)
  expect(textOf(rows[0])).toBe('× A made-up card failed.')
  expect(JSON.stringify(rows[0])).toContain('"color":"error"')
  await promptTyped($)
  expect(textOf(await barRows($, ELS, 100, { on: () => true }))).not.toContain('A made-up card failed.')
  noticeLine($, 'A made-up notice.')
  await new Promise(r => setTimeout(r, 1))
  const notice = await barRows($, ELS, 100, { on: () => true })
  expect(textOf(notice[0])).toBe('A made-up notice.')
  expect(JSON.stringify(notice[0])).toContain('"color":"warning"')
  await promptTyped($)
  expect((await barRows($, ELS, 100, { on: () => true })).length).toBe(1)
})


test('a long busy step keeps the bar to one row: its other steps go, then its words are cut', async () => {
  let now = 0
  const state: Record<string, unknown> = {}
  const $ = { ...stateOnly(state), clock: { now: async () => now, after: () => ({ cancel() {} }) } } as Any
  let alive = true
  await busyWhile($, 'checking 3 citations', async () => alive)
  await busyWhile($, 'fixing fix 6 with a made-up long step name', async () => alive)
  now = 5000
  const wide = textOf(await barRows($, ELS, 160, { on: () => false }))
  expect(wide).toContain('checking 3 citations')
  expect(wide).toContain('fixing fix 6 with a made-up long step name')
  const narrow = textOf(await barRows($, ELS, 50, { on: () => false }))
  expect(narrow).not.toContain(' · ')
  expect(narrow.length).toBeLessThanOrEqual(50)
  const narrower = textOf(await barRows($, ELS, 26, { on: () => false }))
  expect(narrower).toContain('…')
  expect(narrower.length).toBeLessThanOrEqual(26)
  alive = false
})

test('a session starts with a line above the bar that names the keys of the features on and where the settings are; the first prompt takes it, and a click on its thimble opens the settings', async ($, on) => {
  const w = world(on, { ok: true, out: JSON.stringify(COVERAGE) })
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
  const band = textOf(await $.ui.render(BAND))
  expect(band).toContain('thimble · v visualize · e explain')
  expect(band).toContain('s rewrite · click thimble for settings')
  // its thimble opens the settings, as the bar's does
  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'intro-thimble' })
  await ui.unmount()
  expect(w.opened).toEqual(['thimble'])
  // the person's first prompt: the line goes, and a resumed session does not show it again
  await $.prompt.submit({ text: 'which runs failed?', origin: { kind: 'composer' } } as never)
  expect(textOf(await $.ui.render(BAND))).not.toContain('click thimble for settings')
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
  expect(textOf(await $.ui.render(BAND))).not.toContain('click thimble for settings')
})

test('the line at a session\'s start names a key only while its feature is on', async () => {
  expect(introKeys(() => true)).toEqual([['v', 'visualize'], ['e', 'explain'], ['c', 'cite'], ['s', 'rewrite']])
  expect(introKeys(k => k !== 'cards' && k !== 'cite')).toEqual([['e', 'explain'], ['s', 'rewrite']])
})
