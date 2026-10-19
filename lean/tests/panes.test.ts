// Panes and cards as programs on one runtime (shell/panes.ts, panes/*.js): a card under a reply is drawn as the person
// left it (its state and its part, on either surface) and takes its own keys from the empty prompt, which the bar names
// from its first drawing; the detail is a program whose state is one for both surfaces: a state the browser's run
// answers with draws here, and the terminal's is kept where the page reads it. `claude plugin test lean`.
import { expect, mock, test } from 'claude-code/testing'
import { press, promptStub } from './stubs'

const ROOT = '/data'
const SESSION = 's-1'
const OBJECT = {
  id: '01-saves', version: 2, title: 'Saves per day', text: 'June 18 had [6,543](#day-2026-06-18) saves.', program: 'return k.bars(...)',
  history: [{ v: 1 }, { v: 2 }], data: { days: [] }, lineage: { cites: [], rows: { 'revisions.jsonl': { count: 6543 } } },
}
const region = (id: string, label: string) => ({ t: 'region', id, meta: { label, ref: `q1#day=${id.slice(4)}@n` }, kid: { t: 'text', runs: [{ s: `${label} ${'▆'.repeat(8)}`, tone: 'ink' }], wrap: false, w: 20 } })
// the card's program as the sandbox runs it: j steps a day (k.on('j')), a press on Jun 17 is its own (k.on('press:…'))
function drawingFor(input: Any) {
  const at = Number(input.state?.at ?? 0)
  const ev = input.event
  const base = {
    kit: 1, w: 60, h: 24, mode: input.mode, title: 'Saves per day',
    root: { t: 'stack', kids: [region('day-2026-06-17', 'Jun 17'), region('day-2026-06-18', 'Jun 18')] },
    cites: {}, examples: {}, regions: [{ id: 'day-2026-06-17', meta: { label: 'Jun 17' } }, { id: 'day-2026-06-18', meta: { label: 'Jun 18' } }], warnings: [], ms: 1,
    on: [{ name: 'j', label: 'next day' }, { name: 'press:day-2026-06-17', label: '' }],
  }
  if (ev?.key === 'j') return { ...base, state: { at: at + 1 }, handled: 'j' }
  if (ev?.type === 'press') return { ...base, state: { at: 0 }, handled: 'press' }
  return { ...base, state: { at } }
}
const ROW = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const AT = ROW.slice(0, 24)
const RECORD = { v: 1, row: AT, session: SESSION, text: 'June 18 had the most saves.', shown: null, marks: [], verbs: {}, objects: ['01-saves'], final: true }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

function world(on: Any, serverLines: unknown[] = [], draw: (input: Any) => unknown = drawingFor) {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.focus', () => ({}))
  on('ui.panes', () => ({ value: [{ id: 'object', title: 'Saves per day', isShown: true, isFocused: true, isPlaced: true, plugin: 'thimble' }] }))
  on('config.set', (_$: unknown, e: { value: unknown }) => ({ value: e.value }))
  mock.env(on, { THIMBLE_HOME: '/home/t/.thimble', BROWSER: '/usr/bin/open-page' })
  on('turn.start', (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.cwd', () => ({ value: ROOT }))
  on('session.id', () => ({ value: SESSION }))
  const files: Record<string, string> = {
    [`${ROOT}/thimble/objects/01-saves.json`]: JSON.stringify(OBJECT),
    [`${ROOT}/thimble/messages/${SESSION}/${AT}.json`]: JSON.stringify(RECORD),
    // where the person left the card: the day it was on, and its part
    [`${ROOT}/thimble/objects/.state/01-saves.json`]: JSON.stringify({ state: { at: 2 }, region: 'day-2026-06-18', by: 'browser' }),
  }
  on('tool.call', () => {
    files['/home/t/.thimble/lean/events/s-1.jsonl'] = (files['/home/t/.thimble/lean/events/s-1.jsonl'] || '') + JSON.stringify({ t: Date.now() / 1000, kind: 'save', session: SESSION, root: ROOT, object: '01-saves', version: 2 }) + '\n'
    return { result: 'saved 01-saves v2: thimble/objects/01-saves.json\n' }
  })
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: e.path in files || e.path === `${ROOT}/thimble/objects` }))
  on('fs.list', () => ({ value: [] }))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: files[e.path] ?? promptStub(e.path) ?? '' }))
  on('fs.write', (_$: unknown, e: { path: string; content?: string; text?: string; data?: string }) => { files[e.path] = String(e.content ?? e.text ?? e.data ?? ''); return { value: undefined } })
  const preps: Any[] = []
  on('process.run', (_$: unknown, e: { argv: string[]; init?: { stdin?: string } }) => {
    let out: unknown = {}
    if (e.argv.some(a => a.endsWith('prep.mjs'))) {
      const input = JSON.parse(String(e.init?.stdin || '{}'))
      preps.push(input)
      out = { drawing: draw(input), verbs: [], problems: [] }
    } else if (e.argv.some(a => a.endsWith('verb.mjs')) && e.argv.includes('list')) out = { verbs: [{ key: 'v', name: 'visualize', row: true, order: 0 }, { key: 's', name: 'squeeze', row: true, order: 1 }] }
    else if (e.argv.includes('coverage')) out = { feeding: [{ path: 'revisions.jsonl' }], not_feeding: [] }
    else if (e.argv.includes('resolve')) out = { ref: e.argv[2], chain: [], rows: [], count: 3, records: [{ text: 'Hello agents' }], notes: [] }
    return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: JSON.stringify({ ready: { port: 41234, token: 'tok' } }) + '\n' }
    for (const l of serverLines) yield { stream: 'stdout', text: JSON.stringify(l) + '\n' }
    return { value: { code: 0, signal: null } }
  })
  on('prompt.edit', (_$: unknown, e: { text: string; start: number; end: number; inputText: string }) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
  const toasts: string[] = []
  on('ui.toast', (_$: unknown, e: { text?: string }) => { toasts.push(String(e.text ?? '')); return { value: undefined } })
  on('command.register', (_$: unknown, e: { name: string }) => ({ value: { command: e.name } }))
  on('agent.register', () => ({ value: { agent: 'thimble:thread' } }))
  on('config.list', () => ({ value: [] }))
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the reply'] }) as never)
  return { files, preps, toasts }
}

function textOf(n: Any): string {
  if (n == null || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  return textOf(n.props?.children) + textOf(n.children)
}
const HINT = { plugin: 'thimble', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows: 16, bodyColumns: 200, scroll: { offset: 0, bodyRows: 16 }, view: {} }, viewport: { columns: 200, rows: 48, isFullscreen: true } } as never
const PANE = { plugin: 'thimble', component: 'Pane', surface: 'terminal', requestId: 'object', props: { bodyColumns: 100, scroll: { bodyRows: 40, offset: 0 }, isFocused: true, placement: 'dock', title: 'Saves per day', view: {} } } as never
const edit = (key: string, text = '') => ({ origin: { kind: 'composer' }, key: { key }, text, cursor: text.length, start: text.length, end: text.length, inputText: key.length === 1 ? key : '' }) as never
const reply = ($: Any) => $.ui.render({ plugin: 'thimble', component: 'AssistantMessage', surface: 'terminal', requestId: ROW, props: { text: 'June 18 had the most saves.', isFirstOfReply: true }, viewport: { columns: 100, rows: 40, isFullscreen: true } } as never)
// the Text runs drawn with a fill, and their words
const filled = (n: Any): string => (Array.isArray(n) ? n.map(filled).join('') : n && typeof n === 'object' ? (n.props?.backgroundColor === 'selectionBg' ? textOf(n) : filled(n.children ?? n.props?.children)) : '')

async function savedTurn($: Any, clock: { settle: () => Promise<void> }) {
  await $.turn.start({ turnId: 't1', text: 'when?' } as never)
  await $.tool.call({ tool: 'Bash', command: 'thimble save saves' } as never)
  await $.session.append({ door: 'response', uuid: ROW, origin: { kind: 'model', model: 'm' }, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'June 18 had the most saves.' }] } } as never)
  await $.turn.complete({ turnId: 't1', answer: 'June 18 had the most saves.', durationMs: 5, reason: 'answer', isAborted: false } as never)
  await clock.settle()
}

test('a card under a reply is drawn as it was left (its state, its part); at rest the verbs keep their keys, and ] gives the card the focus: its own keys win, the bar names them, 0 gives them back', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  await savedTurn($, clock)
  // at rest the bar names the verbs, ] to reach the card and 1 for its detail, never the card's own keys
  await $.ui.render(HINT)
  await clock.settle()
  const rest = textOf(await $.ui.render(HINT))
  expect(rest).toContain('v visualize · s squeeze · ] card · 1 open detail')
  expect(rest).not.toContain('next day')
  // under the reply: the state and the part the person left it at (here, in the browser)
  await reply($)
  await clock.settle()
  const tree = await reply($)
  expect(w.preps.some(p => p.mode === 'inline' && p.state?.at === 2)).toBe(true)
  expect(filled(tree)).toContain('Jun 18')
  expect(filled(tree)).not.toContain('Jun 17')
  // the card's program learns the keys the terminal keeps under a reply (k.keys)
  expect(Object.keys(w.preps.find(p => p.mode === 'inline')?.keys?.taken ?? {})).toEqual([])
  // j at rest is not the card's: it types
  expect(await press($, clock, edit('j'))).toEqual({ text: 'j', cursor: 1 })
  // ] gives the card the focus: the bar names its keys, then the host's
  expect(await press($, clock, edit(']'))).toEqual({ text: '', cursor: 0 })
  await clock.settle()
  expect(textOf(await $.ui.render(HINT))).toContain('j next day · 1 open detail · ] next · 0 back')
  // j now is the card's: its program answers, and the state is kept for every surface
  expect(await press($, clock, edit('j'))).toEqual({ text: '', cursor: 0 })
  await clock.settle()
  expect(w.preps.some(p => p.event?.key === 'j' && p.mode === 'inline')).toBe(true)
  expect(JSON.parse(w.files[`${ROOT}/thimble/objects/.state/01-saves.json`]!)).toMatchObject({ state: { at: 3 }, region: 'day-2026-06-18', by: 'terminal' })
  // a letter straight after it: j began a word, and the card goes back to where it was
  expect(await press($, clock, edit('u'))).toEqual({ text: 'ju', cursor: 2 })
  expect(JSON.parse(w.files[`${ROOT}/thimble/objects/.state/01-saves.json`]!).state).toEqual({ at: 2 })
})

test('a card whose key is a verb\'s letter: at rest the verb takes it, with the focus the card does', async ($, on) => {
  const clock = mock.clock(on)
  // the card's flip is on v, the visualize verb's letter
  const run = (input: Any) => {
    const d = drawingFor(input)
    const flipped = !!input.state?.flip
    const on = [{ name: 'v', label: 'flip' }]
    if (input.event?.key === 'v') return { ...d, on, state: { ...input.state, flip: !flipped }, handled: 'v' }
    return { ...d, on, state: input.state || {} }
  }
  const w = world(on, [], run)
  await savedTurn($, clock)
  await reply($)
  await clock.settle()
  // at rest v opens the views line under the message, and the card's state is as it was
  expect(await press($, clock, edit('v'))).toEqual({ text: '', cursor: 0 })
  await clock.settle()
  expect(textOf(await reply($))).toContain('▸ 1 another view of this answer')
  expect(w.preps.some(p => p.event?.key === 'v')).toBe(false)
  // 0 closes the line; ] gives the card the focus, and v is its flip now, named in the bar
  await press($, clock, edit('0'))
  await press($, clock, edit(']'))
  await clock.settle()
  expect(textOf(await $.ui.render(HINT))).toContain('v flip · 1 open detail · ] next · 0 back')
  expect(await press($, clock, edit('v'))).toEqual({ text: '', cursor: 0 })
  await clock.settle()
  expect(w.preps.some(p => p.event?.key === 'v' && p.mode === 'inline')).toBe(true)
  expect(JSON.parse(w.files[`${ROOT}/thimble/objects/.state/01-saves.json`]!).state.flip).toBe(true)
  // 0 gives the keys back: v is the verb's again
  await press($, clock, edit('0'))
  await clock.settle()
  expect(textOf(await $.ui.render(HINT))).toContain('v visualize')
})

test('the detail is one program for both surfaces: the browser\'s state draws here, and the terminal\'s is kept where the page reads it', { options: { browser: true } }, async ($, on) => {
  const w = world(on, [{ panestate: { pane: 'detail', args: { id: '01-saves' }, state: { region: 'day-2026-06-17', bar: 'details' } } }])
  const clock = mock.clock(on)
  mock.session(on)
  await $.command.run({ command: 'obj', args: '01-saves' } as never)
  await clock.settle()
  // the card draws, then draws again with the state it was left at (each drawing a child run, settled here)
  for (let i = 0; i < 3; i++) {
    await $.ui.render(PANE)
    await clock.settle()
  }
  // the terminal's e: the examples of the part, kept in the pane's state file for the page
  expect(await press($, clock, edit('e'))).toEqual({ text: '', cursor: 0 })
  await clock.settle()
  const kept = JSON.parse(w.files[`${ROOT}/thimble/panes/${SESSION}/detail-01-saves.json`]!)
  expect(kept).toMatchObject({ pane: 'detail', state: { bar: 'examples' }, by: 'terminal' })
  // the page's run of the same program selects Jun 17 and shows its details: the terminal's pane draws the same
  await $.command.run({ command: 'browser', args: '' } as never)
  await clock.settle()
  await $.ui.render(PANE)
  await clock.settle()
  const t = textOf(await $.ui.render(PANE))
  expect(t).toContain('Jun 17')
  expect(t).toContain('from revisions.jsonl')
  expect(t).not.toContain('examples of')
  // and the card under the reply marks the same part
  expect(JSON.parse(w.files[`${ROOT}/thimble/objects/.state/01-saves.json`]!)).toMatchObject({ region: 'day-2026-06-17', by: 'browser' })
  expect(textOf(await $.ui.render(HINT))).toContain('j next day · ↑↓ part · e examples · 0 clear')
})
