// A card with pages (a page knob, draw/kit.js) in the shell: under a reply its dial turns where it is clicked and its
// row says how many pages there are and that 1 reads them all; the detail shows every page at once (or one at a time,
// a), a part of a page is the card's own part at that page, a card's own key typed as the start of a question gives
// its letter back, and the versions saved in one turn count as one. `claude plugin test lean`. The card's program runs
// here in the real kit, as prep.mjs would run it.
import { expect, mock, test } from 'claude-code/testing'
import '../draw/kit.js'
import { press, promptStub } from './stubs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
const ROOT = '/data'
const SESSION = 's-1'
const ID = '01-orchard'
const FILE = `${ROOT}/thimble/objects/${ID}.json`
const STATE = `${ROOT}/thimble/objects/.state/${ID}.json`
const SEEN = `${ROOT}/thimble/objects/.seen/${ID}.json`
const EVENTS = '/home/t/.thimble/lean/events/s-1.jsonl'
// a made-up guide in three chapters, as the guide that started this was written: a chapter knob shown as "2 of 3",
// its own keys n and p labelled alike, and a part per tree with the rows it stands for. The test's sandbox runs no
// program from a string, so the kit runs it as a function, as it would the saved text
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PROGRAM = (k: any, data: any) => {
  const CH = data.chapters
  const ch = k.knob('chapter', { values: CH.map((_: unknown, i: number) => i + 1), at: 1, label: 'chapter', fmt: (v: number) => v + ' of ' + CH.length })
  k.on('n', () => ({ chapter: Math.min(CH.length, ch + 1) }), 'chapter')
  k.on('p', () => ({ chapter: Math.max(1, ch - 1) }), 'chapter')
  const C = CH[ch - 1]
  return k.stack(
    k.beside(k.text('**' + C.title + '**', { wrap: false }), k.dial('chapter', { label: false }), { gap: 2 }),
    ...C.trees.map((t: string, i: number) => k.region('tree-' + i, { label: t, ref: 'trees.csv#L' + (i + 2) }, k.text(t))),
    { gap: 1 })
}
const DATA = { chapters: [{ title: 'Apples', trees: ['Bramley', 'Cox'] }, { title: 'Pears', trees: ['Conference', 'Comice', 'Williams'] }, { title: 'Plums', trees: ['Victoria'] }] }
const objectAt = (v: number) => ({ id: ID, version: v, title: 'The orchard in three chapters', program: 'the guide', data: DATA, text: 'Three chapters.', lineage: { cites: [] }, history: Array.from({ length: v }, (_, i) => ({ v: i + 1, at: `t${i + 1}`, change: i ? 'changed' : 'made' })) })

const ROW = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const reply = { component: 'AssistantMessage', surface: 'terminal', requestId: ROW, props: { text: 'Here is the guide.', isFirstOfReply: true }, viewport: { columns: 100, rows: 40, isFullscreen: true } } as never
const HINT = { plugin: 'thimble', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows: 16, bodyColumns: 200, scroll: { offset: 0, bodyRows: 16 }, view: {} }, viewport: { columns: 200, rows: 48, isFullscreen: true } } as never
const PANE = { component: 'Pane', surface: 'terminal', requestId: 'object', props: { bodyColumns: 100, scroll: { bodyRows: 60, offset: 0 }, isFocused: true, placement: 'dock', title: 'The orchard', view: {} } } as never
const edit = (key: string, text = '') => ({ origin: { kind: 'composer' }, key: { key }, text, cursor: text.length, start: text.length, end: text.length, inputText: key.length === 1 ? key : '' }) as never

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function textOf(n: any): string {
  if (n == null || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  return textOf(n.props?.children) + textOf(n.children)
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function keysIn(n: any, out: string[] = []): string[] {
  if (n == null || typeof n !== 'object') return out
  if (Array.isArray(n)) { n.forEach(x => keysIn(x, out)); return out }
  if (n.type === 'Button' && n.props?.key) out.push(String(n.props.key))
  keysIn(n.props?.children, out)
  keysIn(n.children, out)
  return out
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function world(on: any) {
  mock.env(on, { THIMBLE_HOME: '/home/t/.thimble' })
  on('session.cwd', () => ({ value: ROOT }))
  on('session.id', () => ({ value: SESSION }))
  on('turn.start', (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('config.list', () => ({ value: [] }))
  on('command.register', (_$: unknown, e: { name: string }) => ({ value: { command: e.name } }))
  const files: Record<string, string> = {}
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: e.path in files || e.path === `${ROOT}/thimble/objects` }))
  on('fs.list', () => ({ value: [] }))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: files[e.path] ?? promptStub(e.path) ?? '' }))
  on('fs.write', (_$: unknown, e: { path: string; content?: string; text?: string; data?: string }) => { files[e.path] = String(e.content ?? e.text ?? e.data ?? ''); return { value: undefined } })
  const preps: Any[] = []
  on('process.run', (_$: unknown, e: { argv: string[]; init?: { stdin?: string } }) => {
    if (e.argv[0] === 'tail') return { value: { exitCode: 0, stdout: (files[e.argv[3]!] ?? '').slice(Number(e.argv[2]!.slice(1)) - 1), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    let out: unknown = {}
    if (e.argv.some(a => a.endsWith('prep.mjs'))) {
      const input = JSON.parse(String(e.init?.stdin || '{}'))
      preps.push(input)
      const o = input.object
      const drawing = (globalThis as Any).DrawKit.run(PROGRAM, o.data, { w: input.w, h: input.h, state: input.state, mode: input.mode, event: input.event, all: input.all, id: o.id, title: o.title })
      out = { drawing }
    } else if (e.argv.includes('resolve')) out = { ref: e.argv[2], chain: [], rows: [], count: 0, records: [], notes: [] }
    else if (e.argv.includes('coverage')) out = { files: [] }
    return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const opened: Any[] = []
  on('ui.open', (_$: unknown, e: Any) => { opened.push(e); return { value: { isPlaced: true } } })
  on('ui.panes', () => ({ value: opened.length ? [{ id: 'object', title: 'The orchard', isShown: true, isFocused: true, isPlaced: true, plugin: 'thimble' }] : [] }))
  on('ui.focus', () => ({ value: {} }))
  on('prompt.edit', (_$: unknown, e: { text: string; start: number; end: number; inputText: string }) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
  on('ui.render', { component: 'PromptHint' }, (_$: unknown, e: { props: { hint: string } }) => ({ type: 'Text', props: {}, children: [String(e.props.hint)] }) as never)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['Here is the guide.'] }) as never)
  // a Bash call that saves the guide at version `v`, as the kernel would: its file, and a line in the change feed
  const save = (v: number) => {
    files[FILE] = JSON.stringify(objectAt(v))
    files[EVENTS] = (files[EVENTS] || '') + JSON.stringify({ t: Date.now() / 1000, kind: 'save', session: SESSION, root: ROOT, object: ID, version: v }) + '\n'
    return { result: `saved ${ID} v${v}: thimble/objects/${ID}.json\n` }
  }
  // each Bash call of a turn saves the next version the turn names
  const queue: number[] = []
  on('tool.call', () => save(queue.shift() ?? 1))
  return { files, preps, opened, queue }
}

/** One turn of main's that saves the guide `saves` times before its reply is done. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function turnSaving($: any, w: ReturnType<typeof world>, clock: { settle: () => Promise<void> }, saves: number[]) {
  w.queue.push(...saves)
  await $.turn.start({ turnId: 't1', text: 'teach me the orchard' } as never)
  for (const _ of saves) await $.tool.call({ tool: 'Bash', command: 'thimble save orchard --from guide.json' } as never)
  await $.session.append({ door: 'response', uuid: ROW, origin: { kind: 'model', model: 'm' }, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'Here is the guide.' }] } } as never)
  await $.turn.complete({ turnId: 't1', answer: 'Here is the guide.', durationMs: 5, reason: 'answer', isAborted: false } as never)
  await clock.settle()
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function drawn($: any, clock: { settle: () => Promise<void> }, what: unknown): Promise<string> {
  await $.ui.render(what)
  await clock.settle()
  await $.ui.render(what)
  await clock.settle()
  return textOf(await $.ui.render(what))
}

test('under a reply: the dial turns where it is clicked, ] then . or n turn it too, and the row and the bar say 1 reads all its chapters', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  await turnSaving($, w, clock, [1])
  let t = await drawn($, clock, reply)
  expect(t).toContain('Apples')
  expect(t).toContain('◂ 1 of 3 ▸')
  expect(t).toContain('3 chapters · 1 read all')
  expect(textOf(await $.ui.render(HINT))).toContain('] card · 1 read all 3 chapters')
  // the dial is two halves: its right half turns it on, here, with no detail opened
  const ui = await $.ui.mount({ plugin: 'thimble', ...(reply as Any) } as never)
  const halves = keysIn(await ui.drawn()).filter(k => k.startsWith('t|') && k.endsWith('|chapter|next'))
  expect(halves.length).toBe(1)
  await ui.press({ key: halves[0]! })
  await clock.settle()
  expect(JSON.parse(w.files[STATE]!).state).toEqual({ chapter: 2 })
  expect(w.opened.length).toBe(0)
  t = await drawn($, clock, reply)
  expect(t).toContain('Pears')
  // its left half turns it back
  await ui.press({ key: keysIn(await ui.drawn()).find(k => k.endsWith('|chapter|back'))! })
  await clock.settle()
  expect(JSON.parse(w.files[STATE]!).state).toEqual({ chapter: 1 })
  // ] gives the card the keys: the bar names them by what they do, and . and n turn it
  expect(await press($, clock, edit(']'))).toEqual({ text: '', cursor: 0 })
  expect(textOf(await $.ui.render(HINT))).toContain('n next chapter · p previous chapter · 1 read all 3 chapters · ] next · 0 back')
  expect(await press($, clock, edit('.'))).toEqual({ text: '', cursor: 0 })
  expect(JSON.parse(w.files[STATE]!).state).toEqual({ chapter: 2 })
  await clock.advance(1000)
  expect(await press($, clock, edit('n'))).toEqual({ text: '', cursor: 0 })
  await clock.settle()
  expect(JSON.parse(w.files[STATE]!).state).toEqual({ chapter: 3 })
  expect(await drawn($, clock, reply)).toContain('Plums')
})

test('the detail shows every chapter at once, from the one the card is at; a part of a page is the card\'s own at that page; a shows one at a time', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  await turnSaving($, w, clock, [1])
  await drawn($, clock, reply)
  // 1 opens the detail with every page at once, as the default says
  expect(await press($, clock, edit('1'))).toEqual({ text: '', cursor: 0 })
  let t = await drawn($, clock, PANE)
  expect(w.preps.some(x => x.all === 'chapter' && x.mode === 'detail')).toBe(true)
  expect(t).toContain('chapter 1 of 3')
  expect(t).toContain('chapter 2 of 3')
  expect(t).toContain('Victoria')
  expect(textOf(await $.ui.render(HINT))).toContain('n next chapter · p previous chapter')
  expect(textOf(await $.ui.render(HINT))).toContain('a chapter by chapter')
  // a click on a part of chapter 3 selects it: the card's own part, the card at chapter 3 (under the reply too)
  const ui = await $.ui.mount({ plugin: 'thimble', ...(PANE as Any) } as never)
  const key = keysIn(await ui.drawn()).find(k => k.startsWith('r|pane|') && k.endsWith('|pg3~~tree-0'))!
  expect(key).toBeTruthy()
  await ui.press({ key })
  await clock.settle()
  expect(JSON.parse(w.files[STATE]!)).toMatchObject({ state: { chapter: 3 }, region: 'tree-0' })
  expect(await drawn($, clock, reply)).toContain('Plums')
  // the card's own p goes to the heading of chapter 2
  await clock.advance(1000)
  expect(await press($, clock, edit('p'))).toEqual({ text: '', cursor: 0 })
  await clock.settle()
  t = await drawn($, clock, PANE)
  expect(JSON.parse(w.files[STATE]!).state).toEqual({ chapter: 2 })
  expect(t).toContain('── chapter 2 of 3')
  expect(JSON.stringify(await $.ui.render(PANE))).toContain('ask about chapter 2 of 3… · the answer shows here')
  // a: one chapter at a time, at chapter 2
  await clock.advance(1000)
  expect(await press($, clock, edit('a'))).toEqual({ text: '', cursor: 0 })
  t = await drawn($, clock, PANE)
  expect(t).toContain('Pears')
  expect(t).not.toContain('chapter 1 of 3')
  expect(t).not.toContain('Victoria')
  expect(textOf(await $.ui.render(HINT))).toContain('a all chapters')
})

test('in the detail, a card\'s own key that began a question gives its letter back, and the chapter goes back where it was', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  await turnSaving($, w, clock, [1])
  await drawn($, clock, reply)
  expect(await press($, clock, edit('1'))).toEqual({ text: '', cursor: 0 })
  await drawn($, clock, PANE)
  await clock.advance(1000)
  // "now…": n turns the chapter, and o straight after it makes it the start of the question
  expect(await press($, clock, edit('n'))).toEqual({ text: '', cursor: 0 })
  await clock.settle()
  expect(JSON.parse(w.files[STATE]!).state).toEqual({ chapter: 2 })
  await clock.advance(100)
  expect(await press($, clock, edit('o'))).toEqual({ text: '', cursor: 0 })
  await clock.settle()
  // back at the first chapter, where the card stood before n
  expect(JSON.parse(w.files[STATE]!).state.chapter ?? 1).toBe(1)
  expect(JSON.stringify(await $.ui.render(PANE))).toContain('"value":"no"')
})

test('a card saved three times in one turn was seen once: the header lists no versions, and h reaches the drafts', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  await turnSaving($, w, clock, [1, 2, 3])
  expect(JSON.parse(w.files[SEEN]!).seen).toEqual([3])
  await drawn($, clock, reply)
  expect(await press($, clock, edit('1'))).toEqual({ text: '', cursor: 0 })
  let t = await drawn($, clock, PANE)
  expect(t).toContain('card:01-orchard')
  expect(t).not.toMatch(/v\d/)
  expect(textOf(await $.ui.render(HINT))).toContain('h drafts')
  // h: the draft before it, named a draft beside the one the person saw
  await clock.advance(1000)
  expect(await press($, clock, edit('h'))).toEqual({ text: '', cursor: 0 })
  await clock.settle()
  t = await drawn($, clock, PANE)
  expect(t).toContain('v2 draft · v3')
  // a later turn that changes it: two versions seen, both listed
  await turnSaving($, w, clock, [4])
  expect(JSON.parse(w.files[SEEN]!).seen).toEqual([3, 4])
})
