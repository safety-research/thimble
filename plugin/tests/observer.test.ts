// The observer's hooks (observer/observer.ts): one look after a turn of work; it lights the verbs of the answer's row
// and places its glosses and heads-ups, a gloss never twice and never fewer for being unopened. All it gives reaches the
// person; it tells Claude nothing. What the person opens reaches the session with their next prompt.
// `claude plugin test plugin`. The model's calls and the Node children are answered here.
import { expect, mock, test } from 'claude-code/testing'

import { slim } from '../observer/evidence.js'
import { press, promptStub } from './stubs'

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
function world(on: Any, o: { question?: Json; fork?: Json | (() => Json); expand?: Json; env?: Record<string, string>; squeeze?: string; holdSqueeze?: Promise<void>; holdPass?: Promise<void> } = {}) {
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
  // how many passes run at once now, and the most that ever did
  const conc = { running: 0, most: 0 }
  const pass = async (prompt: string) => {
    conc.running += 1
    conc.most = Math.max(conc.most, conc.running)
    if (o.holdPass) await o.holdPass
    conc.running -= 1
    forks.push(prompt)
    const out = typeof o.fork === 'function' ? o.fork() : o.fork ?? { line: null, settled: false, hints: {} }
    // a pass that fails: the result as the model call gives it
    if (out && (out as Json).fails) return { value: (out as Json).fails }
    return { value: { isAnswered: true, text: JSON.stringify(out), usage: USAGE } }
  }
  const efforts: (string | null)[] = []
  // squeeze's rewrites (its prompt's stub is THE PROMPT, with the card guide's toolkit after it when the answer has a
  // card), each answered with `squeeze` once `holdSqueeze` lets it come
  const squeezes: string[] = []
  on('model.complete', async (_$: unknown, e: { prompt: string; system?: string; effort?: string; promptBlocks?: { text: string; cache?: true }[] }) => {
    if (String(e.system ?? '').startsWith('THE PROMPT')) {
      squeezes.push(String(e.prompt))
      if (o.holdSqueeze && squeezes.length === 1) await o.holdSqueeze
      return { value: { isAnswered: true, text: `<text>${o.squeeze ?? 'Squeezed.'}</text>`, usage: USAGE } }
    }
    // e on an explainer: the longer one, written from the explainer as it stands
    if (o.expand && String(e.prompt).includes('The explainer as it stands:')) return { value: { isAnswered: true, text: JSON.stringify(o.expand), usage: USAGE } }
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
  return { files, runs, forks, questions, qblocks, squeezes, submitted, filled, at, clock, events, toasts, efforts, conc }
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
  expect(w.forks[0]).toContain('Card 01-saves v1 "Saves per day" (saved since the last look)')
  expect(w.forks[0]).toContain('"6,543" = 6,543 (q1#day=2026-06-18@n): rests on 4 rows of revisions.jsonl')
  expect(w.forks[0]).not.toContain('t trace: where it came from')
  expect(w.forks[0]).toContain('as the analyst sees it under the reply:\n    Jun 18 6,543')
  expect(w.forks[0]).toContain('Not read: 1 file (9 rows): events.jsonl')
  expect(w.runs.some(a => a.includes('coverage'))).toBe(true)
  // the verbs in the bar above the prompt: v lit with its note in place of its name, s as its name
  await clock.settle()
  const drawn = textOf(await reply($))
  await clock.settle()
  const row = textOf(await $.ui.render(BAND))
  expect(row).toContain('v ● 2 views ready')
  expect(row).toContain('s squeeze')
  expect(row).not.toContain('s ●')
  expect(drawn.length).toBeGreaterThan(0)
  expect(JSON.parse(w.files[`${ROOT}/thimble/messages/s-1/${ROW.slice(0, 24)}.json`]!).verbs.v.proposals).toEqual(['saves by day', 'saves by wiki'])
  // the next prompt carries nothing from the look: all it gives is on the screen
  await $.prompt.submit({ text: 'and the busiest month?', origin: { kind: 'composer' } } as never)
  expect(w.submitted.at(-1)!.context.join('\n')).not.toContain('side agent')
  // nothing showed above the prompt
  expect(textOf(await $.ui.render(BAND))).not.toContain('Heads up')
  // the session's file keeps what it lit, for measuring
  expect(JSON.parse(w.files[OBS]!).log.find((r: { kind: string }) => r.kind === 'look').verbs_lit).toEqual(['v'])
})

test('a short answer of a turn with no tool is read too: one look, as every answer of Claude\'s', async ($, on) => {
  const w = world(on)
  const clock = w.clock
  await turn($, w, clock, { id: 't1', prompt: 'thanks', answer: 'You are welcome.', tools: 0 })
  await clock.settle()
  expect(w.questions.length).toBe(0)
  expect(w.forks.length).toBe(1)
})

test('a look that ends while a new turn runs: its verbs light the answer it looked at', async ($, on) => {
  const w = world(on, { fork: { verbs: { v: { note: 'saves by day', proposals: ['saves by day'] } } } })
  const clock = w.clock
  // the turn ends; before its look runs, the person starts another turn
  await $.prompt.submit({ text: 'I will share it', origin: { kind: 'composer' } } as never)
  await $.turn.start({ turnId: 't1', text: 'I will share it' } as never)
  await step($, w, 't1', 0, 1)
  await $.tool.call({ tool: 'Bash', command: 'thimble save saves' } as never)
  await $.session.append({ door: 'response', uuid: ROW, origin: { kind: 'model', model: 'm' }, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'Here.' }] } } as never)
  await $.turn.complete({ turnId: 't1', answer: 'Here.', durationMs: 5, reason: 'answer', isAborted: false } as never)
  await $.prompt.submit({ text: 'and more', origin: { kind: 'composer' } } as never)
  await step($, w, 't2', 0, 1)
  await clock.advance(100)
  expect(w.forks.length).toBe(1)
  expect(textOf(await $.ui.render(BAND))).not.toContain('Heads up')
  await clock.settle()
  textOf(await reply($))
  await clock.settle()
  expect(textOf(await $.ui.render(BAND))).toContain('v ● saves by day')
})

test("a turn v's ask started: the pass reads v's prompt, the key's press and not the person's words", async ($, on) => {
  let n = 0
  const w = world(on, {
    fork: () => (++n === 1 ? { line: null, settled: false, hints: {} } : { line: null, settled: false, hints: {} }),
  })
  on('prompt.edit', (_$: unknown, e: { text: string; start: number; end: number; inputText: string }) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
  const session = mock.session(on)
  const clock = w.clock
  await turn($, w, clock, { id: 't1', prompt: 'I will tell my team the cap cut them off. Anything to fix first?', answer: 'Fix two things.', tools: 1, save: true })
  expect(w.questions.length).toBe(0)
  // v pressed (nothing proposed, so it asks at once): its ask is the next prompt of main, its request in the row for
  // Claude alone before the prompt
  const ui = await $.ui.mount({ plugin: 'thimble', component: 'AssistantMessage', surface: 'terminal', requestId: ROW, props: { text: 'Fix two things.', isFirstOfReply: true }, viewport: { columns: 100, rows: 40, isFullscreen: true } } as never)
  await clock.settle()
  await press($, w.clock, { origin: { kind: 'composer' }, key: { key: 'v' }, text: '', cursor: 0, start: 0, end: 0, inputText: 'v' })
  await clock.advance(700)
  await clock.settle()
  await ui.unmount()
  expect(w.submitted.at(-1)!.text).toBe('visualize another view of this answer')
  const hidden = (session.appended() as Any[]).filter(r => r.message?.type === 'user').map(r => String(r.message.content?.[0]?.text ?? '')).at(-1)!
  expect(hidden).toContain('The analyst pressed v (visualize) on your answer that begins "Fix two things."')
  expect(hidden).not.toContain('side agent')
  await $.turn.start({ turnId: 't2', text: 'visualize another view of this answer' } as never)
  await step($, w, 't2', 0, 2)
  await $.turn.complete({ turnId: 't2', answer: 'This timeline shows when each agent stopped.', durationMs: 5, reason: 'answer', isAborted: false } as never)
  await clock.advance(100)
  // the pass names the message to read and what asked for it: the key's press, not the person's words
  expect(w.forks.length).toBe(2)
  expect(w.forks[1]).toContain('Claude\'s answer at the end of turn 2, which begins "This timeline shows when each agent stopped."')
  expect(w.forks[1]).toContain('It answers the analyst\'s press of a key (visualize), which asked "visualize another view of this answer".')
  const look = JSON.parse(w.files[OBS]!).log.filter((r: Json) => r.kind === 'look').at(-1)
  expect(look).toMatchObject({ question: 'visualize another view of this answer', typed: false, verb: 'visualize' })
})

// ------------------------------------------------------------------------------------------------ glosses

const GLOSS = { term: 'fixture scope', body: 'How long pytest keeps one fixture object.', here: 'In run 7, [conftest.py:14](tests/conftest.py#L14) set it to "module".', program: "return k.text('**module** {dim:one cart per file}')" }
const ANSWER = 'June 18 had the most saves, because the `fixture scope` was module.'
const MSGPATH = `${ROOT}/thimble/messages/s-1/${ROW.slice(0, 24)}.json`
const HINT = { plugin: 'thimble', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows: 16, bodyColumns: 200, scroll: { offset: 0, bodyRows: 16 }, view: {} }, viewport: { columns: 200, rows: 48, isFullscreen: true } } as never
const BAND2 = { ...(BAND as object), props: { hasSurvey: false, isWorking: false, maxRows: 16, bodyColumns: 110, scroll: { offset: 0, bodyRows: 16 }, view: {} }, viewport: { columns: 120, rows: 40, isFullscreen: true } } as never
const key = (k: string, text = '') => ({ origin: { kind: 'composer' }, key: { key: k }, text, cursor: 0, start: 0, end: 0, inputText: k.length === 1 ? k : '' }) as never

test('a gloss is placed by its term in the answer, with a teal fill; its card says what it is and where it mattered, and a citation in it opens over it', async ($, on) => {
  const w = world(on, { fork: { line: null, settled: false, verbs: {}, glosses: [GLOSS, { term: 'not in the answer', body: 'x' }] } })
  on('prompt.edit', (_$: unknown, e: { text: string; start: number; end: number; inputText: string }) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
  await turn($, w, w.clock, { id: 't1', prompt: 'why June 18?', answer: ANSWER, tools: 2, save: true })
  await w.clock.settle()
  const rec = JSON.parse(w.files[MSGPATH]!)
  expect(Object.values(rec.glosses).map((g: Any) => g.term)).toEqual(['fixture scope'])
  const mark = rec.marks.find((m: Any) => m.kind === 'gloss')
  expect(ANSWER.slice(mark.start, mark.end)).toBe('`fixture scope`')
  const drawn = await $.ui.render({ component: 'AssistantMessage', surface: 'terminal', requestId: ROW, props: { text: ANSWER, isFirstOfReply: true }, viewport: { columns: 120, rows: 40, isFullscreen: true } } as never)
  expect(JSON.stringify(drawn)).toContain('"label":"explain fixture scope"')
  // ] opens it in the tray; its card is drawn from the gloss
  await press($, w.clock, key(']'))
  await w.clock.settle()
  textOf(await $.ui.render(BAND2))
  await w.clock.settle()
  const card = textOf(await $.ui.render(BAND2))
  expect(card).toContain('fixture scope')
  // the person reads the mark's kind by its teal frame; a asks, and o opens the cite inside the card, as the bar under
  // the prompt says
  expect(card).not.toContain('gloss')
  expect(JSON.stringify(await $.ui.render(BAND2))).toContain('"color":"#62d2c6"')
  expect(textOf(await $.ui.render(HINT))).toContain('↵ e expand · a ask · o open ')
  expect(textOf(await $.ui.render(HINT))).toContain(' · 0 close · ] next')
  // o opens the citation in it, over it (once a letter after it could no longer make it a word); 0 comes back
  await press($, w.clock, key('o'))
  await w.clock.advance(800)
  await w.clock.settle()
  expect(textOf(await $.ui.render(BAND2))).toContain('conftest.py:14')
  expect(textOf(await $.ui.render(HINT))).toContain('0 back')
  await press($, w.clock, key('0'))
  expect(textOf(await $.ui.render(BAND2))).toContain('fixture scope')
})

test('e on an explainer writes a longer one in its place: in the tray when the terminal has no room for the side panel', async ($, on) => {
  const LONGER = { body: 'How long pytest keeps one fixture object before it builds a new one: a function, a module or the whole session.', here: 'Run 7 set it to "module" in [conftest.py:14](tests/conftest.py#L14).' }
  const w = world(on, { fork: { line: null, settled: false, verbs: {}, glosses: [GLOSS] }, expand: LONGER })
  on('prompt.edit', (_$: unknown, e: { text: string; start: number; end: number; inputText: string }) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'needs 160 columns (120 now)' } }))
  await turn($, w, w.clock, { id: 't1', prompt: 'why June 18?', answer: ANSWER, tools: 2, save: true })
  await w.clock.settle()
  await press($, w.clock, key(']'))
  await w.clock.settle()
  textOf(await $.ui.render(BAND2))
  await w.clock.settle()
  await press($, w.clock, key('e'))
  await w.clock.settle()
  textOf(await $.ui.render(BAND2))
  await w.clock.settle()
  // the tray's frame names it expanded (its card's words are drawn by cards.js, tested in shell/test/message.test.mjs)
  const card = textOf(await $.ui.render(BAND2))
  expect(card).toContain('explain · expanded')
  expect(card).not.toContain('writing a longer explanation')
  expect(textOf(await $.ui.render(HINT))).toContain('thimble  a ask · o open conftest.py:14 · 0 close · ] next')
  // the answer's record keeps the longer one, and the short one beside it
  const g: Any = Object.values(JSON.parse(w.files[MSGPATH]!).glosses)[0]
  expect(g.expanded).toBe(true)
  expect(g.short.body).toBe(GLOSS.body)
})

test('a heads-up is placed on its words in orange beside the explainers, and opens a card of its title, its points and what to do; what the person opened reaches the session once, in one row with their next prompt', async ($, on) => {
  const HEADS = { term: 'June 18 had the most saves', title: 'Two days are missing', bullets: ['[revisions.jsonl ends on Jun 20](revisions.jsonl#L14591), so the last week is short.'], todo: 'Count again per day.' }
  const w = world(on, { fork: { line: null, settled: false, verbs: {}, glosses: [GLOSS], heads: HEADS } })
  const session = mock.session(on)
  on('prompt.edit', (_$: unknown, e: { text: string; start: number; end: number; inputText: string }) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
  await turn($, w, w.clock, { id: 't1', prompt: 'why June 18?', answer: ANSWER, tools: 2, save: true })
  await w.clock.settle()
  const rec = JSON.parse(w.files[MSGPATH]!)
  expect(Object.values(rec.glosses).map((g: Any) => [g.term, g.kind ?? 'explain'])).toEqual([['fixture scope', 'explain'], ['June 18 had the most saves', 'heads']])
  const drawn = JSON.stringify(await $.ui.render({ component: 'AssistantMessage', surface: 'terminal', requestId: ROW, props: { text: ANSWER, isFirstOfReply: true }, viewport: { columns: 120, rows: 40, isFullscreen: true } } as never))
  expect(drawn).toContain('"label":"heads up June 18 had the most saves"')
  // the orange highlighter, dark text on a light fill, beside the explainer's teal one
  expect(drawn).toContain('"backgroundColor":"#ffcf94"')
  expect(drawn).toContain('"backgroundColor":"#9fe0d5"')
  // ] reaches the heads-up first: its words stand first in the answer
  await press($, w.clock, key(']'))
  await w.clock.settle()
  textOf(await $.ui.render(BAND2))
  await w.clock.settle()
  const card = textOf(await $.ui.render(BAND2))
  // the tray's frame names it a heads-up (its card's words are drawn by cards.js, tested in shell/test/message.test.mjs)
  expect(card).toContain('June 18 had the most saves')
  expect(card).toContain('heads up')
  expect(textOf(await $.ui.render(HINT))).not.toContain('expand')
  // the next mark, the explainer; then back to the heads-up, which is told once
  await press($, w.clock, key(']'))
  await press($, w.clock, key('['))
  await w.clock.settle()
  const rows = () => (session.appended() as Any[]).filter(r => r.message?.type === 'user').map(r => String(r.message.content?.[0]?.text ?? ''))
  // nothing yet: the row goes in with the analyst's next prompt, so Claude reads it beside a question of theirs
  expect(rows().filter(r => r.startsWith('What the analyst did'))).toEqual([])
  await $.prompt.submit({ text: 'and June 19?', origin: { kind: 'composer' } } as never)
  expect(rows().filter(r => r.startsWith('What the analyst did'))).toEqual([[
    'What the analyst did on screen since your last reply. It shows what they know and what they care about; none of it asks anything of you.',
    '- They opened the important detail "Two days are missing" on "June 18 had the most saves" in your message that begins "June 18 had the most saves, because the fixture scope was…".',
    '- They opened the explainer of "fixture scope" in your message that begins "June 18 had the most saves, because the fixture scope was…".',
  ].join('\n')])
  // told once: the next prompt carries no row
  await $.prompt.submit({ text: 'and June 20?', origin: { kind: 'composer' } } as never)
  expect(rows().filter(r => r.startsWith('What the analyst did')).length).toBe(1)
})

test('a term already explained is never glossed again, and explains never back off', async ($, on) => {
  const w = world(on, { fork: () => ({ line: null, settled: false, verbs: {}, glosses: [GLOSS] }) })
  await turn($, w, w.clock, { id: 't1', prompt: 'why June 18?', answer: ANSWER, tools: 2, save: true })
  expect(Object.keys(JSON.parse(w.files[MSGPATH]!).glosses)).toEqual(['g1'])
  // the next look is told the term, and a repeat is dropped
  await turn($, w, w.clock, { id: 't2', prompt: 'and June 19?', answer: ANSWER, tools: 2, save: true })
  expect(w.forks[1]).toContain('| - fixture scope')
  expect(JSON.parse(w.files[MSGPATH]!).glosses).toEqual({})
  // looks whose glosses nobody opened: the next looks are asked as the first was, with no rule to give fewer
  await turn($, w, w.clock, { id: 't3', prompt: 'and June 20?', answer: 'June 20 had the module-scoped tests run.', tools: 2, save: true })
  await turn($, w, w.clock, { id: 't4', prompt: 'and June 21?', answer: 'June 21 had the module-scoped tests run.', tools: 2, save: true })
  expect(w.forks.length).toBe(4)
  for (const f of w.forks) expect(f).not.toMatch(/at most|this time/)
})

// ------------------------------------------------------------------------------------------------ lenses, versions, telemetry

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
  for (const x of ['FRAME', 'LENS actions', 'LENS squeeze', 'LENS explain', 'LENS heads', 'LENS claims', 'REPLY {"verbs": {}, "glosses": [], "heads": null, "claims": []}', 'NOW Read this message of Claude\'s', 'It answers the analyst\'s message "when did they edit most?"', 'Card 01-saves v1', '| v visualize, s squeeze, c claims |']) expect(p).toContain(x)
  expect(p.indexOf('LENS claims')).toBeLessThan(p.indexOf('NOW'))
  expect(p).not.toContain('LENS line')
  expect(p).not.toContain('notes')
  // the session is the fork's own: no steps of the turn are copied into the prompt
  expect(p).not.toContain('STEPS')
  const file = '/home/t/.thimble/lean/events/s-1.jsonl'
  expect(w.events.every(e => e.file === file)).toBe(true)
  const prompts = w.events.find(e => e.kind === 'prompts')!
  expect((prompts.active as Json).observer).toBe('v6')
  expect((prompts.active as Json)['lens-explain']).toBe('v6')
  // one call after the turn: no question step
  expect(w.events.some(e => e.kind === 'call' && e.feature === 'question')).toBe(false)
  const pass = w.events.find(e => e.kind === 'call' && e.feature === 'observer')!
  expect(pass.prompt).toBe('observer:v6')
  expect(pass.turn_prompt).toBe('observer-turn:v3')
  // a fork runs as main's thread does: no effort of its own
  expect(pass.effort).toBeUndefined()
  expect(pass.blocked).toBe(false)
  expect(pass.mode).toBe('fork')
  expect(pass.usage).toEqual(USAGE)
  expect(Object.keys(pass.lenses as Json)).toEqual(['actions', 'squeeze', 'explain', 'heads', 'claims'])
  expect((pass.lens_prompts as Json).actions).toBe('lens-actions:v5')
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

test('a lens turned off is neither asked nor merged; another frame version is read in its place', async ($, on) => {
  const w = world(on, { env: { THIMBLE_PROMPTS: 'lens-explain:off,observer:v3' }, fork: { line: null, settled: false, verbs: {}, glosses: [GLOSS] } })
  await turn($, w, w.clock, { id: 't1', prompt: 'why June 18?', answer: ANSWER, tools: 2, save: true })
  await w.clock.settle()
  await w.clock.advance(100)
  await w.clock.settle()
  expect(w.forks[0]).toContain('FRAME')
  expect(w.forks[0]).not.toContain('LENS explain')
  expect(w.forks[0]).toContain('REPLY {"verbs": {}, "heads": null, "claims": []}')
  expect(JSON.parse(w.files[MSGPATH]!).glosses).toEqual({})
  const pass = w.events.find(e => e.kind === 'call' && e.feature === 'observer')!
  expect(pass.prompt).toBe('observer:v3')
  expect(Object.keys(pass.lenses as Json)).not.toContain('explain')
  expect((w.events.find(e => e.kind === 'prompts')!.changed as string)).toBe('observer:v3,lens-explain:off')
})

test('a version that does not exist: the default is read, and one line says so', async ($, on) => {
  const w = world(on, { env: { THIMBLE_PROMPTS: 'observer:v9' }, fork: { line: null, settled: false, verbs: {}, glosses: [] } })
  await turn($, w, w.clock, { id: 't1', prompt: 'when?', answer: 'June 18.', tools: 1 })
  await w.clock.settle()
  await w.clock.advance(100)
  await w.clock.settle()
  expect(w.forks[0]).toContain('FRAME\n')
  expect(w.toasts.length).toBe(1)
  expect(w.toasts[0]).toContain('no version observer:v9, so observer stays at v6')
  expect((w.events.find(e => e.kind === 'prompts')!.problems as string[]).length).toBe(1)
})


// ------------------------------------------------------------------------------------------------ the order with squeeze

test("a step on Interpretation made while the look runs waits for it, then counts from the level the look gave: one step toward facts only from full meaning is some meaning", async ($, on) => {
  let release = () => {}
  const held = new Promise<void>(r => { release = r })
  const w = world(on, { holdPass: held, squeeze: 'June 18, in a few words.', fork: { line: null, settled: false, verbs: { s: { at: { interpret: 'interpret', familiarity: 'working' } } }, glosses: [] } })
  on('prompt.edit', (_$: unknown, e: { text: string; start: number; end: number; inputText: string }) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
  await turn($, w, w.clock, { id: 't1', prompt: 'why June 18?', answer: 'June 18 had the most saves, because the fixture scope leaked between tests.', tools: 2, save: true })
  await w.clock.settle()
  // the chips open with Interpretation in its middle; < asks for one step toward report before the look has said
  await press($, w.clock, key('s'))
  await press($, w.clock, key('2'))
  await press($, w.clock, key('<'))
  await w.clock.settle()
  expect(w.squeezes.length).toBe(0)
  // the look's pass comes back: the original is at interpret, so the step lands on balanced
  release()
  await w.clock.settle()
  await w.clock.advance(100)
  await w.clock.settle()
  expect(w.squeezes.length).toBe(1)
  expect(w.squeezes[0]).toContain('- Interpretation: some meaning (levels facts only · some meaning · full meaning; the original is at full meaning)')
  const rec = JSON.parse(w.files[MSGPATH]!)
  expect(rec.squeeze.at).toEqual({ interpret: 1 })
  expect(rec.shown).toBe('June 18, in a few words.')
})

test('a step on Length, whose original level is always known, goes at once while the look runs', async ($, on) => {
  let release = () => {}
  const held = new Promise<void>(r => { release = r })
  const w = world(on, { holdPass: held, squeeze: 'June 18.', fork: { line: null, settled: false, verbs: { s: { at: { interpret: 'report', familiarity: 'fluent' } } }, glosses: [] } })
  on('prompt.edit', (_$: unknown, e: { text: string; start: number; end: number; inputText: string }) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
  await turn($, w, w.clock, { id: 't1', prompt: 'why June 18?', answer: 'June 18 had the most saves, because the fixture scope leaked between tests.', tools: 2, save: true })
  await w.clock.settle()
  await press($, w.clock, key('s'))
  await press($, w.clock, key('<'))
  await w.clock.settle()
  expect(w.forks.length).toBe(0)
  expect(w.squeezes.length).toBe(1)
  expect(w.squeezes[0]).toContain('- Length: short')
  expect(w.squeezes[0]).toContain('- Interpretation: as the original')
  release()
  await w.clock.settle()
  // the look's levels came after: the version written stays the one the chips show
  const rec = JSON.parse(w.files[MSGPATH]!)
  expect(rec.squeeze.at).toEqual({ length: 1 })
  expect(Object.keys(rec.squeeze.versions)).toEqual(['length=1'])
  expect(rec.shown).toBe('June 18.')
})

test('a long answer arrives as Claude wrote it, beside the look; a step on Interpretation pressed while the look runs shows where it goes, waits for it, and runs from the level it gave', async ($, on) => {
  let looked = () => {}
  const LONG = Array.from({ length: 44 }, (_, i) => `Run ${i + 1} landed ${i + 3} changes in the swarm.`).join('\n')
  const w = world(on, {
    holdPass: new Promise<void>(r => { looked = r }), squeeze: 'Most runs landed changes.',
    fork: { line: null, settled: false, verbs: { s: { at: { interpret: 'interpret', familiarity: 'working' } } }, glosses: [] },
  })
  on('prompt.edit', (_$: unknown, e: { text: string; start: number; end: number; inputText: string }) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
  await turn($, w, w.clock, { id: 't1', prompt: 'which runs landed changes?', answer: LONG, tools: 2, save: true })
  await w.clock.settle()
  // no rewrite went out as the turn ended
  expect(w.squeezes.length).toBe(0)
  await press($, w.clock, key('s'))
  await press($, w.clock, key('2'))
  await press($, w.clock, key('<'))
  await w.clock.settle()
  // the step waits for the look, and the chips show where it goes
  const mid = JSON.parse(w.files[MSGPATH]!)
  expect(mid.shown).toBe(null)
  expect(mid.squeeze.want).toEqual({ interpret: 0 })
  expect(w.squeezes.length).toBe(0)
  looked()
  await w.clock.settle()
  await w.clock.advance(400)
  await w.clock.settle()
  expect(w.squeezes.length).toBe(1)
  expect(w.squeezes[0]).toContain('- Interpretation: some meaning (levels facts only · some meaning · full meaning; the original is at full meaning)')
  const rec = JSON.parse(w.files[MSGPATH]!)
  expect(rec.squeeze.at).toEqual({ interpret: 1 })
  expect(Object.keys(rec.squeeze.versions)).toEqual(['interpret=1'])
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

test("a session of the background service gets no look until the person's first prompt, and looks as usual after it", async ($, on) => {
  const w = world(on, { env: { CLAUDE_CODE_SESSION_KIND: 'bg' } })
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
  // a turn the service ran with no person at the prompt
  await $.turn.start({ turnId: 't0', text: '' } as never)
  await step($, w, 't0', 0, 2)
  await $.turn.complete({ turnId: 't0', answer: 'Done with the background job.', durationMs: 5, reason: 'answer', isAborted: false } as never)
  await w.clock.advance(100)
  await w.clock.settle()
  expect(w.forks.length).toBe(0)
  // the person's first prompt: the next turn of work gets its look
  await turn($, w, w.clock, { id: 't1', prompt: 'when did they edit most?', answer: 'June 18 had the most saves.', tools: 2, save: true })
  await w.clock.settle()
  expect(w.forks.length).toBe(1)
})

// ------------------------------------------------------------------------------------------------ the queue

test('messages that come while a look runs wait in the queue and are read in one look that names each; two looks never run at once', async ($, on) => {
  let release = () => {}
  const held = new Promise<void>(r => { release = r })
  const w = world(on, { holdPass: held, fork: { verbs: {}, glosses: [] } })
  // the first answer: its look starts and is held
  await turn($, w, w.clock, { id: 't1', prompt: 'when did they edit most?', answer: 'June 18 had the most saves.', tools: 2 })
  await w.clock.settle()
  // a background task's report starts a turn of its own, and its answer comes while the look still runs; then another
  await $.prompt.submit({ text: '<task-notification>the count of reverts finished</task-notification>', origin: { kind: 'task-notification' } } as never)
  await $.turn.start({ turnId: 't2', text: 'report' } as never)
  await step($, w, 't2', 0, 1)
  await $.turn.complete({ turnId: 't2', answer: 'The reverts came in, 212 of the 6,543.', durationMs: 5, reason: 'answer', isAborted: false } as never)
  await w.clock.advance(100)
  await turn($, w, w.clock, { id: 't3', prompt: 'and the day after?', answer: 'June 19 had 1,204 saves.', tools: 1 })
  await w.clock.settle()
  expect(w.forks.length).toBe(0)
  release()
  await w.clock.settle()
  await w.clock.advance(100)
  await w.clock.settle()
  // two looks: the first answer's, then one over both answers that waited, in order
  expect(w.forks.length).toBe(2)
  expect(w.conc.most).toBe(1)
  expect(w.forks[0]).toContain('Read this message of Claude\'s, above in the session: Claude\'s answer at the end of turn 1, which begins "June 18 had the most saves."')
  expect(w.forks[1]).toContain('Read these 2 messages of Claude\'s, above in the session, in order.')
  expect(w.forks[1]).toContain('1. Claude\'s answer at the end of turn 2, which begins "The reverts came in, 212 of the 6,543." (1 line). It answers a report the session got')
  expect(w.forks[1]).toContain('2. Claude\'s answer at the end of turn 3, which begins "June 19 had 1,204 saves." (1 line). It answers the analyst\'s message "and the day after?"')
  const looks = JSON.parse(w.files[OBS]!).log.filter((r: Json) => r.kind === 'look')
  expect(looks.map((r: Json) => (r.messages as Json[]).length)).toEqual([1, 2])
})

test('words Claude writes to the person before it goes on working are a message of their own: queued when the turn takes its next step, and read before the answer', async ($, on) => {
  const w = world(on, { fork: { verbs: {}, glosses: [] } })
  const MID = 'aaaaaaaa-bbbb-cccc-dddd-000000000001'
  const LONG = `So far: ${Array.from({ length: 30 }, (_, i) => `agent ${i + 1} made ${i * 7} edits`).join(', ')}. I will check the reverts next.`
  await $.prompt.submit({ text: 'who edited most?', origin: { kind: 'composer' } } as never)
  await $.turn.start({ turnId: 't1', text: 'who edited most?' } as never)
  await step($, w, 't1', 0, 1)
  await $.session.append({ door: 'response', uuid: MID, origin: { kind: 'model', model: 'm' }, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: LONG }] } } as never)
  // a short line before a tool is no message to read
  await step($, w, 't1', 1, 1)
  await w.clock.advance(100)
  await w.clock.settle()
  expect(w.forks.length).toBe(1)
  expect(w.forks[0]).toContain('Words Claude wrote to the analyst in the middle of turn 1, before it went on working, which begin "So far: agent 1 made 0 edits')
  await $.session.append({ door: 'response', uuid: ROW, origin: { kind: 'model', model: 'm' }, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'Agent 30 edited most.' }] } } as never)
  await $.turn.complete({ turnId: 't1', answer: 'Agent 30 edited most.', durationMs: 5, reason: 'answer', isAborted: false } as never)
  await w.clock.advance(100)
  await w.clock.settle()
  expect(w.forks.length).toBe(2)
  expect(w.forks[1]).toContain('Claude\'s answer at the end of turn 1, which begins "Agent 30 edited most."')
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
  expect(w.toasts).toEqual(["thimble's observer could not read Claude's last message: the API is overloaded."])
})

test('THIMBLE_OBSERVER_SHADOW runs another frame version on the same look, measured and never merged', async ($, on) => {
  const w = world(on, { env: { THIMBLE_OBSERVER_SHADOW: 'v4-low' }, fork: { verbs: { v: { note: '1 view ready', proposals: ['saves per day'] } }, glosses: [] } })
  await turn($, w, w.clock, { id: 't1', prompt: 'when did they edit most?', answer: 'June 18 had the most saves.', tools: 2, save: true })
  await w.clock.settle()
  await w.clock.advance(100)
  await w.clock.settle()
  // the look's fork and the shadow's completion (the earlier pass: its frame as the system prompt, low effort)
  expect(w.forks.length).toBe(2)
  expect(w.efforts).toEqual(['low'])
  const log = JSON.parse(w.files[OBS]!).log
  expect(log.find((r: Json) => r.kind === 'shadow')).toMatchObject({ version: 'v4-low' })
  expect(w.events.filter(e => e.kind === 'call' && e.feature === 'observer').map(e => e.shadow ?? null).sort()).toEqual([null, 'observer:v4-low'].sort())
  // only the look's part is merged: v lit once, by the look
  expect(log.filter((r: Json) => r.kind === 'look').map((r: Json) => r.verbs_lit)).toEqual([['v']])
})

