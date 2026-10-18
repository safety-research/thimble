// Claims in a session (verbs/claims, shell/claimsview.ts, observer.ts): the observer's one look after a turn of work
// gives the turn's claims; each is placed in the message that said it, with the citations near it, in the session's
// store (thimble/claims/<session>.json); c lights under the answer with how many are new or revised; c from the empty
// prompt opens the Claims pane as a graph, focused: at rest an island of dots per cluster with its name and no lines;
// the ring on a claim shows its text and its links; ↵ fills the bar (said in turn N, ×N, its sources, what it revised);
// n, /, t and ] [ come through the prompt; the hint line under the prompt holds the keys; a question carries the claim.
// `claude plugin test lean`. The model's calls and the Node children are answered here.
import { expect, mock, test } from 'claude-code/testing'

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
const FORK1 = { notes: [], line: null, settled: false, verbs: {}, glosses: [], claims: [
  { claim: 'The tilt in the edits is one editor', quote: 'The tilt is one editor', kind: 'judgment', cluster: 'testing for bias' },
  { claim: "Kestrel made 41% of June's edits, 212 of them reverts", quote: "Kestrel made 41% of June's edits", kind: 'finding', cluster: 'finding who edited' },
  { claim: 'June 18 had 6,543 saves, the busiest day', quote: 'June 18 had 6,543 saves', kind: 'event', cluster: 'the June 18 burst' },
] }
const Q2 = "I'm going to tell my manager the tilt is one editor. Anything to fix?"
const A2 = 'Fix one thing: it is two editors, not one. Kestrel and Wren made [63%](q8#user=top2@share) of the tilt. The June 18 burst, [6,543 saves](q1#day=2026-06-18@n), stands.'
const FORK2 = { notes: [], line: null, settled: false, verbs: {}, glosses: [], claims: [
  { same: 'c1', quote: 'the tilt is one editor', by: 'person' },
  { claim: 'The tilt is two editors, Kestrel and Wren, not one', quote: 'it is two editors, not one', kind: 'finding', revises: 'c1' },
  { same: 'c3', quote: 'The June 18 burst, 6,543 saves, stands' },
] }

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
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: e.path.endsWith('observer.md') ? 'OBSERVER {{QUESTION}} | CLAIMS {{CLAIMS}} | CLUSTERS {{CLUSTERS}} {{GROWN}}' : e.path.endsWith('question.md') ? 'QUESTION {{QUESTION}} {{ANSWER}}' : files[e.path] ?? '' }))
  on('fs.write', (_$: unknown, e: { path: string; content?: string; text?: string; data?: string }) => {
    files[e.path] = String(e.content ?? e.text ?? e.data ?? '')
    return { value: undefined }
  })
  const runs: string[][] = []
  on('process.run', (_$: unknown, e: { argv: string[] }) => {
    runs.push([...e.argv])
    let out = '{}'
    if (e.argv.some(a => a.endsWith('estimate.mjs'))) out = JSON.stringify({ offer: { what: 'map 4 files', minutes: 4, tokens: 310000 } })
    else if (e.argv.some(a => a.endsWith('objects.mjs'))) out = '[]'
    else if (e.argv.includes('coverage')) out = 'Coverage of this session · 4 source files'
    else if (e.argv.includes('resolve')) out = JSON.stringify({ ref: e.argv[e.argv.indexOf('resolve') + 1], chain: [{ step: 'query', id: 'q4', about: 'share by user', value: '41%' }], rows: ['revisions.jsonl#L28-31'], count: 4, records: [{ ref: 'revisions.jsonl#L28', text: 'Kestrel saved' }], notes: [] })
    else if (e.argv.some(a => a.endsWith('verb.mjs')) && e.argv.includes('list')) out = JSON.stringify({ verbs: [{ key: 'v', name: 'visualize', row: true, order: 0 }, { key: 's', name: 'squeeze', row: true, order: 1 }, { key: 'c', name: 'claims', row: true, order: 1.5 }] })
    else if (e.argv.some(a => a.endsWith('prep.mjs'))) out = JSON.stringify({ drawing: { kit: 1, w: 40, h: 1, root: { t: 'text', runs: [{ s: 'rows', tone: 'ink' }] }, cites: {}, examples: {}, regions: [], warnings: [] }, verbs: [], problems: [] })
    return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const opened: Record<string, unknown>[] = []
  on('ui.open', (_$: unknown, e: Record<string, unknown>) => { opened.push(e); return { value: { isPlaced: true } } })
  on('ui.focus', () => ({ value: {} }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  const prompts: string[] = []
  on('model.complete', () => ({ value: { isAnswered: true, text: JSON.stringify({ parts: [], drift: null, decision: null }), usage: USAGE } }))
  on('model.fork', (_$: unknown, e: { prompt: string }) => {
    prompts.push(String(e.prompt))
    return { value: { isAnswered: true, text: JSON.stringify(forks[prompts.length - 1] ?? forks.at(-1)), usage: USAGE } }
  })
  const submitted: { text: string; context: readonly string[] }[] = []
  on('prompt.submit', (_$: unknown, e: { text: string; context?: readonly string[] }) => {
    submitted.push({ text: e.text, context: e.context ?? [] })
    return { text: e.text }
  })
  on('prompt.edit', (_$: unknown, e: { text: string; start: number; end: number; inputText: string }) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
  on('ui.render', (_$: unknown, e: Any) => ({ type: 'Text', props: {}, children: [e.component === 'PromptHint' ? e.props.hint : 'the reply'] }) as never)
  on('turn.start', (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', (_$: unknown, e: { answer?: string }) => ({ text: e.answer ?? '' }))
  on('command.register', (_$: unknown, e: { name: string }) => ({ value: { command: e.name } }))
  on('config.list', () => ({ value: [] }))
  on('turn.step', async function* (_$: unknown, e: Any) { return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ id: 'u1', name: 'Bash', input: {} }] } })
  const clock = mock.clock(on, { now: NOW })
  return { files, runs, prompts, submitted, clock, opened }
}

function textOf(n: Any): string {
  if (n == null || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  return textOf(n.props?.children) + textOf(n.children) + (typeof n.props?.label === 'string' && !n.props?.children ? n.props.label : '')
}

/** The texts drawn struck through. */
function struck(n: Any, out: string[] = []): string[] {
  if (n == null || typeof n !== 'object') return out
  if (Array.isArray(n)) { n.forEach(x => struck(x, out)); return out }
  if (n.props?.strikethrough) out.push(textOf(n))
  struck(n.props?.children, out)
  struck(n.children, out)
  return out
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

const reply = ($: Any, row: string, text: string) => $.ui.render({ component: 'AssistantMessage', surface: 'terminal', requestId: row, props: { text, isFirstOfReply: true }, viewport: { columns: 120, rows: 50, isFullscreen: true } } as never)
const TRAY = { plugin: 'thimble-lean', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows: 16, bodyColumns: 110, scroll: { offset: 0, bodyRows: 16 }, view: {} }, viewport: { columns: 120, rows: 50, isFullscreen: true } } as never
const key = (k: string) => ({ origin: { kind: 'composer' }, key: { key: k }, text: '', cursor: 0, start: 0, end: 0, inputText: k.length === 1 ? k : '' }) as never

test('after a turn of work its claims are in the store, each where it was said with the citations near it, and c lights with how many are new', async ($, on) => {
  const w = world(on, [FORK1])
  await turn($, w, { id: 't1', user: U1, prompt: Q1, row: R1, answer: A1 })
  // the fork read the claims so far (none yet), and gave this turn's
  expect(w.prompts.length).toBe(1)
  expect(w.prompts[0]).toContain('CLAIMS (none yet)')
  const store = JSON.parse(w.files[STORE]!)
  expect(store.claims.map((c: Any) => c.id)).toEqual(['c1', 'c2', 'c3'])
  const c2 = store.claims[1]
  expect(c2.said[0].row).toBe(R1.slice(0, 24))
  expect(c2.said[0].turn).toBe(1)
  expect(c2.said[0].quote).toBe("Kestrel made 41% of June's edits")
  expect(c2.sources.map((s: Any) => s.label)).toEqual(['41%', '212 of them'])
  expect(store.clusters.map((k: Any) => k.name)).toEqual(['testing for bias', 'finding who edited', 'the June 18 burst'])
  // c lights under the answer, with its note
  textOf(await reply($, R1, A1))
  await w.clock.settle()
  const row = textOf(await reply($, R1, A1))
  expect(row).toContain('● 3 new claims')
  const rec = JSON.parse(w.files[`${ROOT}/thimble/messages/s-1/${R1.slice(0, 24)}.json`]!)
  expect(rec.verbs.c).toEqual({ lit: true, note: '3 new claims', claims: ['c1', 'c2', 'c3'] })
  const log = JSON.parse(w.files['/home/t/.thimble/lean/observer/s-1.json']!).log.find((r: Any) => r.kind === 'look')
  expect(log.claims.added).toEqual(['c1', 'c2', 'c3'])
})


test('a later turn: a claim said again counts ×N; a correction is linked both ways, and c lights with "1 claim revised"', async ($, on) => {
  const w = world(on, [FORK1, FORK2])
  await turn($, w, { id: 't1', user: U1, prompt: Q1, row: R1, answer: A1 })
  await turn($, w, { id: 't2', user: U2, prompt: Q2, row: R2, answer: A2 })
  // the second look read the claims so far by id
  expect(w.prompts[1]).toContain('- c1 · k1 · The tilt in the edits is one editor')
  const store = JSON.parse(w.files[STORE]!)
  const c1 = store.claims.find((c: Any) => c.id === 'c1')
  const c4 = store.claims.find((c: Any) => c.id === 'c4')
  expect(c1.revised_by).toBe('c4')
  expect(c4.revises).toBe('c1')
  expect(c1.said.map((p: Any) => [p.by, p.turn])).toEqual([['claude', 1], ['person', 2]])
  expect(c1.said[1].row).toBe(U2.slice(0, 24))
  expect(store.claims.find((c: Any) => c.id === 'c3').said.length).toBe(2)
  textOf(await reply($, R2, A2))
  await w.clock.settle()
  expect(textOf(await reply($, R2, A2))).toContain('● 1 claim revised')
})

const PANE = { plugin: 'thimble-lean', component: 'Pane', surface: 'terminal', requestId: 'claims', props: { bodyColumns: 110, scroll: { bodyRows: 30 }, isFocused: true, title: 'Claims' }, viewport: { columns: 200, rows: 50, isFullscreen: true } } as never
const HINT = { component: 'PromptHint', surface: 'terminal', requestId: 'hint', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } } as never
const focus = (el: string) => ({ requestId: 'claims', element: el, origin: { kind: 'person' } }) as never
const edges = (t: string) => /[─│╱╲╌╎]/.test(t)

async function twoTurns($: Any, on: Any) {
  const w = world(on, [FORK1, FORK2])
  await turn($, w, { id: 't1', user: U1, prompt: Q1, row: R1, answer: A1 })
  await turn($, w, { id: 't2', user: U2, prompt: Q2, row: R2, answer: A2 })
  await ($ as Any).prompt.edit(key('c'))
  await w.clock.settle()
  return w
}

test('c opens Claims as a graph, focused: at rest an island of dots per cluster, its name at the centre, and no lines', async ($, on) => {
  const w = await twoTurns($, on)
  expect(w.opened.at(-1)).toMatchObject({ id: 'claims', focus: true })
  const rest = textOf(await $.ui.render(PANE))
  expect(rest).toContain('Claims   4 · 3 clusters')
  for (const name of ['testing for bias', 'finding who edited', 'the June 18 burst']) expect(rest).toContain(name)
  // four claims: the revised one hollow, the one said twice heavier
  expect((rest.match(/[●◉○]/g) || []).length).toBe(4)
  expect(rest).toContain('○')
  expect(rest).toContain('◉')
  expect(edges(rest)).toBe(false)
  // no sentence teaches the pane: its keys are in the hint line under the prompt
  expect(rest).not.toContain('↑')
  expect(textOf(await $.ui.render(HINT))).toContain('↑ ↓ move · ↵ select · n cluster · / search · t time · esc close · m map the corpus ~4 min ~310k tokens')
})

test('the ring on a claim: its whole text, its links as thin lines, a revision dashed; ↵ fills the bar; 1 opens a source', async ($, on) => {
  const w = await twoTurns($, on)
  await $.ui.focus(focus('cl-c1'))
  const t = textOf(await $.ui.render(PANE))
  expect(t).toContain('The tilt in the edits is one editor')
  expect(edges(t)).toBe(true)
  // ↵ on the claim (a press): the bar says where it was said, ×N, its sources, and what revised it
  const ui = await $.ui.mount(PANE)
  await w.clock.settle()
  await ui.press({ key: 'cl-c1' })
  await w.clock.settle()
  const bar = textOf(await $.ui.render(PANE))
  expect(bar).toContain('said in turn 1')
  expect(bar).toContain('×2')
  expect(bar).toContain('revised in turn 2 to The tilt is two editors, Kestrel and Wren, not one')
  // a claim with sources: its cite marks, each on a digit
  await ui.press({ key: 'cl-c2' })
  await w.clock.settle()
  expect(textOf(await $.ui.render(PANE))).toMatch(/41%.*212 of them/)
  expect(textOf(await $.ui.render(HINT))).toContain('↵ select · 1–2 source')
  // 1 opens its first source in the tray (the key comes through the prompt), and the pane takes the keys back
  const opened = w.opened.length
  await ($ as Any).prompt.edit(key('1'))
  await w.clock.settle()
  const BAND = { plugin: 'thimble-lean', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows: 16, bodyColumns: 110, scroll: { offset: 0, bodyRows: 16 }, view: {} }, viewport: { columns: 120, rows: 50, isFullscreen: true } } as never
  textOf(await $.ui.render(BAND))
  await w.clock.settle()
  expect(textOf(await $.ui.render(BAND))).toContain('41%')
  expect(w.runs.some(a => a.includes('resolve') && a.includes('q4#user=Kestrel@share'))).toBe(true)
  expect(w.opened.length).toBeGreaterThan(opened)
  await ui.unmount()
})

test('t is time: the claims appear in the order made, a revision only once made; ] [ move; n goes cluster to cluster; / searches', async ($, on) => {
  const w = await twoTurns($, on)
  await ($ as Any).prompt.edit(key('t'))
  await w.clock.settle()
  const t1 = textOf(await $.ui.render(PANE))
  expect(t1).toContain('turn 1 · answer · 3 of 4')
  expect(t1).not.toContain('○')
  expect(textOf(await $.ui.render(HINT))).toContain('] [ turn · t now · esc close')
  await ($ as Any).prompt.edit(key(']'))
  await w.clock.settle()
  expect(textOf(await $.ui.render(PANE))).toContain('Claims   4 · 3 clusters')
  // n: the ring to the next cluster's first claim
  await $.ui.focus(focus('cl-c1'))
  await ($ as Any).prompt.edit(key('n'))
  await w.clock.settle()
  expect(textOf(await $.ui.render(PANE))).toContain("Kestrel made 41% of June's edits, 212 of them reverts")
  // /: a search field in the head, and the hint line says what its keys do
  await ($ as Any).prompt.edit(key('/'))
  await w.clock.settle()
  expect(JSON.stringify(await $.ui.render(PANE))).toContain('"key":"search"')
  expect(textOf(await $.ui.render(HINT))).toContain('type to search · ↵ done · esc close')
})

test('a question asked with a claim selected carries it; 0 closes the pane; m asks Claude for the corpus orientation', async ($, on) => {
  const w = world(on, [FORK1])
  await turn($, w, { id: 't1', user: U1, prompt: Q1, row: R1, answer: A1 })
  await ($ as Any).prompt.edit(key('c'))
  await w.clock.settle()
  await $.ui.focus(focus('cl-c2'))
  await $.prompt.submit({ text: 'is 41% of all June edits or of the relay edits?', origin: { kind: 'composer' } } as never)
  const ctx = w.submitted.at(-1)!.context.join('\n')
  expect(ctx).toContain('a claim of this session selected in the Claims pane: c2 "Kestrel made 41% of June\'s edits, 212 of them reverts"')
  expect(ctx).toContain('q4#user=Kestrel@share')
  await ($ as Any).prompt.edit(key('0'))
  await w.clock.settle()
  expect(textOf(await $.ui.render(HINT))).not.toContain('↵ select')
  await ($ as Any).prompt.edit(key('c'))
  await w.clock.settle()
  await ($ as Any).prompt.edit(key('m'))
  await w.clock.settle()
  const ran = w.runs.find(a => a.some(x => x.endsWith('verb.mjs')) && a.includes('run'))
  expect(ran?.includes('claims')).toBe(true)
})
