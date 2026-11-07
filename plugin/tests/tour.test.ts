// The feature tour (tour/tour.ts, skills/tour/SKILL.md): /thimble:tour or Claude's Skill call starts it. thimble
// places its intro, then its step row under the sample answer, and draws both itself; it sends Claude no prompt. Each
// step done redraws the row in place. A step done early, a step whose feature is off and the selection step where no
// click reaches thimble are left out; v that drew no card lets the tour go on. While e or cite waits, the sample answer
// marks what to select or click. After the sample answer, the replies to the person's own prompts answer nothing, so s
// acts on the sample answer, and the step row is placed again under the reply. After an install inside Claude Code,
// thimble runs /thimble:tour once in that session. All data is made up. `claude plugin test plugin`.
import { expect, mock } from 'claude-code/testing'

import { remindAfterAnswer } from '../bar/hints'
import { failLineNow } from '../bar/notice'
import { noteViewport } from '../cards/draw'
import { answersNothing } from '../core/answers'
import { setOptions } from '../settings/features.mjs'
import { tourDid, tourMissed, tourNow, tourOpened, tourRuns, tourSpans, tourStart, turnTour } from '../tour/tour'
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
  // the command and the skill both start it: one start, one intro
  await tourStart($)
  expect(placed).toEqual(['tour-intro-1'])
  expect(await walk($, ['answer', 'e', 'e', 'cite', 'v', 's'])).toEqual(['e', 'cite', 'cite', 'v', 's', 'end'])
  expect(await tourRuns($)).toBe(false)
  // a step done early is left out when its turn comes
  const b = fake()
  await tourStart(b.$)
  expect(await walk(b.$, ['answer', 's', 'v', 'e'])).toEqual(['e', 'e', 'e', 'cite'])
  // v that drew no card goes on, only while v waits
  await tourMissed(b.$, 'v')
  expect((await tourNow(b.$))?.at).toBe('cite')
  await tourDid(b.$, 'cite')
  expect(await tourRuns(b.$)).toBe(false)
})

test('where no click reaches thimble the selection step is left out; a feature that is off is left out', async () => {
  setOptions({})
  noteViewport({ isFullscreen: false })
  const { $ } = fake()
  await tourStart($)
  expect(await walk($, ['answer'])).toEqual(['cite'])
  noteViewport({ isFullscreen: true })
  setOptions({ squeezeAnswers: false })
  const b = fake()
  await tourStart(b.$)
  expect(await walk(b.$, ['answer', 'e', 'cite', 'v'])).toEqual(['e', 'cite', 'v', 'end'])
  setOptions({})
})

test('while e waits the sample answer marks the words to select, while cite waits the refunds citation, which alone is the step, then nothing', async () => {
  setOptions({})
  noteViewport({ isFullscreen: true })
  const { $ } = fake()
  const text = 'That is an average order value of [$52](#). The shop refunded [7 orders](#). Most arrived on time.'
  await tourStart($)
  await $.state.set({ plugin: 'thimble', key: 'tourSample' }, 'row-sample')
  await tourDid($, 'answer')
  const words = (s: Any[]) => s.map(x => text.slice(x.start, x.end))
  expect(words(await tourSpans($, 'row-sample', text))).toEqual(['average order value'])
  // another row is not marked
  expect(await tourSpans($, 'row-other', text)).toEqual([])
  await tourDid($, 'e')
  expect(words(await tourSpans($, 'row-sample', text))).toEqual(['[7 orders](#)'])
  // the refunds citation is the second of the answer: opening the first, or one of another answer, is not the step
  await $.state.set({ plugin: 'thimble', key: 'answerMsg', id: 'row-sample' }, { row: 'row-sample', turnId: 't1', text, at: 0 })
  await tourOpened($, 'row-sample', 1)
  await tourOpened($, 'row-other', 2)
  expect((await tourNow($))?.at).toBe('cite')
  await tourOpened($, 'row-sample', 2)
  expect((await tourNow($))?.at).toBe('v')
  expect(await tourSpans($, 'row-sample', text)).toEqual([])
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
  const ask = (text: string) => $.prompt.submit({ text, origin: { kind: 'composer' } } as never)
  const press = async (k: string) => { const r = await $.prompt.edit({ origin: { kind: 'composer' }, key: { key: k }, text: '', cursor: 0, start: 0, end: 0, inputText: k } as never); await clock.advance(400); return r }
  return { clock, got, placed, ran, asked, turn, row, ask, press }
}

test("in a session: thimble draws the intro and the step row, sends Claude nothing, places the row again under a reply, and s simplifies the sample answer", { options: { cards: 'off', explain: 'off', citations: 'off' } }, async ($, on) => {
  noteViewport({ isFullscreen: true })
  const t = await session($, on)
  await $.prompt.submit({ text: '/thimble:tour', command: { name: 'thimble:tour', args: '' }, origin: { kind: 'composer' } } as never)
  expect(t.placed).toEqual(['tour-intro-1'])
  expect(await t.row('tour-intro-1')).toContain('One number in it is wrong on purpose.')
  await t.turn('t1', '<command-name>/thimble:tour</command-name>', SAMPLE)
  // Cards, Explainers and Citations are off: the one step is s
  expect(t.placed).toEqual(['tour-intro-1', 'tour-step-2'])
  const first = await t.row('tour-step-2')
  expect(first).toContain('thimble tour · 1 of 1')
  expect(first).toContain('Press s for a shorter, plainer version of the answer.')
  // the person's own question: Claude answers it, and the row is placed again under the reply
  await t.ask('What does s do?')
  await t.turn('t2', 'What does s do?', 'It writes a simpler version of the answer.')
  expect(t.placed.at(-1)).toBe('tour-step-3')
  expect(await t.row('tour-step-2')).toBe('')
  // the reply is no answer: s simplifies the sample answer
  await t.press('s')
  await t.clock.advance(5000)
  expect(t.asked.length).toBe(1)
  expect(String(t.asked[0].prompt)).toContain('late delivery does not explain the refunds')
  expect(String(t.asked[0].prompt)).not.toContain('It writes a simpler version')
  const end = await t.row('tour-step-3')
  expect(end).toContain('thimble tour · done')
  expect(end).toContain('✓ s wrote a simpler version.')
  expect(end).toContain('Type /thimble:tour to take the tour again.')
  // the tour sends Claude no prompt of its own
  expect(t.got.filter(p => p.by === 'plugin')).toEqual([])
})

test("in a session: Claude's Skill call starts the tour, and the turn that called it holds the sample answer", { options: { cards: 'off', explain: 'off', citations: 'off', squeezeAnswers: false } }, async ($, on) => {
  noteViewport({ isFullscreen: true })
  const t = await session($, on)
  await t.ask('Yes, show me the tour.')
  await t.turn('t1', 'Yes, show me the tour.', SAMPLE, () => $.tool.call({ tool: 'Skill', skill: 'thimble:tour', tool_use_id: 'toolu_made_up_1' } as never))
  // with every step's feature off, the sample answer goes on to the end
  expect(t.placed).toEqual(['tour-intro-1', 'tour-step-2'])
  expect(await t.row('tour-step-2')).toContain('The tour is over.')
})

test('thimble loading in the session that installed it runs /thimble:tour once; another session does not', async ($, on) => {
  const files: Record<string, string> = { '/made-up/.thimble/tour-next': 's-tour\n' }
  const t = await session($, on, files)
  await t.clock.advance(1000)
  expect(t.ran.map(e => e.command)).toEqual(['thimble:tour'])
  expect(files['/made-up/.thimble/tour-next']).toBe('')
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
  await t.clock.advance(1000)
  expect(t.ran.length).toBe(1)
  files['/made-up/.thimble/tour-next'] = 's-another'
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
  await t.clock.advance(1000)
  expect(t.ran.length).toBe(1)
})
