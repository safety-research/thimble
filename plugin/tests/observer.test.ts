// The observer's hooks (observer/observer.ts): one look after each answer, a fork of the session (no `claude` started);
// its reply read and merged where the person sees it, and nothing told to Claude; a pass that fails is tried once more,
// then said in one line; a -p run gets no look. `claude plugin test plugin`. The model's calls and the Node children are
// answered here.
import { expect, mock, test } from 'claude-code/testing'

import { slim } from '../observer/evidence.js'
import { promptStub } from './stubs'

const ROOT = '/data'
const DIR = `${ROOT}/thimble/objects`
const OBJECT = {
  id: '01-saves', version: 1, session: 's-1', updated: '2000-01-01T00:00:00+00:00', title: 'Saves per day', question: 'When did the agents edit the wiki most?',
  text: 'June 18 had the most saves: [6,543](q1#day=2026-06-18@n).',
  program: 'return k.bars(...)', data: { days: [{ day: '2026-06-18', n: 6543, _rows: ['revisions.jsonl#L28-31'] }] },
  lineage: {
    queries: { q1: { id: 'q1', about: 'saves per day', inputs: [{ path: 'revisions.jsonl', rows_read: 14591 }], lineage: 'exact' } },
    cites: [{ in: 'text', ref: 'q1#day=2026-06-18@n', label: '6,543', value: 6543, rows: ['revisions.jsonl#L28-31'] }],
    coverage: { files: { 'revisions.jsonl': 'computed' }, not_read: ['events.jsonl'] },
  },
}
const DRAWING = { kit: 1, w: 40, h: 24, mode: 'inline', root: { t: 'stack', kids: [{ t: 'text', runs: [{ s: 'Jun 18 6,543', tone: 'ink' }], wrap: false, w: 12 }] }, cites: {}, examples: {}, regions: [], warnings: [], ms: 2 }
const USAGE = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 }
const NOW = Date.parse('2026-10-18T09:00:00Z')
const ROW = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const OBS = '/home/t/.thimble/lean/observer/s-1.json'

type Json = Record<string, unknown>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** The session around the observer: one object on disk, the Node children, the model's two calls (answered by
 *  `question` and `fork`), the prompt and the band. */
function world(on: Any, o: { question?: Json; fork?: Json | (() => Json); env?: Record<string, string> } = {}) {
  mock.env(on, { THIMBLE_HOME: '/home/t/.thimble', ...(o.env ?? {}) })
  mock.store(on)
  on('session.cwd', () => ({ value: ROOT }))
  on('session.id', () => ({ value: 's-1' }))
  on('session.messages', () => ({ value: [] }))
  const files: Record<string, string> = { [`${DIR}/01-saves.json`]: JSON.stringify(OBJECT) }
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: e.path in files || e.path === DIR || e.path.endsWith('.md') }))
  on('fs.list', (_$: unknown, e: { path?: string }) => ({ value: e.path === DIR ? Object.keys(files).filter(f => f.startsWith(DIR + '/')).map(f => ({ name: f.slice(DIR.length + 1), kind: 'file', size: 1, mtimeMs: 0, isLink: false })) : [] }))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: files[e.path] ?? promptStub(e.path) ?? '' }))
  on('fs.write', (_$: unknown, e: { path: string; content?: string; text?: string; data?: string }) => {
    files[e.path] = String(e.content ?? e.text ?? e.data ?? '')
    return { value: undefined }
  })
  const runs: string[][] = []
  // the session's events, as telemetry appends them through its Node child
  const events: Json[] = []
  on('process.run', (_$: unknown, e: { argv: string[]; init?: { stdin?: string } }) => {
    runs.push([...e.argv])
    if (e.argv.some(a => a.endsWith('telemetry/append.mjs'))) {
      for (const l of String(e.init?.stdin ?? '').split('\n').filter(Boolean)) events.push({ file: e.argv.at(-1), ...JSON.parse(l) })
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    let out = '{}'
    if (e.argv.some(a => a.endsWith('prep.mjs'))) out = JSON.stringify({ drawing: DRAWING })
    else if (e.argv.includes('coverage')) out = 'Coverage of this session · 4 source files\nNot read: 1 file (9 rows): events.jsonl'
    else if (e.argv.some(a => a.endsWith('objects.mjs'))) out = JSON.stringify(Object.entries(files).filter(([k]) => k.startsWith(DIR + '/')).map(([, v]) => slim(JSON.parse(v))).filter(o => o && o.session === e.argv.at(-1)))
    return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const forks: string[] = []
  const questions: string[] = []
  // the question step's prompt as blocks, where its cache marks are
  const qblocks: { text: string; cache?: true }[][] = []
  // the question step is a completion with no system prompt; the pass is one with the frame and its lenses as the
  // system prompt
  const pass = async (prompt: string) => {
    forks.push(prompt)
    const out = typeof o.fork === 'function' ? o.fork() : o.fork ?? { line: null, settled: false, hints: {} }
    // a pass that fails: the result as the model call gives it
    if (out && (out as Json).fails) return { value: (out as Json).fails }
    return { value: { isAnswered: true, text: JSON.stringify(out), usage: USAGE } }
  }
  const efforts: (string | null)[] = []
  on('model.complete', async (_$: unknown, e: { prompt: string; system?: string; effort?: string; promptBlocks?: { text: string; cache?: true }[] }) => {
    if (e.system) { efforts.push(e.effort ?? null); return pass(`${e.system}\n${e.prompt}`) }
    questions.push(String(e.prompt))
    qblocks.push([...(e.promptBlocks ?? [])])
    return { value: { isAnswered: true, text: JSON.stringify(o.question ?? { parts: [], drift: null, decision: null }), usage: USAGE } }
  })
  on('model.fork', (_$: unknown, e: { prompt: string }) => pass(String(e.prompt)))
  const submitted: { text: string; context: readonly string[] }[] = []
  on('prompt.submit', (_$: unknown, e: { text: string; context?: readonly string[] }) => {
    submitted.push({ text: e.text, context: e.context ?? [] })
    return { text: e.text }
  })
  const filled: string[] = []
  on('prompt.read', () => ({ value: { text: '' } }))
  on('prompt.fill', (_$: unknown, e: { text: string }) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  // Claude Code's hint line under the prompt, as a hook leaves it
  on('ui.render', { component: 'PromptHint' }, (_$: unknown, e: { props: { hint: string } }) => ({ type: 'Text', props: {}, children: [String(e.props.hint)] }) as never)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the reply'] }) as never)
  const at = { tools: 0 }
  on('turn.start', (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', (_$: unknown, e: { answer?: string }) => ({ text: e.answer ?? '' }))
  on('command.register', (_$: unknown, e: { name: string }) => ({ value: { command: e.name } }))
  on('turn.step', async function* (_$: unknown, e: Any) { return { turnId: e.turnId, index: e.index, answer: '', toolUses: Array.from({ length: at.tools }, (_, i) => ({ id: `u${i}`, name: 'Bash', input: {} })) } })
  // a save writes the object as the kernel does, stamped with the session's clock
  const clock = mock.clock(on, { now: NOW })
  on('tool.call', () => {
    files[`${DIR}/01-saves.json`] = JSON.stringify({ ...OBJECT, updated: new Date(clock.now()).toISOString() })
    files['/home/t/.thimble/lean/events/s-1.jsonl'] = (files['/home/t/.thimble/lean/events/s-1.jsonl'] || '') + JSON.stringify({ t: Date.now() / 1000, kind: 'save', session: 's-1', root: ROOT, object: '01-saves', version: 1 }) + '\n'
    return { result: 'saved 01-saves v1: thimble/objects/01-saves.json\n' }
  })
  const toasts: string[] = []
  on('ui.toast', (_$: unknown, e: unknown) => { toasts.push(typeof e === 'string' ? e : String((e as { text?: string; message?: string })?.text ?? (e as { message?: string })?.message ?? JSON.stringify(e))); return { value: undefined } })
  return { files, runs, forks, questions, qblocks, submitted, filled, at, clock, events, toasts, efforts }
}

// every string a drawn tree holds, in order
function textOf(n: Any): string {
  if (n == null || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  // a Button's label stands for its words only where it draws no children of its own
  const kids = n.props?.children ?? (Array.isArray(n.children) && n.children.length ? n.children : null)
  return textOf(n.props?.children) + textOf(n.children) + (typeof n.props?.label === 'string' && !kids ? n.props.label : '')
}

/** One model request of main's turn, with `tools` tool calls. */
async function step($: Any, w: { at: { tools: number } }, turnId: string, index: number, tools: number) {
  w.at.tools = tools
  const s = $.turn.step({ turnId, index, model: 'claude-opus-5-5', messageCount: 3 })
  for (let r = await s.next(); !r.done; r = await s.next()) { /* no chunks */ }
}

/** A turn of main's: the person's prompt, its steps (with tool calls), an object saved or not, and its answer. */
async function turn($: Any, w: { at: { tools: number } }, clock: Any, o: { id: string; prompt: string; answer: string; tools: number; save?: boolean }) {
  await $.prompt.submit({ text: o.prompt, origin: { kind: 'composer' } } as never)
  await $.turn.start({ turnId: o.id, text: o.prompt } as never)
  await step($, w, o.id, 0, o.tools)
  if (o.save) {
    await $.tool.call({ tool: 'Bash', command: 'thimble save saves' } as never)
    await $.session.append({ door: 'response', uuid: ROW, origin: { kind: 'model', model: 'm' }, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: o.answer }] } } as never)
  }
  await $.turn.complete({ turnId: o.id, answer: o.answer, durationMs: 5, reason: 'answer', isAborted: false } as never)
  await clock.advance(100)
}

const reply = ($: Any) => $.ui.render({ component: 'AssistantMessage', surface: 'terminal', requestId: ROW, props: { text: 'June 18.', isFirstOfReply: true }, viewport: { columns: 120, rows: 40, isFullscreen: true } } as never)
const BAND = { plugin: 'thimble', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 100, scroll: { offset: 0, bodyRows: 12 }, view: {} }, viewport: { columns: 100, rows: 40, isFullscreen: true } } as never

test('after a turn that saved an object: one look reads its lineage, lights the verbs of the answer, and tells Claude nothing', async ($, on) => {
  const w = world(on, { fork: {
    line: null, settled: false,
    verbs: { v: { note: '2 views ready', proposals: ['saves by day', 'saves by wiki'] }, s: { lit: false } },
    glosses: [],
  } })
  const clock = w.clock
  await turn($, w, clock, { id: 't1', prompt: 'when did they edit most?', answer: 'June 18 had the most saves.', tools: 2, save: true })
  // one pass, and no other call; the pass read the object's lineage, the verbs and the session's coverage
  expect(w.questions.length).toBe(0)
  expect(w.forks.length).toBe(1)
  for (const x of ['01-saves', 'q1#day=2026-06-18@n', 'revisions.jsonl', 'Jun 18 6,543', 'events.jsonl']) expect(w.forks[0]).toContain(x)
  expect(w.runs.some(a => a.includes('coverage'))).toBe(true)
  // the reply read and merged: v lit with its note in the bar above the prompt, and in the message's record
  await clock.settle()
  expect(textOf(await reply($)).length).toBeGreaterThan(0)
  await clock.settle()
  expect(textOf(await $.ui.render(BAND))).toContain('2 views ready')
  expect(JSON.parse(w.files[`${ROOT}/thimble/messages/s-1/${ROW.slice(0, 24)}.json`]!).verbs.v.proposals).toEqual(['saves by day', 'saves by wiki'])
  // the next prompt carries nothing from the look: all it gives is on the screen
  await $.prompt.submit({ text: 'and the busiest month?', origin: { kind: 'composer' } } as never)
  expect(w.submitted.at(-1)!.context.join('\n')).not.toContain('side agent')
  // the session's file keeps what it lit, for measuring
  expect(JSON.parse(w.files[OBS]!).log.find((r: { kind: string }) => r.kind === 'look').verbs_lit).toEqual(['v'])
})

test('the pass is a fork of the session: its prompt is the frame, the lenses, the message to read and the evidence; each call and the turn are lines in the session events, with each lens\'s share', async ($, on) => {
  const w = world(on, { fork: { line: null, settled: false, verbs: { v: { note: '1 view ready', proposals: ['saves per day, June 18 marked'] } }, glosses: [], claims: [] } })
  await turn($, w, w.clock, { id: 't1', prompt: 'when did they edit most?', answer: 'June 18 had the most saves.', tools: 2, save: true })
  await w.clock.settle()
  await w.clock.advance(100)
  await w.clock.settle()
  // one fork, its prompt the frame, the lenses, the message to read, the evidence, the digests and the reply's skeleton
  expect(w.forks.length).toBe(1)
  expect(w.efforts).toEqual([])
  const p = w.forks[0]!
  for (const x of ['FRAME', 'LENS actions', 'LENS explain', 'LENS heads', 'LENS claims', 'REPLY {"verbs": {}, "glosses": [], "heads": null, "claims": []}', 'NOW', 'when did they edit most?', '01-saves']) expect(p).toContain(x)
  expect(p.indexOf('LENS claims')).toBeLessThan(p.indexOf('NOW'))
  expect(p).not.toContain('LENS line')
  expect(p).not.toContain('notes')
  // the session is the fork's own: no steps of the turn are copied into the prompt
  expect(p).not.toContain('STEPS')
  const file = '/home/t/.thimble/lean/events/s-1.jsonl'
  expect(w.events.every(e => e.file === file)).toBe(true)
  const prompts = w.events.find(e => e.kind === 'prompts')!
  expect(prompts.off).toEqual([])
  // one call after the turn: no question step
  expect(w.events.some(e => e.kind === 'call' && e.feature === 'question')).toBe(false)
  const pass = w.events.find(e => e.kind === 'call' && e.feature === 'observer')!
  expect(pass.prompt).toBe('observer')
  expect(pass.turn_prompt).toBe('observer-turn')
  // a fork runs as main's thread does: no effort of its own
  expect(pass.effort).toBeUndefined()
  expect(pass.blocked).toBe(false)
  expect(pass.usage).toEqual(USAGE)
  expect(Object.keys(pass.lenses as Json)).toEqual(['actions', 'explain', 'heads', 'claims'])
  expect((pass.lens_prompts as Json).actions).toBe('lens-actions')
  // one look line in the events: what it lit
  const look = w.events.find(e => e.kind === 'look')!
  expect(look.lit).toEqual(['v', 's'].filter(k => (look.lit as string[]).includes(k)))
  expect((look.v as Json).proposals).toEqual(['saves per day, June 18 marked'])
  expect(((pass.lenses as Json).actions as Json).out).toBeGreaterThan(0)
  const main = w.events.find(e => e.kind === 'turn')!
  expect(main.feature).toBe('main')
  expect(main.agent).toBe(null)
  expect(typeof main.hook_ms).toBe('number')
  // the merge: v lit with its named view
  expect(JSON.parse(w.files[`${ROOT}/thimble/messages/s-1/${ROW.slice(0, 24)}.json`]!).verbs.v.proposals).toEqual(['saves per day, June 18 marked'])
})

test('a -p run gets no look: no model call and no thimble coverage after its turns', async ($, on) => {
  const w = world(on)
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: ROOT, surface: null, isInteractive: false } as never)
  await turn($, w, w.clock, { id: 't1', prompt: 'when did they edit most?', answer: 'June 18 had the most saves.', tools: 2, save: true })
  await w.clock.settle()
  expect(w.questions.length).toBe(0)
  expect(w.forks.length).toBe(0)
  expect(w.runs.some(r => r.includes('coverage'))).toBe(false)
})

test('a pass that fails is tried once more; a second failure is said plainly, with its fix', async ($, on) => {
  let n = 0
  const FAIL = { fails: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: USAGE } }
  const w = world(on, { fork: () => (++n <= 1 ? FAIL : { verbs: { v: { note: '1 view ready', proposals: ['saves per day'] } }, glosses: [] }) })
  await turn($, w, w.clock, { id: 't1', prompt: 'when did they edit most?', answer: 'June 18 had the most saves.', tools: 2 })
  await w.clock.settle()
  await w.clock.advance(2100)
  await w.clock.settle()
  // the second try answered: v lights, and nothing was said
  expect(w.forks.length).toBe(2)
  expect(w.toasts).toEqual([])
  expect((JSON.parse(w.files[OBS]!).log.filter((r: Json) => r.kind === 'look').at(-1).fork as Json).out).toMatchObject({ verbs: { v: { note: '1 view ready' } } })
  // both tries fail: one line, with what failed
  n = -10
  await turn($, w, w.clock, { id: 't2', prompt: 'and the day after?', answer: 'June 19.', tools: 1 })
  await w.clock.settle()
  await w.clock.advance(2100)
  await w.clock.settle()
  expect(w.forks.length).toBe(4)
  expect(w.toasts.length).toBe(1)
  expect(w.toasts[0]).toContain('overloaded')
})

