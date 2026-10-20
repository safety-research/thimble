// Claims in a session (claims/: store.js, lens.mjs, graph.js on shell/panes.ts, term.ts): the observer's one look
// after a turn of work gives the turn's claims, each placed in the message that said it with the citations near it, in
// the session's store (thimble/claims/<session>.json); the bar counts them, and c lights only when a claim was
// corrected. c opens the Claims pane in the side panel: the claims as a graph in clusters, and the selected claim under
// it with where it came from and its evidence rows (read through the kernel); the ring selects the dot it lands on; ↵
// on it opens where it came from over the pane, and a digit a piece of evidence, as a citation opens; a question in the
// panel's input bar goes to the panel's thread, about the claim selected, and never to main; /claims folder asks
// Claude for the folder's map, and its save brings the folder's claims in.
// `claude plugin test plugin`. The model's calls and the Node children are answered here.
import { expect, mock, test } from 'claude-code/testing'

import { press, promptStub } from './stubs'

const ROOT = '/data'
const STORE = `${ROOT}/thimble/claims/s-1.json`
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
  { quote: "Kestrel made 41% of June's edits", claim: "Kestrel made 41% of June's edits, 212 of them reverts", cluster: 'finding who edited' },
  { quote: 'June 18 had 6,543 saves', cluster: 'the June 18 burst' },
] }
const Q2 = "I'm going to tell my manager the tilt is one editor. Anything to fix?"
const A2 = 'Fix one thing: it is two editors, not one. Kestrel and Wren made [63%](q8#user=top2@share) of the tilt. The June 18 burst, [6,543 saves](q1#day=2026-06-18@n), stands.'
const FORK2 = { notes: [], verbs: {}, glosses: [], claims: [
  { same: 'c1', quote: 'the tilt is one editor', by: 'analyst' },
  { quote: 'it is two editors, not one', claim: 'The tilt is two editors, Kestrel and Wren, not one', revises: 'c1' },
  { same: 'c3', quote: 'The June 18 burst, 6,543 saves, stands' },
] }
const MAP = {
  title: '3 trials of "sort the parcels"', program: 'return k.text("map")',
  data: {
    scope: { unit: 'trials', n: 3, what: 'every trial counted' },
    clusters: [{ id: 'belt', name: 'belt slips' }, { id: 'scale', name: 'scale theory' }],
    claims: [
      { id: 'belt-skips', name: 'The belt skips a slot', cluster: 'belt', evidence: [{ ref: 'trials/t1.jsonl#L2', quote: 'The belt skips a slot' }] },
      { id: 'scale-off', name: 'The scale is off', cluster: 'scale', evidence: [{ ref: 'trials/t2.jsonl#L2', quote: 'the scale is off' }] },
    ],
  },
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

function world(on: Any, forks: Record<string, unknown>[]) {
  mock.env(on, { THIMBLE_HOME: '/home/t/.thimble' })
  mock.store(on)
  on('session.cwd', () => ({ value: ROOT }))
  on('session.id', () => ({ value: 's-1' }))
  on('session.messages', () => ({ value: [] }))
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  const files: Record<string, string> = {}
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: e.path in files || e.path === `${ROOT}/thimble/objects` || e.path.endsWith('.md') }))
  on('fs.list', () => ({ value: [] }))
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
    else if (e.argv.includes('coverage')) out = e.argv.includes('--json') ? '{}' : 'Coverage of this session · 4 source files'
    else if (e.argv.includes('resolve')) out = JSON.stringify({ ref: e.argv[e.argv.indexOf('resolve') + 1], chain: [{ step: 'query', id: 'q4', about: 'share by user', value: '41%' }], rows: ['revisions.jsonl#L28-31'], count: 4, records: [{ ref: 'revisions.jsonl#L28', text: 'Kestrel saved Lexicon' }], notes: [] })
    else if (e.argv.some(a => a.endsWith('prep.mjs'))) out = JSON.stringify({ drawing: { kit: 1, w: 40, h: 1, root: { t: 'text', runs: [{ s: 'rows', tone: 'ink' }] }, cites: {}, examples: {}, regions: [], warnings: [] } })
    return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const opened: Record<string, unknown>[] = []
  on('ui.open', (_$: unknown, e: Record<string, unknown>) => { opened.push(e); return { value: { isPlaced: true } } })
  const focused: string[] = []
  on('ui.focus', (_$: unknown, e: Any) => { focused.push(String(e.key ?? e.element)); return { value: {} } })
  const closed: string[] = []
  on('ui.close', (_$: unknown, e: Any) => { closed.push(String(e.id)); return { value: undefined } })
  on('ui.panes', () => ({ value: [] }))
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
  const submitted: { text: string; context: readonly string[] }[] = []
  on('prompt.submit', (_$: unknown, e: { text: string; context?: readonly string[] }) => {
    submitted.push({ text: e.text, context: e.context ?? [] })
    return { text: e.text }
  })
  on('prompt.fill', () => ({ isFilled: true }))
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
  return { files, runs, prompts, submitted, clock, opened, focused, closed, toasts, spawns, sent, appended, started: false }
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
const HINT = { plugin: 'thimble', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows: 16, bodyColumns: 200, scroll: { offset: 0, bodyRows: 16 }, view: {} }, viewport: { columns: 200, rows: 48, isFullscreen: true } } as never
const key = (k: string) => ({ origin: { kind: 'composer' }, key: { key: k }, text: '', cursor: 0, start: 0, end: 0, inputText: k.length === 1 ? k : '' }) as never
const hint = async ($: Any) => textOf(await $.ui.render(HINT))
/** The cell key of a region's row in the side panel's drawing (`r|side|<row>|<region>`). */
async function rowKey($: Any, region: string): Promise<string> {
  const m = new RegExp(`"key":"(r\\|side\\|\\d+\\|${region})"`).exec(JSON.stringify(await $.ui.render(PANE)))
  if (!m) throw new Error(`no row for ${region}`)
  return m[1]!
}
const ringOn = async ($: Any, w: Any, region: string) => {
  await $.ui.focus({ requestId: 'object', element: await rowKey($, region), origin: { kind: 'person' } } as never)
  await w.clock.settle()
}
const askKeyOf = async ($: Any) => /"key":"(ask-\d+)"/.exec(JSON.stringify(await $.ui.render(PANE)))?.[1] ?? ''

async function twoTurns($: Any, on: Any) {
  const w = world(on, [FORK1, FORK2])
  await turn($, w, { id: 't1', user: U1, prompt: Q1, row: R1, answer: A1 })
  await turn($, w, { id: 't2', user: U2, prompt: Q2, row: R2, answer: A2 })
  return w
}

test('after a turn of work its claims are in the store, each where it was said with the citations near it; the bar counts them; c does not light without a correction', async ($, on) => {
  const w = world(on, [FORK1])
  await turn($, w, { id: 't1', user: U1, prompt: Q1, row: R1, answer: A1 })
  expect(w.prompts.length).toBe(1)
  expect(w.prompts[0]).toContain('LENS claims')
  expect(w.prompts[0]).toContain('CLAIMS (none yet)')
  const store = JSON.parse(w.files[STORE]!)
  expect(store.claims.map((c: Any) => c.id)).toEqual(['c1', 'c2', 'c3'])
  const c2 = store.claims[1]
  expect(c2.said[0].row).toBe(R1.slice(0, 24))
  expect(c2.said[0].turn).toBe(1)
  expect(c2.sources.map((s: Any) => s.label)).toEqual(['41%', '212 of them'])
  expect(store.clusters.map((k: Any) => k.name)).toEqual(['testing for bias', 'finding who edited', 'the June 18 burst'])
  // no claim was corrected, so c does not light: the bar only counts the claims
  const bar = await hint($)
  expect(bar).not.toContain('c ●')
  expect(bar).toContain('3 claims')
  const rec = JSON.parse(w.files[`${ROOT}/thimble/messages/s-1/${R1.slice(0, 24)}.json`]!)
  expect(rec.verbs?.c?.lit).toBeFalsy()
  const log = JSON.parse(w.files['/home/t/.thimble/lean/observer/s-1.json']!).log.find((r: Any) => r.kind === 'look')
  expect(log.claims.added).toEqual(['c1', 'c2', 'c3'])
})

test('a later turn: a claim said again counts ×N, a correction is linked both ways, and c lights with "1 claim corrected"', async ($, on) => {
  const w = await twoTurns($, on)
  expect(w.prompts[1]).toContain('- c1 · k1 · The tilt in the edits is one editor')
  const store = JSON.parse(w.files[STORE]!)
  const c1 = store.claims.find((c: Any) => c.id === 'c1')
  const c4 = store.claims.find((c: Any) => c.id === 'c4')
  expect([c1.revised_by, c4.revises]).toEqual(['c4', 'c1'])
  expect(c1.said.map((p: Any) => [p.by, p.turn])).toEqual([['claude', 1], ['person', 2]])
  expect(store.claims.find((c: Any) => c.id === 'c3').said.length).toBe(2)
  const bar = await hint($)
  expect(bar).toContain('c ● 1 claim corrected')
  expect(bar).toContain('4 claims')
})

test('c opens the Claims pane in the side panel: the graph of claims in clusters and the newest claim under it; the bar names its keys and where a question goes', async ($, on) => {
  const w = await twoTurns($, on)
  await press($, w.clock, key('c'))
  await w.clock.settle()
  expect(w.opened.some(x => x.id === 'object' && x.title === 'Claims' && x.focus === true)).toBe(true)
  const t = textOf(await $.ui.render(PANE))
  expect(t).toContain('Claims  4 claims · 3 clusters · to turn 2')
  for (const name of ['testing for bias', 'finding who edited', 'the June 18 burst']) expect(t).toContain(name.replace(/ /g, '\u00a0'))
  // a dot per claim, the corrected one hollow; the newest claim selected under the graph, beside the claim it corrected
  expect(t).toContain('○')
  expect(t).toContain('The tilt is two editors, Kestrel and Wren, not one')
  expect(t).not.toMatch(/judgment|finding ·|precisely/)
  expect(t).toMatch(/corrects\s+The tilt in the edits is one editor/)
  // no key hints in the pane: they are in the bar, with what a typed question is about
  expect(t).not.toContain('esc')
  const bar = await hint($)
  expect(bar).toContain('thimble:main/Claims')
  expect(bar).toContain('↑↓ move · ↵ open')
  expect(bar).toContain('type to ask about claim: The tilt is two editors')
})

test('the ring on a dot selects its claim, with its evidence read through the kernel; a digit opens a piece over the pane, ↵ where it came from', async ($, on) => {
  const w = await twoTurns($, on)
  await press($, w.clock, key('c'))
  await w.clock.settle()
  await ringOn($, w, 'n-c2')
  await w.clock.advance(100)
  await w.clock.settle()
  const t = textOf(await $.ui.render(PANE))
  expect(t).toContain("Kestrel made 41% of June's edits, 212 of them reverts")
  expect(t).toContain("from “Kestrel made 41% of June's edits, and 212 of them were reverts.”")
  expect(t).toContain('q4 · share by user ← 4 source rows in revisions.jsonl')
  expect(w.runs.some(a => a.includes('resolve') && a.includes('q4#user=Kestrel@share'))).toBe(true)
  expect(await hint($)).toContain('1 2 evidence')
  // 2 opens the second piece of evidence as a citation opens: over the pane, in the side panel
  await press($, w.clock, key('2'))
  await w.clock.settle()
  expect(w.opened.some(x => x.id === 'object' && x.title === 'Cite · 212 of them')).toBe(true)
})

test('↵ on the selected dot opens where its claim came from over the pane: the message, its words marked; esc goes back', async ($, on) => {
  const w = await twoTurns($, on)
  await press($, w.clock, key('c'))
  await w.clock.settle()
  await ringOn($, w, 'n-c3')
  const ui = await $.ui.mount({ ...(PANE as Any) } as never)
  await ui.press({ key: await rowKey($, 'n-c3') })
  await w.clock.settle()
  expect(w.opened.some(x => x.id === 'object' && x.title === 'Where it came from')).toBe(true)
  const t = textOf(await $.ui.render(PANE))
  expect(t).toContain("Where it came from  turn 1 · Claude's message")
  expect(t).toContain('June 18 had 6,543 saves, the busiest day.')
  expect(t).toContain('said again once')
  await ui.unmount()
})

test("a question in the panel's input bar goes to the Claims pane's thread, about the row selected, never to main", async ($, on) => {
  const w = await twoTurns($, on)
  await press($, w.clock, key('c'))
  await w.clock.settle()
  await ringOn($, w, 'n-c2')
  // a letter starts the question in the input bar, never in the prompt
  expect((await press($, w.clock, key('i'))).text).toBe('')
  expect(JSON.stringify(await $.ui.render(PANE))).toContain('"value":"i"')
  const before = w.submitted.length
  const ui = await $.ui.mount({ ...(PANE as Any) } as never)
  await ui.input({ key: await askKeyOf($), text: 'is 41% of all June edits or of the relay edits?' })
  await w.clock.settle()
  expect(w.submitted.length).toBe(before)
  expect(w.spawns.length).toBe(1)
  expect(w.spawns[0].prompt).toContain('is 41% of all June edits or of the relay edits?')
  expect(w.spawns[0].prompt).toContain('About: the part "claim: Kestrel made 41% of June\'s edits, 212 of them reverts" (n-c2) of the panel "Claims"')
  expect(w.spawns[0].prompt).toContain('the claim selected is "Kestrel made 41% of June\'s edits, 212 of them reverts" (turn 1, said as')
  expect(w.spawns[0].prompt).toContain('q4#user=Kestrel@share')
  // the question shows in the panel's conversation, under the pane
  expect(textOf(await $.ui.render(PANE))).toContain('❯ is 41% of all June edits or of the relay edits?')
  await ui.unmount()
})

test('a turn whose pass failed is said in the pane, with why', async ($, on) => {
  const NO_SIGN_IN = { failed: { isAnswered: false, reason: 'api-error', status: 401, error: 'authentication_failed', usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }
  const w = world(on, [FORK1, NO_SIGN_IN])
  await turn($, w, { id: 't1', user: U1, prompt: Q1, row: R1, answer: A1 })
  await turn($, w, { id: 't2', user: U2, prompt: Q2, row: R2, answer: A2 })
  expect(JSON.parse(w.files[STORE]!).gaps.map((g: Any) => g.turn)).toEqual([2])
  await press($, w.clock, key('c'))
  await w.clock.settle()
  expect(textOf(await $.ui.render(PANE))).toContain('Turn 2 was not read:')
})

test("/claims folder asks Claude, as a turn, to map the folder's claims with a subagent; the map's save brings its claims into the pane", async ($, on) => {
  const w = world(on, [FORK1])
  await turn($, w, { id: 't1', user: U1, prompt: Q1, row: R1, answer: A1 })
  // the pane offers it with its estimate
  await press($, w.clock, key('c'))
  await w.clock.settle()
  await w.clock.advance(50)
  await w.clock.settle()
  expect(textOf(await $.ui.render(PANE))).toContain('map the claims of the whole folder · 3 trials · about 4 min, read by a subagent')
  await $.command.run({ command: 'claims', args: 'folder' } as never)
  await w.clock.settle()
  const request = w.appended.find(x => x.includes('thimble save folder-claims'))!
  expect(request).toContain('Hand the reading to one subagent with the Agent tool')
  expect(request).toContain(`--from ${ROOT}/thimble/claims/folder.json --program`)
  expect(request).toMatch(/First read \S+\/prompts\/claims-folder\/v2\.md and follow it/)
  expect(w.submitted.at(-1)!.text).toBe('claims of the whole folder (3 trials, about 4 min)')
  expect(textOf(await $.ui.render(PANE))).toContain("Claude is mapping the folder's claims")
  // the subagent saves the map: the feed names the save, and the shell reads it after its Bash call
  w.files[`${ROOT}/thimble/objects/07-folder-claims.json`] = JSON.stringify({ id: '07-folder-claims', version: 1, ...MAP })
  w.files['/home/t/.thimble/lean/events/s-1.jsonl'] = JSON.stringify({ t: Date.now() / 1000 + 60, kind: 'save', session: 's-1', root: ROOT, object: '07-folder-claims', version: 1 }) + '\n'
  await $.tool.call({ tool: 'Bash', command: 'thimble save folder-claims --from f.json', agentId: 'sub-1' } as never)
  await w.clock.settle()
  const store = JSON.parse(w.files[STORE]!)
  expect(store.claims.filter((c: Any) => c.by === 'folder').map((c: Any) => c.text)).toEqual(['The belt skips a slot', 'The scale is off'])
  expect(store.folderAsked).toBeUndefined()
  const t = textOf(await $.ui.render(PANE))
  expect(t).toContain("the folder's map: 2 claims in 2 clusters, from 3 trials")
  expect(t).toContain('belt\u00a0slips\u00a0(folder)')
  expect(w.toasts.at(-1)).toContain("The folder's map is in Claims: 2 claims in 2 clusters")
})
