// The bar above the prompt and its panes, through the whole hooks module: its items per switch and state, a failure's
// line, and the coverage pane drawn from `thimble coverage --json`. All data is made up.
// `claude plugin test plugin`.
import { expect, mock } from 'claude-code/testing'

import { barRows } from '../bar/bar'
import { SPIN, busyNow, busyWhile } from '../bar/busy'
import { recount } from '../bar/counts'
import { noteViewport } from '../cards/draw'
import { INTRO, INTRO_MS } from '../bar/intro'
import { hintUsed, howTo, remindAfterAnswer } from '../bar/hints'
import { failLineNow, failNotice, HINT_MS, hintLine, hintsGone, noticeLine, promptTyped } from '../bar/notice'
import { textWidth } from '../core/text.js'
import { accent, themeLast } from '../core/theme'
import { markColors } from '../explain/place.mjs'
import { setOptions } from '../settings/features.mjs'
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

/** A made-up session: the folder's coverage counts as `coverage` says (a JSON text, or a failure), with two labels.
 *  `ran`: each command's argv. `o.count`: answers each run of `thimble coverage` instead, when it comes; `o.disk`: the
 *  files the plugin writes and reads back, by path. */
function world(on: Any, coverage: { ok: boolean; out: string }, o: { count?: (argv: string[]) => Promise<{ code: number; out: string }>; disk?: Map<string, string> } = {}) {
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
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: o.disk?.get(e.path) ?? promptStub(e.path) ?? '' }))
  on('tool.register', () => ({ value: undefined }))
  on('fs.write', (_$: unknown, e: { path: string; text: string }) => { o.disk?.set(e.path, e.text); return { value: undefined } })
  on('fs.list', () => ({ value: [] }))
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: !!o.disk?.has(e.path) }))
  on('fs.stat', () => ({ value: { kind: 'missing', size: 0 } }))
  on('env.set', () => ({ value: {} }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', (_$: unknown, e: { id: string }) => { opened.push(e.id); opens.push(e); return { value: { isPlaced: true } } })
  on('ui.panes', () => ({ value: opened.map(id => ({ id, title: id })) }))
  on('command.register', () => ({ value: { command: 'thimble-settings' } }))
  on('process.run', (_$: unknown, e: { argv: string[] }) => {
    const out = (exitCode: number, stdout: string, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
    ran.push(e.argv)
    if (e.argv.includes('coverage') && o.count) return o.count(e.argv).then(r => out(r.code, r.out))
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

test("the coverage pane's r close is a click alone: an r typed while the pane holds the keyboard reaches the prompt, where it closes the pane once its word window closed and never opens it again, and a word that starts with r is typed whole", async ($, on) => {
  const w = world(on, { ok: true, out: JSON.stringify(COVERAGE) })
  // the box as Claude Code keeps it, and the side pane: up from an open until a close
  on('prompt.edit', (_$: unknown, e: Any) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
  const closes: string[] = []
  on('ui.close', (_$: unknown, e: { id: string }) => { closes.push(e.id); w.opened.splice(0); return { value: undefined } })
  const key = (k: string, text = '') => $.prompt.edit({ origin: { kind: 'composer' }, key: { key: k }, text, cursor: text.length, start: text.length, end: text.length, inputText: k } as never) as Promise<Any>
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
  await $.session.append({ message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'Two runs failed.' }] }, door: 'response', origin: { kind: 'model', model: 'claude-made-up' }, uuid: 'row-answer-1' } as never)
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'Two runs failed.', durationMs: 10, isAborted: false } as never)
  await w.clock.advance(100)
  expect(textOf(await $.ui.render(BAND))).toContain('r coverage 43% (3/7 files)')
  expect((await key('r')).text).toBe('')
  await w.clock.advance(400)
  expect(w.opened).toEqual(['thimble'])
  // the pane's key row ends with r close, a click alone: no Button of the pane takes r
  const buttons: Any[] = []
  const walk = (n: Any): void => { if (Array.isArray(n)) n.forEach(walk); else if (n && typeof n === 'object') { if (n.type === 'Button') buttons.push(n); walk(n.props?.children); walk(n.children) } }
  walk(await $.ui.render(PANE))
  expect(buttons.filter(b => b.props.hotkey === 'r')).toEqual([])
  const close = buttons.find(b => String(b.key ?? b.props.key) === 'key-r')
  expect([close?.props.label, textOf(close)]).toEqual(['close', 'r: close'])
  // the bar drawn beside the pane: an r typed in the pane reaches the prompt and closes it once its word window closed
  await $.ui.render(BAND)
  expect((await key('r')).text).toBe('')
  await w.clock.advance(400)
  expect(closes).toEqual(['thimble'])
  // open again; an r typed in it, then esc before its word window closed: the pane stays closed
  await $.ui.render(BAND)
  expect((await key('r')).text).toBe('')
  await w.clock.advance(400)
  expect(w.opened).toEqual(['thimble'])
  await $.ui.render(BAND)
  const opens = w.opens.length
  expect((await key('r')).text).toBe('')
  w.opened.splice(0)
  await w.clock.advance(400)
  expect(w.opens.length).toBe(opens)
  // a question that starts with r, typed on: a word, whole in the prompt, and nothing opens
  await $.ui.render(BAND)
  expect((await key('r')).text).toBe('')
  expect((await key('u')).text).toBe('ru')
  expect((await key('n', 'ru')).text).toBe('run')
  await w.clock.advance(400)
  expect(w.opens.length).toBe(opens)
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

/** The made-up folder after Claude touched one more file. */
const NEWER = { ...COVERAGE, total: { files: 7, touched_files: 4, seen_files: 2 } }
/** Where the conversation's last count is kept (core/layout.mjs). */
const KEPT_COUNT = '/made-up/.thimble/conversations/s-bar/coverage.json'

test('a count the kernel stopped at its time runs again at once and goes on until it gives the record; a run that counted no further ends the count, saying why', async ($, on) => {
  const runs: string[][] = []
  const answers: unknown[] = [{ counting: { counted: 10, files: 30 } }, { counting: { counted: 25, files: 30 } }, COVERAGE]
  const w = world(on, { ok: true, out: '' }, { count: async argv => { runs.push(argv); return { code: 0, out: JSON.stringify(answers.shift()) } } })
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
  await w.clock.advance(100)
  expect(runs.length).toBe(3)
  // each run stops counting within Claude Code's 10 minutes
  for (const argv of runs) {
    expect(argv).toEqual(expect.arrayContaining(['coverage', '--json', '--within']))
    const within = Number(argv[argv.indexOf('--within') + 1])
    expect(within > 0 && within < 600).toBe(true)
  }
  expect(textOf(await $.ui.render(BAND))).toContain('r coverage 43% (3/7 files)')
  // after the next answer, a run that counted no more of the folder's files than the run before
  answers.push({ counting: { counted: 25, files: 30 } }, { counting: { counted: 25, files: 30 } })
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'Two runs failed.', durationMs: 10, isAborted: false } as never)
  await w.clock.advance(100)
  const line = textOf(await $.ui.render(BAND))
  expect(line).toContain("Coverage could not be counted: counting the folder's 30 files went no further in")
  expect(line).toContain('r coverage 43% (3/7 files)')
})

test("at a load of the plugin (a reload, a setting changed, a resumed session), the conversation's last count shows on the bar and in the pane while the new count runs, and the new count is kept in its place", async ($, on) => {
  const disk = new Map([[KEPT_COUNT, JSON.stringify({ root: '/made-up/data', coverage: '43% (3/7 files)', labels: 2, record: COVERAGE })]])
  const ends: ((r: { code: number; out: string }) => void)[] = []
  const w = world(on, { ok: true, out: '' }, { disk, count: () => new Promise(r => { ends.push(r) }) })
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
  await w.clock.advance(5000)
  const line = textOf(await $.ui.render(BAND))
  expect(line).toContain('counting coverage')
  expect(line).toContain('r coverage 43% (3/7 files)')
  expect(line).toContain('l 2 labels')
  // r opens the pane on the last count
  await $.prompt.edit({ origin: { kind: 'composer' }, key: { key: 'r' }, text: '', cursor: 0, start: 0, end: 0, inputText: 'r' } as never)
  await w.clock.advance(400)
  const pane = await $.ui.mount(PANE)
  expect((await pane.find({ type: 'Text', text: /files touched/ }))?.text).toMatch(/3\/7 files touched · 43%/)
  await pane.unmount()
  ends[0]!({ code: 0, out: JSON.stringify(NEWER) })
  await w.clock.advance(100)
  expect(textOf(await $.ui.render(BAND))).toContain('r coverage 57% (4/7 files)')
  expect(JSON.parse(disk.get(KEPT_COUNT)!)).toMatchObject({ root: '/made-up/data', coverage: '57% (4/7 files)', labels: 2, record: { total: { touched_files: 4 } } })
})

test("a count that a reload stopped goes on in the next load's count, and the bar's time for it goes on from when it began", async () => {
  let now = 10_000_000
  const state = new Map<string, unknown>()
  const key = (k: Any) => [k.key, k.id].filter(Boolean).join(':')
  // the state as a reload left it: the count began 300 s ago, and the last count stands
  state.set('counts', { coverage: '43% (3/7 files)', labels: 2, gen: 3, error: null, since: now - 300000 })
  const ends: ((r: Any) => void)[] = []
  const $: Any = {
    plugin: { root: '/made-up/plugin' },
    env: { get: async (k: string) => ({ THIMBLE_HOME: '/made-up/.thimble', HOME: '/made-up/home', THIMBLE_ROOT: '/made-up/data' } as Record<string, string>)[k] },
    fs: { read: async () => { throw new Error('missing') }, write: async () => undefined, exists: async () => false, stat: async (p: string) => ({ kind: 'dir', size: 0, realPath: p }) },
    state: { get: async (k: Any) => ({ value: state.get(key(k)) }), set: async (k: Any, v: unknown) => { state.set(key(k), v); return { isSet: true } } },
    clock: { now: async () => now, after: () => ({ cancel() {} }) },
    session: { id: async () => 's-reload', usage: async () => ({}), messages: async () => [], cwd: async () => '/made-up/data', root: async () => '/made-up/data' },
    process: { run: (argv: string[]) => (argv.includes('coverage') ? new Promise(r => { ends.push(r) }) : Promise.resolve({ exitCode: 0, stdout: '[]', stderr: '' })) },
    ui: { toast: () => undefined },
  }
  const counted = recount($)
  await new Promise(r => setTimeout(r, 10))
  now += 4000
  expect(await busyNow($)).toMatchObject({ word: 'counting coverage', secs: 304 })
  // the bar keeps the last count meanwhile
  expect(state.get('counts')).toMatchObject({ coverage: '43% (3/7 files)', labels: 2 })
  ends[0]!({ exitCode: 0, stdout: JSON.stringify(NEWER), stderr: '' })
  await counted
  expect(state.get('counts')).toMatchObject({ coverage: '57% (4/7 files)', since: null })
  expect(await busyNow($)).toBeNull()
})

test('while it counts, the bar keeps its keys: v beside the busy step, and the last count on its right, also when narrow', async ($, on) => {
  const ends: ((r: { code: number; out: string }) => void)[] = []
  const w = world(on, { ok: true, out: '' }, { count: () => new Promise(r => { ends.push(r) }) })
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
  await w.clock.advance(100)
  ends.shift()!({ code: 0, out: JSON.stringify(COVERAGE) })
  await w.clock.advance(100)
  // the next answer's count runs
  await $.session.append({ message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'Two runs failed.' }] }, door: 'response', origin: { kind: 'model', model: 'claude-made-up' }, uuid: 'row-answer-1' } as never)
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'Two runs failed.', durationMs: 10, isAborted: false } as never)
  await w.clock.advance(5000)
  const at = async (width: number) => textOf(await $.ui.render({ ...(BAND as Any), props: { ...(BAND as Any).props, bodyColumns: width } } as never))
  const wide = await at(100)
  for (const item of ['counting coverage 5s', 'v visualize', 'r coverage 43% (3/7 files)']) expect(wide).toContain(item)
  // narrow, coverage's file counts give way, then the busy step's words, down to its glyph and seconds, and the keys stay
  const narrow = await at(60)
  for (const item of ['5s', 'v visualize', 'r coverage 43%']) expect(narrow).toContain(item)
  ends.forEach(end => end({ code: 0, out: JSON.stringify(COVERAGE) }))
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

test('the settings\' preview in a narrow pane lays out whole items: none is split across rows, no row starts or ends with ·, and none is wider than the pane', async () => {
  const state: Record<string, unknown> = { counts: { coverage: '0.01% (1/7,008 files)', labels: 2, gen: 1, error: null } }
  const lines = (await barRows(stateOnly(state), ELS, 40, { on: () => true, preview: true })).map(textOf)
  expect(lines.length).toBeGreaterThan(1)
  for (const l of lines) {
    expect(textWidth(l)).toBeLessThanOrEqual(40)
    expect(l.trim()).not.toMatch(/^·|·$/)
  }
  for (const item of ['v visualize', 'e explain', 'r coverage 0.01% (1/7,008 files)', 'l 2 labels']) expect(lines.filter(l => l.includes(item)).length).toBe(1)
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

test('a busy step that began before this load of the module (a fixer across a reload) counts its seconds from then; a start the clock has not reached starts now', async () => {
  let now = 9000000
  const $ = { ...stateOnly({}), clock: { now: async () => now, after: () => ({ cancel() {} }) } } as Any
  let alive = true
  await busyWhile($, 'fixing a made-up fix', async () => alive, now - 120000)
  expect(await busyNow($)).toMatchObject({ word: 'fixing a made-up fix', secs: 120 })
  await busyWhile($, 'checking 2 citations', async () => alive, now + 60000)
  now += 4000
  expect(await busyNow($)).toMatchObject({ word: 'checking 2 citations', secs: 4 })
  alive = false
})

test("a narrow bar gives way in order: coverage's file counts, then the busy step to its glyph and seconds, then the labels' count, then coverage; the busy step's words take back the room the labels' count left; a hint stays whole, and the keys stay, whole, on a second row when they must", async () => {
  let now = 0
  const state: Record<string, unknown> = { answerRow: 'row-made-up', counts: { coverage: '43% (3/7 files)', labels: 2, gen: 1, error: null }, designNow: 'd1', 'designs:d1': { status: 'done' } }
  const $: Any = { ...stateOnly(state), ui: { invalidate: () => undefined }, clock: { now: async () => now, after: () => ({ cancel() {} }) } }
  let alive = true
  // the newest step (the steps of tests before it still run beside it)
  now = 1000
  await busyWhile($, 'fixing new: add a way for the analyst to see it', async () => alive)
  now = 6000
  // the bar's rows at `width`, none wider than it
  const bar = async (width: number) => {
    const rows = (await barRows($, ELS, width, { on: () => true })).map(textOf)
    for (const r of rows) expect(textWidth(r)).toBeLessThanOrEqual(width)
    return rows
  }
  // coverage's file counts go first, then the busy step's words, a whole word at a time, while both counts stay
  const cut = (await bar(80)).join('\n')
  expect(cut).toContain('fixing new: add a way…')
  expect(cut).not.toContain('to see it')
  expect(cut).not.toContain('(3/7 files)')
  for (const item of ['5s', 'v visualize', 'r coverage 43%', 'l 2 labels']) expect(cut).toContain(item)
  // then down to its glyph and seconds, before any count gives way
  const least = (await bar(60)).join('\n')
  expect(least).not.toContain('fixing')
  for (const item of ['5s', 'v visualize', 'r coverage 43%', 'l 2 labels']) expect(least).toContain(item)
  expect(least).not.toContain('(3/7 files)')
  // then the labels' count; the busy step's words take back the room it left, before coverage's file counts
  const back = (await bar(55)).join('\n')
  for (const item of ['fixing…', '5s', 'v visualize', 'r coverage 43%']) expect(back).toContain(item)
  for (const gone of ['(3/7 files)', 'labels']) expect(back).not.toContain(gone)
  const labelsGone = (await bar(50)).join('\n')
  for (const item of ['5s', 'v visualize', 'r coverage 43%']) expect(labelsGone).toContain(item)
  for (const gone of ['(3/7 files)', 'labels']) expect(labelsGone).not.toContain(gone)
  // then coverage; the labels' count, which is shorter, comes back in the room coverage left when it fits there alone
  const labelsBack = (await bar(40)).join('\n')
  for (const item of ['5s', 'v visualize', 'l 2 labels']) expect(labelsBack).toContain(item)
  expect(labelsBack).not.toContain('coverage')
  // and where neither fits, no count
  const none = (await bar(36)).join('\n')
  for (const item of ['5s', 'v visualize']) expect(none).toContain(item)
  for (const gone of ['coverage', 'labels']) expect(none).not.toContain(gone)
  // a hint stays whole, and the counts give way to it; the busy step takes back the room they leave
  hintLine($, 'select words in an answer and press e to explain them.', 'explain')
  await new Promise(r => setTimeout(r, 5))
  const hinted = await bar(90)
  expect(hinted.length).toBe(1)
  expect(hinted[0]).toContain('select words in an answer and press e to explain them.')
  expect(hinted[0]).toContain('fixing')
  expect(hinted[0]).not.toContain('coverage')
  expect(hinted[0]).not.toContain('labels')
  await hintsGone($)
  // narrower than its keys: they go on a second row, each whole
  const two = await bar(25)
  expect(two.length).toBe(2)
  expect(two[0]).toContain('5s')
  expect(two[1]).toContain('v visualize')
  alive = false
})

test('the first session starts with one plain line above the bar that says where the settings are and names no key; the first prompt takes it, and no later session or reload shows it again', async ($, on) => {
  world(on, { ok: true, out: JSON.stringify(COVERAGE) })
  mock.store(on)
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
  const band = textOf(await $.ui.render(BAND))
  expect(band).toContain(INTRO)
  // the keys are the bar's alone: the line repeats none of them
  expect(band).not.toContain('v visualize · e explain')
  expect(band).not.toContain('c cite')
  await $.prompt.submit({ text: 'which runs failed?', origin: { kind: 'composer' } } as never)
  expect(textOf(await $.ui.render(BAND))).not.toContain(INTRO)
  // a reload or a new session keeps it gone: it is kept for the install, not the session
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
  expect(textOf(await $.ui.render(BAND))).not.toContain(INTRO)
})

test('the line at the first session goes by itself after a few seconds, and stays gone after a reload', async ($, on) => {
  const w = world(on, { ok: true, out: JSON.stringify(COVERAGE) })
  mock.store(on)
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
  expect(textOf(await $.ui.render(BAND))).toContain(INTRO)
  await w.clock.advance(INTRO_MS - 1000)
  expect(textOf(await $.ui.render(BAND))).toContain(INTRO)
  await w.clock.advance(1000)
  expect(textOf(await $.ui.render(BAND))).not.toContain(INTRO)
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
  expect(textOf(await $.ui.render(BAND))).not.toContain(INTRO)
})

test('a hint above the bar goes by itself after a few seconds, or at the next key thimble takes; a failure stays', async () => {
  const state: Record<string, unknown> = {}
  let now = 0
  const timers: { at: number; fn: () => void }[] = []
  const $: Any = { ...stateOnly(state), ui: { invalidate: () => undefined } }
  $.clock = { now: async () => now, after: (ms: number, fn: () => void) => { timers.push({ at: now + ms, fn }); return { cancel() {} } } }
  const advance = async (ms: number) => {
    now += ms
    for (const t of timers.splice(0).filter(t => t.at <= now || !timers.push(t))) t.fn()
    await new Promise(r => setTimeout(r, 5))
  }
  const shown = async () => textOf(await barRows($, ELS, 100, { on: () => true }))
  hintLine($, 'select words in an answer and press e to explain them.', 'explain')
  await advance(0)
  expect(await shown()).toContain('Hint: select words in an answer')
  await advance(HINT_MS - 1000)
  expect(await shown()).toContain('Hint: select words in an answer')
  await advance(1000)
  expect(await shown()).not.toContain('select words in an answer')
  hintLine($, 'nothing to step to yet.', 'tray')
  await advance(0)
  expect(await shown()).toContain('Hint: nothing to step to yet.')
  await hintsGone($)
  expect(await shown()).not.toContain('nothing to step to yet.')
  failNotice($, 'The card did not draw.')
  await advance(HINT_MS * 2)
  await hintsGone($)
  expect(await shown()).toContain('The card did not draw.')
})

test('a hint stands in the bar in place of its left keys, after `thimble`; the right stays, and a hint too long for the row stands whole above the bar, which keeps its keys', async () => {
  const state: Record<string, unknown> = { answerRow: 'row-made-up', counts: { coverage: '43% (3/7 files)', labels: 2, gen: 1, error: null }, designNow: 'd1', 'designs:d1': { status: 'done' } }
  const $: Any = { ...stateOnly(state), ui: { invalidate: () => undefined } }
  const bar = async (width: number) => barRows($, ELS, width, { on: () => true })
  expect(textOf(await bar(100))).toContain('v visualize')
  hintLine($, 'press s to rewrite the last answer shorter or longer.', 'remind:rewrite')
  await new Promise(r => setTimeout(r, 5))
  const rows = await bar(140)
  expect(rows.length).toBe(1)
  const band = textOf(rows)
  expect(band).toContain('thimble  Hint: press s to rewrite the last answer shorter or longer.')
  expect(band).not.toContain('v visualize')
  expect(band).toContain('r coverage 43% (3/7 files) · l 2 labels')
  // a hint too long for the row stands above the bar, whole, and the bar names its keys again
  const long = `select words in an answer and press e to explain them, ${'and then some more words '.repeat(8)}`.trim()
  hintLine($, long, 'explain')
  await new Promise(r => setTimeout(r, 5))
  const narrow = await bar(80)
  expect(narrow.length).toBe(2)
  expect(textOf(narrow[0])).toBe(`Hint: ${long}`)
  expect(textOf(narrow[1])).toContain('v visualize')
  expect(textOf(narrow[1])).toContain('r coverage')
  expect(textOf(narrow)).not.toContain('…')
})

test('the first session\'s hint says where the settings are, in the bar in place of its keys', async ($, on) => {
  world(on, { ok: true, out: JSON.stringify(COVERAGE) })
  mock.store(on)
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
  const band = textOf(await $.ui.render(BAND))
  expect(band).toContain('thimble  Hint: click thimble for settings.')
  expect(band.split('click thimble for settings.').length).toBe(2)
})

/** The node of a drawing whose key is `key`, or null. */
function byKey(n: Any, key: string): Any {
  if (!n || typeof n !== 'object') return null
  if (Array.isArray(n)) { for (const x of n) { const f = byKey(x, key); if (f) return f } return null }
  if (n.props?.key === key) return n
  return byKey(n.props?.children, key) ?? byKey(n.children, key)
}

/** What the observer's look answers after an answer: an explainer and a heads-up on words of MARKED (made up). */
const marksReply = (o: { glosses?: boolean } = {}) => JSON.stringify({
  glosses: o.glosses === false ? [] : [{ term: 'retry budget', body: 'How many times the client tries again.' }],
  heads: { term: '30 seconds after a drop', title: 'Only one network', bullets: ['The log covers one office.'] },
  claims: [],
})
const MARKED = 'Uploads fail after the retry budget runs out: 41 of the 44 failures came 30 seconds after a drop.'
const answerRow = (requestId: string, text: string) => ({ plugin: 'thimble', component: 'AssistantMessage', surface: 'terminal', requestId, viewport: { columns: 100, rows: 40, isFullscreen: true }, props: { text, isFirstOfReply: true } }) as never

/** The looks after main's answers, each answering the next of `replies` ('{}' once they ran out), and the turns'
 *  starts (answered). */
function looks(on: Any, replies: string[]) {
  on('model.fork', () => ({ value: { isAnswered: true, text: replies.shift() ?? '{}' } }))
  on('turn.start', (_$: unknown, e: Any) => ({ turnId: e.turnId }))
}

/** A turn of main's: the person's prompt, the answer `text` in the row `row-<id>`, the look after it, and the row
 *  drawn, with the marks the look gave on its words. */
async function answered($: Any, clock: Any, id: string, text: string) {
  await $.prompt.submit({ text: `question ${id}`, origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: `question ${id}`, turnId: id } as never)
  await $.session.append({ message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] }, door: 'response', origin: { kind: 'model', model: 'claude-made-up' }, uuid: `row-${id}` } as never)
  await $.turn.complete({ turnId: id, reason: 'answer', answer: text, durationMs: 10, isAborted: false } as never)
  await clock.advance(1000)
  await $.ui.render(answerRow(`row-${id}`, text))
  await clock.advance(100)
}

/** MARKED with one of its claims cited, as Claude cites (made up). */
const CITED = 'Uploads fail after the retry budget runs out: [41 of the 44 failures](#) came 30 seconds after a drop.'
/** An answer's row drawn in Claude Code's fullscreen layout, or in its default one, which sends thimble no click. */
const answerIn = (requestId: string, text: string, isFullscreen: boolean) => ({ ...(answerRow(requestId, text) as Any), viewport: { columns: 100, rows: 40, isFullscreen } }) as never

test("an answer whose words show a heads-up, an explainer and a citation brings no row above the bar that names them, in Claude Code's fullscreen layout or its default one: its marks show what they are when opened", async ($, on) => {
  const w = world(on, { ok: true, out: JSON.stringify(COVERAGE) })
  mock.store(on)
  looks(on, [marksReply()])
  // the check of the answer's citations starts, and runs
  on('agent.spawn', () => ({ model: 'claude-made-up', agentId: 'agent-check-1' }) as never)
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
  await answered($, w.clock, 't1', CITED)
  const buttons = (n: Any): Any[] => (!n || typeof n !== 'object' ? [] : Array.isArray(n) ? n.flatMap(buttons) : [...(n.type === 'Button' ? [n] : []), ...buttons(n.props?.children), ...buttons(n.children)])
  try {
    for (const isFullscreen of [true, false]) {
      const labels = buttons(await $.ui.render(answerIn('row-t1', CITED, isFullscreen))).map(b => String(b.props.label))
      expect(labels).toEqual(expect.arrayContaining(['explain retry budget', 'heads up 30 seconds after a drop']))
      expect(labels.some(l => l.startsWith('citation 1'))).toBe(true)
      const band = await $.ui.render({ ...(BAND as Any), viewport: { columns: 100, rows: 40, isFullscreen } } as never)
      expect(byKey(band, 'intro-legend')).toBe(null)
      for (const said of ['heads-up · explainer', 'cited claim', 'click to open', 'a second Claude checks it', 'select words for']) expect(textOf(band)).not.toContain(said)
    }
    // nor after the next prompt and answer
    await answered($, w.clock, 't2', MARKED)
    expect(byKey(await $.ui.render(BAND), 'intro-legend')).toBe(null)
  } finally {
    noteViewport({ isFullscreen: true })
  }
})

/** The band above the prompt, `cols` cells wide, in Claude Code's fullscreen layout or its default one. */
const bandAt = (cols: number, isFullscreen = true) => ({ ...(BAND as Any), props: { ...(BAND as Any).props, bodyColumns: cols }, viewport: { columns: cols, rows: 40, isFullscreen } }) as never

/** The bar's item for ] at rest (tray/tray.ts restItem), and whether its words are lit: in thimble's color, not dim;
 *  on a bar wide enough for each item's words whole. */
async function restKey($: Any): Promise<{ words: string; lit: boolean } | null> {
  const find = (n: Any): Any => (!n || typeof n !== 'object' ? null : Array.isArray(n) ? n.map(find).find(Boolean) ?? null : n.props?.key === 'bar-tray-next' ? n : find(n.props?.children) ?? find(n.children))
  const b = find(await $.ui.render(bandAt(140)))
  if (!b) return null
  const kids = (n: Any): Any[] => (!n || typeof n !== 'object' ? [] : Array.isArray(n) ? n.flatMap(kids) : [n, ...kids(n.props?.children), ...kids(n.children)])
  const words = kids(b).find(n => n.type === 'Text' && textOf(n).startsWith(' '))
  return { words: textOf(b), lit: words?.props?.color === accent() && !words?.props?.dimColor }
}

test("the bar's ] is lit while the answer the keys act on shows a mark the person has not opened, and dim once they opened each: opening its explainer leaves it lit while its citation is not opened, a heads-up asked for after lights it again, and a new answer's marks light it", { options: { details: 'on demand' } }, async ($, on) => {
  const w = world(on, { ok: true, out: JSON.stringify(COVERAGE) })
  mock.store(on)
  // the look after the first answer gives an explainer; h then asks for a heads-up on it; the look after the second
  // answer gives an explainer on its words
  looks(on, [
    JSON.stringify({ glosses: [{ term: 'retry budget', body: 'How many times the client tries again.' }], heads: null, claims: [] }),
    JSON.stringify({ glosses: [], heads: { term: '30 seconds after a drop', title: 'Only one network', bullets: ['The log covers one office.'] }, claims: [] }),
    JSON.stringify({ glosses: [{ term: 'cache key', body: 'What a build looks its cache up by.' }], heads: null, claims: [] }),
  ])
  on('agent.spawn', () => ({ model: 'claude-made-up', agentId: 'agent-check-1' }) as never)
  const press = async (k: string) => {
    await $.prompt.edit({ origin: { kind: 'composer' }, key: { key: k }, text: '', cursor: 0, start: 0, end: 0, inputText: k } as never)
    await w.clock.advance(1000)
  }
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
  await answered($, w.clock, 't1', CITED)
  // (the reminder of h after the answer stands in place of the bar's keys from its first drawing until it goes)
  await $.ui.render(BAND)
  await w.clock.advance(HINT_MS)
  await $.ui.render(answerRow('row-t1', CITED))
  expect(await restKey($)).toEqual({ words: '] show explainer', lit: true })
  // ] opens the explainer, the answer's first mark; its citation is not opened yet, and ] names it
  await press(']')
  await press('0')
  expect(await restKey($)).toEqual({ words: '] next citation', lit: true })
  // ] from rest opens the citation: each mark the answer shows was opened, and ] names its first mark again
  for (const k of [']', '0']) await press(k)
  expect(await restKey($)).toEqual({ words: '] show explainer', lit: false })
  // a heads-up asked for on the same answer comes after: lit, until the person opens it too
  await press('h')
  await $.ui.render(answerRow('row-t1', CITED))
  await w.clock.advance(100)
  const labels = (n: Any): string[] => (!n || typeof n !== 'object' ? [] : Array.isArray(n) ? n.flatMap(labels) : [...(n.type === 'Button' ? [String(n.props?.label)] : []), ...labels(n.props?.children), ...labels(n.children)])
  expect(labels(await $.ui.render(answerRow('row-t1', CITED)))).toContain('heads up 30 seconds after a drop')
  expect(await restKey($)).toEqual({ words: '] next heads up', lit: true })
  // ] from rest opens the heads-up, the one mark not opened
  for (const k of [']', '0']) await press(k)
  expect(await restKey($)).toEqual({ words: '] show explainer', lit: false })
  // the next answer, with marks of its own
  await answered($, w.clock, 't2', 'The cache key changed when the lockfile moved.')
  // (the reminder of s after it, as after the first)
  await $.ui.render(BAND)
  await w.clock.advance(HINT_MS)
  expect(await restKey($)).toEqual({ words: '] show explainer', lit: true })
})

/** The band above the prompt as Claude Code draws it in a terminal `term` columns wide: 5 columns narrower than the
 *  terminal (2.1.307), in its fullscreen layout or its default one. */
const bandIn = (term: number, isFullscreen = true) => ({ ...(BAND as Any), props: { ...(BAND as Any).props, bodyColumns: term - 5 }, viewport: { columns: term, rows: 40, isFullscreen } }) as never

/** The bar in a drawing of the band: its rows' words (the first row's left and right, then any more rows), the first
 *  row's left and right apart, the widest row, and its ] at rest. */
function barIn(band: Any): { rows: string[]; left: string; right: string; widest: number; rest: string | null } {
  const rows = ['bar', 'bar-1', 'bar-2', 'bar-right-0', 'bar-right-1'].map(k => byKey(band, k)).filter(Boolean).map(textOf)
  const b = byKey(band, 'bar-tray-next')
  const first = byKey(band, 'bar')
  const left = textOf(byKey(first, 'bar-left'))
  const right = textOf(byKey(first, 'bar-right'))
  // the first row's left and right stand two cells apart
  const widths = [textWidth(left) + (right ? 2 + textWidth(right) : 0), ...rows.slice(1).map(textWidth)]
  return { rows, left, right, widest: Math.max(0, ...widths), rest: b ? textOf(b) : null }
}

/** A session with one answer, CITED, whose look gave an explainer and a heads-up on its words, its row drawn after the
 *  reminder after it went. `selection`: words of it selected; `counting`: then a count runs until `end`, the one a
 *  click on `r coverage` starts as it opens the coverage pane, which a second click closes. */
async function markedAnswer($: Any, on: Any, o: { selection?: string; counting?: boolean } = {}): Promise<{ clock: Any; end: () => Promise<void> }> {
  const ends: ((r: { code: number; out: string }) => void)[] = []
  let hold = false
  const w = world(on, { ok: true, out: JSON.stringify(COVERAGE) }, { count: () => (hold ? new Promise(r => { ends.push(r) }) : Promise.resolve({ code: 0, out: JSON.stringify(COVERAGE) })) })
  mock.store(on, { introDone: true })
  looks(on, [marksReply()])
  on('agent.spawn', () => ({ model: 'claude-made-up', agentId: 'agent-check-1' }) as never)
  on('ui.close', () => { w.opened.splice(0); return { value: undefined } })
  if (o.selection) on('ui.selection', () => ({ value: { text: o.selection, requestId: 'row-t1' } }) as never)
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
  await answered($, w.clock, 't1', CITED)
  // (the reminder after the answer stands in place of the bar's keys from its first drawing until it goes)
  await $.ui.render(BAND)
  await w.clock.advance(HINT_MS)
  await $.ui.render(answerRow('row-t1', CITED))
  if (o.counting) {
    hold = true
    for (let i = 0; i < 2; i++) {
      const ui = await $.ui.mount(BAND)
      await ui.press({ key: 'bar-coverage' })
      await ui.unmount()
      await w.clock.advance(500)
    }
    expect(w.opened).toEqual([])
    // long enough that the busy step shows its seconds
    await w.clock.advance(5000)
  }
  const end = async () => {
    hold = false
    ends.splice(0).forEach(done => done({ code: 0, out: JSON.stringify(COVERAGE) }))
    await w.clock.advance(1000)
  }
  return { clock: w.clock, end }
}

test("in a terminal 80 to 110 columns wide (the band 5 narrower), after an answer with marks, the bar gives way in order: coverage's file counts, the verb of ], the busy step's words, the mark's name, and only then a whole count; while a count runs and after", async ($, on) => {
  const { end } = await markedAnswer($, on, { counting: true })
  const at = async (term: number) => {
    const bar = barIn(await $.ui.render(bandIn(term)))
    expect(bar.rows.length).toBe(1)
    expect(bar.widest).toBeLessThanOrEqual(term - 5)
    return bar
  }
  // while the count runs, coverage's file counts give way and both counts stay: at 80 the busy step keeps its glyph
  // and seconds, and ] its key; at 90 ] takes back the mark's name, at 100 the busy step its first words, and at 110
  // all its words, and then ] its verb
  let bar = await at(80)
  expect(bar.left).toMatch(/^thimble {2}\S \d+s · v visualize · \] · s rewrite$/)
  expect(bar.right).toBe('r coverage 43% · l 2 labels')
  bar = await at(90)
  expect(bar.left).toMatch(/^thimble {2}\S \d+s · v visualize · \] explainer · s rewrite$/)
  expect(bar.right).toBe('r coverage 43% · l 2 labels')
  bar = await at(100)
  expect(bar.left).toMatch(/^thimble {2}\S counting… \d+s · v visualize · \] explainer · s rewrite$/)
  expect(bar.right).toBe('r coverage 43% · l 2 labels')
  bar = await at(110)
  expect(bar.left).toMatch(/^thimble {2}\S counting coverage \d+s · v visualize · \] show explainer · s rewrite$/)
  expect(bar.right).toBe('r coverage 43% · l 2 labels')
  await end()
  // after it: at 80 coverage's file counts give way first, then ]'s verb, and ] keeps the mark's name; at 100 all of
  // it is whole
  bar = await at(80)
  expect(bar.left).toBe('thimble  v visualize · ] explainer · s rewrite')
  expect(bar.right).toBe('r coverage 43% · l 2 labels')
  bar = await at(100)
  expect(bar.left).toBe('thimble  v visualize · ] show explainer · s rewrite')
  expect(bar.right).toBe('r coverage 43% (3/7 files) · l 2 labels')
})

for (const c of [
  { name: 'at rest, in a terminal 56 columns wide', term: 56, o: {} },
  { name: 'with words selected, in a terminal 77 columns wide', term: 77, o: { selection: 'the retry budget runs out' } },
  { name: 'while a count runs, in a terminal 60 columns wide', term: 60, o: { counting: true } },
]) {
  test(`${c.name} (the band 5 narrower), where coverage does not fit beside the keys, the labels' count, which is shorter, still shows, and ] gives up its words for it`, async ($, on) => {
    await markedAnswer($, on, c.o)
    const bar = barIn(await $.ui.render(bandIn(c.term)))
    expect(bar.rows.length).toBe(1)
    expect(bar.widest).toBeLessThanOrEqual(c.term - 5)
    expect(bar.right).toBe('l 2 labels')
    expect(bar.rest).toBe(']')
  })
}

test("with words of an answer with marks selected, in a terminal 80 or 100 columns wide (the band 5 narrower), the bar names e and c, and gives way in order: coverage's file counts, the verb of ], the busy step's words, the mark's name, then a whole count; in Claude Code's fullscreen layout and its default one, while a count runs and after", async ($, on) => {
  const { end } = await markedAnswer($, on, { selection: 'the retry budget runs out', counting: true })
  const seen: Record<string, ReturnType<typeof barIn>> = {}
  const all = async (when: string) => {
    for (const isFullscreen of [true, false]) {
      noteViewport({ isFullscreen })
      for (const term of [80, 100]) {
        const bar = barIn(await $.ui.render(bandIn(term, isFullscreen)))
        expect(bar.rows.length).toBe(1)
        expect(bar.widest).toBeLessThanOrEqual(term - 5)
        seen[`${when} ${isFullscreen ? 'fullscreen' : 'default'} ${term}`] = bar
      }
    }
  }
  try {
    await all('counting')
    await end()
    await all('after')
  } finally {
    noteViewport({ isFullscreen: true })
  }
  for (const layout of ['fullscreen', 'default']) {
    // while the count runs, at 80 neither count has room beside the keys, and ] takes the mark's name in the room they
    // leave; at 100 both stay, coverage's file counts gone
    expect(seen[`counting ${layout} 80`]!.left).toMatch(/^thimble {2}\S \d+s · v visualize · \] explainer · s rewrite · e explain · c cite$/)
    expect(seen[`counting ${layout} 80`]!.right).toBe('')
    expect(seen[`counting ${layout} 100`]!.left).toMatch(/^thimble {2}\S \d+s · v visualize · \] · s rewrite · e explain · c cite$/)
    expect(seen[`counting ${layout} 100`]!.right).toBe('r coverage 43% · l 2 labels')
    // after it: at 80 the labels' count gives way after coverage's file counts and ]'s words; at 100 both counts stay
    // beside `]` alone, where the mark's name does not fit: no verb stands without the name
    expect(seen[`after ${layout} 80`]!.left).toBe('thimble  v visualize · ] · s rewrite · e explain · c cite')
    expect(seen[`after ${layout} 80`]!.right).toBe('r coverage 43%')
    expect(seen[`after ${layout} 100`]!.left).toBe('thimble  v visualize · ] · s rewrite · e explain · c cite')
    expect(seen[`after ${layout} 100`]!.right).toBe('r coverage 43% · l 2 labels')
  }
})

/** The look of a bar item's key and of its words (the props of their Texts), in a drawing of the band. */
function lookOf(band: Any, id: string): { key: Any; words: Any } | null {
  const b = byKey(band, `bar-${id}`)
  if (!b) return null
  const kids = (n: Any): Any[] => (!n || typeof n !== 'object' ? [] : Array.isArray(n) ? n.flatMap(kids) : [n, ...kids(n.props?.children), ...kids(n.children)])
  const texts = kids(b).filter(n => n.type === 'Text')
  const props = (n: Any) => { if (!n) return null; const { key: _key, children: _children, ...rest } = n.props; return rest }
  return { key: props(texts.find(n => /^\S$/.test(textOf(n)))), words: props(texts.find(n => textOf(n).startsWith(' '))) }
}

/** The look of the words `what` in a bar item (the props of their Text), in a drawing of the band; null when the item
 *  does not draw them apart. */
function namedLook(band: Any, id: string, what: string): Any {
  const b = byKey(band, `bar-${id}`)
  const kids = (n: Any): Any[] => (!n || typeof n !== 'object' ? [] : Array.isArray(n) ? n.flatMap(kids) : [n, ...kids(n.props?.children), ...kids(n.children)])
  const t = kids(b).find(n => n.type === 'Text' && textOf(n) === what)
  if (!t) return null
  const { key: _key, children: _children, ...rest } = t.props
  return rest
}

test("once each of the answer's marks was opened, the bar's ] looks like its other keys, `]` alone too, never dimmer, but for the mark's name, which keeps the mark's look; while one is not opened its verb is lit, in a terminal 80 or 105 columns wide and a wide one", async ($, on) => {
  const { clock } = await markedAnswer($, on, { selection: 'the retry budget runs out' })
  const looks = async () => {
    const out: Record<number, { rest: string | null; it: Any; v: Any; named: Any }> = {}
    for (const term of [80, 105, 160]) {
      const band = await $.ui.render(bandIn(term))
      out[term] = { rest: barIn(band).rest, it: lookOf(band, 'tray-next'), v: lookOf(band, 'v'), named: namedLook(band, 'tray-next', 'explainer') }
    }
    return out
  }
  // with words selected the band 75 wide keeps `]` alone, 100 wide `] explainer`
  const lit = await looks()
  expect([80, 105, 160].map(t => lit[t]!.rest)).toEqual([']', '] explainer', '] show explainer'])
  for (const t of [80, 105, 160]) expect(lit[t]!.it.key).toEqual(lit[t]!.v.key)
  for (const t of [105, 160]) expect(lit[t]!.it.words).toEqual({ color: accent() })
  // the mark's name on the explainers' teal, in the text's own color, as an explainer's words in the reply
  for (const t of [105, 160]) expect(lit[t]!.named).toEqual({ backgroundColor: markColors(themeLast()).glossBg })
  // ] from rest, then on to the citation and the heads-up: each mark of the answer opened
  for (const k of [']', ']', ']', '0']) {
    await $.prompt.edit({ origin: { kind: 'composer' }, key: { key: k }, text: '', cursor: 0, start: 0, end: 0, inputText: k } as never)
    await clock.advance(1000)
  }
  const seen = await looks()
  expect([80, 105, 160].map(t => seen[t]!.rest)).toEqual([']', '] explainer', '] show explainer'])
  for (const t of [80, 105, 160]) {
    expect(seen[t]!.it.key).toEqual(seen[t]!.v.key)
    expect(seen[t]!.it.key).toMatchObject({ color: accent(), bold: true })
    expect(seen[t]!.it.key.dimColor).toBeUndefined()
  }
  for (const t of [105, 160]) expect(seen[t]!.it.words).toEqual(seen[t]!.v.words)
  for (const t of [105, 160]) expect(seen[t]!.named).toEqual({ backgroundColor: markColors(themeLast()).glossBg })
})

test("while the answer's citation is checked, the bar names it in a citation's look, and its tray says checking beside the turning glyph the reply draws after its words, the same frame in thimble's color", async ($, on) => {
  const { clock } = await markedAnswer($, on)
  const press = async (k: string) => {
    await $.prompt.edit({ origin: { kind: 'composer' }, key: { key: k }, text: '', cursor: 0, start: 0, end: 0, inputText: k } as never)
    await clock.advance(1000)
  }
  const kids = (n: Any): Any[] => (!n || typeof n !== 'object' ? [] : Array.isArray(n) ? n.flatMap(kids) : [n, ...kids(n.props?.children), ...kids(n.children)])
  const glyphs = new RegExp(`^ ?[${SPIN}]$`)
  // the reply: the citation's words underlined, and the turning glyph after them, in thimble's color
  const reply = kids(await $.ui.render(answerRow('row-t1', CITED)))
  expect(reply.find(n => n.type === 'Text' && textOf(n) === '41 of the 44 failures')?.props).toMatchObject({ underline: true })
  const spin = reply.find(n => n.type === 'Text' && glyphs.test(textOf(n)))
  expect(spin?.props).toMatchObject({ color: accent() })
  // ] opens the explainer, the answer's first mark; at rest again the bar names the citation, underlined as its words
  await press(']')
  await press('0')
  const bar = await $.ui.render(bandAt(140))
  expect(textOf(byKey(bar, 'bar-tray-next'))).toBe('] next citation')
  expect(namedLook(bar, 'tray-next', 'citation')).toEqual({ underline: true })
  // ] opens the citation: its header says checking beside the glyph, the reply's frame, in thimble's color
  await press(']')
  const band = await $.ui.render(BAND)
  const head = byKey(band, 'tray-head')
  expect(textOf(head)).toMatch(new RegExp(`41 of the 44 failures[${SPIN}] checking {2}a ask`))
  const sign = kids(head).find(n => n.type === 'Text' && glyphs.test(textOf(n)))
  expect(sign?.props).toMatchObject({ color: accent() })
  expect(textOf(sign)).toBe(textOf(spin).trim())
  expect(kids(head).find(n => n.type === 'Text' && textOf(n) === ' checking')?.props).toMatchObject({ dimColor: true })
  expect(textOf(band)).toContain('The check is running.')
})

test('a session after the one whose first prompt took the line starts without it, and the bar is the only row with keys', async ($, on) => {
  world(on, { ok: true, out: JSON.stringify(COVERAGE) })
  mock.store(on, { introDone: true })
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
  expect(textOf(await $.ui.render(BAND))).not.toContain(INTRO)
})

test('a how-to hint shows until the session used its feature; then it stays away', async () => {
  const state: Record<string, unknown> = {}
  const $: Any = { ...stateOnly(state), ui: { invalidate: () => undefined } }
  await howTo($, 'explain', 'select a passage in an answer and press e to explain it.', 'explain')
  await new Promise(r => setTimeout(r, 5))
  expect(String((await failLineNow($))?.text)).toBe('select a passage in an answer and press e to explain it.')
  await hintsGone($)
  await hintUsed($, 'explain')
  await howTo($, 'explain', 'select a passage in an answer and press e to explain it.', 'explain')
  await new Promise(r => setTimeout(r, 5))
  expect(await failLineNow($)).toBe(null)
  // another feature's hint still shows
  await howTo($, 'cite', 'select a passage in an answer and press c to verify the claim.', 'cite')
  await new Promise(r => setTimeout(r, 5))
  expect(String((await failLineNow($))?.text)).toContain('press c to verify')
})

test('after each answer one reminder of a feature on demand the session has not used; each once a session, none for auto or off', async () => {
  const state: Record<string, unknown> = {}
  const $: Any = { ...stateOnly(state), ui: { invalidate: () => undefined } }
  const answer = async (): Promise<string | null> => {
    await hintsGone($)
    await remindAfterAnswer($)
    await new Promise(r => setTimeout(r, 5))
    const line = await failLineNow($)
    return line ? String(line.text) : null
  }
  setOptions({ explain: 'on demand', details: 'on demand', citations: 'manual', squeezeAnswers: true })
  try {
    expect(await answer()).toBe('select a passage in an answer and press e to explain it.')
    // h is used before its turn comes: the next answer skips it
    await hintUsed($, 'heads')
    expect(await answer()).toBe('select a passage in an answer and press c to verify the claim.')
    expect(await answer()).toBe('press s to rewrite the last answer shorter or longer, more novice or more expert.')
    // each was reminded once: no more this session
    expect(await answer()).toBe(null)
    // a failure showing stays; no reminder replaces it
    for (const k of Object.keys(state)) delete state[k]
    failNotice($, 'The card did not draw.')
    await remindAfterAnswer($)
    expect(String((await failLineNow($))?.text)).toBe('The card did not draw.')
    // auto and off: nothing to remind of but the rewrite
    for (const k of Object.keys(state)) delete state[k]
    setOptions({ explain: 'auto', details: 'off', citations: 'auto cite', squeezeAnswers: true })
    expect(await answer()).toBe('press s to rewrite the last answer shorter or longer, more novice or more expert.')
    expect(await answer()).toBe(null)
  } finally {
    setOptions({})
  }
})
