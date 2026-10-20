// Coverage and the label viewer (shell/dock.ts, panes/coverage.js, panes/labels.js) in the side panel: the bar's right
// side names the coverage, with a small bar of the folder's file types, and the labels once the folder has some; a click
// on either, or r and l from the empty prompt (once a moment passed with no letter after them), opens its pane in the
// side panel as a thread; the pane's keys reach its program; a number key in the label viewer is the person's check of
// the record shown; ↵ on a read range or a record opens it as a citation over the pane; a question typed under either
// pane goes to its thread, about the part selected. `claude plugin test plugin`. The kernel is answered at process.run.
import { expect, mock, test } from 'claude-code/testing'

import { press, promptStub } from './stubs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
const ROOT = '/data'
const ROW = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const OBJECT = { id: '01-saves', version: 1, title: 'Saves per day', program: 'return k.text("x")', data: {}, lineage: { cites: [] } }
const DRAWING = { kit: 1, w: 40, h: 2, mode: 'inline', root: { t: 'text', runs: [{ s: 'saves', tone: 'ink' }] }, cites: {}, examples: {}, regions: [], warnings: [], ms: 1 }
const file = (path: string, type: string, pattern: string, status: string, o: Record<string, unknown> = {}) => ({ path, type, pattern, group: pattern, rows: 300, lines: 300, status, share: 0, read_lines: 0, ranges: [], hit_lines: [], hits: 0, by: [], searched_by: [], queries: [], computed: 0, shown: 0, ...o })
const COVERAGE = {
  session: 's-1',
  files: [file('runs/r1.jsonl', 'jsonl', 'runs/*.jsonl', 'read', { share: 0.34, read_lines: 102, ranges: [[1, 102]] }), file('runs/r2.jsonl', 'jsonl', 'runs/*.jsonl', 'named', { by: ['wc'] })],
  patterns: [{ pattern: 'runs/*.jsonl', files: 2, rows: 600, read_rows: 102, by_status: { read: 1, named: 1 } }],
  types: [{ type: 'jsonl', files: 2, rows: 600, read_rows: 102, by_status: { read: 1, named: 1 } }],
  total: { files: 2, rows: 600, read_rows: 102, read_share: 102 / 600 },
}
const LABELS = [
  { name: 'apology', kind: 'prompt', rule: 'Does the agent apologize?', values: ['yes', 'no'], in: 'chat/*.jsonl', version: 1, records: 3, waiting: 0, failed: 0, checked: 0, agree: 0, disagree: 0, counts: { yes: 1, no: 2 }, query: 'r1' },
  { name: 'fails', kind: 'regex', rule: 'fail', values: ['fail', 'pass'], in: 'runs/*.log', version: 1, records: 4, waiting: 0, failed: 0, checked: 0, counts: { fail: 1, pass: 3 } },
]
const RECORDS = [
  { ref: 'chat/room.jsonl#L1', i: 0, value: 'yes', by: 'model', confidence: 0.9, words: 'Sorry, I broke it.', text: 'Sorry, I broke it.' },
  { ref: 'chat/room.jsonl#L2', i: 1, value: 'no', by: 'model', confidence: 0.8, words: 'Merged.', text: 'Merged.' },
]
const RESOLVED = { ref: 'chat/room.jsonl#L2', chain: [], rows: ['chat/room.jsonl#L2'], count: 1, records: [{ ref: 'chat/room.jsonl#L2', text: 'Merged.' }], notes: [] }

function world(on: Any) {
  mock.env(on, { THIMBLE_HOME: '/home/t/.thimble' })
  on('turn.start', (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.cwd', () => ({ value: ROOT }))
  on('session.id', () => ({ value: 's-1' }))
  const files: Record<string, string> = { [`${ROOT}/thimble/objects/01-saves.json`]: JSON.stringify(OBJECT) }
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: e.path in files || e.path === `${ROOT}/thimble/objects` }))
  // two labels in the folder
  on('fs.list', (_$: unknown, e: { path?: string }) => ({ value: e.path === `${ROOT}/thimble/labels` ? [{ name: 'apology.json', kind: 'file' }, { name: 'fails.json', kind: 'file' }, { name: '.apology.lock', kind: 'file' }] : [] }))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: files[e.path] ?? promptStub(e.path) ?? '' }))
  on('fs.write', (_$: unknown, e: { path: string; content?: string; text?: string; data?: string }) => { files[e.path] = String(e.content ?? e.text ?? e.data ?? ''); return { value: undefined } })
  const runs: string[][] = []
  on('process.run', (_$: unknown, e: { argv: string[] }) => {
    runs.push([...e.argv])
    const a = e.argv
    let out: unknown = {}
    if (a.some(x => x.endsWith('prep.mjs'))) out = { drawing: DRAWING }
    else if (a.includes('coverage')) out = COVERAGE
    else if (a.includes('resolve')) out = RESOLVED
    else if (a[1] === 'label' && a.includes('--records')) out = { label: LABELS[0], value: null, at: 0, total: 3, records: RECORDS }
    else if (a[1] === 'label' && a.includes('--check')) out = { ref: a[a.indexOf('--check') + 1], was: 'yes', now: a[a.indexOf('--check') + 2], ...LABELS[0] }
    else if (a[1] === 'label' && a[2] === '--json') out = LABELS
    else if (a[1] === 'label' && a.includes('--json')) out = { ...LABELS[0], card: 'label-apology', card_version: 2 }
    else if (a[0] === 'awk') return { value: { exitCode: 0, stdout: Array.from({ length: 30 }, (_, i) => `{"n": ${i + 1}}`).join('\n') + '\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const opened: Any[] = []
  on('ui.open', (_$: unknown, e: Any) => { opened.push(e); return { value: { isPlaced: true } } })
  on('ui.focus', () => ({ value: {} }))
  const closed: string[] = []
  on('ui.close', (_$: unknown, e: { id: string }) => { closed.push(e.id); return { value: undefined } })
  on('ui.panes', () => ({ value: opened.length ? [{ id: 'object', title: 'Coverage', isShown: true, isFocused: true, isPlaced: true, plugin: 'thimble' }] : [] }))
  on('ui.view', () => ({ value: {} }))
  on('prompt.edit', (_$: unknown, e: { text: string; start: number; end: number; inputText: string }) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
  on('prompt.fill', () => ({ isFilled: true }))
  const submitted: { text: string; context: readonly string[] }[] = []
  on('prompt.submit', (_$: unknown, e: { text: string; context?: readonly string[] }) => { submitted.push({ text: e.text, context: e.context ?? [] }); return { text: e.text } })
  // a pane's thread: its agent's first prompt is what a test reads
  const spawns: Any[] = []
  on('agent.register', () => ({ value: { agent: 'thimble:thread' } }))
  on('agent.spawn', (_$: unknown, e: Any) => { spawns.push(e); return { model: 'claude-test', agentId: `agent-${spawns.length}` } as never })
  on('agent.list', () => ({ value: spawns.map((_, i) => ({ id: `agent-${i + 1}`, type: 'thimble:thread', description: 'thread', status: 'running' })) }))
  on('session.messages', () => ({ value: [] }))
  on('config.list', () => ({ value: [] }))
  on('ui.toast', () => ({ value: undefined }))
  return { runs, files, opened, submitted, spawns, closed }
}

function textOf(n: Any): string {
  if (n == null || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  return textOf(n.props?.children) + textOf(n.children)
}
function walk(n: Any, f: (x: Any) => void): void {
  if (n == null || typeof n !== 'object') return
  if (Array.isArray(n)) { n.forEach(x => walk(x, f)); return }
  f(n)
  walk(n.props?.children, f)
  walk(n.children, f)
}
const HINT = { plugin: 'thimble', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows: 16, bodyColumns: 200, scroll: { offset: 0, bodyRows: 16 }, view: {} }, viewport: { columns: 200, rows: 48, isFullscreen: true } } as never
const PANEL = { plugin: 'thimble', component: 'Pane', surface: 'terminal', requestId: 'object', props: { bodyColumns: 100, scroll: { bodyRows: 50, offset: 0 }, isFocused: true, placement: 'dock', title: 'Coverage', view: {} } } as never
const edit = (key: string, text = '') => ({ origin: { kind: 'composer' }, key: { key }, text, cursor: text.length, start: text.length, end: text.length, inputText: key.length === 1 ? key : '' }) as never
/** A key pressed in the panel, then the moment in which a letter would make it the start of a question passed. */
const key = async ($: Any, clock: Any, k: string) => { const r = await press($, clock, edit(k)); await clock.advance(800); await clock.settle(); return r }
const panel = async ($: Any, clock: { settle: () => Promise<void> }) => { for (let i = 0; i < 3; i++) { await $.ui.render(PANEL); await clock.settle() } return textOf(await $.ui.render(PANEL)) }
/** The panel's title as its last open with a title named it (an open with none takes the keys back). */
const titled = (w: { opened: Any[] }) => [...w.opened].reverse().find(o => o.title)
const askKeyOf = async ($: Any) => /"key":"(ask-\d+)"/.exec(JSON.stringify(await $.ui.render(PANEL)))?.[1] ?? ''

async function turn($: Any, on: Any, clock: { settle: () => Promise<void> }) {
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the reply'] }) as never)
  on('tool.call', () => ({ result: 'ok' }))
  await $.turn.start({ turnId: 't1', text: 'what did you read?' } as never)
  await $.session.append({ door: 'response', uuid: ROW, origin: { kind: 'model', model: 'm' }, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'I read one run.' }] } } as never)
  await $.turn.complete({ turnId: 't1', answer: 'I read one run.', durationMs: 5, reason: 'answer', isAborted: false } as never)
  await clock.settle()
}

test('the bar names the coverage with a small bar of its file types and the labels, each with its key; a click on coverage opens Coverage in the side panel, its keys reach it, a question goes to its thread, and ↵ on a read range opens it as a citation', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  await turn($, on, clock)
  const bar = await $.ui.render(HINT)
  expect(textOf(bar)).toContain('r coverage 17% ████████ · l 2 labels')
  // the small bar: the jsonl type's read part bright, the rest pale
  const cells: string[] = []
  walk(bar, x => { if (x.type === 'Text' && /^█+$/.test(textOf(x))) cells.push(String(x.props?.color)) })
  expect(cells.length).toBe(2)
  expect(cells[0]).not.toBe(cells[1])
  // a click on the coverage count opens the pane in the side panel, with the keys
  const band = await $.ui.mount({ ...(HINT as Any) } as never)
  await band.press({ key: 'count-cov' })
  await clock.settle()
  expect(titled(w)).toMatchObject({ id: 'object', title: 'Coverage', focus: true })
  const drawn = await panel($, clock)
  expect(drawn).toContain('Coverage of this session · 2 files · 600 rows')
  expect(drawn).toContain('runs/*.jsonl')
  // the panel's input bar is under it, about the group selected
  expect(JSON.stringify(await $.ui.render(PANEL))).toContain('Ask about runs/*.jsonl')
  // t is the pane's: it groups the files by type, and never reaches the prompt
  expect(await key($, clock, 't')).toEqual({ text: '', cursor: 0 })
  expect(await panel($, clock)).toContain('▸ jsonl')
  await key($, clock, 't')
  // ↵ opens the group, then its first file: the file's read lines
  await key($, clock, 'return')
  await panel($, clock)
  await key($, clock, 'return')
  const fileView = await panel($, clock)
  expect(fileView).toContain('read  rows 1–102')
  expect(fileView).toContain('1 ▌{"n": 1}')
  // the file's lines were the person's read, never Claude's
  expect(w.runs.some(r => r[0] === 'awk' && r.includes('/data/runs/r1.jsonl'))).toBe(true)
  // a question typed under it goes to the pane's thread, about the read range selected and carrying its ref
  const ui = await $.ui.mount({ ...(PANEL as Any) } as never)
  await ui.input({ key: await askKeyOf($), text: 'why only the first 102 rows?' })
  await clock.settle()
  expect(w.spawns.length).toBe(1)
  const prompt = String(w.spawns[0].prompt)
  expect(prompt).toMatch(/^why only the first 102 rows\?/)
  expect(prompt).toContain('runs/r1.jsonl: read rows 1 to 102')
  expect(prompt).toContain('what this session read of the folder, by `thimble coverage`: 2 source files, 102 of 600 rows read (17%)')
  expect(prompt).toContain('runs/r1.jsonl#L1-102')
  expect(w.submitted.length).toBe(0)
  // ↵ on the range: its lines as a citation, over the pane in the panel
  await key($, clock, 'return')
  await panel($, clock)
  expect(String(titled(w)?.title)).toContain('runs/r1.jsonl lines 1–102')
})

test('l opens the label viewer in the side panel; a number key checks the record shown, as the person; a question asks its thread; a click on the bar closes it', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  await turn($, on, clock)
  await $.ui.render(HINT)
  // l acts once a moment passed with no letter after it (as t does)
  expect(await press($, clock, edit('l'))).toEqual({ text: '', cursor: 0 })
  await clock.advance(700)
  await clock.settle()
  expect(titled(w)).toMatchObject({ id: 'object', title: 'Labels', focus: true })
  const list = await panel($, clock)
  expect(list).toContain('Labels · 2 in this folder')
  expect(list).toContain('● yes 1   ● no 2')
  // 1 opens the first label: its records are a page the kernel reads for the person
  await key($, clock, '1')
  const one = await panel($, clock)
  expect(one).toContain('made by    a model, reading each record against the definition')
  expect(one).toContain('room.jsonl:1')
  expect(w.runs.some(r => r[1] === 'label' && r[2] === 'apology' && r.includes('--records'))).toBe(true)
  expect(textOf(await $.ui.render(HINT))).toContain('[ ] record · 1 yes · 2 no · f filter')
  // 2: the person says the record shown is no
  expect(await key($, clock, '2')).toEqual({ text: '', cursor: 0 })
  expect(w.runs.some(r => r[1] === 'label' && r[2] === 'apology' && r.includes('--check') && r.includes('chat/room.jsonl#L1') && r.includes('no'))).toBe(true)
  // a question typed under it: about the record selected, with what the label is
  await panel($, clock)
  const ui = await $.ui.mount({ ...(PANEL as Any) } as never)
  await ui.input({ key: await askKeyOf($), text: 'is this one really no?' })
  await clock.settle()
  const prompt = String(w.spawns[0].prompt)
  expect(prompt).toMatch(/^is this one really no\?/)
  expect(prompt).toContain('a record of apology, room.jsonl:2')
  expect(prompt).toContain('the label apology, made by a model, reading each record against the definition, over chat/*.jsonl')
  expect(prompt).toContain('chat/room.jsonl#L2')
  // a click on the bar's labels closes the viewer (inside it, a letter starts a question); the panel's close then has
  // Claude hear of the checks (labels.ts checksDone, as for the card detail)
  await panel($, clock)
  const band = await $.ui.mount({ ...(HINT as Any) } as never)
  await band.press({ key: 'count-labels' })
  await clock.settle()
  expect(w.closed).toEqual(['object'])
})

test('l then a letter at once is a word: both letters stay in the prompt and no panel opens', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  await turn($, on, clock)
  await $.ui.render(HINT)
  expect(await press($, clock, edit('l'))).toEqual({ text: '', cursor: 0 })
  expect(await press($, clock, edit('o'))).toEqual({ text: 'lo', cursor: 2 })
  await clock.advance(800)
  await clock.settle()
  expect(w.opened.length).toBe(0)
})
