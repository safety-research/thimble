// The feature tour (tour/tour.ts, skills/tour/SKILL.md): /thimble:tour or Claude's Skill call starts it. thimble
// places its intro, and the sample answer draws the step row at its end; thimble draws both itself and sends Claude no
// prompt. Each step done redraws the row in place. A tour started again keeps the earlier tour's rows. A step done early, a step whose feature is off and the selection step where no
// click reaches thimble are left out; v that drew no card lets the tour go on, and leaves out ask. Step e names its
// words in bold; while cite waits, the sample answer marks the wrong number. After the sample answer, the replies to the
// person's own prompts answer nothing, so s acts on the sample answer, and the step row is placed under the reply; a
// fork's end moves nothing. After an install inside Claude Code, the
// person's /reload-plugins runs /thimble:tour once in that session, soon after the install only. All data is made up. `claude plugin test plugin`.
import { expect, mock } from 'claude-code/testing'

import { remindAfterAnswer } from '../bar/hints'
import { failLineNow } from '../bar/notice'
import { noteViewport } from '../cards/draw'
import { answersNothing } from '../core/answers'
import { setOptions } from '../settings/features.mjs'
import { NEXT_MS, placeIntro, stepRowEl, tourDid, tourMissed, tourNow, tourOpened, tourRuns, tourSpans, tourStart, turnTour, type TourState } from '../tour/tour'
import { test } from './kit'
import { promptStub, tempRun } from './stubs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** A made-up engine with what the tour reads: the session's state, the environment, the clock, and the rows it places. */
function fake() {
  const state = new Map<string, unknown>()
  const placed: string[] = []
  const $: Any = {
    state: {
      get: async (k: Any) => ({ value: state.get(JSON.stringify(k)), version: 0 }),
      set: async (k: Any, v: unknown) => { state.set(JSON.stringify(k), v); return { isSet: true, version: 1 } },
    },
    env: { get: async () => undefined },
    clock: { now: async () => 0 },
    config: { list: async () => [] },
    ui: { invalidate: () => undefined, place: async (a: Any) => { placed.push(a.id); return { isPlaced: true, requestId: a.id } } },
  }
  return { $, placed }
}

/** The steps the tour waited for, in order, as each step is done. */
async function walk($: Any, steps: Any[]): Promise<string[]> {
  const at: string[] = []
  for (const s of steps) {
    await tourDid($, s)
    at.push((await tourNow($))?.at ?? 'end')
  }
  return at
}

test('each step done moves the tour to the next step that is on and not done; the intro is placed once per start', async () => {
  setOptions({})
  noteViewport({ isFullscreen: true })
  const { $, placed } = fake()
  await tourDid($, 'v')
  expect(await tourRuns($)).toBe(false)
  await tourStart($)
  await placeIntro($)
  // the command and the skill both start it: one start, one intro
  await tourStart($)
  await placeIntro($)
  expect(placed).toEqual(['tour-intro-1'])
  expect(await walk($, ['answer', 'e', 'e', 'v', 'ask', 's', 'cite'])).toEqual(['e', 'v', 'v', 'ask', 's', 'cite', 'end'])
  expect(await tourRuns($)).toBe(false)
  // a step done early is left out when its turn comes
  const b = fake()
  await tourStart(b.$)
  expect(await walk(b.$, ['answer', 's', 'v', 'e'])).toEqual(['e', 'e', 'e', 'ask'])
  // v that drew no card goes on, only while v waits
  await tourMissed(b.$, 'v')
  expect((await tourNow(b.$))?.at).toBe('ask')
  expect(await walk(b.$, ['ask', 'cite'])).toEqual(['cite', 'end'])
  // while v waits, v that drew no card goes on past ask, which has no card to ask about
  const c = fake()
  await tourStart(c.$)
  expect(await walk(c.$, ['answer', 'e'])).toEqual(['e', 'v'])
  await tourMissed(c.$, 'v')
  expect((await tourNow(c.$))?.at).toBe('s')
  expect((await tourNow(c.$))?.missed).toEqual(['v'])
})

test('where no click reaches thimble the selection step is left out; a feature that is off is left out', async () => {
  setOptions({})
  noteViewport({ isFullscreen: false })
  const { $ } = fake()
  await tourStart($)
  expect(await walk($, ['answer'])).toEqual(['v'])
  noteViewport({ isFullscreen: true })
  setOptions({ squeezeAnswers: false })
  const b = fake()
  await tourStart(b.$)
  expect(await walk(b.$, ['answer', 'e', 'v', 'ask', 'cite'])).toEqual(['e', 'v', 'ask', 'cite', 'end'])
  // with Cards off, v draws no card, so ask is left out too
  setOptions({ cards: 'off' })
  const c = fake()
  await tourStart(c.$)
  expect(await walk(c.$, ['answer', 'e', 's'])).toEqual(['e', 's', 'cite'])
  setOptions({})
})

test('while e waits the sample answer marks nothing; while cite waits it marks the refunds citation, which alone is the step, then nothing', async () => {
  setOptions({})
  noteViewport({ isFullscreen: true })
  const { $ } = fake()
  const text = 'That is an average order value of [$52](#). The shop refunded [7 orders](#). Most arrived on time.'
  await tourStart($)
  await $.state.set({ plugin: 'thimble', key: 'tourSample' }, 'row-sample')
  await tourDid($, 'answer')
  const words = (s: Any[]) => s.map(x => text.slice(x.start, x.end))
  expect((await tourNow($))?.at).toBe('e')
  expect(await tourSpans($, 'row-sample', text)).toEqual([])
  await walk($, ['e', 'v', 'ask', 's'])
  expect(words(await tourSpans($, 'row-sample', text))).toEqual(['[7 orders](#)'])
  // another row is not marked
  expect(await tourSpans($, 'row-other', text)).toEqual([])
  // the refunds citation is the second of the answer: opening the first, or one of another answer, is not the step. A
  // click on it in the simpler version opens it by the sample's row and its number there (squeeze/ui.ts), as here
  await $.state.set({ plugin: 'thimble', key: 'answerMsg', id: 'row-sample' }, { row: 'row-sample', turnId: 't1', text, at: 0 })
  await tourOpened($, 'row-sample', 1)
  await tourOpened($, 'row-other', 2)
  expect((await tourNow($))?.at).toBe('cite')
  await tourOpened($, 'row-sample', 2)
  expect(await tourRuns($)).toBe(false)
  expect(await tourSpans($, 'row-sample', text)).toEqual([])
})

/** Elements as plain objects, for reading what the step row draws. */
const els: Any = new Proxy({}, { get: (_t, type: string) => (props: Any) => ({ type, props }) })
const nodes = (n: Any, out: Any[] = []): Any[] => {
  if (!n || typeof n !== 'object') return out
  if (Array.isArray(n)) { n.forEach(x => nodes(x, out)); return out }
  out.push(n)
  nodes(n.props?.children, out)
  return out
}

test('the step row counts the steps it shows, names the words of e in bold and its keys in color, and words ask with and without clicks', () => {
  setOptions({})
  const at = (step: Any, done: Any[], missed: Any[] = []): TourState => ({ at: step, done, missed, startedAt: 0, k: 1, intro: null, sample: 'row-sample', moved: null })
  const row = (t: TourState, clicks = true) => stepRowEl(els, t, clicks, 100)
  // e waits: its words bold, in the default color; its key in thimble's color; the line itself not bold
  const e = row(at('e', ['answer']))
  expect(textOf(e)).toContain('thimble tour · 1 of 5')
  expect(textOf(e)).toContain('› Select average order value in the answer with the mouse, then press e.')
  const bold = nodes(e).find(n => n.type === 'Text' && n.props?.children === 'average order value')
  expect(bold?.props).toMatchObject({ bold: true })
  expect(bold?.props?.color).toBeUndefined()
  expect(nodes(e).find(n => n.type === 'Text' && n.props?.children === 'e')?.props).toMatchObject({ bold: true })
  expect(nodes(e).find(n => n.props?.key === 'a-e')?.props?.bold).toBeUndefined()
  // v waits: 2 of 5
  expect(textOf(row(at('v', ['answer', 'e'])))).toContain('thimble tour · 2 of 5')
  // ask, with clicks and without (no e then, so 2 of 4)
  const ask = textOf(row(at('ask', ['answer', 'e', 'v'])))
  expect(ask).toContain('thimble tour · 3 of 5')
  expect(ask).toContain('✓ v drew a card.')
  expect(ask).toContain('› Click ask at the top right of the card, type a question about it, and press Enter.')
  const keys = textOf(row(at('ask', ['answer', 'v']), false))
  expect(keys).toContain('thimble tour · 2 of 4')
  expect(keys).toContain('› Press ] until it reaches the card, press a, type a question about it, and press Enter.')
  // cite, last: where the answer is, with clicks; ] without
  const cite = textOf(row(at('cite', ['answer', 'e', 'v', 'ask', 's'])))
  expect(cite).toContain('thimble tour · 5 of 5')
  expect(cite).toContain('✓ You asked a side thread about the card.')
  expect(cite).toContain('› One number was wrong on purpose. Scroll up to the tea shop answer and click the highlighted number.')
  expect(textOf(row(at('cite', ['answer', 'v', 'ask', 's']), false))).toContain('› One number was wrong on purpose. Press ] until the tray above the prompt shows the highlighted number.')
  // v that drew no card: ask is not shown
  const missed = textOf(row(at('s', ['answer', 'e', 'v'], ['v'])))
  expect(missed).toContain('thimble tour · 3 of 4')
  expect(missed).toContain('✓ v drew no card this time.')
  expect(missed).not.toContain('side thread')
})

test('no reminder shows while the tour runs; answers are held after the sample answer; a /clear ends the tour', async () => {
  setOptions({ explain: 'on demand' })
  const { $ } = fake()
  $.clock.after = () => ({ cancel() {} })
  await tourStart($)
  await remindAfterAnswer($)
  expect(await failLineNow($)).toBeNull()
  expect(await answersNothing($, 't-mine')).toBe(false)
  await tourDid($, 'answer')
  expect(await answersNothing($, 't-mine')).toBe(true)
  await turnTour($)
  expect(await tourRuns($)).toBe(false)
  expect(await answersNothing($, 't-mine')).toBe(false)
  await remindAfterAnswer($)
  expect((await failLineNow($))?.text).toContain('press e')
  setOptions({})
})

const NO_FILES = (on: Any, files: Record<string, string> = {}) => {
  mock.env(on, { THIMBLE_HOME: '/made-up/.thimble', HOME: '/made-up/home', TMPDIR: '/made-up/tmp', PATH: '/usr/bin' })
  on('session.id', () => ({ value: 's-tour' }))
  on('session.cwd', () => ({ value: '/made-up/data' }))
  on('session.root', () => ({ value: '/made-up/data' }))
  on('session.messages', () => ({ value: [] }))
  on('fs.read', (_$: unknown, e: { path: string }) => (e.path in files ? { value: files[e.path] } : { value: promptStub(e.path) ?? '' }))
  on('fs.write', (_$: unknown, e: { path: string; text: string }) => { files[e.path] = e.text; return { value: undefined } })
  on('fs.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('fs.stat', () => ({ value: { kind: 'missing', size: 0 } }))
  on('env.set', () => ({ value: {} }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.scroll', () => ({ value: undefined }))
  on('prompt.change', (_$: unknown, e: Any) => ({ text: e.text, cursor: e.cursor }))
  on('model.fork', () => ({ value: { isAnswered: true, text: '{}' } }))
  on('process.run', (_$: unknown, e: { argv: string[] }) => ({ value: { ...(tempRun(e.argv) ?? { exitCode: 0, stdout: '', stderr: '' }), isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }) as never)
  on('turn.start', (_$: unknown, e: Any) => ({ turnId: e.turnId }))
  on('turn.complete', (_$: unknown, e: Any) => ({ text: e.answer }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the engine'] }) as never)
}

const SAMPLE = 'Customers placed [36 orders](#) in March 2026. The shop refunded [7 orders](#). Most of the refunded orders arrived on time, so late delivery does not explain the refunds.'

function textOf(n: Any): string {
  if (n == null || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  return textOf(n.props?.children) + textOf(n.children)
}

/** A session where the tour runs through the whole hooks module: the prompts that reach Claude, the rows placed,
 *  Simplify's calls, and a turn of main's. */
async function session($: Any, on: Any, files: Record<string, string> = {}) {
  NO_FILES(on, files)
  const clock = mock.clock(on, { now: 0 })
  const got: { text: string; by: string }[] = []
  const placed: string[] = []
  const ran: Any[] = []
  const asked: Any[] = []
  on('prompt.submit', (_$: unknown, e: Any) => { got.push({ text: String(e.text), by: String(e.origin?.kind ?? '') }); return { text: e.text } })
  on('prompt.edit', (_$: unknown, e: Any) => ({ text: e.text, cursor: e.cursor }))
  on('prompt.fill', () => ({ isFilled: true }) as never)
  on('ui.place', (_$: unknown, e: Any) => { placed.push(e.id); return { value: { isPlaced: true, requestId: `r-${e.id}` } } })
  on('command.run', (_$: unknown, e: Any) => { ran.push(e); return {} as never })
  on('model.complete', async (_$: unknown, e: Any) => { asked.push(e); return { value: { isAnswered: true, text: '<text>\nThe shop refunded a few orders.\n</text>', usage: {} } } })
  on('tool.call', (_$: unknown, e: Any) => ({ result: `ran ${e.tool}` }))
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
  const turn = async (id: string, text: string, answer: string, during?: () => Promise<unknown>) => {
    await $.turn.start({ text, turnId: id } as never)
    if (during) await during()
    await $.session.append({ message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: answer }] }, door: 'response', origin: { kind: 'model', model: 'claude-made-up' }, uuid: `row-${id}` } as never)
    await $.turn.complete({ turnId: id, reason: 'answer', answer, durationMs: 10, isAborted: false } as never)
    await clock.advance(100)
  }
  const row = async (id: string) => textOf(await $.ui.render({ plugin: 'thimble', component: 'Placed', surface: 'terminal', requestId: `r-${id}`, viewport: { columns: 100, rows: 60, isFullscreen: true }, props: { id, plugin: 'thimble' } } as never))
  const answer = async (id: string, text: string) => textOf(await $.ui.render({ plugin: 'thimble', component: 'AssistantMessage', surface: 'terminal', requestId: id, viewport: { columns: 100, rows: 60, isFullscreen: true }, props: { text, isFirstOfReply: true } } as never))
  const ask = (text: string) => $.prompt.submit({ text, origin: { kind: 'composer' } } as never)
  const press = async (k: string) => { const r = await $.prompt.edit({ origin: { kind: 'composer' }, key: { key: k }, text: '', cursor: 0, start: 0, end: 0, inputText: k } as never); await clock.advance(400); return r }
  return { clock, got, placed, ran, asked, turn, row, answer, ask, press }
}

test("in a session: thimble draws the intro and the step row under the sample answer, sends Claude nothing, places the row under a reply, s simplifies the sample answer, and a second tour keeps the first one's rows", { options: { cards: 'off', explain: 'off', citations: 'off' } }, async ($, on) => {
  noteViewport({ isFullscreen: true })
  const t = await session($, on)
  const tour = () => $.prompt.submit({ text: '/thimble:tour', command: { name: 'thimble:tour', args: '' }, origin: { kind: 'composer' } } as never)
  await tour()
  expect(t.placed).toEqual(['tour-intro-1'])
  expect(await t.row('tour-intro-1')).toContain('One number in it is wrong on purpose.')
  await t.turn('t1', '<command-name>/thimble:tour</command-name>', SAMPLE)
  // Cards, Explainers and Citations are off: the one step is s. The sample answer draws the row at its end
  expect(t.placed).toEqual(['tour-intro-1'])
  const first = await t.answer('row-t1', SAMPLE)
  expect(first.indexOf('thimble tour · 1 of 1')).toBeGreaterThan(first.indexOf('late delivery'))
  expect(first).toContain('Press s for a shorter, plainer version of the tea shop answer.')
  // a fork's turn ends (a side thread's answer, say): it is no turn of main's, and the row stays under the sample answer
  await $.turn.complete({ turnId: 'f1', agentId: 'agent-made-up', reason: 'answer', answer: 'A side answer.', durationMs: 10, isAborted: false } as never)
  expect(t.placed).toEqual(['tour-intro-1'])
  expect(await t.answer('row-t1', SAMPLE)).toContain('thimble tour · 1 of 1')
  // the person's own question: Claude answers it, and the row is placed under the reply instead
  await t.ask('What does s do?')
  await t.turn('t2', 'What does s do?', 'It writes a simpler version of the answer.')
  expect(t.placed).toEqual(['tour-intro-1', 'tour-step-2'])
  expect(await t.answer('row-t1', SAMPLE)).not.toContain('thimble tour')
  expect(await t.answer('row-t2', 'It writes a simpler version of the answer.')).not.toContain('thimble tour')
  // the reply is no answer: s simplifies the sample answer
  await t.press('s')
  await t.clock.advance(5000)
  expect(t.asked.length).toBe(1)
  expect(String(t.asked[0].prompt)).toContain('late delivery does not explain the refunds')
  expect(String(t.asked[0].prompt)).not.toContain('It writes a simpler version')
  const end = await t.row('tour-step-2')
  expect(end).toContain('thimble tour · done')
  expect(end).toContain('✓ s wrote a simpler version.')
  expect(end).toContain('Type /thimble:tour to take the tour again.')
  // the tour sends Claude no prompt of its own
  expect(t.got.filter(p => p.by === 'plugin')).toEqual([])
  // the tour again: a new intro, and the first tour's rows still draw it
  await t.clock.advance(20_000)
  await tour()
  expect(t.placed).toEqual(['tour-intro-1', 'tour-step-2', 'tour-intro-3'])
  expect(await t.row('tour-intro-1')).toContain('One number in it is wrong on purpose.')
  expect(await t.row('tour-step-2')).toContain('thimble tour · done')
})

test("in a session: Claude's Skill call starts the tour, and the turn that called it holds the sample answer", { options: { cards: 'off', explain: 'off', citations: 'off', squeezeAnswers: false } }, async ($, on) => {
  noteViewport({ isFullscreen: true })
  const t = await session($, on)
  await t.ask('Yes, show me the tour.')
  await t.turn('t1', 'Yes, show me the tour.', SAMPLE, () => $.tool.call({ tool: 'Skill', skill: 'thimble:tour', tool_use_id: 'toolu_made_up_1' } as never))
  // with every step's feature off, the sample answer goes on to the end
  expect(t.placed).toEqual(['tour-intro-1'])
  expect(await t.answer('row-t1', SAMPLE)).toContain('The tour is over.')
})

test("the person's /reload-plugins soon after an install in this session runs /thimble:tour once; a later one, or another session's, does not", async ($, on) => {
  const file = '/made-up/.thimble/tour-next'
  const files: Record<string, string> = { [file]: 's-tour 0\n' }
  const t = await session($, on, files)
  // thimble loads at the reload
  await t.clock.advance(1000)
  expect(t.ran.map(e => e.command)).toEqual(['thimble:tour'])
  expect(files[file]).toBe('')
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
  await t.clock.advance(1000)
  expect(t.ran.length).toBe(1)
  // thimble was loaded already: it hears the reload end
  files[file] = 's-tour 2'
  await $.command.run({ command: 'reload-plugins', args: '' } as never)
  await t.clock.advance(1000)
  expect(t.ran.map(e => e.command)).toEqual(['thimble:tour', 'reload-plugins', 'thimble:tour'])
  // a file from long ago (a session resumed later) starts nothing, and is emptied
  await t.clock.advance(NEXT_MS)
  files[file] = 's-tour 1'
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
  await t.clock.advance(1000)
  expect(files[file]).toBe('')
  files[file] = `s-another ${Math.floor((NEXT_MS + 4000) / 1000)}`
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
  await t.clock.advance(1000)
  expect(t.ran.length).toBe(3)
})
