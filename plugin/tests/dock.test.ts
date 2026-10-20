// Coverage and the label viewer (shell/dock.ts, panes/coverage.js, panes/labels.js): the bar's right side names the
// coverage, with a small bar of the folder's file types, and the labels once the session has some; a click on either,
// or r and l from the empty prompt, docks its pane where the card detail docks; the pane's keys reach its program; a
// number key in the label viewer is the person's check of the record shown; esc goes back, then closes; a letter typed
// at once after r or l is a word. `claude plugin test plugin`. The kernel is answered here, at process.run.
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
  { name: 'apology', kind: 'prompt', rule: 'Does the agent apologize?', values: ['yes', 'no'], in: 'chat/*.jsonl', version: 1, records: 3, waiting: 0, failed: 0, checked: 0, agree: 0, disagree: 0, counts: { yes: 1, no: 2 } },
  { name: 'fails', kind: 'regex', rule: 'fail', values: ['fail', 'pass'], in: 'runs/*.log', version: 1, records: 4, waiting: 0, failed: 0, checked: 0, counts: { fail: 1, pass: 3 } },
]
const RECORDS = [
  { ref: 'chat/room.jsonl#L1', i: 0, value: 'yes', by: 'model', confidence: 0.9, words: 'Sorry, I broke it.', text: 'Sorry, I broke it.' },
  { ref: 'chat/room.jsonl#L2', i: 1, value: 'no', by: 'model', confidence: 0.8, words: 'Merged.', text: 'Merged.' },
]

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
  on('process.run', (_$: unknown, e: { argv: string[]; init?: { stdin?: string } }) => {
    runs.push([...e.argv])
    const a = e.argv
    let out: unknown = {}
    if (a.some(x => x.endsWith('prep.mjs'))) out = { drawing: DRAWING }
    else if (a.includes('coverage')) out = COVERAGE
    else if (a[1] === 'label' && a.includes('--records')) out = { label: LABELS[0], value: null, at: 0, total: 3, records: RECORDS }
    else if (a[1] === 'label' && a.includes('--check')) out = { ref: a[a.indexOf('--check') + 1], was: 'yes', now: a[a.indexOf('--check') + 2], ...LABELS[0] }
    else if (a[1] === 'label' && a[2] === '--json') out = LABELS
    else if (a[1] === 'label' && a.includes('--json')) out = { ...LABELS[0], card: 'label-apology', card_version: 2 }
    else if (a[0] === 'awk') return { value: { exitCode: 0, stdout: Array.from({ length: 30 }, (_, i) => `{"n": ${i + 1}}`).join('\n') + '\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const opened: Any[] = []
  const closed: string[] = []
  on('ui.open', (_$: unknown, e: Any) => { opened.push(e); return { value: { isPlaced: true } } })
  on('ui.close', (_$: unknown, e: { id: string }) => { closed.push(e.id); return { value: undefined } })
  on('ui.focus', () => ({}))
  on('ui.panes', () => ({ value: [] }))
  const submitted: { text: string; context: readonly string[] }[] = []
  on('prompt.submit', (_$: unknown, e: { text: string; context?: readonly string[] }) => { submitted.push({ text: e.text, context: e.context ?? [] }); return { text: e.text } })
  on('prompt.edit', (_$: unknown, e: { text: string; start: number; end: number; inputText: string }) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
  on('ui.toast', () => ({ value: undefined }))
  return { runs, files, opened, closed, submitted }
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
const pane = (id: string) => ({ plugin: 'thimble', component: 'Pane', surface: 'terminal', requestId: id, props: { bodyColumns: 100, scroll: { bodyRows: 40, offset: 0 }, isFocused: true, placement: 'dock', title: id, view: {} } }) as never
const edit = (key: string, text = '') => ({ origin: { kind: 'composer' }, key: { key }, text, cursor: text.length, start: text.length, end: text.length, inputText: key.length === 1 ? key : '' }) as never

async function turn($: Any, on: Any, clock: { settle: () => Promise<void> }) {
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the reply'] }) as never)
  on('tool.call', () => ({ result: 'ok' }))
  await $.turn.start({ turnId: 't1', text: 'what did you read?' } as never)
  await $.session.append({ door: 'response', uuid: ROW, origin: { kind: 'model', model: 'm' }, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'I read one run.' }] } } as never)
  await $.turn.complete({ turnId: 't1', answer: 'I read one run.', durationMs: 5, reason: 'answer', isAborted: false } as never)
  await clock.settle()
}

test('the bar names the coverage with a small bar of its file types and the labels, each with its key; a click on coverage docks Coverage beside the chat, and its keys reach it', async ($, on) => {
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
  // a click on the coverage count docks the pane, with the keys
  const band = await $.ui.mount({ ...(HINT as Any) } as never)
  await band.press({ key: 'count-cov' })
  await clock.settle()
  expect(w.opened.at(-1)).toMatchObject({ id: 'coverage', title: 'Coverage', focus: true, closeOnEscape: true })
  await $.ui.render(pane('coverage'))
  await clock.settle()
  const drawn = textOf(await $.ui.render(pane('coverage')))
  expect(drawn).toContain('Coverage of this session · 2 files · 600 rows')
  expect(drawn).toContain('runs/*.jsonl')
  // the bar names the pane's keys while it has the focus
  expect(textOf(await $.ui.render(HINT))).toContain('[ ] step · t by type · esc close')
  // t is the pane's: it groups the files by type, and never reaches the prompt
  expect(await press($, clock, edit('t'))).toEqual({ text: '', cursor: 0 })
  expect(textOf(await $.ui.render(pane('coverage')))).toContain('▸ jsonl')
  // ↵ on the group (a press on its row), then on its first file: the file's read lines, with a link that opens it
  await press($, clock, edit('t'))
  const cov = await $.ui.mount({ ...(pane('coverage') as Any) } as never)
  const draw = async () => { for (let i = 0; i < 3; i++) { await cov.redraw(); await clock.settle() } }
  await draw()
  await cov.press({ key: 'r|p-coverage|~|g-0' })
  await draw()
  await cov.press({ key: 'r|p-coverage|~|f-0' })
  await draw()
  const fileView = await cov.drawn()
  expect(textOf(fileView)).toContain('read  rows 1–102')
  expect(textOf(fileView)).toContain('1 ▌{"n": 1}')
  const links: string[] = []
  walk(fileView, x => { if (x.type === 'Markdown') links.push(x.props.text) })
  expect(links).toEqual(['↗ [runs/r1.jsonl:1](file:///data/runs/r1.jsonl#L1)'])
  // the file's lines were the person's read, never Claude's: no thimble call of the pane counts as Claude's coverage
  expect(w.runs.some(r => r[0] === 'awk' && r.includes('/data/runs/r1.jsonl'))).toBe(true)
})

test('l opens the label viewer; a number key checks the record shown, as the person; Claude hears of the checks with the next prompt; a letter at once after l is a word', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  await turn($, on, clock)
  await $.ui.render(HINT)
  expect(await press($, clock, edit('l'))).toEqual({ text: '', cursor: 0 })
  expect(w.opened.at(-1)).toMatchObject({ id: 'labels', title: 'Labels', focus: true })
  await $.ui.render(pane('labels'))
  await clock.settle()
  const list = textOf(await $.ui.render(pane('labels')))
  expect(list).toContain('Labels · 2 in this folder')
  expect(list).toContain('● yes 1   ● no 2')
  // 1 opens the first label: its records are a page the kernel reads for the person
  await press($, clock, edit('1'))
  await $.ui.render(pane('labels'))
  await clock.settle()
  const one = textOf(await $.ui.render(pane('labels')))
  expect(one).toContain('made by    a model, reading each record against the definition')
  expect(one).toContain('room.jsonl:1')
  expect(w.runs.some(r => r[1] === 'label' && r[2] === 'apology' && r.includes('--records'))).toBe(true)
  expect(textOf(await $.ui.render(HINT))).toContain('[ ] record · 1 yes · 2 no · f filter · esc back')
  // 2: the person says the record shown is no
  expect(await press($, clock, edit('2'))).toEqual({ text: '', cursor: 0 })
  expect(w.runs.some(r => r[1] === 'label' && r[2] === 'apology' && r.includes('--check') && r.includes('chat/room.jsonl#L1') && r.includes('no'))).toBe(true)
  // 0 goes back to the list; Claude hears of the check with the next prompt
  await press($, clock, edit('0'))
  expect(textOf(await $.ui.render(pane('labels')))).toContain('Labels · 2 in this folder')
  await $.prompt.submit({ text: 'and now?', origin: { kind: 'composer' } } as never)
  expect(w.submitted.at(-1)!.context.join('\n')).toContain('The analyst checked 1 record of the label apology')
  // l again closes the viewer (its key named in the bar); then l and a letter at once: the word "lo", and the viewer
  // closes again
  expect(await press($, clock, edit('l'))).toEqual({ text: '', cursor: 0 })
  expect(w.closed.at(-1)).toBe('labels')
  // a drawing of the pane after its close (Claude Code may draw a closing pane once more) never brings its keys back
  await $.ui.render(pane('labels'))
  await clock.settle()
  expect(textOf(await $.ui.render(HINT))).not.toContain('open a label')
  w.closed.length = 0
  expect(await press($, clock, edit('l'))).toEqual({ text: '', cursor: 0 })
  expect(w.opened.at(-1)).toMatchObject({ id: 'labels' })
  expect(await press($, clock, edit('o'))).toEqual({ text: 'lo', cursor: 2 })
  expect(w.closed.at(-1)).toBe('labels')
})
