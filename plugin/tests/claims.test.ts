// Claims in a session (claims/, shell/panes.ts): after two turns of work, c opens the Claims pane with the ring on the
// selected dot rather than on the input bar, so the first arrow walks the claims from it, and a letter still starts a
// question. Coverage (r) opens the same way, on its selected row, so ↵ opens it. `claude plugin test plugin`.
// The model's calls and the Node children are answered here.
import { expect, mock, test } from 'claude-code/testing'

import { press, promptStub } from './stubs'
import { itemId } from '../panes/coverage.js'

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

function world(on: Any, forks: Record<string, unknown>[], o: { cov?: unknown; labels?: Any[]; slow?: { gate: Promise<void> | null } } = {}) {
  mock.env(on, { THIMBLE_HOME: '/home/t/.thimble' })
  mock.store(on)
  on('session.cwd', () => ({ value: ROOT }))
  on('session.id', () => ({ value: 's-1' }))
  on('session.messages', () => ({ value: [] }))
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  const files: Record<string, string> = {}
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: e.path in files || e.path === `${ROOT}/thimble/objects` || e.path.endsWith('.md') }))
  on('fs.list', (_$: unknown, e: { path: string }) => ({ value: e.path.endsWith('/thimble/labels') ? (o.labels ?? []).map(l => ({ name: `${l.name}.json`, kind: 'file' })) : [] }))
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
    else if (e.argv.includes('label')) out = JSON.stringify(e.argv.includes('--records') ? { records: [{ i: 0, ref: 'revisions.jsonl#L3', value: 'yes', words: 'Kestrel saved Lexicon', by: 'regex' }] } : o.labels ?? [])
    else if (e.argv.includes('coverage')) {
      out = e.argv.includes('--json') ? JSON.stringify(o.cov ?? {}) : 'Coverage of this session · 4 source files'
      // a large folder: the read answers only when the test opens the gate
      if (o.slow?.gate) return o.slow.gate.then(() => ({ value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
    } else if (e.argv.includes('resolve')) out = JSON.stringify({ ref: e.argv[e.argv.indexOf('resolve') + 1], chain: [{ step: 'query', id: 'q4', about: 'share by user', value: '41%' }], rows: ['revisions.jsonl#L28-31'], count: 4, records: [{ ref: 'revisions.jsonl#L28', text: 'Kestrel saved Lexicon' }], notes: [] })
    else if (e.argv.some(a => a.endsWith('prep.mjs'))) out = JSON.stringify({ drawing: { kit: 1, w: 40, h: 1, root: { t: 'text', runs: [{ s: 'rows', tone: 'ink' }] }, cites: {}, examples: {}, regions: [], warnings: [] } })
    return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  // the side panel as Claude Code keeps it: whether it is open, whether it holds the keys, and whether Claude Code gives
  // them when the panel asks (`grant`: false while a key is still in the prompt, which refuses an open's focus)
  // `prompt`: the text in the prompt (Claude Code refuses the panel the keys while it holds any); `fills`: each text a
  // fill put there
  const keys = { open: false, panel: false, grant: true, prompt: '' }
  const fills: string[] = []
  const opened: Record<string, unknown>[] = []
  on('ui.open', (_$: unknown, e: Record<string, unknown>) => { opened.push(e); keys.open = true; if (e.focus && keys.grant && keys.prompt === '') keys.panel = true; return { value: { isPlaced: true } } })
  const focused: string[] = []
  on('ui.focus', (_$: unknown, e: Any) => { focused.push(String(e.key ?? e.element)); return { value: {} } })
  const closed: string[] = []
  on('ui.close', (_$: unknown, e: Any) => { closed.push(String(e.id)); keys.open = false; keys.panel = false; return { value: undefined } })
  on('ui.panes', () => ({ value: keys.open ? [{ id: 'object', title: 'Claims', isShown: true, isFocused: keys.panel, isPlaced: true, plugin: 'thimble' }] : [] }))
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
  on('prompt.fill', (_$: unknown, e: Any) => { fills.push(String(e.text)); if (e.mode === 'replace') keys.prompt = String(e.text); return { isFilled: true } })
  on('prompt.suggest', () => ({ isShown: true }))
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
  return { files, runs, prompts, submitted, clock, opened, focused, closed, toasts, spawns, sent, appended, keys, fills, started: false }
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
  // the ring stands on the selected dot (the newest claim's): the first ↑ (Claude Code's ring onto the dot above) walks
  // to the claim before it in the pane's order, which is selected
  const dots = [...drawn.matchAll(/"key":"(r\|side\|\d+\|n-c\d+)"/g)].map(m => m[1]!)
  const sel = await rowKey($, 'n-c4')
  const before = dots[dots.indexOf(sel) - 1]!
  w.focused.length = 0
  await $.ui.focus({ requestId: 'object', element: before, origin: { kind: 'person' } } as never)
  await w.clock.advance(50)
  await w.clock.settle()
  expect(textOf(await $.ui.render(PANE))).not.toContain('The tilt is two editors, Kestrel and Wren, not one.')
  await w.clock.settle()
  // the drawings that select that claim (its box adds presses and covers others) leave the ring on its dot, never on the
  // dot it left
  await $.ui.render(PANE)
  await w.clock.settle()
  const now = JSON.stringify(await $.ui.render(PANE))
  expect(now).toContain('Ask about claim:')
  expect(now).not.toContain('Ask about claim: The tilt is two editors')
  expect(w.focused).not.toContain(sel)
  // a letter starts a question in the input bar
  expect(await press($, w.clock, key('w'))).toEqual({ text: '', cursor: 0 })
  await w.clock.settle()
  expect(JSON.stringify(await $.ui.render(PANE))).toMatch(/"key":"ask-\d+"[^}]*"value":"w"|"value":"w"[^}]*"key":"ask-\d+"/)
})

test('↑↓ walk the claims in the pane\'s order, wherever Claude Code\'s ring would land: on another dot, on the head\'s press, under the page; a click selects the dot it presses', async ($, on) => {
  const w = await twoTurns($, on)
  await press($, w.clock, key('c'))
  await w.clock.settle()
  for (let i = 0; i < 3; i++) { await $.ui.render(PANE); await w.clock.settle() }
  // the claim selected, as the input bar names it
  const selected = async () => { await w.clock.settle(); const t = JSON.stringify(await $.ui.render(PANE)); await w.clock.settle(); return (/Ask about claim: ([^…"]{1,40})/.exec(t) || [])[1] ?? '' }
  // the ring as Claude Code's arrows move it: onto the head's press (the folder's), under the page (the input bar), or
  // onto a dot drawn near
  const move = async (to: string) => { await $.ui.focus({ requestId: 'object', element: to, origin: { kind: 'person' } } as never); await w.clock.advance(50); return selected() }
  const head = await rowKey($, 'folder')
  const bar = /"key":"(ask-\d+)"/.exec(JSON.stringify(await $.ui.render(PANE)))![1]!
  const order = [await selected()]
  expect(order[0]).toMatch(/^The tilt is two editors/)
  // ↓ four times (the ring onto the input bar under the page, then from nowhere onto the first press, the head's):
  // each step selects the next claim, and four steps come back round
  for (const to of [bar, head, bar, bar]) order.push(await move(to))
  expect(new Set(order.slice(0, 4)).size).toBe(4)
  expect(order[4]).toBe(order[0])
  // the claim's box is open
  expect(textOf(await $.ui.render(PANE))).toContain('The tilt is two editors, Kestrel and Wren, not one.')
  // ↑ (the ring onto a dot drawn above it, of whichever claim) goes back one claim in the same order
  const drawn = JSON.stringify(await $.ui.render(PANE))
  const dots = [...drawn.matchAll(/"key":"(r\|side\|(\d+)\|n-c\d+)"/g)].map(m => [m[1]!, Number(m[2])] as const)
  const sel = await rowKey($, 'n-c4')
  const above = dots.filter(([, y]) => y < Number(sel.split('|')[2])).at(-1)
  if (above) expect(await move(above[0])).toBe(order[3])
  // a click on another dot selects that dot: its press cancels the step its move of the ring would be
  const ui = await $.ui.mount({ plugin: 'thimble', ...(PANE as Any) } as never)
  const now = await selected()
  const other = dots.map(([k]) => k).find(k => !k.endsWith('|n-c4') && !now.startsWith('x'))!
  await $.ui.focus({ requestId: 'object', element: other, origin: { kind: 'person' } } as never)
  await ui.press({ key: other })
  await w.clock.advance(50)
  const clicked = await selected()
  expect(clicked).not.toBe(now)
  expect(textOf(await $.ui.render(PANE))).toContain(clicked)
})

// a folder of two jsonl files, three rows of one read
const COV = {
  session: 's-1',
  files: [
    { path: 'revisions.jsonl', type: 'jsonl', pattern: '*.jsonl', rows: 10, lines: 10, status: 'seen', touched: true, share: 0.3, seen_lines: 3, ranges: [[2, 4]] },
    { path: 'pages.jsonl', type: 'jsonl', pattern: '*.jsonl', rows: 10, lines: 10, status: 'not read', share: 0, seen_lines: 0, ranges: [] },
  ],
  patterns: [{ pattern: '*.jsonl', files: 2, rows: 20, seen_rows: 3, seen_files: 1, by_status: { seen: 1, 'not read': 1 } }],
  types: [{ type: 'jsonl', files: 2, rows: 20, seen_rows: 3, seen_files: 1, touched: 1, by_status: { seen: 1, 'not read': 1 } }],
  total: { files: 2, rows: 20, seen_rows: 3, seen_files: 1, touched_files: 1 },
}

test('Coverage opens with the ring on the selected file, not on the input bar: ↵ opens its lines at once, as a click does', async ($, on) => {
  const w = world(on, [FORK1], { cov: COV })
  await turn($, w, { id: 't1', user: U1, prompt: Q1, row: R1, answer: A1 })
  // r opens Coverage once a moment passed with no letter after it
  await press($, w.clock, key('r'))
  await w.clock.advance(1000)
  await w.clock.settle()
  for (let i = 0; i < 3; i++) { await $.ui.render(PANE); await w.clock.settle() }
  const drawn = JSON.stringify(await $.ui.render(PANE))
  expect(drawn).toContain('Ask about revisions.jsonl')
  expect(drawn).not.toMatch(/"key":"ask-\d+"[^}]*"autoFocus":true/)
  // the ring stands in the gutter beside the selected row (a cell of one color), so the row is shaded, never inverse
  expect(drawn).toMatch(/"key":"g\|side\|\d+"/)
  // a folder of two files lists them, with no group to open; the ring stands on the first, so ↵ opens its lines
  const ui = await $.ui.mount({ plugin: 'thimble', ...(PANE as Any) } as never)
  await ui.press({ key: await rowKey($, 'f:revisions.jsonl') })
  await w.clock.settle()
  expect(textOf(await $.ui.render(PANE))).toContain('read 3 of 10 records (30%)')
})

// The side panel holds the keys the same way whatever it shows (shell/detail.tsx holdKeys). Claude Code refuses a pane
// the keys while a key is still in the prompt, so the pane a key opens (c Claims, r Coverage, l the labels) asks for
// them again a little later, while it does not have them. Without that, every key after the open went to the prompt.
const LABELS = [
  { name: 'coordination', values: ['yes', 'no'], counts: { yes: 4, no: 6 }, records: 10, kind: 'regex', rule: 'relay|deadline', in: 'revisions.jsonl' },
  { name: 'fetches', values: ['yes', 'no'], counts: { yes: 7, no: 3 }, records: 10, kind: 'regex', rule: 'proxy', in: 'revisions.jsonl' },
]

/** A key from the empty prompt opens a pane while Claude Code still refuses the panel the keys. Once the key has left the
 *  prompt, the panel holds the keys, with the ring on the part selected and never on the input bar. */
async function opensHoldingKeys($: Any, w: Any, k: string): Promise<string> {
  w.keys.grant = false
  await press($, w.clock, key(k))
  await w.clock.advance(1000)
  await w.clock.settle()
  w.ui = await $.ui.mount({ plugin: 'thimble', ...(PANE as Any) } as never)
  for (let i = 0; i < 3; i++) { await $.ui.render(PANE); await w.clock.settle() }
  expect(w.keys.open).toBe(true)
  expect(w.keys.panel).toBe(false)
  // the key has left the prompt: the panel's next request for the keys is granted
  w.keys.grant = true
  w.focused.length = 0
  await w.clock.advance(2000)
  await w.clock.settle()
  expect(w.keys.panel).toBe(true)
  const drawn = JSON.stringify(await $.ui.render(PANE))
  await w.clock.settle()
  expect(drawn).not.toMatch(/"key":"ask-\d+"[^}]*"autoFocus":true/)
  return drawn
}

test('Claims takes the keys again when a request is refused while its key is still in the prompt, the ring on the selected dot', async ($, on) => {
  const w = await twoTurns($, on)
  const drawn = await opensHoldingKeys($, w, 'c')
  // the ring's cell beside the selected dot
  expect(drawn).toContain(`g|side|${(await rowKey($, 'n-c4')).split('|')[2]}`)
})

test('Coverage takes the keys again when its open is refused, the ring on the selected file', async ($, on) => {
  const w = world(on, [FORK1], { cov: COV })
  await turn($, w, { id: 't1', user: U1, prompt: Q1, row: R1, answer: A1 })
  const drawn = await opensHoldingKeys($, w, 'r')
  expect(drawn).toContain(`g|side|${(await rowKey($, 'f:revisions.jsonl')).split('|')[2]}`)
})

test('the labels hold the keys on the label selected: ↵ opens it, and the way back goes to the list', async ($, on) => {
  const w = world(on, [FORK1], { labels: LABELS })
  await turn($, w, { id: 't1', user: U1, prompt: Q1, row: R1, answer: A1 })
  const drawn = await opensHoldingKeys($, w, 'l')
  expect(drawn).toContain('2 labels in this folder')
  // the ring stands on the first label's gutter cell, so ↵ (Claude Code's press on it) opens that label
  const gutter = `g|side|${(await rowKey($, 'lb-0')).split('|')[2]}`
  expect(drawn).toContain(gutter)
  await w.ui.press({ key: gutter })
  await w.clock.settle()
  for (let i = 0; i < 2; i++) { await $.ui.render(PANE); await w.clock.settle() }
  expect(textOf(await $.ui.render(PANE))).toContain('label over revisions.jsonl')
  // back to the list (the press at the top does what esc does), and the keys stay with the panel
  await w.ui.press({ key: 'side-back' })
  await w.clock.settle()
  for (let i = 0; i < 2; i++) { await $.ui.render(PANE); await w.clock.settle() }
  const list = JSON.stringify(await $.ui.render(PANE))
  expect(list).toContain('2 labels in this folder')
})

test('a key of a pane\'s program typed while the prompt had the keys (e in Claims) gives them back to the panel, again until it holds them', async ($, on) => {
  const w = await twoTurns($, on)
  await press($, w.clock, key('c'))
  await w.clock.settle()
  for (let i = 0; i < 3; i++) { await $.ui.render(PANE); await w.clock.settle() }
  expect(w.keys.panel).toBe(true)
  // the person's e went to the prompt (the program's key), and Claude Code keeps the keys there for a moment
  w.keys.panel = false
  w.keys.grant = false
  await press($, w.clock, key('e'))
  await w.clock.advance(100)
  await w.clock.settle()
  expect(w.keys.panel).toBe(false)
  w.keys.grant = true
  await w.clock.advance(2000)
  await w.clock.settle()
  expect(w.keys.panel).toBe(true)
  // e opened the claim's evidence
  expect(JSON.stringify(await $.ui.render(PANE))).toMatch(/evidence/)
})

// ↓ in a pane is Claude Code's step to the next press in its order (the next gutter cell): the selection follows the
// ring, and the input bar names the part selected. Files in folders have ids the kit keeps (panes/coverage.js itemId)
test('Coverage: ↓ moves the selection with the ring, and the input bar names the file', async ($, on) => {
  const nested = { ...COV, files: COV.files.map((f, i) => ({ ...f, path: `runs/r0${i + 1}/${f.path}` })) }
  const w = world(on, [FORK1], { cov: nested })
  await turn($, w, { id: 't1', user: U1, prompt: Q1, row: R1, answer: A1 })
  await press($, w.clock, key('r'))
  await w.clock.advance(1000)
  await w.clock.settle()
  for (let i = 0; i < 3; i++) { await $.ui.render(PANE); await w.clock.settle() }
  expect(JSON.stringify(await $.ui.render(PANE))).toContain('Ask about runs/r01/revisions.jsonl')
  const g1 = `g|side|${(await rowKey($, itemId('f', 'runs/r01/revisions.jsonl').replace(/\./g, '\\.'))).split('|')[2]}`
  const g2 = `g|side|${(await rowKey($, itemId('f', 'runs/r02/pages.jsonl').replace(/\./g, '\\.'))).split('|')[2]}`
  w.focused.length = 0
  await $.ui.focus({ requestId: 'object', element: g2, origin: { kind: 'person' } } as never)
  await w.clock.advance(200)
  await w.clock.settle()
  for (let i = 0; i < 3; i++) { await $.ui.render(PANE); await w.clock.advance(100); await w.clock.settle() }
  const drawn = JSON.stringify(await $.ui.render(PANE))
  expect(drawn).toContain('Ask about runs/r02/pages.jsonl')
  expect(w.focused).not.toContain(g1)
  // ↵ on it (Claude Code's press on the ring's cell) opens its lines
  const ui = await $.ui.mount({ plugin: 'thimble', ...(PANE as Any) } as never)
  await ui.press({ key: g2 })
  await w.clock.settle()
  expect(textOf(await $.ui.render(PANE))).toContain('runs/r02/pages.jsonl')
  expect(textOf(await $.ui.render(PANE))).toContain('file ·')
})

// A file nothing touched opens as its own page, with no line to walk: its title is the part, so the ring stays on the
// pane (never on the input bar), the input bar names the file (not the pane), and the bar says esc goes back a level
test('Coverage: ↵ on an untouched file opens it on the file, and the bar says esc back', async ($, on) => {
  const BAND = { plugin: 'thimble', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows: 14, bodyColumns: 160, scroll: { offset: 0, bodyRows: 14 }, view: {} }, viewport: { columns: 160, rows: 40, isFullscreen: true } } as never
  const w = world(on, [FORK1], { cov: COV })
  await turn($, w, { id: 't1', user: U1, prompt: Q1, row: R1, answer: A1 })
  await press($, w.clock, key('r'))
  await w.clock.advance(1000)
  await w.clock.settle()
  for (let i = 0; i < 3; i++) { await $.ui.render(PANE); await w.clock.settle() }
  const bar = async () => { await $.ui.render(BAND); await w.clock.settle(); return textOf(await $.ui.render(BAND)) }
  expect(await bar()).toContain('esc close')
  const ui = await $.ui.mount({ plugin: 'thimble', ...(PANE as Any) } as never)
  await ui.press({ key: await rowKey($, 'f:pages\\.jsonl') })
  await w.clock.settle()
  for (let i = 0; i < 3; i++) { await $.ui.render(PANE); await w.clock.settle() }
  const drawn = JSON.stringify(await $.ui.render(PANE))
  expect(textOf(await $.ui.render(PANE))).toContain('file ·')
  expect(drawn).toContain('Ask about pages.jsonl: none')
  expect(drawn).not.toContain('Ask about Coverage')
  expect(drawn).not.toMatch(/"key":"ask-\d+"[^}]*"autoFocus":true/)
  expect(await bar()).toContain('esc back')
  expect(await bar()).not.toContain('esc close')
})

// On a large folder the coverage read takes seconds: the pane closes before it ends. The read's end, and a drawing of
// the pane that comes after the close, leave the panel closed: the bar names r again, never `esc close`
test('Coverage closed while its read still runs: the bar says r again, and a later drawing does not reopen it', async ($, on) => {
  const BAND = { plugin: 'thimble', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows: 14, bodyColumns: 160, scroll: { offset: 0, bodyRows: 14 }, view: {} }, viewport: { columns: 160, rows: 40, isFullscreen: true } } as never
  const slow = { gate: null as Promise<void> | null }
  const w = world(on, [FORK1], { cov: COV, slow })
  await turn($, w, { id: 't1', user: U1, prompt: Q1, row: R1, answer: A1 })
  let done = () => {}
  slow.gate = new Promise<void>(r => { done = r })
  await press($, w.clock, key('r'))
  await w.clock.advance(1000)
  await w.clock.settle()
  for (let i = 0; i < 3; i++) { await $.ui.render(PANE); await w.clock.settle() }
  const bar = async () => { await $.ui.render(BAND); await w.clock.settle(); return textOf(await $.ui.render(BAND)) }
  expect(await bar()).toContain('esc close')
  // the panel closes: Claude Code takes the pane away, and the module hears of it (here from the next prompt, which
  // finds the pane gone; esc's close runs the same closed())
  const band = await $.ui.mount(BAND)
  await band.press({ key: 'count-cov' })
  await w.clock.settle()
  expect(w.closed).toContain('object')
  await $.prompt.submit({ text: 'and the other folder?', origin: { kind: 'composer' } } as never)
  await w.clock.settle()
  expect(await bar()).not.toContain('esc close')
  // the read ends after the close, and Claude Code draws the pane once more
  done()
  await w.clock.advance(100)
  await w.clock.settle()
  await $.ui.render(PANE)
  await w.clock.settle()
  const line = await bar()
  expect(line).not.toContain('esc close')
  expect(line).toContain('r coverage')
})

// Claude Code hands esc at an idle, empty prompt only to an open pane. So r shows Coverage early in its wait, without
// the keys: esc then closes it and nothing opens after; a letter typed at a usual pace makes r a word and opens nothing;
// with no letter the pane takes the keys once the wait has passed
test('esc in r\'s wait closes Coverage for good; a word opens nothing; else the pane takes the keys', async ($, on) => {
  const w = world(on, [FORK1], { cov: COV })
  await turn($, w, { id: 't1', user: U1, prompt: Q1, row: R1, answer: A1 })
  const opens = () => w.opened.filter((o: Any) => o.id === 'object')

  // a word: r, then u 150 ms later
  await press($, w.clock, key('r'))
  await w.clock.advance(150)
  const word = await press($, w.clock, key('u'))
  expect(word.text).toBe('ru')
  await w.clock.advance(1000)
  await w.clock.settle()
  expect(opens()).toHaveLength(0)
  await $.prompt.edit({ origin: { kind: 'composer' }, key: { key: 'backspace' }, text: '', cursor: 0, start: 0, end: 0, inputText: '' } as never)

  // esc 500 ms after r: the pane shown early, without the keys, closes, and nothing opens after
  await press($, w.clock, key('r'))
  await w.clock.advance(400)
  await w.clock.settle()
  expect(opens()).toHaveLength(1)
  expect(opens()[0].focus).toBeUndefined()
  expect(opens()[0].closeOnEscape).toBe(true)
  expect(w.keys.panel).toBe(false)
  await w.clock.advance(100)
  // esc at the idle, empty prompt: Claude Code closes the pane (closeOnEscape), and the panel's close runs closed().
  // The kit raises no close of the person's, so the module hears of it here from a prompt that finds the pane gone
  w.keys.open = false
  await $.prompt.submit({ text: 'and the other folder?', origin: { kind: 'composer' } } as never)
  await w.clock.settle()
  await w.clock.advance(3000)
  await w.clock.settle()
  expect(opens()).toHaveLength(1)
  expect(w.keys.panel).toBe(false)

  // no letter and no esc: the pane takes the keys once the wait has passed
  await press($, w.clock, key('r'))
  await w.clock.advance(1000)
  await w.clock.settle()
  const later = opens().slice(1)
  expect(later[0].focus).toBeUndefined()
  expect(later.slice(1).some((o: Any) => o.focus === true)).toBe(true)
  expect(w.keys.panel).toBe(true)
})

// Claude Code gives ← and → to the prompt even while a pane holds the keys (its panes bind ↑ ↓ tab ↵ esc, never ← →),
// and ↑ reaches the prompt in the moment before the panel holds them. A suggestion → takes, or a history entry ↑
// recalls, fills the prompt, and Claude Code then refuses the panel the keys: esc, ↑ and the letters all went to the
// prompt. So the panel shows no suggestion while it is open, and a text that reaches the prompt is taken out again
test('while a pane is open the prompt shows no suggestion', async ($, on) => {
  const w = world(on, [FORK1], { cov: COV })
  await turn($, w, { id: 't1', user: U1, prompt: Q1, row: R1, answer: A1 })
  expect((await $.prompt.suggest({ text: 'now check the other folder' } as never)).isShown).toBe(true)
  await press($, w.clock, key('r'))
  await w.clock.advance(1000)
  await w.clock.settle()
  for (let i = 0; i < 3; i++) { await $.ui.render(PANE); await w.clock.settle() }
  expect(w.keys.open).toBe(true)
  expect((await $.prompt.suggest({ text: 'now check the other folder' } as never)).isShown).toBe(false)
})

for (const [what, origin] of [['→ took a suggestion', 'engine'], ['↑ recalled the history', 'history']] as const) {
  test(`a text that reached the prompt while a pane is open (${what}) is taken out, and the pane holds the keys again`, async ($, on) => {
    const w = await twoTurns($, on)
    await press($, w.clock, key('c'))
    await w.clock.advance(1000)
    await w.clock.settle()
    for (let i = 0; i < 3; i++) { await $.ui.render(PANE); await w.clock.settle() }
    expect(w.keys.panel).toBe(true)
    // the key went to the prompt: Claude Code put the text there and gave the prompt the keys
    w.keys.panel = false
    w.keys.prompt = 'how many edits were reverted?'
    // (the test's host has no prompt.change of its own beneath the plugin's, which observes it and passes it on)
    await $.prompt.change({ text: w.keys.prompt, cursor: w.keys.prompt.length, origin: { kind: origin } } as never).catch(() => undefined)
    await w.clock.advance(100)
    await w.clock.settle()
    expect(w.fills).toContain('')
    expect(w.keys.prompt).toBe('')
    await w.clock.advance(1000)
    await w.clock.settle()
    expect(w.keys.panel).toBe(true)
  })
}

test('a pane asks for the keys until it has them, however long the key that opened it stays in the prompt', async ($, on) => {
  const w = await twoTurns($, on)
  // a busy terminal: the c that opened Claims stays in the prompt for seconds, so each request is refused
  w.keys.prompt = 'c'
  await press($, w.clock, key('c'))
  for (let i = 0; i < 5; i++) { await w.clock.advance(1000); await w.clock.settle(); await $.ui.render(PANE); await w.clock.settle() }
  expect(w.keys.open).toBe(true)
  expect(w.keys.panel).toBe(false)
  w.keys.prompt = ''
  await w.clock.advance(1500)
  await w.clock.settle()
  expect(w.keys.panel).toBe(true)
})
