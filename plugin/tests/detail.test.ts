// The card detail (shell/detail.tsx) and the side threads (shell/thread.ts): one pattern for every card (header with
// v1 · v2, the card with its part marked, the claim with [ ] n of m, the "from" line, the examples' words), keys that
// act only while the composer is empty (and give their letter back when they began a word), a question typed while the
// detail is open goes to the card's side thread and never to main, the thread's reports never enter main, a question
// after a part change names the new part, and the thread's turns come from its agent's transcript.
// `claude plugin test plugin`. The drawing, `thimble coverage` and `thimble resolve` are answered here, at process.run.
import { expect, mock, test } from 'claude-code/testing'
import { press, promptStub } from './stubs'

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
function world(on: any, prep: (input: Any) => Any = () => DRAWING, open: Any = { isPlaced: true }) {
  mock.env(on, { THIMBLE_HOME: '/home/t/.thimble' })
  on('session.cwd', () => ({ value: ROOT }))
  on('session.id', () => ({ value: SESSION }))
  const files: Record<string, string> = {
    [`${ROOT}/thimble/objects/01-saves.json`]: JSON.stringify(OBJECT),
    [`${ROOT}/thimble/objects/.versions/01-saves/v1.json`]: JSON.stringify(V1),
  }
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
      out = { drawing: prep(input) }
    }
    else if (e.argv.includes('coverage')) out = COVERAGE
    else if (e.argv.includes('resolve')) out = { ref: e.argv[2], chain: [], rows: [], count: 0, records: [], notes: [] }
    return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const opened: Any[] = []
  on('ui.open', (_$: unknown, e: Any) => { opened.push(e); return { value: open } })
  const focused: string[] = []
  on('ui.focus', (_$: unknown, e: Any) => { focused.push(String(e.element ?? e.key)); return { value: {} } })
  on('ui.panes', () => ({ value: opened.length ? [{ id: 'object', title: 'Saves per day', isShown: true, isFocused: true, isPlaced: true, plugin: 'thimble' }] : [] }))
  const views: Any[] = []
  on('ui.view', (_$: unknown, e: Any) => { views.push(e); return { value: {} } })
  on('prompt.edit', (_$: unknown, e: { text: string; start: number; end: number; inputText: string }) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
  const fills: string[] = []
  on('prompt.fill', (_$: unknown, e: { text: string }) => { fills.push(e.text); return { isFilled: true } })
  const submitted: string[] = []
  on('prompt.submit', (_$: unknown, e: { text: string }) => { submitted.push(e.text); return { text: e.text } })
  const spawns: Any[] = []
  on('agent.register', () => ({ value: { agent: 'thimble:thread' } }))
  on('agent.spawn', (_$: unknown, e: Any) => { spawns.push(e); return { model: 'claude-test' } as never })
  on('agent.list', () => ({ value: spawns.map((_, i) => ({ id: `agent-${i + 1}`, type: 'thimble:thread', description: 'thread', status: 'running' })) }))
  const sent: Any[] = []
  on('session.send', (_$: unknown, e: Any) => { sent.push(e); return { isDelivered: true } })
  on('session.messages', () => ({ value: [
    { role: 'user', content: [{ type: 'text', text: '<system-reminder>env</system-reminder>' }, { type: 'text', text: spawns[0]?.prompt ?? '' }] },
    { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'thimble resolve "q1#day=2026-06-18@n"' } }] },
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
  return { files, opened, views, fills, submitted, spawns, sent, toasts, status, preps, focused }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function textOf(n: any): string {
  if (n == null || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  return textOf(n.props?.children) + textOf(n.children)
}

// the props of each Text whose own words hold `part`, with the color it inherits from a Text around it
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function textsWith(n: any, part: string, color?: string): { color?: string; backgroundColor?: string }[] {
  if (n == null || typeof n !== 'object') return []
  if (Array.isArray(n)) return n.flatMap(x => textsWith(x, part, color))
  const kids = n.props?.children ?? n.children
  const own = n.type === 'Text' ? (n.props?.color ?? color) : color
  const words = (Array.isArray(kids) ? kids : [kids]).filter((k: unknown) => typeof k === 'string').join('')
  const here = n.type === 'Text' && words && words.includes(part) ? [{ color: own, backgroundColor: n.props?.backgroundColor }] : []
  return [...here, ...textsWith(kids, part, own)]
}

const HINT = { plugin: 'thimble', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows: 16, bodyColumns: 200, scroll: { offset: 0, bodyRows: 16 }, view: {} }, viewport: { columns: 200, rows: 48, isFullscreen: true } } as never
const BAND = { plugin: 'thimble', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 100, scroll: { offset: 0, bodyRows: 12 }, view: {} }, viewport: { columns: 140, rows: 40, isFullscreen: true } } as never
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hintOf = async ($: any) => textOf(await $.ui.render(HINT))
// the ask line's key in the pane as drawn now
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const askKeyOf = async ($: any) => /"key":"(ask-\d+)"/.exec(JSON.stringify(await $.ui.render(PANE)))?.[1] ?? 'ask-0'

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
  await $.command.run({ command: 'card', args: '01-saves day-2026-06-18' } as never)
  await clock.settle()
  // the pane docks beside the transcript and asks for the keys
  expect(w.opened.at(-1)).toMatchObject({ id: 'object', focus: true, closeOnEscape: true })
  const t = await pane($, clock)
  expect(t).toContain('Saves per day')
  // the card's id shows here only, in the header, beside its versions
  expect(t).toContain('card:01-saves')
  expect(t).toContain('v1 · v2')
  expect(t).toContain('June 18 had 6,543 saves.')
  // the selected part is marked beside the card (the page above it is the detail's program, panes/detail.js)
  expect(t).toContain('▸')
  expect(t).toContain('Jun 18 ▆▆▆')
  // no details up front: no examples, no rows, no from line
  expect(t).not.toContain('Hello agents')
  expect(t).not.toContain('[ ]')
  expect(t).not.toContain('from revisions.jsonl')
  // the empty bar is whitespace: no frame, no words; its keys are in the hint line
  expect(t).not.toContain('details')
  expect(t).not.toContain('esc back')
  expect(await hintOf($)).toContain('↑↓ part · ↵ details · e examples · p program · h versions · type to ask about Jun 18 · esc back')
  // ↵ on the selected part (the ring's press) fills the bar with its details: where it comes from, and its examples one key away
  const ui = await $.ui.mount({ plugin: 'thimble', ...(PANE as Any) } as never)
  await clock.settle()
  await ui.press({ key: 'r|pane|1|day-2026-06-18' })
  await clock.settle()
  const d = textOf(await ui.drawn())
  expect(d).toContain('from revisions.jsonl')
  expect(d).not.toContain('e examples')
  expect(await hintOf($)).toContain('↑↓ part · e examples · 0 clear')
  expect(d).not.toContain('Hello agents')
  // e: the examples of the selected part, labelled, with their from line; each reads as its words, never as field: value
  expect(await press($, clock, edit('e'))).toEqual({ text: '', cursor: 0 })
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
  expect(await press($, clock, edit('0'))).toEqual({ text: '', cursor: 0 })
  expect(await pane($, clock)).not.toContain('Hello agents')
})

test('keys act only while the composer is empty; a key that began a word gives its letter back; h steps to v1', async ($, on) => {
  world(on)
  const clock = mock.clock(on)
  await $.command.run({ command: 'card', args: '01-saves day-2026-06-18' } as never)
  await pane($, clock)
  // ] opens the bar on the first example, and flips to the next
  expect(await press($, clock, edit(']'))).toEqual({ text: '', cursor: 0 })
  expect(await pane($, clock)).toContain('· 1 of 6,543')
  expect(await press($, clock, edit(']'))).toEqual({ text: '', cursor: 0 })
  expect(await pane($, clock)).toContain('· 2 of 6,543')
  // p lays the program over the card; a letter straight after it was the start of a word: both go to the ask line,
  // never into the prompt
  expect(await press($, clock, edit('p'))).toEqual({ text: '', cursor: 0 })
  expect(await pane($, clock)).toContain('how Claude drew this')
  expect(await press($, clock, edit('l'))).toEqual({ text: '', cursor: 0 })
  await clock.settle()
  expect(await pane($, clock)).not.toContain('how Claude drew this')
  expect(JSON.stringify(await $.ui.render(PANE))).toContain('"value":"pl"')
  expect(await hintOf($)).toContain('↵ ask · esc back to the card')
  // a letter that arrives before the ask line has the keys joins the question, and so does a paste (no key)
  expect(await press($, clock, edit('a'))).toEqual({ text: '', cursor: 0 })
  expect(JSON.stringify(await $.ui.render(PANE))).toContain('"value":"pla"')
  expect(await press($, clock, { origin: { kind: 'composer' }, text: '', cursor: 0, start: 0, end: 0, inputText: 'nts here?' } as never)).toEqual({ text: '', cursor: 0 })
  expect(JSON.stringify(await $.ui.render(PANE))).toContain('"value":"plants here?"')
  // with words in the composer (typed there before the detail opened), every key types there
  expect(await press($, clock, edit('p', 'what about '))).toEqual({ text: 'what about p', cursor: 12 })
  expect(await press($, clock, edit(']', 'x'))).toEqual({ text: 'x]', cursor: 2 })
  // ↵ in the ask line asks the card's thread, and the keys go back to the card
  const ui = await $.ui.mount({ plugin: 'thimble', ...(PANE as Any) } as never)
  await ui.input({ key: await askKeyOf($), text: 'plants?' })
  await clock.settle()
  expect(JSON.stringify(await $.ui.render(PANE))).not.toContain('"value":"plants here?"')
  // h steps back to v1 (the history lives in the header)
  await clock.advance(1000)
  expect(await press($, clock, edit('h'))).toEqual({ text: '', cursor: 0 })
  expect(await pane($, clock)).toContain('Saves per day (first)')
})

test('a question typed while the detail is open goes to the card\'s side thread, never to main; its reports never enter main; a later question names a new part', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  const session = mock.session(on)
  await $.command.run({ command: 'card', args: '01-saves day-2026-06-18' } as never)
  await pane($, clock)
  // the question is typed in the pane's ask line: it never passes through the prompt, so main's transcript gets no row
  const ui = await $.ui.mount({ plugin: 'thimble', ...(PANE as Any) } as never)
  await ui.input({ key: await askKeyOf($), text: 'why so many links?' })
  await clock.advance(100)
  expect(w.submitted).not.toContain('why so many links?')
  expect(w.views.length).toBe(0)
  // its agent: the question, the part and the card, and the folder of the data
  expect(w.spawns.length).toBe(1)
  expect(w.spawns[0].subagent_type).toBe('thimble:thread')
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
  // the bar above the prompt counts the threads, and names the thread the prompt goes to
  const wideBand = textOf(await $.ui.render({ ...(BAND as Any), props: { ...(BAND as Any).props, bodyColumns: 200 } } as never))
  expect(wideBand).toContain('1 thread')
  expect(wideBand).toContain('thimble:main/01-saves')
  // beside the docked detail the band is narrow: one line, the counts dropped first, the keys kept as words
  const line = textOf(await $.ui.render(BAND))
  expect(line).not.toContain('1 thread')
  expect(line.length).toBeLessThanOrEqual(99)
  expect(line).toContain('↑↓ part')
  expect(w.status.length).toBe(0)
  expect(file.turns[1].calls).toEqual(['thimble resolve "q1#day=2026-06-18@n"'])
  expect(file.turns[1].text).toContain('Links peaked that day')
  // under the card, the thread's latest exchange: the question with its part, its last step, then the answer
  const t = await pane($, clock)
  expect(t).not.toContain("card's own thread")
  expect(t).toContain('❯ why so many links?')
  expect(t).toContain('about Jun 18')
  expect(t).toContain('thimble resolve "q1#day=2026-06-18@n"')
  expect(t).toContain('Links peaked that day: 2,994 of the')
  // on the pane's background the answer's words and the selected part's name read in the theme's text color, never
  // the terminal's own (which may be light on a light pane); a colored mark in the part keeps its color
  const drawnPane = await $.ui.render(PANE)
  expect(textsWith(drawnPane, 'peaked').map(x => x.color)).toEqual(['text'])
  const picked = textsWith(drawnPane, 'Jun 18').filter(x => x.backgroundColor === 'selectionBg')
  expect(picked.length).toBeGreaterThan(0)
  expect([...new Set(picked.map(x => x.color))]).toEqual(['text'])
  // another part: the next question resumes the same agent and names the new part
  await $.command.run({ command: 'card', args: '01-saves day-2026-06-17' } as never)
  await pane($, clock)
  // the thread's agent can read the part selected now (a message typed in its own view names none)
  expect(w.spawns[0].prompt).toContain(`${ROOT}/thimble/threads/${SESSION}/sel/card-01-saves.json`)
  // a question typed in the composer instead (its words were there before) goes to the thread too, dropped from main
  const r = await $.prompt.submit({ text: 'and here?', origin: { kind: 'composer' } } as never)
  expect(String((r as Any).drop)).toContain("asked the card's thread about Jun 17")
  expect(w.submitted).not.toContain('and here?')
  expect(w.spawns.length).toBe(1)
  expect(w.sent.at(-1).text).toContain('and here?')
  expect(w.sent.at(-1).text).toContain('About the part "Jun 17" (day-2026-06-17) now.')
  // m sends the thread's answer to main, as a row Claude reads with the next prompt
  expect(await press($, clock, edit('m'))).toEqual({ text: '', cursor: 0 })
  await clock.settle()
  expect(JSON.stringify(session.appended())).toContain('The thread answered: Links peaked that day')
})

test('typing in the ask line is never interrupted: the ask line keeps the ring while the question is typed, every letter reaches the thread, and the line empties after the send', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  await $.command.run({ command: 'card', args: '01-saves day-2026-06-18' } as never)
  await pane($, clock)
  const ui = await $.ui.mount({ plugin: 'thimble', ...(PANE as Any) } as never)
  await clock.settle()
  // ↵ on the selected part, then e: the bar shows its details and examples; the part's cell takes the ring
  await ui.press({ key: 'r|pane|1|day-2026-06-18' })
  await clock.settle()
  expect(await press($, clock, edit('e'))).toEqual({ text: '', cursor: 0 })
  // which element takes the ring when the pane takes the keyboard (its autoFocus)
  const ringer = async () => ((await ui.findAll({})) as Any[]).find(x => x.props?.autoFocus)?.key as string | undefined
  await ui.redraw()
  expect(await ringer()).toMatch(/^g\|pane\|\d+$/)
  // the first letter reaches the prompt (the ring was on the part), and the pane draws again before the ask line has
  // the ring: from that drawing on, the ask line takes the ring, never the part's cell
  const UNFOCUSED = { ...(PANE as Any), props: { ...(PANE as Any).props, isFocused: false } } as never
  await clock.advance(1000)
  await $.ui.render(UNFOCUSED)
  expect(await $.prompt.edit(edit('w'))).toEqual({ text: '', cursor: 0 })
  await ui.redraw()
  expect(await ringer()).toMatch(/^ask-\d+$/)
  await clock.settle()
  await ui.redraw()
  expect(await ringer()).toBe(await askKeyOf($))
  expect(await hintOf($)).toContain('↵ ask · esc back to the card')
  // letters that come faster than the ring (a burst, each drawn at once) join the question in order
  for (const c of 'hich') { await $.prompt.edit(edit(c)); await ui.redraw() }
  await clock.settle()
  await ui.redraw()
  const last = await askKeyOf($)
  expect(await ringer()).toBe(last)
  expect(JSON.stringify(await ui.drawn())).toContain('"value":"which"')
  // the rest is typed in the field itself: drawings in between keep every letter and the ring on the field
  await ui.input({ key: last, text: 'which models', kind: 'change' })
  await clock.settle()
  await pane($, clock)
  await ui.redraw()
  expect(await ringer()).toBe(last)
  expect(JSON.stringify(await ui.drawn())).toContain('"value":"which models"')
  // ↵ asks the thread with the whole question; the line empties (a field drawn afresh) and the ring goes back to the part
  await ui.input({ key: last, text: 'which models are these?' })
  await clock.settle()
  expect(w.spawns.length).toBe(1)
  expect(w.spawns[0].prompt).toContain('which models are these?\n\nAbout: the part "Jun 18"')
  await ui.redraw()
  expect(JSON.stringify(await ui.drawn())).not.toContain('"value":"which')
  expect(await askKeyOf($)).not.toBe(last)
  expect(await ringer()).toMatch(/^g\|pane\|\d+$/)
  expect(await hintOf($)).toContain('type to ask about Jun 18')
})

test('with no detail open, a prompt goes to Claude as always', async ($, on) => {
  const w = world(on)
  await $.prompt.submit({ text: 'what next?', origin: { kind: 'composer' } } as never)
  expect(w.submitted).toContain('what next?')
  expect(w.spawns.length).toBe(0)
})


test('a card is a program: its own keys reach it in the open detail, the state it answers with is kept for the browser, and ask(selection) scopes the next question', async ($, on) => {
  // the program as the sandbox would run it: j steps a day (k.on('j')), a asks about the days it has selected (k.ask)
  const prep = (input: Any) => {
    const at = Number(input.state?.at ?? 0)
    const ev = input.event
    const base = { ...DRAWING, on: [{ name: 'j', label: 'next day' }, { name: 'a', label: 'ask about these' }] }
    if (ev?.key === 'j') return { ...base, state: { at: at + 1 }, handled: 'j' }
    if (ev?.key === 'a') return { ...base, state: { at }, handled: 'a', ask: { label: '2 days from Jun 17', refs: ['q1#day=2026-06-17', 'q1#day=2026-06-18'] } }
    return { ...base, state: { at } }
  }
  const w = world(on, prep)
  const clock = mock.clock(on)
  mock.session(on)
  await $.command.run({ command: 'card', args: '01-saves day-2026-06-18' } as never)
  await pane($, clock)
  // the bar names the card's own keys beside the detail's
  expect(await hintOf($)).toContain('j next day · a ask about these')
  // j is the card's: the program runs with the key, and its new state is what the detail draws and the browser opens
  expect(await press($, clock, edit('j'))).toEqual({ text: '', cursor: 0 })
  await clock.settle()
  expect(w.preps.some(x => x.event?.type === 'key' && x.event.key === 'j' && x.event.region === 'day-2026-06-18')).toBe(true)
  const kept = JSON.parse(w.files[`${ROOT}/thimble/objects/.state/01-saves.json`] ?? '{}')
  expect(kept).toMatchObject({ state: { at: 1 }, region: 'day-2026-06-18', by: 'terminal' })
  await pane($, clock)
  expect(w.preps.at(-1).state).toMatchObject({ at: 1 })
  // a: the program asks about its own selection; the next question goes to the card's thread with those rows
  await clock.advance(1000)
  expect(await press($, clock, edit('a'))).toEqual({ text: '', cursor: 0 })
  await clock.settle()
  expect(await hintOf($)).toContain('type to ask about 2 days from Jun 17')
  const r = await $.prompt.submit({ text: 'what changed between them?', origin: { kind: 'composer' } } as never)
  await clock.advance(100)
  expect(String((r as Any).drop)).toContain("asked the card's thread about 2 days from Jun 17")
  expect(w.submitted).not.toContain('what changed between them?')
  expect(String(w.spawns[0]?.prompt)).toContain('the selection "2 days from Jun 17" in the card')
  expect(String(w.spawns[0]?.prompt)).toContain('q1#day=2026-06-17, q1#day=2026-06-18')
  // the selection was for that question: the next one is about the part again
  expect(await hintOf($)).toContain('type to ask about Jun 18')
})

test('a prompt after the pane has gone goes to Claude, even when the module still marks the detail open', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  await $.command.run({ command: 'card', args: '01-saves day-2026-06-18' } as never)
  await pane($, clock)
  // the pane went without a close the module heard: Claude Code lists it no more
  w.opened.length = 0
  await $.prompt.submit({ text: 'and across all the runs?', origin: { kind: 'composer' } } as never)
  expect(w.submitted).toContain('and across all the runs?')
  expect(w.spawns.length).toBe(0)
})

test('the detail leaves the chat about two fifths of the terminal, so its lines read beside the card', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  // a 144-column terminal, as the band above the prompt measured it
  await $.ui.render({ ...(BAND as Any), viewport: { columns: 144, rows: 36, isFullscreen: true } } as never)
  await $.command.run({ command: 'card', args: '01-saves day-2026-06-18' } as never)
  await clock.settle()
  expect(w.opened.at(-1)).toMatchObject({ id: 'object', columns: 144 - 58 })
  // the terminal widened to 240 while the detail is docked: the pane measures it (the conversation's 140 columns, its
  // own 99 and the border), and the next open keeps the chat at 80, its most
  await $.ui.render({ ...(PANE as Any), props: { ...(PANE as Any).props, bodyColumns: 99 }, viewport: { columns: 140, rows: 60, isFullscreen: true } } as never)
  await $.command.run({ command: 'card', args: '01-saves day-2026-06-17' } as never)
  await clock.settle()
  expect(w.opened.at(-1)).toMatchObject({ columns: 160 })
  // no thread column in the pane: the chat beside it is the conversation
  expect(await pane($, clock)).not.toContain('ask this card…  ')
})

test('one selection, one highlight: the ring stands on the selected part, and stays with it while the card scrolls', async ($, on) => {
  // a tall card: 30 steps, one row each, in a pane of 14 rows
  const steps = Array.from({ length: 30 }, (_, i) => region(`step-${i}`, `Step ${i}`, i))
  const TALL = { ...DRAWING, root: { t: 'stack', kids: steps }, regions: steps.map(x => ({ id: x.id, meta: x.meta })) }
  const w = world(on, () => TALL)
  const clock = mock.clock(on)
  const SMALL = { ...(PANE as Any), props: { ...(PANE as Any).props, scroll: { bodyRows: 14, offset: 0 } } } as never
  await $.command.run({ command: 'card', args: '01-saves step-0' } as never)
  const ui = await $.ui.mount({ plugin: 'thimble', ...(SMALL as Any) } as never)
  const draw = async () => { for (let i = 0; i < 3; i++) { await ui.redraw(); await clock.settle() } }
  // the gutter cells the ring can stand on, in document order, and the one marked ▸ (the selected part's)
  const gutters = async () => ((await ui.findAll({ type: 'Button' })) as Any[]).filter(b => String(b.key).startsWith('g|'))
  const marked = async () => (await gutters()).find(b => String(b.text).includes('▸'))?.key as string | undefined
  const selected = async () => { const b = (await gutters()).find(x => String(x.text).includes('▸')); const m = /Step (\d+)/.exec(String(b?.props?.label ?? '')); return m ? Number(m[1]) : -1 }
  await draw()
  expect(await selected()).toBe(0)
  let ring = (await marked())!
  expect(ring).toMatch(/^g\|pane\|\d+$/)
  let landed = 0
  // ↓ twenty times: the engine proposes the gutter cell after the ring's; each lands on the next part, past the
  // window's edge too, and the ring is put on that part's own cell (never another part's)
  for (let i = 1; i <= 20; i++) {
    const keys = (await gutters()).map(b => String(b.key))
    const at = keys.indexOf(ring)
    const proposed = keys[at + 1] ?? keys[keys.length - 1]!
    const before = w.focused.length
    await $.ui.focus({ requestId: 'object', element: proposed, origin: { kind: 'person' } } as never)
    await draw()
    expect(await selected()).toBe(i)
    const now = (await marked())!
    // where the move landed when the part was drawn: on its gutter cell
    if (w.focused.length > before) { landed++; expect(w.focused.at(-1)).toBe(now) }
    ring = now
  }
  // most moves land at once; the rest wait for the drawing that scrolls the part into view
  expect(landed).toBeGreaterThan(10)
  // the window followed: the twentieth step is drawn, the first is not
  expect(textOf(await ui.drawn())).toContain('Step 20')
  expect(textOf(await ui.drawn())).not.toContain('Step 0 ')
})

test('on a tall card, e shows what it opens: the window moves to the bar under the card, and the wheel moves the window', async ($, on) => {
  // a tall card: 30 steps, one row each, in a pane of 14 rows; the first step has examples
  const steps = Array.from({ length: 30 }, (_, i) => region(`step-${i}`, `Step ${i}`, i, i === 0 ? 'ex-18' : undefined))
  const TALL = { ...DRAWING, root: { t: 'stack', kids: steps }, regions: steps.map(x => ({ id: x.id, meta: x.meta })) }
  world(on, () => TALL)
  const clock = mock.clock(on)
  const SMALL = { ...(PANE as Any), props: { ...(PANE as Any).props, scroll: { bodyRows: 14, offset: 0 } } } as never
  await $.command.run({ command: 'card', args: '01-saves step-0' } as never)
  const ui = await $.ui.mount({ plugin: 'thimble', ...(SMALL as Any) } as never)
  const draw = async () => { for (let i = 0; i < 3; i++) { await ui.redraw(); await clock.settle() } }
  await draw()
  expect(textOf(await ui.drawn())).toContain('Step 0 ')
  // e: the examples open under the card, and the window shows them
  expect(await press($, clock, edit('e'))).toEqual({ text: '', cursor: 0 })
  await draw()
  const shown = textOf(await ui.drawn())
  expect(shown).toContain('examples of saves on Jun 18')
  expect(shown).toContain('Hello agents, sign below.')
  expect(shown).toContain('Step 29')
  // the wheel up over the pane: the window moves up, rows of the card come back into view
  const wheel = (by: number) => $.ui.scroll({ component: 'Pane', requestId: 'object', offset: 0, by, bodyRows: 14, contentRows: 14, origin: { kind: 'person' } } as never)
  expect(shown).not.toContain('Step 20')
  for (let i = 0; i < 8; i++) await wheel(-1)
  await draw()
  expect(textOf(await ui.drawn())).toContain('Step 20')
  expect(textOf(await ui.drawn())).not.toContain('Hello agents')
  // past the top it stops at the top: the next tick down moves it at once
  for (let i = 0; i < 60; i++) await wheel(-1)
  await draw()
  expect(textOf(await ui.drawn())).toContain('Step 0 ')
  for (let i = 0; i < 5; i++) await wheel(1)
  await draw()
  expect(textOf(await ui.drawn())).not.toContain('Step 0 ')
})

test('the bar says the keys of what is on top of the focus stack: the detail gone, they are gone', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  // the detail: its keys
  await $.command.run({ command: 'card', args: '01-saves day-2026-06-18' } as never)
  await pane($, clock)
  expect(await hintOf($)).toContain('↑↓ part')
  // the pane goes (the module learns it as a prompt comes): the detail leaves the stack, and the bar says no key of it
  w.opened.length = 0
  await $.prompt.submit({ text: 'and across all the runs?', origin: { kind: 'composer' } } as never)
  await clock.settle()
  expect(await hintOf($)).not.toContain('↑↓ part')
  expect(await hintOf($)).not.toContain('type to ask')
})

test('a terminal too narrow for the docked detail: the waiting pane is closed again, the keys stay the chat\'s, and a toast says what opens it', async ($, on) => {
  const w = world(on, undefined, { isPlaced: false, reason: 'unasked below 144 columns (120 now): placed when the person opens it, or when the terminal widens' })
  const clock = mock.clock(on)
  await $.command.run({ command: 'card', args: '01-saves' } as never)
  await clock.settle()
  expect(w.toasts).toContain("The card's detail needs 144 columns when a key opens it (120 now). Type /card to open it here, or widen the terminal.")
  expect(await hintOf($)).not.toContain('↑↓ part')
})
