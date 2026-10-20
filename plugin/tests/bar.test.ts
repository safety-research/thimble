// The bar and the keys (shell/shell.tsx) and work a key asks of Claude beside the conversation (shell/aside.ts): the bar
// is there from a session's start, its keys dim until there is an answer to act on (and then they type); while Claude
// works the keys act on the last finished answer; a click on a key of the bar does what the key does, and an item at
// its right is words until a module makes it a press (pressableBarItem); v makes its card in a fork of the
// conversation, drawn under the answer, with one line under it while it works, and main reads one row naming the card.
// `claude plugin test`. The Node children (the drawing, `thimble resolve`) are answered here, at process.run.
import { expect, mock, test } from 'claude-code/testing'

import { press, promptStub } from './stubs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
const ROOT = '/data'
const DRAWING = { kit: 1, w: 40, h: 24, mode: 'inline', root: { t: 'stack', kids: [{ t: 'region', id: 'day-2026-06-18', meta: { label: 'Jun 18 6,543' }, kid: { t: 'text', runs: [{ s: 'Jun 18 6,543', tone: 'ink' }], wrap: false } }] }, cites: {}, examples: {}, regions: [{ id: 'day-2026-06-18', meta: { label: 'Jun 18 6,543' } }], warnings: [], ms: 2 }
const EVENTS = '/home/t/.thimble/lean/events/s-1.jsonl'
const ROW = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const AT = ROW.slice(0, 24)
const ANSWER = 'June 18 had the most saves, [6,543](q1#day=2026-06-18@n) of them.'
const HINT = { plugin: 'thimble', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows: 16, bodyColumns: 200, scroll: { offset: 0, bodyRows: 16 }, view: {} }, viewport: { columns: 200, rows: 48, isFullscreen: true } } as never
const WORKING = { ...(HINT as Any), props: { ...(HINT as Any).props, isWorking: true } } as never
const REPLY = { plugin: 'thimble', component: 'AssistantMessage', surface: 'terminal', requestId: ROW, props: { text: ANSWER, isFirstOfReply: true }, viewport: { columns: 100, rows: 40, isFullscreen: true } } as never
const edit = (key: string, text = '') => ({ origin: { kind: 'composer' }, key: { key }, text, cursor: text.length, start: text.length, end: text.length, inputText: key.length === 1 ? key : '' }) as never

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
const dimText = (t: Any) => { const out: string[] = []; walk(t, x => { if (x.type === 'Text' && x.props?.dimColor) out.push(textOf(x)) }); return out.join('|') }
const buttons = (t: Any) => { const out: Any[] = []; walk(t, x => { if (x.type === 'Button') out.push(x) }); return out }

/** A save the kernel writes to the change feed, as a Bash call that saves `id` does. */
function feedSave(files: Record<string, string>, id: string, v = 1): void {
  files[EVENTS] = (files[EVENTS] || '') + JSON.stringify({ t: Date.now() / 1000, kind: 'save', session: 's-1', root: ROOT, object: id, version: v }) + '\n'
}

function world(on: Any, o: { read?: number } = {}) {
  mock.env(on, { THIMBLE_HOME: '/home/t/.thimble' })
  on('turn.start', (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.cwd', () => ({ value: ROOT }))
  on('session.id', () => ({ value: 's-1' }))
  on('config.list', () => ({ value: [] }))
  on('command.register', (_$: unknown, e: { name: string }) => ({ value: { command: e.name } }))
  const object = (id: string) => JSON.stringify({ id, version: 1, title: `Card ${id}`, program: 'return k.text("x")', data: {}, lineage: { cites: [] } })
  const files: Record<string, string> = { [`${ROOT}/thimble/objects/02-view.json`]: object('02-view') }
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: e.path in files || e.path === `${ROOT}/thimble/objects` }))
  on('fs.list', () => ({ value: [] }))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: files[e.path] ?? promptStub(e.path) ?? '' }))
  on('fs.write', (_$: unknown, e: { path: string; content?: string; text?: string; data?: string }) => { files[e.path] = String(e.content ?? e.text ?? e.data ?? ''); return { value: undefined } })
  on('process.run', (_$: unknown, e: { argv: string[]; init?: { stdin?: string } }) => {
    if (e.argv[0] === 'tail') return { value: { exitCode: 0, stdout: (files[e.argv[3]!] ?? '').slice(Number(e.argv[2]!.slice(1)) - 1), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    const prep = e.argv.some(a => a.endsWith('prep.mjs')) ? JSON.parse(String(e.init?.stdin || '{}')) : null
    const read = o.read ?? 0
    const out = prep ? { drawing: DRAWING, ...(prep.check ? { check: { line: null, tried: 0, total: 0, failed: 0, cut: 0, ms: 1 } } : {}) } : e.argv.includes('coverage') ? { files: [{ path: 'a.csv', rows: 4, lines: 4, status: 'computed', computed: read * 4 }], total: { files: 1, rows: 4, read_share: read } } : {}
    return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const submitted: string[] = []
  on('prompt.submit', (_$: unknown, e: { text: string }) => { submitted.push(e.text); return { text: e.text } })
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.edit', (_$: unknown, e: { text: string; start: number; end: number; inputText: string }) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the reply'] }) as never)
  return { files, submitted }
}

async function answered($: Any, clock: { settle: () => Promise<void> }): Promise<void> {
  await $.turn.start({ turnId: 't1', text: 'when?' } as never)
  await $.session.append({ door: 'prompt', uuid: 'pppppppp-0000-0000-0000-000000000000', origin: { kind: 'composer' }, message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'when?' }] } } as never)
  await $.session.append({ door: 'response', uuid: ROW, origin: { kind: 'model', model: 'm' }, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: ANSWER }] } } as never)
  await $.turn.complete({ turnId: 't1', answer: ANSWER, durationMs: 5, reason: 'answer', isAborted: false } as never)
  await clock.settle()
}

test('the bar is there from the start of a session: its keys dim while there is no answer, and they type as letters', async ($, on) => {
  world(on)
  const clock = mock.clock(on)
  await clock.settle()
  const bar = await $.ui.render(HINT)
  expect(textOf(bar)).toContain('thimble  v visualize · s squeeze · ] cite & explain')
  expect(dimText(bar)).toContain('v visualize| · |s squeeze| · |] cite & explain')
  // nothing to act on: no key of it is a press, and v types
  expect(buttons(bar).length).toBe(0)
  expect(await press($, clock, edit('v'))).toEqual({ text: 'v', cursor: 1 })
  // while the first turn runs, the same
  await $.turn.start({ turnId: 't1', text: 'when?' } as never)
  expect(dimText(await $.ui.render(WORKING))).toContain('v visualize')
})

test('while Claude works the keys act on the last finished answer: the bar names them, and s opens the chips under it', async ($, on) => {
  world(on)
  const clock = mock.clock(on)
  await answered($, clock)
  await $.turn.start({ turnId: 't2', text: 'and the day before?' } as never)
  const bar = textOf(await $.ui.render(WORKING))
  expect(bar).toContain('thimble  v visualize · s squeeze · ] cite & explain')
  expect(await press($, clock, edit('s'))).toEqual({ text: '', cursor: 0 })
  expect(textOf(await $.ui.render(WORKING))).toContain('[ ] shorter / longer · 1–3 pick chip')
  expect(textOf(await $.ui.render(REPLY))).toContain('1 Length')
})

test('a click on a key of the bar does what the key does; an item at its right is a press only where a module made it one', async ($, on) => {
  world(on)
  const clock = mock.clock(on)
  await answered($, clock)
  const ui = await $.ui.mount(HINT)
  await clock.settle()
  // s by a click: the chips open, and the bar names their keys, each a press ([ and ] one by one)
  await ui.press({ key: buttons(await ui.drawn()).find((b: Any) => b.props.label === 'squeeze').props.key })
  await clock.settle()
  const keys = buttons(await ui.drawn()).map((b: Any) => String(b.props.label))
  expect(keys).toContain('[ shorter / longer')
  expect(keys).toContain('] shorter / longer')
  // s done, by a click: the chips close
  await ui.press({ key: buttons(await ui.drawn()).find((b: Any) => b.props.label === 'done').props.key })
  await clock.settle()
  expect(textOf(await ui.drawn())).toContain('v visualize · s squeeze')
  // coverage is words until a module makes it a press; its click is then that module's ui.press hook
  expect(buttons(await ui.drawn()).some((b: Any) => String(b.props.key).startsWith('bar-item-'))).toBe(false)
  await ui.unmount()
})

test('v makes its card beside the conversation: a fork, no prompt and no reply in the chat, one line under the answer while it works, the card under the answer, and a row main reads naming it', async ($, on) => {
  const w = world(on)
  const session = mock.session(on)
  const clock = mock.clock(on)
  const spawns: Any[] = []
  on('agent.spawn', (_$: unknown, e: Any) => { spawns.push(e); return { model: 'claude-test' } as never })
  // the agent the engine started, as its list names it (a hook's answer carries no agentId: core sets it)
  on('agent.list', () => ({ value: spawns.map((_, i) => ({ id: `fork-${i + 1}`, type: 'fork', description: 'thimble · visualize', status: 'running' })) }))
  on('session.messages', () => ({ value: [{ role: 'assistant', text: '', toolUses: [{ tool: 'Bash', input: { command: 'thimble run q2.py' } }] }] }))
  // the fork's own call that saves its card (below): the kernel writes the save to the change feed
  on('tool.call', (_$: unknown, e: Any) => { if (String(e.command).startsWith('thimble save 02-view')) feedSave(w.files, '02-view'); return { result: 'ok' } })
  await answered($, clock)
  // v on an empty prompt; it waits a moment (a letter typed then makes it the start of a word), then starts the fork
  expect(await press($, clock, edit('v'))).toEqual({ text: '', cursor: 0 })
  await clock.advance(700)
  await clock.settle()
  expect(spawns.length).toBe(1)
  expect(spawns[0].subagent_type).toBe('fork')
  expect(spawns[0].prompt).toContain('The analyst pressed v (visualize) on your answer that begins "June 18 had the most saves, 6,543 of them."')
  expect(spawns[0].prompt).toContain('You work in the background, beside the conversation: the analyst sees none of your messages, only the card, drawn under that answer, so ask them nothing.')
  // no prompt in the chat, and its line under the answer says how far it is
  expect(w.submitted).toEqual([])
  await clock.advance(1000)
  await clock.settle()
  expect(textOf(await $.ui.render(REPLY))).toMatch(/visualize… another view of this answer · 1 step · \ds/)
  // v again while it works asks nothing more
  await press($, clock, edit('v'))
  await clock.advance(700)
  await clock.settle()
  expect(spawns.length).toBe(1)
  // the fork saves its card in a call of its own: drawn under the answer at once
  await $.tool.call({ tool: 'Bash', command: 'thimble save 02-view --from /tmp/v.json', agentId: 'fork-1' } as never)
  await clock.settle()
  await $.ui.render(REPLY)
  await clock.settle()
  const drawn = textOf(await $.ui.render(REPLY))
  expect(drawn).toContain('Jun 18 6,543')
  // its end: the line goes, and main reads one row naming the card (the person sees none)
  await $.turn.complete({ turnId: 'f1', agentId: 'fork-1', answer: 'Saved 02-view.', durationMs: 5, reason: 'answer', isAborted: false } as never)
  await clock.settle()
  expect(textOf(await $.ui.render(REPLY))).not.toContain('visualize…')
  const rows = session.appended() as unknown as { door: string; message: { type: string; content: { text?: string }[] } }[]
  const note = rows.filter(r => r.door === 'note' && r.message.content.some(b => String(b.text).includes('A copy of you that worked in the background made the card 02-view@1')))
  expect(note.length).toBe(1)
  // its report in main's queue is dropped
  const r = await $.prompt.submit({ text: '<task-notification><task-id>fork-1</task-id><status>completed</status></task-notification>', origin: { kind: 'task-notification' } } as never)
  expect((r as Any).drop).toBeDefined()
})

test("a fork whose calls this plugin does not hear: its card is read from the change feed at its end and drawn under the answer; one that saved nothing says so under it", async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  let n = 0
  on('agent.spawn', () => { n++; return { model: 'claude-test' } as never })
  on('agent.list', () => ({ value: Array.from({ length: n }, (_, i) => ({ id: `fork-${i + 1}`, type: 'fork', description: 'thimble · visualize', status: 'running' })) }))
  on('session.messages', () => ({ value: [] }))
  await answered($, clock)
  await press($, clock, edit('v'))
  await clock.advance(700)
  await clock.settle()
  // the save is in the feed, but no call of the fork reached the hooks
  expect(textOf(await $.ui.render(REPLY))).toContain('visualize… another view of this answer')
  feedSave(w.files, '02-view')
  await $.turn.complete({ turnId: 'f1', agentId: 'fork-1', answer: 'Saved 02-view.', durationMs: 5, reason: 'answer', isAborted: false } as never)
  await clock.settle()
  await $.ui.render(REPLY)
  await clock.settle()
  expect(textOf(await $.ui.render(REPLY))).toContain('Jun 18 6,543')
  // a second v whose fork saves nothing: the line says so, with how to try again
  await press($, clock, edit('v'))
  await clock.advance(700)
  await clock.settle()
  await $.turn.complete({ turnId: 'f2', agentId: 'fork-2', answer: 'I could not find the data.', durationMs: 5, reason: 'answer', isAborted: false } as never)
  await clock.settle()
  expect(textOf(await $.ui.render(REPLY))).toContain('× visualize made no card: I could not find the data. · press v to try again')
})

test('where no fork can start, v asks main as before: a turn whose row reads as the press', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  on('agent.spawn', () => ({ deny: 'forks are off here' }) as never)
  await answered($, clock)
  await press($, clock, edit('v'))
  await clock.advance(700)
  await clock.settle()
  expect(w.submitted).toEqual(['visualize another view of this answer'])
  expect(AT.length).toBe(24)
})
