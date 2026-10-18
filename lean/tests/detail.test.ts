// The card detail (shell/detail.tsx) and the side threads (shell/thread.ts): one pattern for every card (header with
// v1 · v2, the card with its part marked, the claim with [ ] n of m, the "from" line, the examples' words), keys that
// act only while the composer is empty (and give their letter back when they began a word), a question typed while the
// detail is open goes to the card's side thread and never to main, the thread's reports never enter main, a question
// after a part change names the new part, and the thread's turns come from its agent's transcript.
// `claude plugin test lean`. The drawing, `lean coverage` and `lean resolve` are answered here, at process.run.
import { expect, mock, test } from 'claude-code/testing'

const ROOT = '/data'
const SESSION = 's-1'
const PROGRAM = "k.examples('ex-18', {}); return k.stack(k.region('day-2026-06-17', {}, k.text('a')), k.region('day-2026-06-18', {}, k.text('b')))"
const OBJECT = {
  id: '01-saves', version: 2, title: 'Saves per day', program: PROGRAM, text: 'June 18 had [6,543](#day-2026-06-18) saves.',
  history: [{ v: 1, at: 'a' }, { v: 2, at: 'b', change: 'split by label' }],
  data: { days: [] }, lineage: { cites: [], rows: { 'revisions.jsonl': { count: 6543 } }, queries: { q1: { uses: [{ name: 'purpose' }] } } },
}
const V1 = { ...OBJECT, version: 1, title: 'Saves per day (first)' }
const region = (id: string, label: string, y: number, ex?: string) => ({ t: 'region', id, meta: { label, ...(ex ? { examples: ex } : {}) }, kid: { t: 'text', runs: [{ s: `${label} ${'▆'.repeat(10)}`, tone: 'ink' }], wrap: false, w: 30 }, y })
const DRAWING = {
  kit: 1, w: 98, h: 24, mode: 'detail',
  root: { t: 'stack', kids: [region('day-2026-06-17', 'Jun 17', 0), region('day-2026-06-18', 'Jun 18', 1, 'ex-18')] },
  cites: {},
  examples: { 'ex-18': { label: 'saves on Jun 18', total: 6543, records: [
    { rev_id: 'wA~P@1', page_id: 'wA/Lexicon', name: 'Lexicon', body: 'Hello agents, sign below.', label: 'Scout' },
    { rev_id: 'wA~P@2', page_id: 'wA/Lexicon', name: 'Lexicon', body: 'Put the table back.', label: 'Keeper' },
  ] } },
  regions: [{ id: 'day-2026-06-17', meta: { label: 'Jun 17' } }, { id: 'day-2026-06-18', meta: { label: 'Jun 18', examples: 'ex-18' } }], warnings: [], ms: 1,
}
const COVERAGE = { feeding: [{ path: 'revisions.jsonl' }], not_feeding: [{ path: 'pages.jsonl' }] }
const PANE = { component: 'Pane', surface: 'terminal', requestId: 'object', props: { bodyColumns: 100, scroll: { bodyRows: 40, offset: 0 }, isFocused: true, placement: 'dock', title: 'Saves per day', view: {} } } as never
const edit = (key: string, text = '') => ({ origin: { kind: 'composer' }, key: { key }, text, cursor: text.length, start: text.length, end: text.length, inputText: key.length === 1 ? key : '' }) as never

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function world(on: any) {
  mock.env(on, { THIMBLE_HOME: '/home/t/.thimble' })
  on('session.cwd', () => ({ value: ROOT }))
  on('session.id', () => ({ value: SESSION }))
  const files: Record<string, string> = {
    [`${ROOT}/thimble/objects/01-saves.json`]: JSON.stringify(OBJECT),
    [`${ROOT}/thimble/objects/.versions/01-saves/v1.json`]: JSON.stringify(V1),
  }
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: e.path in files || e.path === `${ROOT}/thimble/objects` }))
  on('fs.list', () => ({ value: [] }))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: files[e.path] ?? '' }))
  on('fs.write', (_$: unknown, e: { path: string; content?: string; text?: string; data?: string }) => { files[e.path] = String(e.content ?? e.text ?? e.data ?? ''); return { value: undefined } })
  on('process.run', (_$: unknown, e: { argv: string[] }) => {
    let out: unknown = {}
    if (e.argv.some(a => a.endsWith('prep.mjs'))) out = { drawing: DRAWING, verbs: [], problems: [] }
    else if (e.argv.includes('coverage')) out = COVERAGE
    else if (e.argv.includes('resolve')) out = { ref: e.argv[2], chain: [], rows: [], count: 0, records: [], notes: [] }
    return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const opened: Any[] = []
  on('ui.open', (_$: unknown, e: Any) => { opened.push(e); return { value: { isPlaced: true } } })
  on('ui.focus', () => ({}))
  const views: Any[] = []
  on('ui.view', (_$: unknown, e: Any) => { views.push(e); return { value: {} } })
  on('prompt.edit', (_$: unknown, e: { text: string; start: number; end: number; inputText: string }) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
  const fills: string[] = []
  on('prompt.fill', (_$: unknown, e: { text: string }) => { fills.push(e.text); return { isFilled: true } })
  const submitted: string[] = []
  on('prompt.submit', (_$: unknown, e: { text: string }) => { submitted.push(e.text); return { text: e.text } })
  const spawns: Any[] = []
  on('agent.register', () => ({ value: { agent: 'thimble-lean:thread' } }))
  on('agent.spawn', (_$: unknown, e: Any) => { spawns.push(e); return { model: 'claude-test' } as never })
  on('agent.list', () => ({ value: spawns.map((_, i) => ({ id: `agent-${i + 1}`, type: 'thimble-lean:thread', description: 'thread', status: 'running' })) }))
  const sent: Any[] = []
  on('session.send', (_$: unknown, e: Any) => { sent.push(e); return { isDelivered: true } })
  on('session.messages', () => ({ value: [
    { role: 'user', content: [{ type: 'text', text: '<system-reminder>env</system-reminder>' }, { type: 'text', text: spawns[0]?.prompt ?? '' }] },
    { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'lean resolve "q1#day=2026-06-18@n"' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'rows' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Links peaked that day: [2,994](q2#n) of the saves.' }] },
  ] }))
  const status: string[] = []
  on('ui.status', (_$: unknown, e: { text?: string }) => { status.push(String(e.text ?? '')); return { value: undefined } })
  const toasts: string[] = []
  on('ui.toast', (_$: unknown, e: { text?: string }) => { toasts.push(String(e.text ?? '')); return { value: undefined } })
  on('config.list', () => ({ value: [] }))
  on('turn.start', (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('command.register', (_$: unknown, e: { name: string }) => ({ value: { command: e.name } }))
  // Claude Code's hint line under the prompt, as a hook leaves it
  on('ui.render', { component: 'PromptHint' }, (_$: unknown, e: { props: { hint: string } }) => ({ type: 'Text', props: {}, children: [String(e.props.hint)] }) as never)
  on('ui.render', () => ({ type: 'Text', props: {}, children: [''] }) as never)
  return { files, opened, views, fills, submitted, spawns, sent, toasts, status }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function textOf(n: any): string {
  if (n == null || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  return textOf(n.props?.children) + textOf(n.children)
}

const HINT = { plugin: 'thimble-lean', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows: 16, bodyColumns: 200, scroll: { offset: 0, bodyRows: 16 }, view: {} }, viewport: { columns: 200, rows: 48, isFullscreen: true } } as never
const BAND = { plugin: 'thimble-lean', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 100, scroll: { offset: 0, bodyRows: 12 }, view: {} }, viewport: { columns: 140, rows: 40, isFullscreen: true } } as never
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hintOf = async ($: any) => textOf(await $.ui.render(HINT))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function pane($: any, clock: { settle: () => Promise<void> }): Promise<string> {
  await $.ui.render(PANE)
  await clock.settle()
  await $.ui.render(PANE)
  await clock.settle()
  return textOf(await $.ui.render(PANE))
}

test('overview first: the card enlarged under its title, takeaway and v1 · v2; the bar under it starts empty, and e fills it with examples labelled with what they are examples of', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  await $.command.run({ command: 'obj', args: '01-saves day-2026-06-18' } as never)
  await clock.settle()
  // the pane docks beside the transcript and asks for the keys
  expect(w.opened.at(-1)).toMatchObject({ id: 'object', focus: true, closeOnEscape: true })
  const t = await pane($, clock)
  expect(t).toContain('Saves per day')
  // the card's id shows here only, in the header, beside its versions
  expect(t).toContain('card:01-saves')
  expect(t).toContain('v1 · v2')
  expect(t).toContain('June 18 had 6,543 saves.')
  expect(t).toContain('▸Jun 17')
  expect(t).toContain('Jun 18 ▆▆▆')
  // no details up front: no examples, no rows, no from line
  expect(t).not.toContain('Hello agents')
  expect(t).not.toContain('[ ]')
  expect(t).not.toContain('from revisions.jsonl')
  // the empty bar is whitespace: no frame, no words; its keys are in the hint line
  expect(t).not.toContain('details')
  expect(t).not.toContain('esc back')
  expect(await hintOf($)).toContain('↑↓ part · ↵ details · e examples · p program · h versions · type to ask this card · esc back')
  // ↵ on the selected part (the ring's press) fills the bar with its details: where it comes from, and its examples one key away
  const ui = await $.ui.mount({ plugin: 'thimble-lean', ...(PANE as Any) } as never)
  await clock.settle()
  await ui.press({ key: 'r|pane|1|day-2026-06-18' })
  await clock.settle()
  const d = textOf(await ui.drawn())
  expect(d).toContain('from revisions.jsonl')
  expect(d).not.toContain('e examples')
  expect(await hintOf($)).toContain('↑↓ part · e examples · 0 clear')
  expect(d).not.toContain('Hello agents')
  // e: the examples of the selected part, labelled, with their from line; each reads as its words, never as field: value
  expect(await ($ as Any).prompt.edit(edit('e'))).toEqual({ text: '', cursor: 0 })
  const b = await pane($, clock)
  expect(b).toContain('examples of saves on Jun 18 · 1 of 6,543')
  expect(await hintOf($)).toContain('[ ] flip · e hide examples · 0 clear')
  expect(b).toContain('from revisions.jsonl')
  expect(b).toContain('label purpose')
  expect(b).toContain('1 of 2 files read')
  expect(b).toContain('Hello agents, sign below.')
  expect(b).toContain('Lexicon · Scout')
  expect(b).not.toContain('rev_id')
  expect(b).not.toContain('page_id:')
  // 0 empties the bar again
  await clock.advance(1000)
  expect(await ($ as Any).prompt.edit(edit('0'))).toEqual({ text: '', cursor: 0 })
  expect(await pane($, clock)).not.toContain('Hello agents')
})

test('keys act only while the composer is empty; a key that began a word gives its letter back; h steps to v1', async ($, on) => {
  world(on)
  const clock = mock.clock(on)
  await $.command.run({ command: 'obj', args: '01-saves day-2026-06-18' } as never)
  await pane($, clock)
  // ] opens the bar on the first example, and flips to the next
  expect(await ($ as Any).prompt.edit(edit(']'))).toEqual({ text: '', cursor: 0 })
  expect(await pane($, clock)).toContain('· 1 of 6,543')
  expect(await ($ as Any).prompt.edit(edit(']'))).toEqual({ text: '', cursor: 0 })
  expect(await pane($, clock)).toContain('· 2 of 6,543')
  // p lays the program over the card; a letter straight after it was the start of a word
  expect(await ($ as Any).prompt.edit(edit('p'))).toEqual({ text: '', cursor: 0 })
  expect(await pane($, clock)).toContain('how Claude drew this')
  expect(await ($ as Any).prompt.edit(edit('l'))).toEqual({ text: 'pl', cursor: 2 })
  expect(await pane($, clock)).not.toContain('how Claude drew this')
  // once a question has begun, every key types
  expect(await ($ as Any).prompt.edit(edit('p', 'what about '))).toEqual({ text: 'what about p', cursor: 12 })
  expect(await ($ as Any).prompt.edit(edit(']', 'x'))).toEqual({ text: 'x]', cursor: 2 })
  // h steps back to v1 (the history lives in the header)
  await clock.advance(1000)
  expect(await ($ as Any).prompt.edit(edit('h'))).toEqual({ text: '', cursor: 0 })
  expect(await pane($, clock)).toContain('Saves per day (first)')
})

test('a question typed while the detail is open goes to the card\'s side thread, never to main; its reports never enter main; a later question names a new part', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  const session = mock.session(on)
  await $.command.run({ command: 'obj', args: '01-saves day-2026-06-18' } as never)
  await pane($, clock)
  const r = await $.prompt.submit({ text: 'why so many links?', origin: { kind: 'composer' } } as never)
  await clock.advance(100)
  // dropped from main, with where it went; the prompt box is cleared; the main view stays (the pane draws the thread)
  expect(String((r as Any).drop)).toContain("asked the card's thread about Jun 18")
  expect(w.submitted).not.toContain('why so many links?')
  expect(w.fills).toContain('')
  expect(w.views.length).toBe(0)
  // its agent: the question, the part and the card, and the folder of the data
  expect(w.spawns.length).toBe(1)
  expect(w.spawns[0].subagent_type).toBe('thimble-lean:thread')
  expect(w.spawns[0].prompt).toContain('why so many links?\n\nAbout: the part "Jun 18" (day-2026-06-18) of the card "Saves per day" (01-saves@2')
  expect(w.spawns[0].cwd).toBe(ROOT)
  // the thread's hand-back and its task notification are dropped; another agent's notification is main's
  const back = await $.prompt.submit({ text: '<agent-message from="agent-1">\n[Subagent hand-back] Links peaked.', origin: { kind: 'peer' } } as never)
  expect(String((back as Any).drop)).toBe('the thread of Jun 18 answered')
  const note = await $.prompt.submit({ text: '<task-notification>\n<task-id>agent-1</task-id>', origin: { kind: 'task-notification' } } as never)
  expect(String((note as Any).drop)).toContain('answered')
  await $.prompt.submit({ text: '<task-notification>\n<task-id>someone-else</task-id>', origin: { kind: 'task-notification' } } as never)
  expect(w.submitted.some(s => s.includes('someone-else'))).toBe(true)
  // the thread's turns come from its agent's transcript, the person's question in place of the prompt it got
  await $.turn.complete({ turnId: 'x', agentId: 'agent-1', answer: '', durationMs: 5, reason: 'answer', isAborted: false } as never)
  await clock.settle()
  const file = JSON.parse(w.files[`${ROOT}/thimble/threads/${SESSION}/card-01-saves.json`]!)
  // the shared form: id, session, scope, title (the first question), turns of the person and claude
  expect(file).toMatchObject({ id: 'card-01-saves', session: SESSION, title: 'why so many links?', status: 'done' })
  expect(file.scope).toMatchObject({ object: '01-saves', region: 'day-2026-06-18' })
  expect(file.turns[0]).toMatchObject({ role: 'person', text: 'why so many links?', about: 'Jun 18' })
  expect(file.turns[1].role).toBe('claude')
  expect(typeof file.turns[1].at).toBe('string')
  // the thimble line above the prompt counts the threads, and names the thread the prompt goes to
  const line = textOf(await $.ui.render(BAND))
  expect(line).toContain('1 thread')
  expect(line).toContain('thimble:main/01-saves')
  expect(w.status.length).toBe(0)
  expect(file.turns[1].calls).toEqual(['lean resolve "q1#day=2026-06-18@n"'])
  expect(file.turns[1].text).toContain('Links peaked that day')
  expect(await pane($, clock)).toContain('1 question · answered')
  // a wide pane: the card's thread is its left column, the question with its part, then the answer
  const WIDE = { ...(PANE as Any), props: { ...(PANE as Any).props, bodyColumns: 140 } } as never
  await $.ui.render(WIDE)
  await clock.settle()
  const wide = textOf(await $.ui.render(WIDE))
  expect(wide).not.toContain('Thread ·')
  expect(wide).not.toContain("card's own thread")

  expect(wide).toContain('❯ why so many links?')
  expect(wide).toContain('about Jun 18')
  expect(wide).toContain('lean resolve "q1#day=2026-06-18@n"')
  expect(wide).toContain('Links peaked that day: 2,994 of the')
  // another part: the next question resumes the same agent and names the new part
  await $.command.run({ command: 'obj', args: '01-saves day-2026-06-17' } as never)
  await pane($, clock)
  // the thread's agent can read the part selected now (a message typed in its own view names none)
  expect(w.spawns[0].prompt).toContain(`${ROOT}/thimble/threads/${SESSION}/sel/card-01-saves.json`)
  await $.prompt.submit({ text: 'and here?', origin: { kind: 'composer' } } as never)
  expect(w.spawns.length).toBe(1)
  expect(w.sent.at(-1).text).toContain('and here?')
  expect(w.sent.at(-1).text).toContain('About the part "Jun 17" (day-2026-06-17) now.')
  // m sends the thread's answer to main, as a row Claude reads with the next prompt
  expect(await ($ as Any).prompt.edit(edit('m'))).toEqual({ text: '', cursor: 0 })
  await clock.settle()
  expect(JSON.stringify(session.appended())).toContain('The thread answered: Links peaked that day')
})

test('with no detail open, a prompt goes to Claude as always', async ($, on) => {
  const w = world(on)
  await $.prompt.submit({ text: 'what next?', origin: { kind: 'composer' } } as never)
  expect(w.submitted).toContain('what next?')
  expect(w.spawns.length).toBe(0)
})

