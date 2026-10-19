// Claims in a session (verbs/claims, panes/claims.js on shell/panes.ts, observer.ts): the observer's one look after a turn of work
// gives the turn's claims, each with what it means; each is placed in the message that said it, with the citations near
// it, in the session's store (thimble/claims/<session>.json); c lights under the answer with how many are new; c from
// the empty prompt opens the Claims pane as a graph, focused: at rest an island of dots per cluster with its name and no
// lines; the ring on a claim (arrow keys or a click) shows its card (the claim, Precisely, Based on, Judgment, Not
// stated) and its links; r replays the graph in the order made and any key stops it; the thimble line above the prompt
// says `r replay · esc close`; a question carries the claim the ring is on.
// `claude plugin test lean`. The model's calls and the Node children are answered here.
import { expect, mock, test } from 'claude-code/testing'

import '../draw/kit.js'
import claimsPane from '../panes/claims.js'
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
const FORK1 = { notes: [], line: null, settled: false, verbs: {}, glosses: [], claims: [
  { claim: 'The tilt in the edits is one editor', quote: 'The tilt is one editor', kind: 'judgment', cluster: 'testing for bias', precisely: 'One editor made most of the edits that lean one way in June', based_on: 'q4, q7 · June edits, all users', judgment: "'tilt' is a reading: no side was measured", unstated: 'Most of all June edits, or of the reverts?' },
  { claim: "Kestrel made 41% of June's edits, 212 of them reverts", quote: "Kestrel made 41% of June's edits", kind: 'finding', cluster: 'finding who edited', precisely: "41% of the 517 edits saved in June were Kestrel's; 212 of those were reverts", based_on: 'q4 · revisions.jsonl, June · 517 rows' },
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
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: files[e.path] ?? promptStub(e.path) ?? '' }))
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
  // the question step has no system prompt; the pass has the frame and its lenses as one (observer:v2)
  const pass = (prompt: string) => {
    prompts.push(prompt)
    return { value: { isAnswered: true, text: JSON.stringify(forks[prompts.length - 1] ?? forks.at(-1)), usage: USAGE } }
  }
  on('model.complete', (_$: unknown, e: { prompt: string; system?: string }) => (e.system ? pass(`${e.system}\n${e.prompt}`) : { value: { isAnswered: true, text: JSON.stringify({ parts: [], drift: null, decision: null }), usage: USAGE } }))
  on('model.fork', (_$: unknown, e: { prompt: string }) => pass(String(e.prompt)))
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

test('after a turn of work its claims are in the store, each where it was said with the citations near it and what it means; c lights with what they leave open', async ($, on) => {
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
  expect(c2.precisely).toBe("41% of the 517 edits saved in June were Kestrel's; 212 of those were reverts")
  // c lights under the answer, with what the new claims leave open (c1 does not say what its "most" is out of)
  textOf(await reply($, R1, A1))
  await w.clock.settle()
  // in the thimble line above the prompt, in place of its name
  const row = textOf(await $.ui.render(HINT))
  expect(row).toContain('c ● 1 claim needs a denominator')
  const rec = JSON.parse(w.files[`${ROOT}/thimble/messages/s-1/${R1.slice(0, 24)}.json`]!)
  expect(rec.verbs.c).toEqual({ lit: true, note: '1 claim needs a denominator', claims: ['c1', 'c2', 'c3'] })
  const log = JSON.parse(w.files['/home/t/.thimble/lean/observer/s-1.json']!).log.find((r: Any) => r.kind === 'look')
  expect(log.claims.added).toEqual(['c1', 'c2', 'c3'])
})


test('a terse claim (lens-claims v2) is named by its quote, and its "based on" comes from the rows behind the citation in its sentence', async ($, on) => {
  const TERSE = { notes: [], line: null, settled: false, verbs: {}, glosses: [], claims: [
    { quote: 'June 18 had 6,543 saves, the busiest day', kind: 'event', cluster: 'the June 18 burst', precisely: '6,543 saves on June 18, the most of any day in June' },
  ] }
  const w = world(on, [TERSE])
  await turn($, w, { id: 't1', user: U1, prompt: Q1, row: R1, answer: A1 })
  const c1 = JSON.parse(w.files[STORE]!).claims[0]
  expect(c1.text).toBe('June 18 had 6,543 saves, the busiest day')
  expect(c1.sources.map((x: Any) => x.ref)).toEqual(['q1#day=2026-06-18@n'])
  // read through `lean resolve` once the look is done: the file, the group the value is of, and its rows
  expect(w.runs.some(a => a.includes('resolve') && a.includes('q1#day=2026-06-18@n'))).toBe(true)
  expect(c1.based_on).toBe('revisions.jsonl, day 2026-06-18 · 4 rows')
  expect(c1.precisely).toBe('6,543 saves on June 18, the most of any day in June')
})

test('a later turn: a claim said again counts ×N; a correction is linked both ways, and c lights with "1 new claim"', async ($, on) => {
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
  // a revision is a new claim: the note says nothing more of it
  expect(textOf(await $.ui.render(HINT))).toContain('c ● 1 new claim')
})

const PANE = { plugin: 'thimble-lean', component: 'Pane', surface: 'terminal', requestId: 'claims', props: { bodyColumns: 110, scroll: { bodyRows: 30 }, isFocused: true, title: 'Claims' }, viewport: { columns: 200, rows: 50, isFullscreen: true } } as never
const HINT = { plugin: 'thimble-lean', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows: 16, bodyColumns: 200, scroll: { offset: 0, bodyRows: 16 }, view: {} }, viewport: { columns: 200, rows: 48, isFullscreen: true } } as never
const focus = (el: string) => ({ requestId: 'claims', element: el, origin: { kind: 'person' } }) as never
// a claim's dot is a part of the pane's drawing: its press's key is the cells' (r|<pane>|<row>|cl-<id>)
async function dotKey($: Any, id: string): Promise<string> {
  const m = new RegExp(`"key":"(r\\|p-claims\\|\\d+\\|cl-${id})"`).exec(JSON.stringify(await $.ui.render(PANE)))
  if (!m) throw new Error(`no dot for ${id}`)
  return m[1]!
}
const ringOn = async ($: Any, id: string) => $.ui.focus(focus(await dotKey($, id)))
const edges = (t: string) => /[─│╱╲╌╎]/.test(t)

async function twoTurns($: Any, on: Any) {
  const w = world(on, [FORK1, FORK2])
  await turn($, w, { id: 't1', user: U1, prompt: Q1, row: R1, answer: A1 })
  await turn($, w, { id: 't2', user: U2, prompt: Q2, row: R2, answer: A2 })
  await press($, w.clock, key('c'))
  await w.clock.settle()
  return w
}

test('c opens Claims as a graph, focused: at rest an island of dots per cluster, its name at the centre, and no lines', async ($, on) => {
  const w = await twoTurns($, on)
  expect(w.opened.at(-1)).toMatchObject({ id: 'claims', focus: true })
  const rest = textOf(await $.ui.render(PANE))
  expect(rest).toContain('Claims   4 · 3 clusters')
  for (const name of ['testing for bias', 'finding who edited', 'the June 18 burst']) expect(rest).toContain(name)
  // four claims: the revised one hollow, the one said twice heavier, and a faint ? beside the one whose denominator
  // was not stated
  expect((rest.match(/[●◉○]/g) || []).length).toBe(4)
  // (textOf reads a dot's press with its label: the ? stands right after it)
  expect(rest).toMatch(/○claim: The tilt in the edits is one editor\?/)
  expect(rest).toContain('◉')
  expect(edges(rest)).toBe(false)
  // no sentence teaches the pane: its keys are in the thimble line above the prompt, and they are only these
  expect(rest).not.toContain('↑')
  expect(textOf(await $.ui.render(HINT))).toContain('thimble  r replay · esc close')
})

test('the ring on a claim: its card says what it means, its links are thin lines, the rest fades; a click moves the ring', async ($, on) => {
  const w = await twoTurns($, on)
  await ringOn($, 'c2')
  const t = textOf(await $.ui.render(PANE))
  expect(t).toContain("Kestrel made 41% of June's edits, 212 of them reverts")
  expect(t).toContain("precisely   41% of the 517 edits saved in June were Kestrel's; 212 of those were reverts")
  expect(t).toContain('based on    q4 · revisions.jsonl, June · 517 rows')
  expect(t).not.toContain('judgment')
  expect(edges(t)).toBe(true)
  // a click on another claim puts the ring there: its card, with its judgment and what it does not state
  const ui = await $.ui.mount(PANE)
  await w.clock.settle()
  await ui.press({ key: await dotKey($, 'c1') })
  await w.clock.settle()
  const c1 = textOf(await $.ui.render(PANE))
  expect(c1).toContain("judgment    'tilt' is a reading: no side was measured")
  expect(c1).toContain('not stated  Most of all June edits, or of the reverts?')
  // no bar of details, no sources on digits: the card is all
  expect(c1).not.toContain('said in turn')
  expect(textOf(await $.ui.render(HINT))).toContain('thimble  r replay · esc close')
  await ui.unmount()
})

test('r replays the graph in the order the claims were made, "turn N of M" in the head; any key stops it; / t n are not its keys', async ($, on) => {
  const w = await twoTurns($, on)
  await ringOn($, 'c2')
  await press($, w.clock, key('r'))
  await w.clock.settle()
  // it starts from nothing, with the ring off, so no card covers the growth
  let t = textOf(await $.ui.render(PANE))
  expect(t).toContain('Claims   replay')
  expect(t).not.toContain('precisely')
  // it grows in the order made: turn 1's three claims, then turn 2's correction; the head says which turn
  const seen: string[] = []
  const dots: number[] = []
  // about three seconds in all
  let ms = 0
  for (let i = 0; i < 60; i++) {
    await w.clock.advance(100)
    ms += 100
    await w.clock.settle()
    t = textOf(await $.ui.render(PANE))
    const m = /Claims {3}(turn \d of 2|replay)/.exec(t)
    if (!m) break
    if (seen.at(-1) !== m[1]) seen.push(m[1]!)
    dots.push((t.match(/[●◉○]/g) || []).length)
    // the correction is hollow only once it is made: in turn 1 no ○ is drawn
    if (m[1] === 'turn 1 of 2') expect(t).not.toContain('○')
  }
  expect(seen).toEqual(['replay', 'turn 1 of 2', 'turn 2 of 2'])
  expect(ms).toBeGreaterThanOrEqual(3000)
  expect(ms).toBeLessThanOrEqual(4200)
  expect(dots).toEqual([...dots].sort((a, b) => a - b))
  expect(t).toContain('Claims   4 · 3 clusters')
  // again, then any key stops it: the whole graph at once
  await press($, w.clock, key('r'))
  await w.clock.settle()
  await w.clock.advance(900)
  await w.clock.settle()
  expect(textOf(await $.ui.render(PANE))).toContain('turn 1 of 2')
  await press($, w.clock, key('x'))
  await w.clock.settle()
  expect(textOf(await $.ui.render(PANE))).toContain('Claims   4 · 3 clusters')
  // / t n ] are not keys of the pane: nothing in it changes, and the hint stays
  for (const k of ['/', 't', 'n']) {
    const r = await press($, w.clock, key(k))
    expect(r.text).toBe(k)
  }
  expect(textOf(await $.ui.render(PANE))).toContain('Claims   4 · 3 clusters')
  expect(JSON.stringify(await $.ui.render(PANE))).not.toContain('"key":"search"')
  expect(textOf(await $.ui.render(HINT))).toContain('thimble  r replay · esc close')
})

test('a question asked with the ring on a claim carries it; c closes the pane', async ($, on) => {
  const w = world(on, [FORK1])
  await turn($, w, { id: 't1', user: U1, prompt: Q1, row: R1, answer: A1 })
  await press($, w.clock, key('c'))
  await w.clock.settle()
  await ringOn($, 'c2')
  await $.prompt.submit({ text: 'is 41% of all June edits or of the relay edits?', origin: { kind: 'composer' } } as never)
  const ctx = w.submitted.at(-1)!.context.join('\n')
  expect(ctx).toContain('the ring on a claim of this session in the Claims pane: c2 "Kestrel made 41% of June\'s edits, 212 of them reverts"')
  expect(ctx).toContain('q4#user=Kestrel@share')
  await press($, w.clock, key('c'))
  await w.clock.settle()
  expect(textOf(await $.ui.render(HINT))).not.toContain('r replay')
})

test('a graph with no layout (a drawing older than its module, after a reload) says so in one line and never throws', () => {
  // the pane's program on data with no layout: one line, under the head
  const DK = (globalThis as Any).DrawKit
  const d = DK.run(claimsPane.program, { total: 1, clusters: 1, claims: [{ id: 'c1', cluster: 'k1', text: 'June 18 was the busiest day', n: 1, said: [], sources: [] }], groups: [{ id: 'k1', name: 'the June 18 burst', i: 0 }], order: ['c1'], w: 80, h: 20 }, { w: 80, h: 22 })
  expect(d.error).toBeUndefined()
  expect(JSON.stringify(d.root)).toContain('The graph could not be laid out. Press esc, then c to open it again.')
})
