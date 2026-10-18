// The observer's hooks (observer/observer.ts): one look after a turn of work, or a turn that states a decision; its
// notes reach Claude beside the next prompt and never the person; its line shows above the prompt only when it names
// a decision and no turn runs; it lights the verbs of the answer's row and places its glosses, a gloss never twice and
// fewer when nobody opens them; a line the session settled closes.
// `claude plugin test lean`. The model's calls and the Node children are answered here.
import { expect, mock, test } from 'claude-code/testing'

import { slim } from '../observer/evidence.js'
import { glossSkipsFor, skipsFor } from '../observer/observer'

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
const VERBS = [
  { key: 's', name: 'squeeze', line: 'shorter', phrase: null, picked: false },
  { key: 'x', name: 'explore', line: 'a view to explore', phrase: 'explore 1 day', picked: true },
  { key: 't', name: 'trace', line: 'where it came from', phrase: 'where these numbers come from', picked: true },
]
const USAGE = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 }
const NOW = Date.parse('2026-10-18T09:00:00Z')
const ROW = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const OBS = '/home/t/.thimble/lean/observer/s-1.json'

type Json = Record<string, unknown>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** The session around the observer: one object on disk, the Node children, the model's two calls (answered by
 *  `question` and `fork`), the prompt and the band. */
function world(on: Any, o: { question?: Json; fork?: Json | (() => Json) } = {}) {
  mock.env(on, { THIMBLE_HOME: '/home/t/.thimble' })
  mock.store(on)
  on('session.cwd', () => ({ value: ROOT }))
  on('session.id', () => ({ value: 's-1' }))
  on('session.messages', () => ({ value: [] }))
  const files: Record<string, string> = { [`${DIR}/01-saves.json`]: JSON.stringify(OBJECT) }
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: e.path in files || e.path === DIR || e.path.endsWith('.md') }))
  on('fs.list', (_$: unknown, e: { path?: string }) => ({ value: e.path === DIR ? Object.keys(files).filter(f => f.startsWith(DIR + '/')).map(f => ({ name: f.slice(DIR.length + 1), kind: 'file', size: 1, mtimeMs: 0, isLink: false })) : [] }))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: e.path.endsWith('observer.md') ? 'OBSERVER {{QUESTION}} | {{DECISION}} | {{OBJECTS}} | {{COVERAGE}} | {{NOTES}} | {{OPEN}} {{LINE_RULE}} | {{GLOSSED}}' : e.path.endsWith('question.md') ? 'QUESTION {{QUESTION}} {{ANSWER}}' : files[e.path] ?? '' }))
  on('fs.write', (_$: unknown, e: { path: string; content?: string; text?: string; data?: string }) => {
    files[e.path] = String(e.content ?? e.text ?? e.data ?? '')
    return { value: undefined }
  })
  const runs: string[][] = []
  on('process.run', (_$: unknown, e: { argv: string[] }) => {
    runs.push([...e.argv])
    let out = '{}'
    if (e.argv.some(a => a.endsWith('prep.mjs'))) out = JSON.stringify({ drawing: DRAWING, verbs: VERBS, problems: [] })
    else if (e.argv.includes('coverage')) out = 'Coverage of this session · 4 source files\nNot read: 1 file (9 rows): events.jsonl'
    else if (e.argv.some(a => a.endsWith('objects.mjs'))) out = JSON.stringify(Object.entries(files).filter(([k]) => k.startsWith(DIR + '/')).map(([, v]) => slim(JSON.parse(v))).filter(o => o && o.session === e.argv.at(-1)))
    return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const forks: string[] = []
  const questions: string[] = []
  on('model.complete', (_$: unknown, e: { prompt: string }) => {
    questions.push(String(e.prompt))
    return { value: { isAnswered: true, text: JSON.stringify(o.question ?? { parts: [], drift: null, decision: null }), usage: USAGE } }
  })
  on('model.fork', (_$: unknown, e: { prompt: string }) => {
    forks.push(String(e.prompt))
    const out = typeof o.fork === 'function' ? o.fork() : o.fork ?? { notes: [], line: null, settled: false, hints: {} }
    return { value: { isAnswered: true, text: JSON.stringify(out), usage: USAGE } }
  })
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
    return { result: 'saved 01-saves v1: thimble/objects/01-saves.json\n' }
  })
  return { files, runs, forks, questions, submitted, filled, at, clock }
}

// every string a drawn tree holds, in order
function textOf(n: Any): string {
  if (n == null || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  return textOf(n.props?.children) + textOf(n.children) + (typeof n.props?.label === 'string' && !n.props?.children ? n.props.label : '')
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
    await $.tool.call({ tool: 'Bash', command: 'lean save saves' } as never)
    await $.session.append({ door: 'response', uuid: ROW, origin: { kind: 'model', model: 'm' }, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: o.answer }] } } as never)
  }
  await $.turn.complete({ turnId: o.id, answer: o.answer, durationMs: 5, reason: 'answer', isAborted: false } as never)
  await clock.advance(100)
}

const reply = ($: Any) => $.ui.render({ component: 'AssistantMessage', surface: 'terminal', requestId: ROW, props: { text: 'June 18.', isFirstOfReply: true }, viewport: { columns: 120, rows: 40, isFullscreen: true } } as never)
const BAND = { plugin: 'thimble-lean', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 100, scroll: { offset: 0, bodyRows: 12 }, view: {} }, viewport: { columns: 100, rows: 40, isFullscreen: true } } as never

test('after a turn that saved an object: one look reads its lineage; its note reaches Claude with the next prompt, and it lights the verbs of the answer', async ($, on) => {
  const w = world(on, { fork: {
    notes: [{ note: 'The 6,543 counts every save of Jun 18, reverts too; say so.', rests_on: 'tally(df, "day")' }],
    line: null, settled: false,
    verbs: { v: { note: '2 views ready', proposals: ['saves by day', 'saves by wiki'] }, s: { lit: false } },
    glosses: [],
  } })
  const clock = w.clock
  await turn($, w, clock, { id: 't1', prompt: 'when did they edit most?', answer: 'June 18 had the most saves.', tools: 2, save: true })
  // one question step and one fork; the fork read the object's lineage, the verbs and the session's coverage
  expect(w.questions.length).toBe(1)
  expect(w.forks.length).toBe(1)
  expect(w.forks[0]).toContain('Object 01-saves v1 "Saves per day" (saved since the last look)')
  expect(w.forks[0]).toContain('"6,543" = 6,543 (q1#day=2026-06-18@n): rests on 4 rows of revisions.jsonl')
  expect(w.forks[0]).not.toContain('t trace: where it came from')
  expect(w.forks[0]).toContain('as the person sees it under the reply:\n    Jun 18 6,543')
  expect(w.forks[0]).toContain('Not read: 1 file (9 rows): events.jsonl')
  expect(w.runs.some(a => a.includes('coverage'))).toBe(true)
  // the verb row under the answer: v lit with its note, s dim
  await clock.settle()
  const drawn = textOf(await reply($))
  await clock.settle()
  const row = textOf(await reply($))
  expect(row).toContain('● 2 views ready')
  // s dim: its key alone
  expect(row).toContain('  s')
  expect(row).not.toContain('s ●')
  expect(drawn.length).toBeGreaterThan(0)
  expect(JSON.parse(w.files[`${ROOT}/thimble/messages/s-1/${ROW.slice(0, 24)}.json`]!).verbs.v.proposals).toEqual(['saves by day', 'saves by wiki'])
  // the note: for Claude alone, with the next prompt, once
  await $.prompt.submit({ text: 'and the busiest month?', origin: { kind: 'composer' } } as never)
  const ctx = w.submitted.at(-1)!.context.join('\n')
  expect(ctx).toContain('The 6,543 counts every save of Jun 18, reverts too; say so.')
  expect(ctx).toContain('Do not mention the side agent')
  await $.prompt.submit({ text: 'ok', origin: { kind: 'composer' } } as never)
  expect(w.submitted.at(-1)!.context.join('\n')).not.toContain('6,543 counts')
  // nothing showed above the prompt
  expect(textOf(await $.ui.render(BAND))).not.toContain('Heads up')
  // the session's file keeps what it lit, for measuring
  expect(JSON.parse(w.files[OBS]!).log.find((r: { kind: string }) => r.kind === 'look').verbs_lit).toEqual(['v'])
})

test('a short turn that states a decision gets a look; its line names the decision and shows above the prompt; Send to main fills the prompt', async ($, on) => {
  const w = world(on, {
    question: { parts: [], drift: null, decision: 'tell my manager the edits were biased' },
    fork: { notes: [], settled: false, hints: {}, line: { decision: 'tell my manager', line: 'Before you tell your manager: only 18% of saves carry an OpenAI name, not most.', title: 'Most is 18%', explanation: '- q4 counts 2,678 of 14,591.\n- Check: q4.' } },
  })
  const clock = w.clock
  await turn($, w, clock, { id: 't1', prompt: "I'm going to tell my manager that most edits came from OpenAI agents. Anything to fix?", answer: 'Fix the share.', tools: 0 })
  expect(w.forks.length).toBe(1)
  expect(w.forks[0]).toContain('tell my manager the edits were biased')
  const ui = await $.ui.mount(BAND)
  await clock.settle()
  const band = textOf(await ui.drawn())
  expect(band).toContain('Heads up')
  expect(band).toContain('only 18% of saves carry an OpenAI name')
  for (const k of ['Learn more', 'Know this already', 'Send to main', 'Not now']) expect(band).toContain(k)
  await ui.press({ key: 'send' })
  await clock.settle()
  expect(w.filled.length).toBe(1)
  expect(w.filled[0]).toContain('Here is a note offered by a side agent:')
  expect(w.filled[0]).toContain('only 18% of saves')
  expect(textOf(await ui.drawn())).not.toContain('Heads up')
  await ui.unmount()
})

test('a short turn with no tool, no decision and no drift gets no look', async ($, on) => {
  const w = world(on)
  const clock = w.clock
  await turn($, w, clock, { id: 't1', prompt: 'thanks', answer: 'You are welcome.', tools: 0 })
  expect(w.questions.length).toBe(1)
  expect(w.forks.length).toBe(0)
})

test('a line that names no decision goes to Claude as a note; a line the person saw is not shown again', async ($, on) => {
  const line = { decision: '', line: 'The busiest month is June by saves, May by pages.', title: 'Two busiest months', explanation: '' }
  const w = world(on, { fork: { notes: [], settled: false, hints: {}, line } })
  const clock = w.clock
  await turn($, w, clock, { id: 't1', prompt: 'busiest month?', answer: 'June.', tools: 1 })
  expect(textOf(await $.ui.render(BAND))).not.toContain('Heads up')
  await $.prompt.submit({ text: 'next', origin: { kind: 'composer' } } as never)
  expect(w.submitted.at(-1)!.context.join('\n')).toContain('The busiest month is June by saves, May by pages.')
  const log = JSON.parse(w.files[OBS]!).log
  expect(log.find((r: Json) => r.kind === 'look').line_dropped.why).toBe('it names no decision')
})

test('a line the session settled closes at the next look, and does not count as typed past', async ($, on) => {
  let n = 0
  const line = { decision: 'send the summary', line: 'Before you send the summary: the 39% is of link edits only.', title: 'A share of link edits', explanation: '- x' }
  const w = world(on, {
    question: { parts: [], drift: null, decision: 'send the summary' },
    fork: () => (++n === 1 ? { notes: [], settled: false, hints: {}, line } : { notes: [], settled: true, hints: {}, line: null }),
  })
  const clock = w.clock
  await turn($, w, clock, { id: 't1', prompt: 'I will send this summary', answer: 'Here.', tools: 1 })
  expect(textOf(await $.ui.render(BAND))).toContain('the 39% is of link edits only')
  // the next look is told the line is open, and finds it settled: it closes
  await turn($, w, clock, { id: 't2', prompt: 'fix the share', answer: 'The 39% is of link edits; 18% of all.', tools: 1 })
  expect(w.forks[1]).toContain('"Before you send the summary: the 39% is of link edits only." (shown 1 prompt ago)')
  expect(w.forks[1]).toContain('Give no new line this time')
  expect(textOf(await $.ui.render(BAND))).not.toContain('39%')
  const log = JSON.parse(w.files[OBS]!).log
  expect(log.some((r: Json) => r.settled)).toBe(true)
  expect(log.some((r: Json) => r.key === 'typed_past')).toBe(false)
})

test('an unanswered line clears at the second prompt after it showed, and lines typed past in a row back off', async ($, on) => {
  const line = { decision: 'send the summary', line: 'Before you send the summary: the 39% is of link edits only.', title: 'A share of link edits', explanation: '- x' }
  const w = world(on, { question: { parts: [], drift: null, decision: 'send the summary' }, fork: { notes: [], settled: false, hints: {}, line } })
  const clock = w.clock
  await turn($, w, clock, { id: 't1', prompt: 'I will send this summary', answer: 'Here.', tools: 1 })
  await $.prompt.submit({ text: 'one', origin: { kind: 'composer' } } as never)
  expect(textOf(await $.ui.render(BAND))).toContain('39%')
  await $.prompt.submit({ text: 'two', origin: { kind: 'composer' } } as never)
  expect(textOf(await $.ui.render(BAND))).not.toContain('39%')
  const log = JSON.parse(w.files[OBS]!).log
  expect(log.find((r: Json) => r.key === 'typed_past').typed_past_in_a_row).toBe(1)
  expect([1, 2, 3, 4, 5, 9].map(skipsFor)).toEqual([0, 0, 1, 2, 4, 16])
})

test('a look that ends while a new turn runs: no line mid-turn (its finding goes to Claude), and its verbs light the answer it looked at', async ($, on) => {
  const line = { decision: 'share it', line: 'Before you share it: the 6,543 counts reverts.', title: 'Reverts counted', explanation: '- x' }
  const w = world(on, { question: { parts: [], drift: null, decision: 'share it' }, fork: { notes: [], settled: false, line, verbs: { v: { note: 'saves by day', proposals: ['saves by day'] } } } })
  const clock = w.clock
  // the turn ends; before its look runs, the person starts another turn
  await $.prompt.submit({ text: 'I will share it', origin: { kind: 'composer' } } as never)
  await $.turn.start({ turnId: 't1', text: 'I will share it' } as never)
  await step($, w, 't1', 0, 1)
  await $.tool.call({ tool: 'Bash', command: 'lean save saves' } as never)
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
  expect(textOf(await reply($))).toContain('● saves by day')
  // the line's finding waits for Claude's next prompt
  await $.turn.complete({ turnId: 't2', answer: 'More.', durationMs: 5, reason: 'answer', isAborted: false } as never)
  await clock.advance(100)
  await $.prompt.submit({ text: 'ok', origin: { kind: 'composer' } } as never)
  expect(w.submitted.at(-1)!.context.join('\n')).toContain('Before you share it: the 6,543 counts reverts.')
})

test('/observe off: no look, no note; /observe says what it did', async ($, on) => {
  const w = world(on, { fork: { notes: [{ note: 'a note' }], line: null, settled: false, hints: {} } })
  const clock = w.clock
  await turn($, w, clock, { id: 't1', prompt: 'q', answer: 'a', tools: 1 })
  expect(String((await $.command.run({ command: 'observe', args: '' } as never)).text)).toContain('1 look, 1 note to Claude, 0 lines shown')
  await $.command.run({ command: 'observe', args: 'off' } as never)
  await turn($, w, clock, { id: 't2', prompt: 'q2', answer: 'a2', tools: 1 })
  expect(w.forks.length).toBe(1)
  expect(w.submitted.at(-1)!.context.join('\n')).not.toContain('a note')
})

test('a reload mid-session keeps the notes not yet delivered: they reach Claude with the next prompt', async ($, on) => {
  const w = world(on)
  w.files[OBS] = JSON.stringify({ hints: {}, notesGiven: ['The 412 counts all months.'], log: [
    { kind: 'look', question: 'which region?', notes_added: [{ from: 'observer', note: 'The 412 counts all months.' }] },
  ] })
  await $.prompt.submit({ text: 'and March?', origin: { kind: 'composer' } } as never)
  expect(w.submitted.at(-1)!.context.join('\n')).toContain('The 412 counts all months.')
  await $.prompt.submit({ text: 'ok', origin: { kind: 'composer' } } as never)
  expect(w.submitted.at(-1)!.context.join('\n')).not.toContain('412')
})

// ------------------------------------------------------------------------------------------------ glosses

const GLOSS = { term: 'fixture scope', body: 'How long pytest keeps one fixture object.', here: 'In run 7, [conftest.py:14](tests/conftest.py#L14) set it to "module".', program: "return k.text('**module** {dim:one cart per file}')" }
const ANSWER = 'June 18 had the most saves, because the `fixture scope` was module.'
const MSGPATH = `${ROOT}/thimble/messages/s-1/${ROW.slice(0, 24)}.json`
const HINT = { plugin: 'thimble-lean', component: 'PromptHint', surface: 'terminal', requestId: 'hint', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' }, viewport: { columns: 120, rows: 40, isFullscreen: true } } as never
const BAND2 = { ...(BAND as object), props: { hasSurvey: false, isWorking: false, maxRows: 16, bodyColumns: 110, scroll: { offset: 0, bodyRows: 16 }, view: {} }, viewport: { columns: 120, rows: 40, isFullscreen: true } } as never
const key = (k: string, text = '') => ({ origin: { kind: 'composer' }, key: { key: k }, text, cursor: 0, start: 0, end: 0, inputText: k.length === 1 ? k : '' }) as never

test('a gloss is placed by its term in the answer, with a teal fill; its card says what it is and where it mattered, and a citation in it opens over it', async ($, on) => {
  const w = world(on, { fork: { notes: [], line: null, settled: false, verbs: {}, glosses: [GLOSS, { term: 'not in the answer', body: 'x' }] } })
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
  await ($ as Any).prompt.edit(key(']'))
  await w.clock.settle()
  textOf(await $.ui.render(BAND2))
  await w.clock.settle()
  const card = textOf(await $.ui.render(BAND2))
  expect(card).toContain('fixture scope')
  // the person reads the mark's kind by its teal frame; 1 asks, and the cite inside the card has the next digit, as
  // the hint line under the prompt says
  expect(card).not.toContain('gloss')
  expect(JSON.stringify(await $.ui.render(BAND2))).toContain('"color":"#62d2c6"')
  expect(textOf(await $.ui.render(HINT))).toBe('1 ask · 2 open · ] [ next mark · 0 close')
  // 2 opens the citation in it, over it; 0 comes back
  await ($ as Any).prompt.edit(key('2'))
  expect(textOf(await $.ui.render(BAND2))).toContain('conftest.py:14')
  expect(textOf(await $.ui.render(HINT))).toContain('0 back')
  await ($ as Any).prompt.edit(key('0'))
  expect(textOf(await $.ui.render(BAND2))).toContain('fixture scope')
})

test('a term the person saw explained is never glossed again; glosses nobody opens back off', async ($, on) => {
  const w = world(on, { fork: () => ({ notes: [], line: null, settled: false, verbs: {}, glosses: [GLOSS] }) })
  await turn($, w, w.clock, { id: 't1', prompt: 'why June 18?', answer: ANSWER, tools: 2, save: true })
  expect(Object.keys(JSON.parse(w.files[MSGPATH]!).glosses)).toEqual(['g1'])
  // the next look is told the term, and a repeat is dropped
  await turn($, w, w.clock, { id: 't2', prompt: 'and June 19?', answer: ANSWER, tools: 2, save: true })
  expect(w.forks[1]).toContain('| - fixture scope')
  expect(JSON.parse(w.files[MSGPATH]!).glosses).toEqual({})
  // looks whose glosses nobody opened: after two, the next looks are told to give none
  expect([1, 2, 3, 4, 5, 9].map(glossSkipsFor)).toEqual([0, 0, 1, 2, 4, 8])
})
