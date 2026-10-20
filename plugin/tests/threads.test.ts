// The side panel as a thread (shell/side.ts, shell/detail.tsx, shell/conversation.ts, shell/thread.ts): whatever opens
// beside the conversation shows the thing at the top, the thread's conversation under it and an input bar like the
// prompt at the bottom. A question's answer shows in that conversation, never in place of the thing and never in main;
// a later question joins the run of an agent still working, else starts a new fork told the earlier turns; a citation
// in an answer opens over the thing and esc goes back; the bar's
// `t N threads` lists the threads (never from inside a thread) and opening one shows its panel again with its
// conversation; nothing of a thread reaches main. `claude plugin test plugin`. The drawing and `thimble resolve` are answered here, at process.run.
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
const BAND = { plugin: 'thimble', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows: 16, bodyColumns: 200, scroll: { offset: 0, bodyRows: 16 }, view: {} }, viewport: { columns: 200, rows: 48, isFullscreen: true } } as never
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
  /** The agent answers: a step, then its words; its turn ends. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const answer = async ($: any, clock: { settle: () => Promise<void> }, agentId: string, text: string) => {
    transcripts.get(agentId)!.push({ role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'thimble rows "q1#day=2026-06-18@n"' } }] })
    transcripts.get(agentId)!.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'rows' }] })
    transcripts.get(agentId)!.push({ role: 'assistant', content: [{ type: 'text', text }] })
    ended.add(agentId)
    await $.turn.complete({ turnId: `x-${Math.random()}`, agentId, answer: text, durationMs: 5, reason: 'answer', isAborted: false } as never)
    await clock.settle()
  }
  return { files, opened, views, submitted, spawns, sent, toasts, answer, keys }
}

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
  if (n.props?.key) out.push(String(n.props.key))
  keysIn(n.props?.children ?? n.children, out)
  return out
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pane = async ($: any, clock: { settle: () => Promise<void> }) => { for (let i = 0; i < 3; i++) { await $.ui.render(PANE); await clock.settle() } return textOf(await $.ui.render(PANE)) }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const askKeyOf = async ($: any) => /"key":"(ask-\d+)"/.exec(JSON.stringify(await $.ui.render(PANE)))?.[1] ?? ''
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hintOf = async ($: any) => textOf(await $.ui.render(BAND))
/** The keys of the presses a drawing holds, in order. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pressKeys(n: any, out: string[] = []): string[] {
  if (n == null || typeof n !== 'object') return out
  if (Array.isArray(n)) { n.forEach(x => pressKeys(x, out)); return out }
  if (n.type === 'Button' && n.props?.key) out.push(String(n.props.key))
  pressKeys(n.props?.children ?? n.children, out)
  return out
}
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
/** A question typed in the panel's input bar and sent. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ask($: any, clock: { settle: () => Promise<void> }, text: string) {
  const ui = await mounted($)
  await ui.input({ key: await askKeyOf($), text })
  await clock.settle()
  return ui
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

test("a card's thread with three questions: each answer shows in the panel's conversation under the card; a question after an answer starts a new fork told the earlier turns, one asked while it works joins its run, and main sees nothing", async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  await $.command.run({ command: 'card', args: '01-saves day-2026-06-18' } as never)
  // the input bar: Claude Code's prompt box in the panel, saying what a question is about
  const before = await pane($, clock)
  expect(before).toContain('❯ ')
  expect(JSON.stringify(await $.ui.render(PANE))).toContain('"placeholder":"Ask about Jun 18…"')
  await ask($, clock, 'why so many links?')
  expect(w.spawns.length).toBe(1)
  expect(w.spawns[0].prompt).toMatch(/\n\nwhy so many links\?\n\nAbout: the part "Jun 18" \(day-2026-06-18\) of the card "Saves per day"/)
  // while it works: the question, and that it is starting
  const working = await pane($, clock)
  expect(working).toContain('main/Saves per day')
  expect(working).toContain('❯ why so many links?')
  expect(working).toContain('◌')
  await w.answer($, clock, 'agent-1', 'Links peaked that day: [2,994](q2#n) of the saves.')
  const one = await pane($, clock)
  expect(one).toContain('❯ why so many links?')
  expect(one).toContain('about Jun 18')
  expect(one).toContain('1 step · thimble rows')
  expect(one).toContain('● Links peaked that day: 2,994 of the saves.')
  // spaced as Claude Code spaces the main view: a blank row before the question, before its steps and before the answer
  const rows = JSON.stringify(await $.ui.render(PANE))
  const blank = '{"type":"Text","children":[" "]}'
  const between = (a: string, b: string) => rows.slice(rows.indexOf(a), rows.indexOf(b))
  expect(between('about Jun 18', '● 1 step')).toContain(blank)
  expect(between('● 1 step', 'Links peaked')).toContain(blank)
  // the card stays at the top: the answer never takes its place
  expect(one).toContain('Jun 17 ▆')
  // a second question, after the agent ended: a new fork, told the earlier turns (an ended agent resumed would end
  // with a task notification in main's queue); both questions and answers show, in order
  await ask($, clock, 'and the day before?')
  expect(w.spawns.length).toBe(2)
  expect(w.sent.length).toBe(0)
  expect(w.spawns[1].subagent_type).toBe('fork')
  expect(w.spawns[1].prompt).toContain('\n\nand the day before?\n\nAbout: the part "Jun 18"')
  expect(w.spawns[1].prompt).toContain('Earlier in this thread:\nQ: why so many links?\nA: Links peaked that day: [2,994](q2#n) of the saves.')
  await w.answer($, clock, 'agent-2', 'The day before had [870](q3#n).')
  const two = await pane($, clock)
  // (the new agent's transcript begins at the second question: the first exchange is kept as the thread had it)
  expect(two).toContain('❯ why so many links?')
  expect(two).toContain('Links peaked that day')
  expect(two.indexOf('why so many links?')).toBeLessThan(two.indexOf('and the day before?'))
  expect(two.indexOf('Links peaked that day')).toBeLessThan(two.indexOf('The day before had 870.'))
  // a third question while the agent still works on it: the message joins its run, and no agent starts
  await ask($, clock, 'and the week?')
  await ask($, clock, 'only weekdays?')
  expect(w.spawns.length).toBe(3)
  expect(JSON.stringify(w.sent.at(-1))).toContain('agent-3')
  expect(w.sent.at(-1).text).toContain('only weekdays?')
  await w.answer($, clock, 'agent-3', 'Weekdays had [5,100](q4#n).')
  const three = await pane($, clock)
  expect(three.indexOf('The day before had 870.')).toBeLessThan(three.indexOf('❯ and the week?'))
  expect(three.indexOf('❯ and the week?')).toBeLessThan(three.indexOf('❯ only weekdays?'))
  expect(three).toContain('Weekdays had 5,100.')
  // main sees nothing of it: no prompt, no row, no view of the agent
  expect(w.submitted.length).toBe(0)
  expect(w.views.length).toBe(0)
  // the bar names the thread the panel shows
  expect(await hintOf($)).toContain('thimble:main/01-saves')
})

test('a citation in an answer opens over the card in the panel, as its own thread, with esc back to the card', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  await $.command.run({ command: 'card', args: '01-saves day-2026-06-18' } as never)
  await pane($, clock)
  const ui = await ask($, clock, 'why so many links?')
  await w.answer($, clock, 'agent-1', 'Links peaked that day: [2,994](q2#n) of the saves.')
  await pane($, clock)
  const cite = keysIn(await ui.drawn()).find(k => /^mk-conv-a\d+-0$/.test(k))
  expect(cite).toBeDefined()
  await ui.press({ key: cite! })
  await clock.settle()
  expect(w.opened.some(x => x.title === 'Cite · 2,994')).toBe(true)
  const shown = await pane($, clock)
  // its subject once, at the top, as every thread's, under the way back to the card
  expect(shown).toContain('‹ the card')
  expect(shown).toContain('▎ 2,994')
  expect(shown).not.toContain('╭─ 2,994')
  expect(shown).not.toContain('v1 · v2')
  // its own thread: a question here is about the citation
  expect(JSON.stringify(await $.ui.render(PANE))).toContain('"placeholder":"Ask about 2,994…"')
  // esc goes back to the card under it (the bar says so: esc back, where the card alone said esc close)
  expect(await hintOf($)).toContain('esc back')
})

test("a citation's thread: a in the tray opens the citation in the side panel with the input bar holding the keys; a letter starts the question there", async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  await markedTurn($, clock)
  await press($, clock, edit(']'))
  // one way to ask about a citation in the side panel: a ask (↵ does the same where Claude Code hands it on)
  expect(await hintOf($)).toContain('a ask')
  expect(await hintOf($)).not.toContain('expand')
  // a acts once a letter after it could no longer make it the start of a word
  expect(await press($, clock, edit('a'))).toEqual({ text: '', cursor: 0 })
  await clock.advance(800)
  await clock.settle()
  expect(w.opened.some(x => x.title === 'Cite · 6,543 saves')).toBe(true)
  // the tray gives way to the panel; the bar says the thread's name and what esc does, the input bar how to ask
  const bar = await hintOf($)
  expect(bar).toContain('thimble:main/6,543 saves')
  expect(bar).toContain('esc close')
  expect(JSON.stringify(await $.ui.render(PANE))).toContain('"placeholder":"Ask about 6,543 saves…"')
  // the question's letters go to the input bar, never the prompt
  for (const k of 'why') expect(await press($, clock, edit(k))).toEqual({ text: '', cursor: 0 })
  expect(JSON.stringify(await $.ui.render(PANE))).toContain('"value":"why"')
  const ui = await mounted($)
  await ui.input({ key: await askKeyOf($), text: 'why so high?' })
  await clock.settle()
  expect(w.spawns[0].prompt).toContain('About: Claude\'s citation "6,543 saves" (q1#day=2026-06-18@n).')
  await w.answer($, clock, 'agent-1', 'Most were reverts.')
  const shown = await pane($, clock)
  expect(shown).toContain('main/6,543 saves')
  expect(shown).toContain('❯ why so high?')
  expect(shown).toContain('● Most were reverts.')
  // its thread file keeps where it opens again
  const file = JSON.parse(w.files[`${ROOT}/thimble/threads/${SESSION}/mark-aaaaaaaa-bbbb-cccc-dddd-q1-day-2026-06-18-n.json`]!)
  expect(file.anchor).toMatchObject({ kind: 'pane', pane: 'mark' })
  expect(w.submitted.length).toBe(0)
})

test('a question typed while the keys are back at the prompt (keys typed at once can take them there): the input bar asks for the keys again, and ↵ after a click on it sends the question once, as typed', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  await markedTurn($, clock)
  await press($, clock, edit(']'))
  await press($, clock, edit('a'))
  // the panel is open, and the asks for the keys that follow the open are over; the ring lands on the input bar
  await clock.advance(2000)
  await pane($, clock)
  await $.ui.focus({ requestId: 'object', element: (await fieldOf($)).key, origin: { kind: 'plugin', name: 'thimble' } } as never)
  await clock.settle()
  // the keys go back to the prompt: Claude Code draws the panel without them
  w.keys.panel = false
  const UNFOCUSED = { ...(PANE as Any), props: { ...(PANE as Any).props, isFocused: false } } as never
  await $.ui.render(UNFOCUSED)
  const opens = w.opened.length
  // the question comes through the prompt as one edit, and joins the input bar
  const burst = { origin: { kind: 'composer' }, text: '', cursor: 0, start: 0, end: 0, inputText: 'why so high?' } as never
  expect(await press($, clock, burst)).toEqual({ text: '', cursor: 0 })
  await $.ui.render(UNFOCUSED)
  await clock.settle()
  const field = await fieldOf($, UNFOCUSED)
  expect(field.value).toBe('why so high?')
  // the input bar asks for the keys again: Claude Code keeps a ↵ typed at an empty prompt, so it never reaches the panel
  expect(w.opened.slice(opens).some(x => x.id === 'object' && x.focus)).toBe(true)
  // a click on the input bar gives it the keys, and ↵ sends what it shows: the question, once
  w.keys.panel = true
  await $.ui.focus({ requestId: 'object', element: field.key, origin: { kind: 'person' } } as never)
  await clock.settle()
  const ui = await mounted($)
  await ui.input({ key: field.key, text: field.value })
  await clock.settle()
  expect(w.spawns.length).toBe(1)
  expect(w.spawns[0].prompt).toContain('why so high?\n\nAbout')
  expect(w.spawns[0].prompt).not.toContain('why so high?why so high?')
  expect(w.submitted.length).toBe(0)
})

test('a question begun gives the conversation more rows, and the citations they show stand above the input bar: the input bar asks for the ring again, so the ↵ that follows reaches it, not a citation', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  await markedTurn($, clock)
  await press($, clock, edit(']'))
  await press($, clock, edit('a'))
  await clock.advance(2000)
  await ask($, clock, 'why so high?')
  // a long answer, its citation at its start: the conversation's window shows its end
  const long = ['Most were [6,543 saves](q1#day=2026-06-18@n) of reverts.', ...Array.from({ length: 12 }, (_, i) => `Line ${i + 1} of the answer.`)].join('\n\n')
  await w.answer($, clock, 'agent-1', long)
  await pane($, clock)
  const cites = async () => pressKeys(await $.ui.render(PANE)).filter(k => k.startsWith('mk-conv'))
  expect(await cites()).toEqual([])
  // the ring lands on the input bar, and a letter is typed there
  const field = (await fieldOf($)).key
  await $.ui.focus({ requestId: 'object', element: field, origin: { kind: 'plugin', name: 'thimble' } } as never)
  await clock.settle()
  const opens = w.opened.length
  const ui = await mounted($)
  await ui.input({ key: field, text: 'a', kind: 'change' })
  await pane($, clock)
  // the conversation takes more rows while a question is typed: its citation is a press above the input bar now
  expect(await cites()).toEqual(['mk-conv-a1-0'])
  // Claude Code keeps the ring at its place in the order of the presses, which is the citation now: the input bar asks
  // for the ring again
  expect(w.opened.slice(opens).some(x => x.id === 'object' && x.focus)).toBe(true)
})

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

test("a reply's margin: a ? over the ● (shown under the pointer) asks about the passage in a side thread, as a does; once asked, a ↳ in its place opens that thread", async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  await markedTurn($, clock)
  const REPLY = { component: 'AssistantMessage', surface: 'terminal', requestId: ROW, props: { text: MARKED, isFirstOfReply: true }, viewport: { columns: 100, rows: 40, isFullscreen: true } } as never
  const ui = await $.ui.mount({ plugin: 'thimble', ...(REPLY as Any) } as never)
  const tree = await ui.drawn()
  // the ?, in the ●'s own cell: drawn out of the flow, shown only while the pointer is over its row
  const q = pressKeys(tree).find(k => k.endsWith('-ask'))!
  expect(q).toBeDefined()
  expect(JSON.stringify(tree)).toMatch(/"display":"none","position":"absolute","top":0,"left":0\},"hover":\{"display":"flex"\}/)
  // (the ● stays drawn under it: the ? hides nothing while the pointer is elsewhere)
  expect(textOf(tree)).toMatch(/^●\?Mostly 6,543 saves on June 18/)
  await ui.press({ key: q })
  await clock.advance(2000)
  await pane($, clock)
  // the passage in the side panel, its input bar holding the keys, as a ask does for a citation
  expect(w.opened.some(x => String(x.title).startsWith('Passage · "Mostly 6,543 saves on June 18'))).toBe(true)
  expect(JSON.stringify(await $.ui.render(PANE))).toMatch(/"key":"ask-\d+"[^}]*"autoFocus":true/)
  await ask($, clock, 'why June 18?')
  expect(w.spawns[0].prompt).toContain("About: this passage of Claude's message:\nMostly [6,543 saves](q1#day=2026-06-18@n) on June 18")
  // once asked: a ↳ in the margin, which opens that thread again
  await ui.redraw()
  const asked = pressKeys(await ui.drawn()).find(k => k.endsWith('-asked'))!
  expect(asked).toBeDefined()
  expect(pressKeys(await ui.drawn()).some(k => k.endsWith('-ask'))).toBe(false)
  const n = w.opened.length
  await ui.press({ key: asked })
  await clock.settle()
  expect(w.opened.slice(n).some(x => String(x.title).startsWith('Passage · '))).toBe(true)
})

test('the thread list opens from the prompt, never from inside a thread: t in the panel is a letter of the question; the bar\'s threads opens the list, which has no input bar, and a press on a row opens that thread', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  // a card's thread, and the thread of a citation in its answer
  await $.command.run({ command: 'card', args: '01-saves day-2026-06-18' } as never)
  await pane($, clock)
  const ui = await ask($, clock, 'why so many links?')
  await w.answer($, clock, 'agent-1', 'Links peaked that day: [2,994](q2#n) of the saves.')
  await pane($, clock)
  await ui.press({ key: keysIn(await ui.drawn()).find(k => /^mk-conv-a\d+-0$/.test(k))! })
  await clock.settle()
  await pane($, clock)
  await ask($, clock, 'from which wiki?')
  await w.answer($, clock, 'agent-2', 'Mostly wiki A.')
  await pane($, clock)
  // t in the panel, alone, is a letter of the question: no list
  const opens = w.opened.length
  expect(await press($, clock, edit('t'))).toEqual({ text: '', cursor: 0 })
  await clock.advance(800)
  await clock.settle()
  expect(w.opened.slice(opens).some(x => x.title === 'Threads')).toBe(false)
  expect(JSON.stringify(await $.ui.render(PANE))).toContain('"value":"t"')
  // the bar's threads opens the list
  const band = await $.ui.mount({ ...(BAND as Any) } as never)
  await band.press({ key: 'bar-item-threads' })
  await clock.settle()
  expect(w.opened.some(x => x.title === 'Threads')).toBe(true)
  const list = await pane($, clock)
  expect(list).toContain('▎ Threads')
  expect(list).toContain('main/2,994')
  expect(list).toContain('main/Saves per day')
  // the list is no thread: no conversation and no input bar under it
  expect(list).not.toContain('Mostly wiki A.')
  expect(JSON.stringify(await $.ui.render(PANE))).not.toContain('"placeholder"')
  // a press on the card's row opens it: the card at the top again, its conversation under it, the way back to the list
  const ui3 = await mounted($)
  const row = keysIn(await ui3.drawn()).find(k => /^r\|side\|\d+\|t1$/.test(k))!
  expect(row).toBeDefined()
  await ui3.press({ key: row })
  await clock.settle()
  const opened = await pane($, clock)
  expect(opened).toContain('Jun 17 ▆')
  expect(opened).toContain('❯ why so many links?')
  expect(opened).toContain('Links peaked that day: 2,994 of the saves.')
  expect(opened).toContain('‹ Threads')
  expect(await hintOf($)).toContain('esc back')
  expect(w.submitted.length).toBe(0)
  const r = await $.command.run({ command: 'threads', args: '' } as never)
  expect((r as Any).text).toBeUndefined()
})

test("a card a thread's agent saves is drawn under its answer in the panel; a new version of the card shown above is named, not drawn again", async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  await $.command.run({ command: 'card', args: '01-saves day-2026-06-18' } as never)
  await pane($, clock)
  await ask($, clock, 'show links per day')
  // the agent saves another card, and a new version of this one
  const feed = '/home/t/.thimble/lean/events/s-1.jsonl'
  w.files[feed] = `${JSON.stringify({ t: Date.now() / 1000 + 5, kind: 'save', session: SESSION, root: ROOT, object: '02-links', version: 1 })}\n${JSON.stringify({ t: Date.now() / 1000 + 5, kind: 'save', session: SESSION, root: ROOT, object: '01-saves', version: 2 })}\n`
  await $.tool.call({ tool: 'Bash', command: 'thimble save links', agentId: 'agent-1' } as never)
  await w.answer($, clock, 'agent-1', 'Here they are.')
  const shown = await pane($, clock)
  expect(shown).toContain('● Here they are.')
  expect(shown).toContain('saved a new version of this card, shown above')
  // 02-links drawn as under a reply (its parts), under the answer
  expect(shown.lastIndexOf('Jun 18 ▆')).toBeGreaterThan(shown.indexOf('Here they are.'))
})

test('a terminal too narrow for the panel: 1 in the tray leaves the tray as it was and a toast names /threads, which opens the citation here', async ($, on) => {
  const w = world(on, { isPlaced: false, reason: 'the panel needs 144 columns (120 now)' })
  const clock = mock.clock(on)
  await markedTurn($, clock)
  await press($, clock, edit(']'))
  await press($, clock, edit('1'))
  expect(w.toasts.at(-1)).toBe('The side panel needs 144 columns when a key opens it (120 now). Type /threads to open it here, or widen the terminal.')
  // the keys are the chat's again, and the tray still shows the citation
  expect(await hintOf($)).toContain('a ask')
  expect(await press($, clock, edit('w'))).toEqual({ text: 'w', cursor: 1 })
  const n = w.opened.length
  await $.command.run({ command: 'threads', args: '' } as never)
  expect(w.opened.slice(n).some(x => x.title === 'Cite · 6,543 saves')).toBe(true)
})
