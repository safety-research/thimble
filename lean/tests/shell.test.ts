// The shell's hooks (shell/shell.tsx): an object Claude saves is placed under the turn's next words, a prompt asked
// while the detail view is open carries the object and its selected part, /verb lists the verbs for an object, a verb
// of the message row draws what it made under the same message, a verb's call to the model is made by the module,
// what a verb says for Claude goes with the next prompt, a verb's request to Claude reads as one line, and a resumed
// session draws its objects again. The message layer: each message's record on disk, its marks drawn inline, the verb
// row under the answer, the keys of an empty prompt, the tray and a question asked from it. `claude plugin test lean`.
// The Node children (the drawing, a verb's run, `lean resolve`) are answered here, at process.run.
import { expect, mock, test } from 'claude-code/testing'

import { plainWhy } from '../shell/shell'

const ROOT = '/data'
const FILE = `${ROOT}/thimble/objects/01-saves.json`
const OBJECT = {
  id: '01-saves', version: 1, title: 'Saves per day', question: 'When did the agents edit the wiki most?',
  program: 'return k.bars(...)', data: { days: [{ day: '2026-06-18', n: 6543, _rows: ['revisions.jsonl#L28-31'] }] },
  lineage: { cites: [] },
}
const DRAWING = { kit: 1, w: 40, h: 24, mode: 'inline', root: { t: 'stack', kids: [{ t: 'region', id: 'day-2026-06-18', meta: { ref: 'q1#day=2026-06-18@n', label: 'Jun 18 6,543' }, kid: { t: 'beside', kids: [{ t: 'text', runs: [{ s: 'Jun 18', tone: 'ink' }], wrap: false, w: 6 }, { t: 'bar', tone: 'accent', value: 6543, max: 6543 }, { t: 'text', runs: [{ s: '6,543', tone: 'ink' }], align: 'right', w: 5 }], gap: 1 } }] }, cites: {}, examples: {}, regions: [{ id: 'day-2026-06-18', meta: { ref: 'q1#day=2026-06-18@n', label: 'Jun 18 6,543' } }], warnings: [], ms: 2 }
const VERBS = [
  { key: 's', name: 'squeeze', line: 'shorter', phrase: null, picked: false },
  { key: 'x', name: 'explore', line: 'a view to explore', phrase: 'explore 1 day', picked: true },
  { key: 't', name: 'trace', line: 'where it came from', phrase: 'where these numbers come from', picked: true },
]
const RESOLVED = { ref: 'q1#day=2026-06-18@n', chain: [{ step: 'query', id: 'q1', about: 'saves per day' }], rows: ['revisions.jsonl#L28-31'], count: 4, records: [{ ref: 'revisions.jsonl#L28', text: 'x' }], notes: [] }

const TRACE = { ...OBJECT, id: '02-trace', title: 'Trace · Jun 18', verb: 'trace' }
const SHOWN = '/home/t/.thimble/lean/shown/s-1.json'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Verb = (input: any) => unknown
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function world(on: any, verb: Verb = () => ({ verb: 'trace', text: 'ok' }), drawing: unknown = DRAWING) {
  mock.env(on, { THIMBLE_HOME: '/home/t/.thimble' })
  on('turn.start', (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.cwd', () => ({ value: ROOT }))
  on('session.id', () => ({ value: 's-1' }))
  const files: Record<string, string> = { [FILE]: JSON.stringify(OBJECT), [`${ROOT}/thimble/objects/02-trace.json`]: JSON.stringify(TRACE) }
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: e.path in files || e.path === `${ROOT}/thimble/objects` }))
  on('fs.list', (_$: unknown, e: { path?: string }) => ({ value: e.path === `${ROOT}/thimble/objects` ? [{ name: '01-saves.json', kind: 'file', size: 1, mtimeMs: 0, isLink: false }] : [] }))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: files[e.path] ?? '' }))
  on('fs.write', (_$: unknown, e: { path: string; content?: string; text?: string; data?: string }) => {
    files[e.path] = String(e.content ?? e.text ?? e.data ?? '')
    return { value: undefined }
  })
  const runs: string[][] = []
  const inputs: unknown[] = []
  on('process.run', (_$: unknown, e: { argv: string[]; init?: { stdin?: string } }) => {
    runs.push([...e.argv])
    let out: unknown = {}
    if (e.argv.some(a => a.endsWith('prep.mjs'))) out = { drawing, verbs: VERBS, problems: [] }
    else if (e.argv.some(a => a.endsWith('verb.mjs'))) {
      const input = JSON.parse(String(e.init?.stdin || '{}'))
      inputs.push(input)
      out = verb(input)
    } else if (e.argv.includes('resolve')) out = RESOLVED
    else if (e.argv.includes('coverage')) out = { files: [{ path: 'revisions.jsonl', rows: 300, lines: 300, status: 'computed', computed: 102 }, { path: 'events.jsonl', rows: 300, lines: 300, status: 'not read', computed: 0 }] }
    return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const submitted: { text: string; context: readonly string[] }[] = []
  on('prompt.submit', (_$: unknown, e: { text: string; context?: readonly string[] }) => {
    submitted.push({ text: e.text, context: e.context ?? [] })
    return { text: e.text }
  })
  const toasts: string[] = []
  on('ui.toast', (_$: unknown, e: { text?: string }) => {
    toasts.push(String(e.text ?? ''))
    return { value: undefined }
  })
  // the prompt box, as its editor applies an edit
  on('prompt.edit', (_$: unknown, e: { text: string; start: number; end: number; inputText: string }) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
  // Claude Code's hint line under the prompt, as a hook leaves it
  on('ui.render', { component: 'PromptHint' }, (_$: unknown, e: { props: { hint: string } }) => ({ type: 'Text', props: {}, children: [String(e.props.hint)] }) as never)
  return { runs, inputs, files, submitted, toasts }
}

// every string a drawn tree holds, in order
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function textOf(n: any): string {
  if (n == null || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  return textOf(n.props?.children) + textOf(n.children)
}

const ROW = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const AT = ROW.slice(0, 24)
const MOUNT = { plugin: 'thimble-lean', component: 'AssistantMessage', surface: 'terminal', requestId: ROW, props: { text: 'June 18 had the most saves.', isFirstOfReply: true }, viewport: { columns: 100, rows: 40, isFullscreen: true } } as never
const BAND = { plugin: 'thimble-lean', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows: 16, bodyColumns: 110, scroll: { offset: 0, bodyRows: 16 }, view: {} }, viewport: { columns: 120, rows: 40, isFullscreen: true } } as never
const verbKey = (k: string) => `vr-${AT}-verb-${k}`
const HINT = { plugin: 'thimble-lean', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows: 16, bodyColumns: 200, scroll: { offset: 0, bodyRows: 16 }, view: {} }, viewport: { columns: 200, rows: 48, isFullscreen: true } } as never
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hintOf = async ($: any) => textOf(await $.ui.render(HINT))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
// every Button and every Markdown in a drawn tree
function walk(n: Node, f: (x: Node) => void): void {
  if (n == null || typeof n !== 'object') return
  if (Array.isArray(n)) { n.forEach(x => walk(x, f)); return }
  f(n)
  walk(n.props?.children, f)
  walk(n.children, f)
}
const buttons = (t: Node) => { const out: Node[] = []; walk(t, x => { if (x.type === 'Button') out.push(x) }); return out }
const markdowns = (t: Node) => { const out: string[] = []; walk(t, x => { if (x.type === 'Markdown') out.push(x.props.text) }); return out }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const reply = ($: any) => $.ui.render({ component: 'AssistantMessage', surface: 'terminal', requestId: ROW, props: { text: 'June 18 had the most saves.', isFirstOfReply: true }, viewport: { columns: 100, rows: 40, isFullscreen: true } } as never)

test('an object Claude saves is drawn under the next words of the turn; its verbs and 1 open detail are in the thimble line', async ($, on) => {
  world(on)
  const clock = mock.clock(on)
  const opened: string[] = []
  on('ui.open', (_$: unknown, e: { id: string }) => { opened.push(e.id); return { value: { isPlaced: true } } })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the reply'] }) as never)
  on('tool.call', () => ({ result: 'saved 01-saves v1: thimble/objects/01-saves.json\n  /days ← q1 (exact)\n' }))
  await $.turn.start({ turnId: 't1', text: 'when?' } as never)
  const saved = await $.tool.call({ tool: 'Bash', command: "lean save saves <<'JSON'\n{}\nJSON" } as never)
  // Claude reads what the person sees of it, after the command's own output
  expect(String((saved as { context?: string[] }).context)).toContain('01-saves@1 is drawn for the person under your reply')
  await $.session.append({ door: 'response', uuid: ROW, origin: { kind: 'model', model: 'm' }, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'June 18 had the most saves.' }] } } as never)
  const first = textOf(await reply($))
  expect(first).toContain('the reply')
  await $.turn.complete({ turnId: 't1', answer: 'June 18 had the most saves.', durationMs: 5, reason: 'answer', isAborted: false } as never)
  await clock.settle()
  const drawn = textOf(await reply($))
  expect(drawn).toContain('the reply')
  expect(drawn).toContain('Jun 18')
  expect(drawn).toContain('6,543')
  // the message, then the object with nothing under it; the keys act on this answer, so the thimble line above the
  // prompt names its verbs and what 1 does, and 1 on an empty prompt opens the card's detail view
  expect(drawn).not.toContain('visualize')
  expect(drawn).not.toContain('1 open detail')
  expect(await hintOf($)).toContain('thimble  v visualize · s squeeze · 1 open detail')
  expect(drawn).not.toContain('x explore')
  expect(drawn).not.toContain('? all')
  expect(await ($ as Any).prompt.edit(edit('1'))).toEqual({ text: '', cursor: 0 })
  expect(opened).toEqual(['object'])
})

test('a reply after no save draws as Claude Code draws it', async ($, on) => {
  world(on)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the reply'] }) as never)
  on('tool.call', () => ({ result: 'ok' }))
  await $.turn.start({ turnId: 't1', text: 'when?' } as never)
  await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  await $.session.append({ door: 'response', uuid: ROW, origin: { kind: 'model', model: 'm' }, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'June 18 had the most saves.' }] } } as never)
  expect(textOf(await reply($))).toBe('the reply')
})

test('while the detail view is open, a prompt carries the object and its selected part', async ($, on) => {
  const w = world(on)
  const { runs } = w
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'object', title: 'Saves per day', isShown: true, isFocused: false, isPlaced: true, plugin: 'thimble-lean' }] }))
  await $.command.run({ command: 'obj', args: 'saves day-2026-06-18' } as never)
  // the region's rows were resolved for the view, as the person's, not as what Claude read
  const resolve = runs.find(a => a.includes('resolve'))
  expect(resolve).toBeDefined()
  expect(resolve!.includes('q1#day=2026-06-18@n')).toBe(true)
  await $.prompt.submit({ text: 'why is this day so high?' } as never)
  const carried = w.submitted.at(-1)!.context
  expect(carried.length).toBe(1)
  expect(carried[0]).toContain('01-saves@1')
  expect(carried[0]).toContain('day-2026-06-18')
  expect(carried[0]).toContain('q1#day=2026-06-18@n')
})

test('/verb ? lists every verb for the object, the picked ones marked', async ($, on) => {
  world(on)
  on('tool.call', () => ({ result: 'saved 01-saves v1: thimble/objects/01-saves.json\n' }))
  await $.turn.start({ turnId: 't1', text: 'when?' } as never)
  await $.tool.call({ tool: 'Bash', command: 'lean save saves' } as never)
  const r = await $.command.run({ command: 'verb', args: '?' } as never)
  expect(String(r.text)).toContain('● x  explore')
  expect(String(r.text)).toContain('where these numbers come from')
  expect(String(r.text)).toContain('  s  squeeze')
})

test('a reply draws its citations inline, each underlined and a press that opens its source card in the tray', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the reply'] }) as never)
  const text = 'June 18 had [6,543 saves](q1#day=2026-06-18@n); [4,219](q9#kind=SEC via proxy@n) went through a proxy, as [this one](revisions.jsonl#L28) and [a page](https://example.org/x).\n\nA plain closing line.'
  const ui = await $.ui.mount({ ...(MOUNT as object), props: { text, isFirstOfReply: true } } as never)
  const tree = await ui.drawn()
  const shown = textOf(tree)
  // the citations read as their words, in place; the plain paragraph is Claude Code's own Markdown
  expect(shown).toContain('June 18 had 6,543 saves; 4,219 went through a proxy, as this one and a page')
  expect(shown).not.toContain('q1#day')
  const cite = buttons(tree).find(b => b.props.label === 'cite 6,543 saves')!
  expect(cite).toBeDefined()
  expect(JSON.stringify(cite)).toContain('"underline":true')
  expect(buttons(tree).map(b => b.props.label)).toEqual(['cite 6,543 saves', 'cite 4,219', 'cite this one'])
  expect(markdowns(tree)).toEqual(['A plain closing line.'])
  // a press opens the tray on it: its source card, read through the kernel
  await ui.press({ key: cite.props.key })
  expect(textOf(await $.ui.render(BAND))).toContain('6,543 saves')
  await clock.settle()
  const card = textOf(await $.ui.render(BAND))
  expect(card).toContain('Jun 18')
  // the tray's keys are in the thimble line under it, not on its frame
  expect(card.split('╯')[0]).not.toContain('1 ask')
  expect(await hintOf($)).toContain('thimble  1 ask · 0 close · ] next')
  expect(w.runs.some(a => a.includes('resolve') && a.includes('q1#day=2026-06-18@n'))).toBe(true)
  await ui.unmount()
})

// ------------------------------------------------------------------------------------------------ verbs, pressed


/** A turn that saves 01-saves and ends with words: the object is drawn under them. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function savedTurn($: any, on: any, clock: { settle: () => Promise<void> }) {
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the reply'] }) as never)
  on('tool.call', () => ({ result: 'saved 01-saves v1: thimble/objects/01-saves.json\n' }))
  await $.turn.start({ turnId: 't1', text: 'when?' } as never)
  await $.tool.call({ tool: 'Bash', command: 'lean save saves' } as never)
  await $.session.append({ door: 'response', uuid: ROW, origin: { kind: 'model', model: 'm' }, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'June 18 had the most saves.' }] } } as never)
  await $.turn.complete({ turnId: 't1', answer: 'June 18 had the most saves.', durationMs: 5, reason: 'answer', isAborted: false } as never)
  await clock.settle()
}

test('a verb of the message row: v opens its line, a pick runs it on the message, and what it made is drawn under the same message; Claude reads what it did with the next prompt', async ($, on) => {
  const w = world(on, () => ({ verb: 'visualize', saved: { id: '02-trace', v: 1 }, note: 'It drew the message as 2 bars.' }))
  const clock = mock.clock(on)
  await savedTurn($, on, clock)
  const ui = await $.ui.mount(MOUNT)
  await clock.settle()
  expect(textOf(await ui.drawn()).match(/Jun 18/g)?.length).toBe(1)
  // v on an empty prompt, as the thimble line names it
  await ($ as Any).prompt.edit(edit('v'))
  expect(textOf(await ui.drawn())).toContain('▸ 1 another view of this answer')
  await ui.press({ key: `vl-${AT}-opt-0` })
  await clock.settle()
  // the verb ran with the message: its record, as an object with its words, and the pick as its words
  const input = w.inputs[0] as { object: { kind: string; text: string; row: string }; message: { row: string; final: boolean }; args: string }
  expect(input.object.kind).toBe('message')
  expect(input.object.text).toBe('June 18 had the most saves.')
  expect(input.message.row).toBe(AT)
  expect(input.message.final).toBe(true)
  expect(input.args).toBe('')
  // what it made is drawn under the same message, after the object there
  expect(textOf(await ui.drawn()).match(/Jun 18/g)?.length).toBe(2)
  expect(JSON.parse(w.files[SHOWN]!).under[AT].map((x: { id: string }) => x.id)).toEqual(['01-saves', '02-trace'])
  expect(JSON.parse(w.files[`${ROOT}/thimble/messages/s-1/${AT}.json`]!).objects).toEqual(['01-saves', '02-trace'])
  // no prompt was sent; Claude reads it beside the next one, once
  expect(w.submitted.length).toBe(0)
  await $.prompt.submit({ text: 'and this?' } as never)
  const context = w.submitted.at(-1)!.context.join('\n')
  expect(context).toContain('The person ran the verb visualize on the message "June 18 had the most saves."')
  expect(context).toContain('It drew the message as 2 bars.')
  await $.prompt.submit({ text: 'more?' } as never)
  expect(w.submitted.at(-1)!.context.join('\n')).not.toContain('ran the verb visualize')
  await ui.unmount()
})

test('a verb that needs the model: the module makes the call, and the verb runs again with the answer', async ($, on) => {
  const w = world(on, (input: { answers?: Record<string, { text: string }> }) => input.answers?.k1
    ? { verb: 'squeeze', text: `squeezed to: ${input.answers.k1.text}` }
    : { verb: 'squeeze', need: { kind: 'complete', request: { model: 'sonnet', prompt: 'the spans', maxTokens: 8000 }, key: 'k1' } })
  const asked: { model?: string; prompt?: string }[] = []
  on('model.complete', (_$: unknown, e: { model?: string; prompt?: string }) => {
    asked.push(e)
    return { value: { isAnswered: true, text: 'two lines', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }
  })
  const r = await $.command.run({ command: 'verb', args: 'squeeze saves' } as never)
  expect(asked.length).toBe(1)
  expect(asked[0]!.model).toBe('sonnet')
  expect(asked[0]!.prompt).toBe('the spans')
  expect(w.inputs.length).toBe(2)
  expect(String(r.text)).toContain('squeezed to: two lines')
})

test("v asks Claude for a card of the message: the row reads as the person's pick, the request beside it for Claude alone", async ($, on) => {
  const ask = 'The person pressed v (visualize) on your reply that begins "June 18 had the most saves.". Make a card of it.'
  const w = world(on, () => ({ verb: 'visualize', text: 'Claude is making a card of this message.', ask }))
  const session = mock.session(on)
  const clock = mock.clock(on)
  await savedTurn($, on, clock)
  const ui = await $.ui.mount(MOUNT)
  await clock.settle()
  // v on an empty prompt, as the thimble line names it
  await ($ as Any).prompt.edit(edit('v'))
  expect(textOf(await ui.drawn())).toContain('▸ 1 another view of this answer')
  await ui.press({ key: `vl-${AT}-opt-0` })
  await clock.settle()
  expect((w.inputs[0] as { args: string }).args).toBe('')
  // the row reads as the press; Claude reads the request in a row before it that the person does not see
  expect(w.submitted.map(x => x.text)).toEqual(['visualize another view of this answer'])
  const rows = session.appended() as unknown as { door: string; message: { type: string; content: { text?: string }[] } }[]
  const hidden = rows.filter(r => r.door === 'note' && r.message.type === 'user' && r.message.content.some(b => String(b.text).includes(ask)))
  expect(hidden.length).toBe(1)
  await ui.unmount()
})

test('a view that fails to draw: no prompt and no row; Claude reads why, at once after its save and with /verb explore', async ($, on) => {
  const failed = { ...DRAWING, error: { name: 'TypeError', message: 'data.days is undefined', line: 3 } }
  const w = world(on, () => ({ verb: 'explore', saved: { id: '01-saves', v: 1 }, text: 'The view\'s program failed (TypeError).', note: 'The explore view 01-saves failed to draw: TypeError. Fix its program and save it again under the same name.' }), failed)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const clock = mock.clock(on)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the reply'] }) as never)
  on('tool.call', () => ({ result: 'saved 01-saves v1: thimble/objects/01-saves.json\n' }))
  await $.turn.start({ turnId: 't1', text: 'when?' } as never)
  const saved = await $.tool.call({ tool: 'Bash', command: 'lean save saves' } as never)
  expect(String((saved as { context?: string[] }).context)).toContain('Fix the program and save it again under the same name now')
  await $.session.append({ door: 'response', uuid: ROW, origin: { kind: 'model', model: 'm' }, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'Here.' }] } } as never)
  await clock.settle()
  // explore is a card form now, still run by /verb: Claude reads why, with the command's row
  const r = await $.command.run({ command: 'verb', args: 'explore saves' } as never)
  expect(w.submitted.length).toBe(0)
  expect(String((r as { context?: string[] }).context)).toContain('Fix its program and save it again under the same name')
})

test('an object whose file cannot be read is not drawn in silence: Claude reads why with the save', async ($, on) => {
  const w = world(on)
  w.files[FILE] = '{"id": "01-saves", "data": ' // a read that does not give the whole file, as one over 4 MiB
  mock.clock(on)
  on('tool.call', () => ({ result: 'saved 01-saves v1: thimble/objects/01-saves.json\n' }))
  await $.turn.start({ turnId: 't1', text: 'when?' } as never)
  const saved = await $.tool.call({ tool: 'Bash', command: 'lean save saves' } as never)
  expect(String((saved as { context?: string[] }).context)).toContain('The person cannot see 01-saves')
  expect(String((saved as { context?: string[] }).context)).toContain('could not be read')
})

test('a resumed session draws its objects under the same replies again', async ($, on) => {
  const w = world(on)
  w.files[SHOWN] = JSON.stringify({ under: { [AT]: [{ id: '01-saves', v: 1, root: ROOT }] } })
  const clock = mock.clock(on)
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('command.register', (_$: unknown, e: { name: string }) => ({ value: { command: e.name } }))
  on('config.list', () => ({ value: [] }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the reply'] }) as never)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
  await clock.settle()
  textOf(await reply($))
  await clock.settle()
  const drawn = textOf(await reply($))
  expect(drawn).toContain('Jun 18')
  expect(drawn).not.toContain('open ›')
})

// ------------------------------------------------------------------------------------------------ the message layer

const MARKED = 'Mostly [6,543 saves](q1#day=2026-06-18@n) on June 18, from [this one](revisions.jsonl#L28) on. The `fixture scope` mattered.'
const edit = (key: string, text = '') => ({ origin: { kind: 'composer' }, key: { key }, text, cursor: text.length, start: text.length, end: text.length, inputText: key.length === 1 ? key : '' }) as never

/** A turn that answers with marked words and ends: its record is written and its verb row drawn. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function markedTurn($: any, on: any, clock: { settle: () => Promise<void> }, text = MARKED) {
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the reply'] }) as never)
  on('tool.call', () => ({ result: 'ok' }))
  await $.turn.start({ turnId: 't1', text: 'when?' } as never)
  await $.session.append({ door: 'prompt', uuid: 'pppppppp-0000-0000-0000-000000000000', origin: { kind: 'composer' }, message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'when?' }] } } as never)
  await $.session.append({ door: 'response', uuid: ROW, origin: { kind: 'model', model: 'm' }, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] } } as never)
  await $.turn.complete({ turnId: 't1', answer: text, durationMs: 5, reason: 'answer', isAborted: false } as never)
  await clock.settle()
}

test("each row is written to the messages folder: an index line per row, and a record of Claude's message with its marks", async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  await markedTurn($, on, clock)
  const dir = `${ROOT}/thimble/messages/s-1`
  const index = w.files[`${dir}/index.jsonl`]!.trim().split('\n').map(l => JSON.parse(l))
  expect(index.map((x: { kind: string }) => x.kind)).toEqual(['user', 'assistant'])
  expect(index[0].text).toBe('when?')
  expect(index[1].row).toBe(AT)
  const rec = JSON.parse(w.files[`${dir}/${AT}.json`]!)
  expect(rec.v).toBe(1)
  expect(rec.session).toBe('s-1')
  expect(rec.text).toBe(MARKED)
  expect(rec.shown).toBe(null)
  expect(rec.final).toBe(true)
  expect(rec.marks.map((m: { kind: string; label?: string }) => `${m.kind} ${m.label}`)).toEqual(['cite 6,543 saves', 'cite this one'])
  expect(MARKED.slice(rec.marks[0].start, rec.marks[0].end)).toBe('[6,543 saves](q1#day=2026-06-18@n)')
})

test('keys of an empty prompt: ] opens the tray on the next mark and 0 goes back; v opens its line, and a letter typed straight after gives v back to the prompt', async ($, on) => {
  world(on)
  const clock = mock.clock(on)
  await markedTurn($, on, clock)
  // the hint line names the key that opens the answer's marks; the verb row does not
  expect(textOf(await $.ui.render({ ...(MOUNT as object), props: { text: MARKED, isFirstOfReply: true } } as never))).not.toContain('marks')
  expect(await hintOf($)).toContain('thimble  v visualize · s squeeze · ] cite & explain')
  // the thimble line above the prompt counts what the session holds
  expect(textOf(await $.ui.render(BAND))).toContain('2 cites')
  expect(textOf(await $.ui.render(BAND))).not.toContain('6,543 saves')
  // ] : the first mark of the latest message, in the tray; the key never reaches the prompt
  expect(await ($ as Any).prompt.edit(edit(']'))).toEqual({ text: '', cursor: 0 })
  expect(textOf(await $.ui.render(BAND))).toContain('6,543 saves')
  expect(await hintOf($)).toContain('thimble  1 ask · 0 close · ] next')
  // 1 asks: the panel turns to the mark's side thread, and the hint line says how to ask it
  expect(await ($ as Any).prompt.edit(edit('1'))).toEqual({ text: '', cursor: 0 })
  expect(textOf(await $.ui.render(BAND))).toContain('ask about 6,543 saves…')
  expect(await hintOf($)).toContain('type to ask · ↵ asks this thread · 0 back')
  // the thimble line names the thread the prompt goes to
  expect(textOf(await $.ui.render(BAND))).toContain('thimble:main/6,543 saves')
  await ($ as Any).prompt.edit(edit(']'))
  expect(textOf(await $.ui.render(BAND))).toContain('this one')
  await ($ as Any).prompt.edit(edit('['))
  expect(textOf(await $.ui.render(BAND))).toContain('6,543 saves')
  // with the tray open the prompt is its question: letters are typed
  expect(await ($ as Any).prompt.edit(edit('w'))).toEqual({ text: 'w', cursor: 1 })
  // 0 on an empty prompt closes the tray
  expect(await ($ as Any).prompt.edit(edit('0'))).toEqual({ text: '', cursor: 0 })
  expect(textOf(await $.ui.render(BAND))).toContain('2 cites')
  expect(textOf(await $.ui.render(BAND))).not.toContain('6,543 saves')
  // v opens its line under the answer; i typed straight after was the start of a word
  expect(await ($ as Any).prompt.edit(edit('v'))).toEqual({ text: '', cursor: 0 })
  expect(textOf(await $.ui.render(MOUNT))).toContain('▸ 1 another view of this answer')
  expect(await ($ as Any).prompt.edit(edit('i'))).toEqual({ text: 'vi', cursor: 2 })
  expect(textOf(await $.ui.render(MOUNT))).not.toContain('▸ 1 another view')
  // a key in a prompt with words in it is typed
  expect(await ($ as Any).prompt.edit(edit('s', 'so'))).toEqual({ text: 'sos', cursor: 3 })
})

test('a question asked with the tray open goes to the side thread of its mark: main never sees it, and the panel shows the thread', async ($, on) => {
  const w = world(on)
  const spawns: Any[] = []
  on('agent.register', () => ({ value: { agent: 'thimble-lean:thread' } }))
  on('agent.spawn', (_$: unknown, e: Any) => { spawns.push(e); return { model: 'claude-test' } as never })
  on('agent.list', () => ({ value: spawns.map((_, i) => ({ id: `agent-${i + 1}`, type: 'thimble-lean:thread', description: 'thread', status: 'running' })) }))
  on('session.messages', () => ({ value: [] }))
  on('ui.status', () => ({ value: undefined }))
  on('prompt.fill', () => ({ isFilled: true }))
  const clock = mock.clock(on)
  await markedTurn($, on, clock)
  await ($ as Any).prompt.edit(edit(']'))
  const before = w.submitted.length
  const r = await $.prompt.submit({ text: 'why so high?', origin: { kind: 'composer' } } as never)
  // dropped from main, with where it went; the thread's agent got the question and what it is about
  expect(String((r as Any).drop)).toBe('asked the thread of 6,543 saves')
  expect(w.submitted.length).toBe(before)
  expect(spawns[0].subagent_type).toBe('thimble-lean:thread')
  expect(spawns[0].prompt).toContain('why so high?')
  expect(spawns[0].prompt).toContain('About: Claude\'s citation "6,543 saves" (q1#day=2026-06-18@n).')
  // the panel shows the thread: the question, and that it is being answered
  await clock.settle()
  const band = textOf(await $.ui.render(BAND))
  expect(band).toContain('❯ why so high?')
  expect(await hintOf($)).toContain('0 back')
  // the thimble line counts the thread
  expect(band).toContain('1 thread')
  // its thread file is written for the browser
  expect(Object.keys(w.files).some(f => f.includes('/thimble/threads/s-1/'))).toBe(true)
})

test("a resumed session finds its messages on disk: their marks open from the keys, and the keys act on its latest answer", async ($, on) => {
  const w = world(on)
  mock.clock(on)
  const dir = `${ROOT}/thimble/messages/s-1`
  const rec = { v: 1, row: AT, session: 's-1', text: MARKED, shown: null, marks: [{ kind: 'cite', start: 7, end: 42, ref: 'q1#day=2026-06-18@n', label: '6,543 saves' }], glosses: {}, verbs: { s: { lit: true, note: '24 lines' } }, objects: [], final: true }
  w.files[`${dir}/index.jsonl`] = `${JSON.stringify({ row: 'pppppppp-0000-0000-0000-', kind: 'user', text: 'when?' })}\n${JSON.stringify({ row: AT, kind: 'assistant' })}\n`
  w.files[`${dir}/${AT}.json`] = JSON.stringify(rec)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the reply'] }) as never)
  const RESUMED = { ...(MOUNT as object), props: { text: MARKED, isFirstOfReply: true } } as never
  expect(textOf(await $.ui.render(HINT))).toContain('s ● 24 lines')
  await ($ as Any).prompt.edit(edit(']'))
  expect(textOf(await $.ui.render(BAND))).toContain('6,543 saves')
  await ($ as Any).prompt.edit(edit('0'))
  await ($ as Any).prompt.edit(edit('s'))
  // s opens the squeeze chips under it, in place of its verb row
  expect(textOf(await $.ui.render(RESUMED))).toContain('Report ↔ Interpret')
})

test('a failure reads as plain words, never JSON; a refusal that needs nothing from the person says nothing', () => {
  // the engine refuses a scroll that a key asked for, or one to a mark not drawn now: the tray shows the mark anyway
  expect(plainWhy({ deny: 'not person-initiated' })).toBeNull()
  expect(plainWhy('scroll: {"deny":"no element of its own is drawn under that key"}')).toBeNull()
  expect(plainWhy(new Error('thimble-lean: $.ui.scroll: not person-initiated'))).toBeNull()
  // a real failure keeps its own words
  expect(plainWhy(new Error('thimble-lean: $.model.complete: the model is busy'))).toBe('the model is busy')
  expect(plainWhy('{"error":"q9 has no column n"}')).toBe('q9 has no column n')
  expect(plainWhy('Traceback (most recent call last):\n  File "x"')).toBe('Traceback (most recent call last):')
})

test('the thimble line is the one bar: the verbs in words at its left, a lit one with its note; the non-zero counts at its right, coverage the share read; a changed count bright for a moment; a blank row above it only while Claude works', async ($, on) => {
  world(on)
  const clock = mock.clock(on)
  await markedTurn($, on, clock)
  const bar = textOf(await $.ui.render(HINT))
  expect(bar).toContain('thimble  v visualize · s squeeze · ] cite & explain')
  // 102 of 600 rows read: 17%; no zero count shows
  expect(bar).toContain('2 cites · coverage 17%')
  expect(bar).not.toContain('card')
  expect(bar).not.toContain('thread')
  expect(bar).not.toContain('claims')
  // the counts that just changed are bright, then dim
  const lit = (t: Any) => { let on = false; walk(t, x => { if (x.type === 'Text' && x.props?.bold && textOf(x) === '2 cites') on = true }); return on }
  expect(lit(await $.ui.render(HINT))).toBe(true)
  for (let i = 0; i < 40; i++) await clock.advance(50)
  expect(lit(await $.ui.render(HINT))).toBe(false)
  // at rest no blank row stands above the bar (Claude Code's [-] stands beside its first row); while Claude works, one does
  const rest = await $.ui.render(BAND) as Any
  expect(textOf(rest).startsWith('thimble')).toBe(true)
  const working = await $.ui.render({ ...(BAND as object), props: { ...(BAND as Any).props, isWorking: true } } as never) as Any
  expect(textOf(working).startsWith(' thimble')).toBe(true)
  // inside a thread the bar's label names it, and its left side is that thread's keys
  await ($ as Any).prompt.edit(edit(']'))
  await ($ as Any).prompt.edit(edit('1'))
  const inThread = textOf(await $.ui.render(HINT))
  expect(inThread).toContain('thimble:main/6,543 saves')
  expect(inThread).toContain('type to ask · ↵ asks this thread · 0 back')
})
