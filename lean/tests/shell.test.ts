// The shell's hooks (shell/shell.tsx): an object Claude saves is placed under the turn's next words, a prompt asked
// while the detail view is open carries the object and its selected part, /verb lists the verbs for an object, a verb
// pressed under an object draws what it made under the same reply, a verb's call to the model is made by the module,
// what a verb says for Claude goes with the next prompt, a verb's request to Claude reads as one line, and a resumed
// session draws its objects again. `claude plugin test lean`. The Node children (the drawing, a verb's run, `lean
// resolve`) are answered here, at process.run.
import { expect, mock, test } from 'claude-code/testing'

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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const reply = ($: any) => $.ui.render({ component: 'AssistantMessage', surface: 'terminal', requestId: ROW, props: { text: 'June 18 had the most saves.', isFirstOfReply: true }, viewport: { columns: 100, rows: 40, isFullscreen: true } } as never)

test('an object Claude saves is drawn under the next words of the turn, with its verbs', async ($, on) => {
  world(on)
  const clock = mock.clock(on)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the reply'] }) as never)
  on('tool.call', () => ({ result: 'saved 01-saves v1: thimble/objects/01-saves.json\n  /days ← q1 (exact)\n' }))
  await $.turn.start({ turnId: 't1', text: 'when?' } as never)
  const saved = await $.tool.call({ tool: 'Bash', command: "lean save saves <<'JSON'\n{}\nJSON" } as never)
  // Claude reads what the person sees of it, after the command's own output
  expect(String((saved as { context?: string[] }).context)).toContain('01-saves@1 is drawn for the person under your reply')
  await $.session.append({ door: 'response', uuid: ROW, origin: { kind: 'model', model: 'm' }, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'June 18 had the most saves.' }] } } as never)
  const first = textOf(await reply($))
  expect(first).toContain('the reply')
  await clock.settle()
  const drawn = textOf(await reply($))
  expect(drawn).toContain('the reply')
  expect(drawn).toContain('Jun 18')
  expect(drawn).toContain('6,543')
  // one hint row: the verbs picked for it, `? all`, and open
  expect(drawn).toContain('x explore')
  expect(drawn).toContain('t trace')
  expect(drawn).not.toContain('s squeeze')
  expect(drawn).toContain('? all')
  expect(drawn).toContain('open ›')
  expect(drawn).not.toContain('browser')
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

test('a reply draws its citations as their words, and names them in one row a press opens', async ($, on) => {
  world(on)
  let drawnText = ''
  on('ui.render', (_$: unknown, e: { props: { text?: string } }) => {
    drawnText = String(e.props.text ?? '')
    return { type: 'Text', props: {}, children: ['the reply'] } as never
  })
  const text = 'June 18 had [6,543 saves](q1#day=2026-06-18@n); [4,219](q9#kind=SEC via proxy@n) went through a proxy, as [this one](revisions.jsonl#L28) and [a page](https://example.org/x).'
  const tree = await $.ui.render({ component: 'AssistantMessage', surface: 'terminal', requestId: ROW, props: { text, isFirstOfReply: true }, viewport: { columns: 100, rows: 40, isFullscreen: true } } as never)
  expect(drawnText).toBe('June 18 had 6,543 saves; 4,219 went through a proxy, as this one and [a page](https://example.org/x).')
  const shown = textOf(tree)
  expect(shown).toContain('cites 6,543 saves · 4,219 · this one')
})

// ------------------------------------------------------------------------------------------------ verbs, pressed

const AT = ROW.slice(0, 24)
const MOUNT = { plugin: 'thimble-lean', component: 'AssistantMessage', surface: 'terminal', requestId: ROW, props: { text: 'June 18 had the most saves.', isFirstOfReply: true }, viewport: { columns: 100, rows: 40, isFullscreen: true } } as never
const chip = (verb: string) => `row-${AT}-0-01-saves:v:${verb}`

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

test('a verb pressed under an object runs in the module, and what it made is drawn under the same reply; Claude reads what it did with the next prompt', async ($, on) => {
  const w = world(on, () => ({ verb: 'trace', saved: { id: '02-trace', v: 1 }, note: 'It traced q1.' }))
  const clock = mock.clock(on)
  await savedTurn($, on, clock)
  const ui = await $.ui.mount(MOUNT)
  await clock.settle()
  expect(textOf(await ui.drawn()).match(/Jun 18/g)?.length).toBe(1)
  await ui.press({ key: chip('trace') })
  await clock.settle()
  // the verb ran with the object, as the kernel keeps it, and the drawing the person sees
  const input = w.inputs[0] as { object: { id: string }; drawing: unknown; refs: string[] }
  expect(input.object.id).toBe('01-saves')
  expect(input.drawing).toEqual(DRAWING)
  // what it made is drawn under the same reply, after the object it came from
  expect(textOf(await ui.drawn()).match(/Jun 18/g)?.length).toBe(2)
  expect(JSON.parse(w.files[SHOWN]!).under[AT].map((x: { id: string }) => x.id)).toEqual(['01-saves', '02-trace'])
  // no prompt was sent; Claude reads it beside the next one
  expect(w.submitted.length).toBe(0)
  await $.prompt.submit({ text: 'and this?' } as never)
  const context = w.submitted.at(-1)!.context.join('\n')
  expect(context).toContain('The person ran the verb trace on 01-saves@1. It shows them 02-trace@1')
  expect(context).toContain('It traced q1.')
  // said once
  await $.prompt.submit({ text: 'more?' } as never)
  expect(w.submitted.at(-1)!.context.join('\n')).not.toContain('ran the verb trace')
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

test("a verb's request to Claude goes as the person's few words, the request beside them for Claude alone", async ($, on) => {
  const ask = 'The person pressed x (Explore) on the object 01-saves. Make it a view they can explore.'
  const w = world(on, () => ({ verb: 'explore', text: 'Claude is writing a view of this you can explore.', ask }))
  const session = mock.session(on)
  const clock = mock.clock(on)
  await savedTurn($, on, clock)
  const ui = await $.ui.mount(MOUNT)
  await clock.settle()
  await ui.press({ key: chip('explore') })
  await clock.settle()
  // the row reads as the press; Claude reads the request in a row before it that the person does not see
  expect(w.submitted.map(x => x.text)).toEqual(['explore 01-saves@1'])
  const rows = session.appended() as unknown as { door: string; message: { type: string; content: { text?: string }[] } }[]
  const hidden = rows.filter(r => r.door === 'note' && r.message.type === 'user' && r.message.content.some(b => String(b.text).includes(ask)))
  expect(hidden.length).toBe(1)
  await ui.unmount()
})

test('a view that fails to draw: no prompt and no row; Claude reads why, at once after its save and with the next prompt after x', async ($, on) => {
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
  const ui = await $.ui.mount(MOUNT)
  await clock.settle()
  await ui.press({ key: chip('explore') })
  await clock.settle()
  expect(w.submitted.length).toBe(0)
  await $.prompt.submit({ text: 'ok' } as never)
  expect(w.submitted.at(-1)!.context.join('\n')).toContain('Fix its program and save it again under the same name')
  await ui.unmount()
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
  expect(drawn).toContain('x explore')
})
