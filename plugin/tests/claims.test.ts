// Claims in a session (claims/, shell/panes.ts): after two turns of work, c opens the Claims pane with the ring on the
// selected dot rather than on the input bar, so the first arrow walks the claims from it, and a letter still starts a
// question. Coverage (r) opens the same way, on its selected group, so ↵ opens its files. `claude plugin test plugin`.
// The model's calls and the Node children are answered here.
import { expect, mock, test } from 'claude-code/testing'

import { press, promptStub } from './stubs'

const ROOT = '/data'
const USAGE = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 }
const NOW = Date.parse('2026-10-18T09:00:00Z')
const U1 = '1a1a1a1a-aaaa-bbbb-cccc-000000000001'
const R1 = '2a2a2a2a-aaaa-bbbb-cccc-000000000001'
const U2 = '1b1b1b1b-aaaa-bbbb-cccc-000000000002'
const R2 = '2b2b2b2b-aaaa-bbbb-cccc-000000000002'

const Q1 = 'was there any bias in the edits over time? who drove it?'
const A1 = 'Yes. The tilt is one editor. Kestrel made [41%](q4#user=Kestrel@share) of June\'s edits, and [212 of them](q7#user=Kestrel@n) were reverts. June 18 had [6,543 saves](q1#day=2026-06-18@n), the busiest day.'
const FORK1 = { notes: [], verbs: {}, glosses: [], claims: [
  { quote: 'The tilt is one editor', claim: 'The tilt in the edits is one editor', cluster: 'testing for bias' },
  { quote: "Kestrel made 41% of June's edits, and 212 of them were reverts", claim: "Kestrel made 41% of June's edits, 212 of them reverts", cluster: 'finding who edited' },
  { quote: 'June 18 had 6,543 saves', cluster: 'the June 18 burst' },
] }
const Q2 = "I'm going to tell my manager the tilt is one editor. Anything to fix?"
const A2 = 'Fix one thing: it is two editors, not one. Kestrel and Wren made [63%](q8#user=top2@share) of the tilt. The June 18 burst, [6,543 saves](q1#day=2026-06-18@n), stands.'
const FORK2 = { notes: [], verbs: {}, glosses: [], claims: [
  { same: 'c1', quote: 'the tilt is one editor', by: 'analyst' },
  { quote: 'it is two editors, not one', claim: 'The tilt is two editors, Kestrel and Wren, not one', revises: 'c1', links: [{ to: 'c2', how: 'same topic' }] },
  { same: 'c3', quote: 'The June 18 burst, 6,543 saves, stands' },
] }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

function world(on: Any, forks: Record<string, unknown>[], o: { cov?: unknown } = {}) {
  mock.env(on, { THIMBLE_HOME: '/home/t/.thimble' })
  mock.store(on)
  on('session.cwd', () => ({ value: ROOT }))
  on('session.id', () => ({ value: 's-1' }))
  on('session.messages', () => ({ value: [] }))
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  const files: Record<string, string> = {}
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: e.path in files || e.path === `${ROOT}/thimble/objects` || e.path.endsWith('.md') }))
  on('fs.list', () => ({ value: [] }))
  on('fs.stat', (_$: unknown, e: { path: string }) => (e.path in files ? { value: { kind: 'file', size: files[e.path]!.length, mtimeMs: 0 } } : { value: { kind: 'missing', size: 0, mtimeMs: 0 } }) as never)
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: files[e.path] ?? promptStub(e.path) ?? '' }))
  on('fs.write', (_$: unknown, e: { path: string; content?: string; text?: string; data?: string }) => {
    files[e.path] = String(e.content ?? e.text ?? e.data ?? '')
    return { value: undefined }
  })
  const runs: string[][] = []
  on('process.run', (_$: unknown, e: { argv: string[] }) => {
    runs.push([...e.argv])
    let out = '{}'
    if (e.argv.some(a => a.endsWith('estimate.mjs'))) out = JSON.stringify({ kind: 'runs', offer: { what: '3 trials', minutes: 4, tokens: 310000, read: 'trials/', detail: '3 transcripts · 2 KB' } })
    else if (e.argv.some(a => a.endsWith('objects.mjs'))) out = '[]'
    else if (e.argv.includes('coverage')) out = e.argv.includes('--json') ? JSON.stringify(o.cov ?? {}) : 'Coverage of this session · 4 source files'
    else if (e.argv.includes('resolve')) out = JSON.stringify({ ref: e.argv[e.argv.indexOf('resolve') + 1], chain: [{ step: 'query', id: 'q4', about: 'share by user', value: '41%' }], rows: ['revisions.jsonl#L28-31'], count: 4, records: [{ ref: 'revisions.jsonl#L28', text: 'Kestrel saved Lexicon' }], notes: [] })
    else if (e.argv.some(a => a.endsWith('prep.mjs'))) out = JSON.stringify({ drawing: { kit: 1, w: 40, h: 1, root: { t: 'text', runs: [{ s: 'rows', tone: 'ink' }] }, cites: {}, examples: {}, regions: [], warnings: [] } })
    return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const opened: Record<string, unknown>[] = []
  on('ui.open', (_$: unknown, e: Record<string, unknown>) => { opened.push(e); return { value: { isPlaced: true } } })
  const focused: string[] = []
  on('ui.focus', (_$: unknown, e: Any) => { focused.push(String(e.key ?? e.element)); return { value: {} } })
  const closed: string[] = []
  on('ui.close', (_$: unknown, e: Any) => { closed.push(String(e.id)); return { value: undefined } })
  on('ui.panes', () => ({ value: [] }))
  on('ui.scroll', () => ({ value: {} }))
  const toasts: string[] = []
  on('ui.toast', (_$: unknown, e: unknown) => { toasts.push(typeof e === 'string' ? e : String((e as { text?: string })?.text ?? JSON.stringify(e))); return { value: undefined } })
  const prompts: string[] = []
  const pass = (prompt: string) => {
    prompts.push(prompt)
    const fork = (forks[prompts.length - 1] ?? forks.at(-1)) as Any
    if (fork?.failed) return { value: fork.failed }
    return { value: { isAnswered: true, text: JSON.stringify(fork), usage: USAGE } }
  }
  on('model.complete', (_$: unknown, e: { prompt: string; system?: string }) => pass(`${e.system ?? ''}\n${e.prompt}`))
  // the observer's look: a fork of the session with its frame and lenses as the prompt
  on('model.fork', (_$: unknown, e: { prompt: string }) => pass(e.prompt))
  const submitted: { text: string; context: readonly string[] }[] = []
  on('prompt.submit', (_$: unknown, e: { text: string; context?: readonly string[] }) => {
    submitted.push({ text: e.text, context: e.context ?? [] })
    return { text: e.text }
  })
  on('prompt.fill', () => ({ isFilled: true }))
  const appended: string[] = []
  on('session.append', async (_$: unknown, e: Any, next: Any) => {
    const c = e.message?.content
    appended.push(Array.isArray(c) ? c.map((b: Any) => b.text || '').join('') : String(c ?? ''))
    return next(e)
  })
  on('command.run', () => ({}))
  on('tool.call', () => ({ result: 'saved 07-folder-claims v1\n  2 of 2 citations hold\n' }))
  on('prompt.edit', (_$: unknown, e: { text: string; start: number; end: number; inputText: string }) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the reply'] }) as never)
  on('turn.start', (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', (_$: unknown, e: { answer?: string }) => ({ text: e.answer ?? '' }))
  on('command.register', (_$: unknown, e: { name: string }) => ({ value: { command: e.name } }))
  on('config.list', () => ({ value: [] }))
  const spawns: Any[] = []
  on('agent.register', () => ({ value: { agent: 'thimble:thread' } }))
  on('agent.spawn', (_$: unknown, e: Any) => { spawns.push(e); return { model: 'claude-test', agentId: `agent-${spawns.length}` } as never })
  on('agent.list', () => ({ value: spawns.map((_, i) => ({ id: `agent-${i + 1}`, type: 'thimble:thread', description: 'thread', status: 'running' })) }))
  const sent: Any[] = []
  on('session.send', (_$: unknown, e: Any) => { sent.push(e); return { isDelivered: true } })
  on('turn.step', async function* (_$: unknown, e: Any) { return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ id: 'u1', name: 'Bash', input: {} }] } })
  const clock = mock.clock(on, { now: NOW })
  return { files, runs, prompts, submitted, clock, opened, focused, closed, toasts, spawns, sent, appended, started: false }
}

function textOf(n: Any): string {
  if (n == null || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  return textOf(n.props?.children) + textOf(n.children)
}

/** One turn of main's: the person's prompt row, a step with a tool call, Claude's answer row, the end. */
async function turn($: Any, w: Any, o: { id: string; user: string; prompt: string; row: string; answer: string }) {
  if (!w.started) { w.started = true; await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never) }
  await $.prompt.submit({ text: o.prompt, origin: { kind: 'composer' } } as never)
  await $.session.append({ door: 'prompt', uuid: o.user, origin: { kind: 'composer' }, message: { type: 'user', role: 'user', content: [{ type: 'text', text: o.prompt }] } } as never)
  await $.turn.start({ turnId: o.id, text: o.prompt } as never)
  const s = $.turn.step({ turnId: o.id, index: 0, model: 'claude-opus-5-5', messageCount: 3 })
  for (let r = await s.next(); !r.done; r = await s.next()) { /* no chunks */ }
  await $.session.append({ door: 'response', uuid: o.row, origin: { kind: 'model', model: 'm' }, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: o.answer }] } } as never)
  await $.turn.complete({ turnId: o.id, answer: o.answer, durationMs: 5, reason: 'answer', isAborted: false } as never)
  await w.clock.advance(100)
  await w.clock.settle()
}

const PANE = { plugin: 'thimble', component: 'Pane', surface: 'terminal', requestId: 'object', props: { bodyColumns: 92, placement: 'dock', scroll: { bodyRows: 44, offset: 0 }, isFocused: true, title: 'Claims', view: {} }, viewport: { columns: 58, rows: 50, isFullscreen: true } } as never
const key = (k: string) => ({ origin: { kind: 'composer' }, key: { key: k }, text: '', cursor: 0, start: 0, end: 0, inputText: k.length === 1 ? k : '' }) as never
/** The cell key of a region's row in the side panel's drawing (`r|side|<row>|<region>`). */
async function rowKey($: Any, region: string): Promise<string> {
  const m = new RegExp(`"key":"(r\\|side\\|\\d+\\|${region})"`).exec(JSON.stringify(await $.ui.render(PANE)))
  if (!m) throw new Error(`no row for ${region}`)
  return m[1]!
}

async function twoTurns($: Any, on: Any) {
  const w = world(on, [FORK1, FORK2])
  await turn($, w, { id: 't1', user: U1, prompt: Q1, row: R1, answer: A1 })
  await turn($, w, { id: 't2', user: U2, prompt: Q2, row: R2, answer: A2 })
  return w
}

test('the Claims pane opens with the ring on the selected dot, not on the input bar: the first ↑ walks the claims from it; a letter still starts a question', async ($, on) => {
  const w = await twoTurns($, on)
  await press($, w.clock, key('c'))
  await w.clock.settle()
  for (let i = 0; i < 3; i++) { await $.ui.render(PANE); await w.clock.settle() }
  const drawn = JSON.stringify(await $.ui.render(PANE))
  // the input bar is there, without the ring
  expect(drawn).toContain('Ask about claim: The tilt is two editors')
  expect(drawn).not.toMatch(/"key":"ask-\d+"[^}]*"autoFocus":true/)
  // the ring stands on the selected dot (the newest claim's): the first ↑ moves it to the dot before, which is selected
  const dots = [...drawn.matchAll(/"key":"(r\|side\|\d+\|n-c\d+)"/g)].map(m => m[1]!)
  const sel = await rowKey($, 'n-c4')
  const before = dots[dots.indexOf(sel) - 1]!
  await $.ui.focus({ requestId: 'object', element: before, origin: { kind: 'person' } } as never)
  await w.clock.settle()
  expect(textOf(await $.ui.render(PANE))).not.toContain('The tilt is two editors, Kestrel and Wren, not one.')
  // a letter starts a question in the input bar
  expect(await press($, w.clock, key('w'))).toEqual({ text: '', cursor: 0 })
  await w.clock.settle()
  expect(JSON.stringify(await $.ui.render(PANE))).toMatch(/"key":"ask-\d+"[^}]*"value":"w"|"value":"w"[^}]*"key":"ask-\d+"/)
})

// a folder of two jsonl files, three rows of one read
const COV = {
  session: 's-1',
  files: [
    { path: 'revisions.jsonl', type: 'jsonl', pattern: '*.jsonl', rows: 10, lines: 10, status: 'seen', share: 0.3, seen_lines: 3, ranges: [[2, 4]] },
    { path: 'pages.jsonl', type: 'jsonl', pattern: '*.jsonl', rows: 10, lines: 10, status: 'not read', share: 0, seen_lines: 0, ranges: [] },
  ],
  patterns: [{ pattern: '*.jsonl', files: 2, rows: 20, seen_rows: 3, seen_files: 1, by_status: { seen: 1, 'not read': 1 } }],
  types: [{ type: 'jsonl', files: 2, rows: 20, seen_rows: 3, seen_files: 1, by_status: { seen: 1, 'not read': 1 } }],
  total: { files: 2, rows: 20, seen_rows: 3, seen_share: 0.15, seen_files: 1 },
}

test('Coverage opens with the ring on the selected group, not on the input bar: ↵ opens its files at once, as a click does', async ($, on) => {
  const w = world(on, [FORK1], { cov: COV })
  await turn($, w, { id: 't1', user: U1, prompt: Q1, row: R1, answer: A1 })
  // r opens Coverage once a moment passed with no letter after it
  await press($, w.clock, key('r'))
  await w.clock.advance(1000)
  await w.clock.settle()
  for (let i = 0; i < 3; i++) { await $.ui.render(PANE); await w.clock.settle() }
  const drawn = JSON.stringify(await $.ui.render(PANE))
  expect(drawn).toContain('Ask about *.jsonl')
  expect(drawn).not.toMatch(/"key":"ask-\d+"[^}]*"autoFocus":true/)
  // the ring stands on the selected group's row, so ↵ presses it: its files open
  const ui = await $.ui.mount({ plugin: 'thimble', ...(PANE as Any) } as never)
  await ui.press({ key: await rowKey($, 'g-0') })
  await w.clock.settle()
  expect(textOf(await $.ui.render(PANE))).toContain('Claude read 3 of their 20 rows (15%), from 1 of 2 files.')
})
