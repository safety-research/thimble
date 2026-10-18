// Claims in a session (verbs/claims, shell/claimsview.ts, observer.ts): the observer's one look after a turn of work
// gives the turn's claims; each is placed in the message that said it, with the citations near it, in the session's
// store (thimble/claims/<session>.json); c lights under the answer with how many are new or revised; c from the empty
// prompt opens the Claims pane, focused (clusters with their claims, fact or interp, ×N; a revised claim struck
// through with └→ its replacement under it); the ring on a claim shows where it was said, its sources and ×N; ] [
// replay the claims in the order made; 2–8 open a source in the tray; 0 closes; a question asked carries the claim.
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
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the reply'] }) as never)
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

const PANE = { component: 'Pane', surface: 'terminal', requestId: 'claims', props: { bodyColumns: 120, scroll: { bodyRows: 46 } } } as never
const focus = (el: string) => ({ requestId: 'claims', element: el, origin: { kind: 'person' } }) as never

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

test('c opens the Claims pane, focused: clusters with their claims, fact or interp, ×N, a revised claim struck through with └→ its replacement', async ($, on) => {
  const w = world(on, [FORK1, FORK2])
  await turn($, w, { id: 't1', user: U1, prompt: Q1, row: R1, answer: A1 })
  await turn($, w, { id: 't2', user: U2, prompt: Q2, row: R2, answer: A2 })
  await ($ as Any).prompt.edit(key('c'))
  await w.clock.settle()
  expect(w.opened.at(-1)).toMatchObject({ id: 'claims', focus: true })
  const pane = await $.ui.render(PANE)
  const t = textOf(pane)
  expect(t).toContain("Claims · 4 from Claude's work and our chat · deduped · 3 clusters")
  expect(t).toContain('↑ ↓ claim · ] [ time · ')
  for (const name of ['● testing for bias · 2', '● finding who edited · 1', '● the June 18 burst · 1']) expect(t).toContain(name)
  expect(t).toMatch(/The tilt in the edits is one editor +revised/)
  expect(t).toMatch(/└→ The tilt is two editors, Kestrel and Wren, not one +fact/)
  expect(t).toMatch(/June 18 had 6,543 saves, the busiest day +fact +×2/)
  expect(t).toMatch(/Kestrel made 41% of June's edits, 212 of them reverts +fact/)
  expect(struck(pane).join('|')).toContain('The tilt in the edits is one editor')
  expect(struck(pane).join('|')).not.toContain('two editors')
  expect(t).toContain('orient on the whole corpus · map 4 files · ~4 min · ~310k tokens')
  // the time strip: one dot per message that said claims, the turns named
  expect(t).toContain('turn 1')
  expect(t).toContain('▲ turn 2 · answer · 4 of 4 claims')
  // the ring starts on the claim the message added; the details say where it was said
  expect(t).toContain('said in turn 2 by Claude')
  // the ring on the revised claim: where it was said twice, its sources as cite marks, what revised it
  await $.ui.focus(focus('cl-c1'))
  const d = textOf(await $.ui.render(PANE))
  expect(d).toContain('revised in turn 2 → The tilt is two editors')
  expect(d).toContain('said in turn 1 by Claude · ×2 restated, merged · interp · testing for bias')
  expect(d).toMatch(/sources .*41%.*212 of them/)
  expect(d).toContain('turn 1  Claude "The tilt is one editor"')
  expect(d).toContain('turn 2  you    "the tilt is one editor"')
  expect(d).toContain(' · 2–3 open a source · 0 close')
  // 2 opens its first source in the tray
  await ($ as Any).prompt.edit(key('2'))
  await w.clock.settle()
  const BAND = { plugin: 'thimble-lean', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows: 16, bodyColumns: 110, scroll: { offset: 0, bodyRows: 16 }, view: {} }, viewport: { columns: 120, rows: 50, isFullscreen: true } } as never
  textOf(await $.ui.render(BAND))
  await w.clock.settle()
  expect(textOf(await $.ui.render(BAND))).toContain('41%')
  expect(w.runs.some(a => a.includes('resolve') && a.includes('q4#user=Kestrel@share'))).toBe(true)
  // 0 closes the source card first
  await ($ as Any).prompt.edit(key('0'))
  expect(textOf(await $.ui.render(BAND))).not.toContain('41%')
})

test('] [ replay the claims in the order made: later claims are not shown yet, and a revision only once it was made', async ($, on) => {
  const w = world(on, [FORK1, FORK2])
  await turn($, w, { id: 't1', user: U1, prompt: Q1, row: R1, answer: A1 })
  await turn($, w, { id: 't2', user: U2, prompt: Q2, row: R2, answer: A2 })
  await ($ as Any).prompt.edit(key('c'))
  await w.clock.settle()
  await ($ as Any).prompt.edit(key('['))
  await w.clock.settle()
  const back = await $.ui.render(PANE)
  const t = textOf(back)
  expect(t).toContain('▲ turn 1 · answer · 3 of 4 claims')
  expect(t).toContain("Claims · 3 from Claude's work")
  expect(t).not.toContain('Kestrel and Wren')
  expect(t).toMatch(/The tilt in the edits is one editor +interp +claim:/)
  expect(t).toMatch(/June 18 had 6,543 saves, the busiest day +fact +claim:/)
  expect(t).toContain('the claim the ring was on is said later, in turn 2')
  expect(struck(back).join('|')).not.toContain('The tilt in the edits')
  // the pane takes the keys back after a key that came through the prompt
  expect(w.opened.filter(o => o.id === 'claims').length).toBe(2)
  await ($ as Any).prompt.edit(key(']'))
  await w.clock.settle()
  expect(textOf(await $.ui.render(PANE))).toContain('▲ turn 2 · answer · 4 of 4 claims')
})

test('a question asked with the ring on a claim carries it; 0 closes the pane; m asks Claude for the corpus orientation', async ($, on) => {
  const w = world(on, [FORK1])
  await turn($, w, { id: 't1', user: U1, prompt: Q1, row: R1, answer: A1 })
  await ($ as Any).prompt.edit(key('c'))
  await w.clock.settle()
  await $.ui.focus(focus('cl-c2'))
  await ($ as Any).prompt.edit(key('1'))
  expect(textOf(await $.ui.render(PANE))).toContain('type your question below · ↵ sends it with this claim')
  await $.prompt.submit({ text: 'is 41% of all June edits or of the relay edits?', origin: { kind: 'composer' } } as never)
  const ctx = w.submitted.at(-1)!.context.join('\n')
  expect(ctx).toContain('a claim of this session selected in the Claims pane: c2 "Kestrel made 41% of June\'s edits, 212 of them reverts"')
  expect(ctx).toContain('q4#user=Kestrel@share')
  // 0 closes the pane; c opens it again, and m asks for the orientation (the claims verb run with "orient")
  await ($ as Any).prompt.edit(key('0'))
  await w.clock.settle()
  await ($ as Any).prompt.edit(key('c'))
  await w.clock.settle()
  await ($ as Any).prompt.edit(key('m'))
  await w.clock.settle()
  const ran = w.runs.find(a => a.some(x => x.endsWith('verb.mjs')) && a.includes('run'))
  expect(ran?.includes('claims')).toBe(true)
})
