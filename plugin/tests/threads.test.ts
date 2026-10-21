// The side panel as a thread (shell/side.ts, shell/detail.tsx, shell/thread.ts): a question typed in its input bar is
// asked once, even when ↵ comes twice before the thread's agent has started. `claude plugin test plugin`. The drawing
// and `thimble resolve` are answered here, at process.run.
import { expect, mock, test } from 'claude-code/testing'
import { press, promptStub } from './stubs'

const ROOT = '/data'
const SESSION = 's-1'
const OBJECT = {
  id: '01-saves', version: 2, title: 'Saves per day', program: 'return k.stack(...)', text: 'June 18 had [6,543](#day-2026-06-18) saves.',
  history: [{ v: 1, at: 'a' }, { v: 2, at: 'b' }], data: { days: [] }, lineage: { cites: [], rows: { 'revisions.jsonl': { count: 6543 } } },
}
const LINKS = { ...OBJECT, id: '02-links', version: 1, title: 'Links per day', history: [{ v: 1, at: 'c' }] }
const region = (id: string, label: string) => ({ t: 'region', id, meta: { label, ref: `q1#day=${id.slice(4)}@n` }, kid: { t: 'text', runs: [{ s: `${label} ${'▆'.repeat(10)}`, tone: 'ink' }], wrap: false, w: 30 } })
const DRAWING = {
  kit: 1, w: 98, h: 24, mode: 'detail',
  root: { t: 'stack', kids: [region('day-2026-06-17', 'Jun 17'), region('day-2026-06-18', 'Jun 18')] },
  cites: {}, examples: {}, regions: [{ id: 'day-2026-06-17', meta: { label: 'Jun 17', ref: 'q1#day=2026-06-17@n' } }, { id: 'day-2026-06-18', meta: { label: 'Jun 18', ref: 'q1#day=2026-06-18@n' } }], warnings: [], ms: 1,
}
const RESOLVED = { ref: 'q1#day=2026-06-18@n', chain: [{ step: 'query', id: 'q1', about: 'saves per day' }], rows: ['revisions.jsonl#L28-31'], count: 4, records: [{ ref: 'revisions.jsonl#L28', text: 'x' }], notes: [] }
const ROW = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const MARKED = 'Mostly [6,543 saves](q1#day=2026-06-18@n) on June 18, from [this one](revisions.jsonl#L28) on.'
const PANE = { component: 'Pane', surface: 'terminal', requestId: 'object', props: { bodyColumns: 100, scroll: { bodyRows: 60, offset: 0 }, isFocused: true, placement: 'dock', title: 'Saves per day', view: {} } } as never
const edit = (key: string, text = '') => ({ origin: { kind: 'composer' }, key: { key }, text, cursor: text.length, start: text.length, end: text.length, inputText: key.length === 1 ? key : '' }) as never

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function world(on: any, open: Any = { isPlaced: true }) {
  mock.env(on, { THIMBLE_HOME: '/home/t/.thimble' })
  on('session.cwd', () => ({ value: ROOT }))
  on('session.id', () => ({ value: SESSION }))
  const files: Record<string, string> = {
    [`${ROOT}/thimble/objects/01-saves.json`]: JSON.stringify(OBJECT),
    [`${ROOT}/thimble/objects/02-links.json`]: JSON.stringify(LINKS),
  }
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: e.path in files || e.path === `${ROOT}/thimble/objects` }))
  on('fs.list', () => ({ value: [] }))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: files[e.path] ?? promptStub(e.path) ?? '' }))
  on('fs.write', (_$: unknown, e: { path: string; content?: string; text?: string; data?: string }) => { files[e.path] = String(e.content ?? e.text ?? e.data ?? ''); return { value: undefined } })
  on('process.run', (_$: unknown, e: { argv: string[] }) => {
    const out = e.argv.some(a => a.endsWith('prep.mjs')) ? { drawing: DRAWING } : e.argv.includes('resolve') ? RESOLVED : {}
    return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const opened: Any[] = []
  on('ui.open', (_$: unknown, e: Any) => { opened.push(e); return { value: open } })
  // whether the panel holds the keys (a test gives them to the prompt), and each element the ring was put on
  const keys = { panel: true, rings: [] as string[] }
  on('ui.focus', (_$: unknown, e: Any) => { keys.rings.push(String(e.element ?? e.key)); return { value: {} } })
  on('ui.close', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: opened.length ? [{ id: 'object', title: 'Saves per day', isShown: true, isFocused: keys.panel, isPlaced: true, plugin: 'thimble' }] : [] }))
  const views: Any[] = []
  on('ui.view', (_$: unknown, e: Any) => { views.push(e); return { value: {} } })
  on('prompt.edit', (_$: unknown, e: { text: string; start: number; end: number; inputText: string }) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
  on('prompt.fill', () => ({ isFilled: true }))
  const submitted: string[] = []
  on('prompt.submit', (_$: unknown, e: { text: string }) => { submitted.push(e.text); return { text: e.text } })
  // each thread's agent: its transcript grows with each question it gets and each answer a test gives it
  const spawns: Any[] = []
  const transcripts = new Map<string, Any[]>()
  on('agent.register', () => ({ value: { agent: 'thimble:thread' } }))
  on('agent.spawn', (_$: unknown, e: Any) => {
    spawns.push(e)
    const id = `agent-${spawns.length}`
    transcripts.set(id, [{ role: 'user', content: [{ type: 'text', text: '<system-reminder>env</system-reminder>' }, { type: 'text', text: e.prompt }] }])
    return { model: 'claude-test', agentId: id } as never
  })
  // an agent whose turn ended is completed; a message sent to it while it works joins its run
  const ended = new Set<string>()
  on('agent.list', () => ({ value: spawns.map((_, i) => ({ id: `agent-${i + 1}`, type: 'thimble:thread', description: 'thread', status: ended.has(`agent-${i + 1}`) ? 'completed' : 'running' })) }))
  const sent: Any[] = []
  on('session.send', (_$: unknown, e: Any) => {
    sent.push(e)
    const id = typeof e.to === 'string' ? e.to : e.to?.agentId
    transcripts.get(id)?.push({ role: 'user', content: [{ type: 'text', text: `The coordinator sent a message while you were working:\n${e.text}\n\nAddress this before completing your current task.` }] })
    return { isDelivered: true }
  })
  on('session.messages', (_$: unknown, e: Any) => ({ value: transcripts.get(e.agentId) ?? [] }))
  const toasts: string[] = []
  on('ui.toast', (_$: unknown, e: { text?: string }) => { toasts.push(String(e.text ?? '')); return { value: undefined } })
  on('config.list', () => ({ value: [] }))
  on('turn.start', (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: 'ok' }))
  on('command.register', (_$: unknown, e: { name: string }) => ({ value: { command: e.name } }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: [''] }) as never)
  return { files, opened, views, submitted, spawns, sent, toasts, keys }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function textOf(n: any): string {
  if (n == null || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  return textOf(n.props?.children) + textOf(n.children)
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pane = async ($: any, clock: { settle: () => Promise<void> }) => { for (let i = 0; i < 3; i++) { await $.ui.render(PANE); await clock.settle() } return textOf(await $.ui.render(PANE)) }
/** The input bar's field as the panel draws it now: its key and the text it holds. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fieldOf = async ($: any, at: unknown = PANE) => {
  const s = JSON.stringify(await $.ui.render(at))
  return { key: /"key":"(ask-\d+)"/.exec(s)?.[1] ?? '', value: /"key":"ask-\d+"[^}]*?"value":"([^"]*)"/.exec(s)?.[1] ?? /"value":"([^"]*)"[^}]*?"key":"ask-\d+"/.exec(s)?.[1] ?? '' }
}
/** The panel, mounted once per test (the kit holds one mount of an instance). */
const mounts = new WeakMap<object, Any>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function mounted($: any): Promise<Any> {
  if (!mounts.has($)) mounts.set($, await $.ui.mount({ plugin: 'thimble', ...(PANE as Any) } as never))
  return mounts.get($)
}

/** A turn of main's that answers with marked words: its record is written, so ] opens its marks in the tray. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function markedTurn($: any, clock: { settle: () => Promise<void> }) {
  await $.turn.start({ turnId: 't1', text: 'when?' } as never)
  await $.session.append({ door: 'prompt', uuid: 'pppppppp-0000-0000-0000-000000000000', origin: { kind: 'composer' }, message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'when?' }] } } as never)
  await $.session.append({ door: 'response', uuid: ROW, origin: { kind: 'model', model: 'm' }, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: MARKED }] } } as never)
  await $.turn.complete({ turnId: 't1', answer: MARKED, durationMs: 5, reason: 'answer', isAborted: false } as never)
  await clock.settle()
}

test('a second ↵ while the thread\'s agent starts sends nothing more: the question is asked once', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  await markedTurn($, clock)
  await press($, clock, edit(']'))
  await press($, clock, edit('a'))
  await clock.advance(2000)
  await pane($, clock)
  const ui = await mounted($)
  const field = (await fieldOf($)).key
  // ↵, and ↵ again before the first has started the thread's agent
  await Promise.all([ui.input({ key: field, text: 'why so high?' }), ui.input({ key: field, text: 'why so high?' })])
  await clock.settle()
  expect(w.spawns.length).toBe(1)
  const file = JSON.parse(w.files[`${ROOT}/thimble/threads/${SESSION}/mark-aaaaaaaa-bbbb-cccc-dddd-q1-day-2026-06-18-n.json`]!)
  expect(file.asks.map((a: Any) => a.text)).toEqual(['why so high?'])
})

test('] stops at the newest reply\'s last mark: it never runs on into the first reply, whose marks are off screen', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  await markedTurn($, clock)
  // a second reply with the same two marks
  const NEWER = 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee'
  await $.turn.start({ turnId: 't2', text: 'and then?' } as never)
  await $.session.append({ door: 'prompt', uuid: 'pppppppp-0000-0000-0000-000000000001', origin: { kind: 'composer' }, message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'and then?' }] } } as never)
  await $.session.append({ door: 'response', uuid: NEWER, origin: { kind: 'model', model: 'm' }, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: MARKED }] } } as never)
  await $.turn.complete({ turnId: 't2', answer: MARKED, durationMs: 5, reason: 'answer', isAborted: false } as never)
  await clock.settle()
  // four ]: the newest reply's two marks, then it stays on the last one; a asks about the mark the tray shows
  for (let n = 0; n < 4; n++) await press($, clock, edit(']'))
  await press($, clock, edit('a'))
  await clock.advance(2000)
  await pane($, clock)
  const ui = await mounted($)
  await ui.input({ key: (await fieldOf($)).key, text: 'why this one?' })
  await clock.settle()
  const threads = Object.keys(w.files).filter(f => f.includes(`/thimble/threads/${SESSION}/`)).map(f => f.split('/').pop())
  expect(threads).toEqual(['mark-ffffffff-bbbb-cccc-dddd-revisions.jsonl-L28.json'])
})
