// The first session's tour (bar/intro.ts): after the intro and main's first answer in a session, one step at a time in
// the row above the bar, `Tour 1/4: …`, with the bar's keys kept. A step goes when the person does what it says or
// after two prompts sent while it showed; a step whose feature is off is skipped; once done, it never shows again, and
// while it runs no reminder shows. All data is made up.
// `claude plugin test plugin`.
import { expect, mock } from 'claude-code/testing'

import { hintUsed, remindAfterAnswer } from '../bar/hints'
import { introDone, introHint, tourHint, tourPrompt, tourRuns, tourShown, tourStart } from '../bar/intro'
import { failLineNow } from '../bar/notice'
import { setOptions } from '../settings/features.mjs'
import { test } from './kit'
import { promptStub, tempRun } from './stubs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** A made-up engine with what the tour reads: the store (kept across sessions), the session's state, the clock. */
function fake() {
  const store = new Map<string, unknown>()
  const state = new Map<string, unknown>()
  let now = 1000
  const $: Any = {
    store: { get: async (k: string) => store.get(k), set: async (k: string, v: unknown) => { store.set(k, v) } },
    state: {
      get: async (k: Any) => ({ value: state.get(JSON.stringify(k)), version: 0 }),
      set: async (k: Any, v: unknown) => { state.set(JSON.stringify(k), v); return { isSet: true, version: 1 } },
    },
    ui: { invalidate: () => undefined },
    clock: { now: async () => (now += 10), after: () => ({ cancel() {} }) },
    env: { get: async () => undefined },
  }
  /** A later session: the store stays, the state goes. */
  const nextSession = () => state.clear()
  return { $, store, nextSession }
}

/** A person's first session: the intro showed and went, and main answered once. */
async function answeredOnce($: Any): Promise<void> {
  expect(await introHint($)).toBe('click thimble for settings.')
  expect(await tourHint($)).toBeNull()
  await introDone($)
  await tourStart($)
}

/** The step as the bar draws it, told to the tour as register.ts tells it. */
const words = async ($: Any, clicks = true) => {
  const t = await tourHint($, clicks)
  tourShown(t?.id ?? null)
  return t ? `${t.lead} ${t.words}` : null
}

const CHECKED = 'thimble checks it against the data, and corrects the words or marks them × when they are wrong.'

test('the tour shows its steps in order after the first answer, each going when the person does what it says, and never again once done', async () => {
  setOptions({})
  const { $, nextSession } = fake()
  await answeredOnce($)
  expect(await words($)).toBe('Tour 1/4: press v to draw a card of this answer.')
  // a feature of a later step used first: that step is done too, and the step that shows stays
  await hintUsed($, 'rewrite')
  expect(await words($)).toBe('Tour 1/4: press v to draw a card of this answer.')
  await hintUsed($, 'visualize')
  expect(await words($)).toBe('Tour 2/4: select a few words in the answer and press e to explain them.')
  await hintUsed($, 'explain')
  expect(await words($)).toBe(`Tour 3/4: click a citation to see its evidence: ${CHECKED}`)
  await hintUsed($, 'evidence')
  expect(await words($)).toBeNull()
  expect(await tourRuns($)).toBe(false)
  // a later session and its first answer: neither the intro nor the tour
  nextSession()
  expect(await introHint($)).toBeNull()
  await tourStart($)
  expect(await words($)).toBeNull()
})

test('a step goes after the person sent two prompts while it showed; c is the citation step too', async () => {
  setOptions({})
  const { $ } = fake()
  await answeredOnce($)
  expect(await words($)).toMatch(/^Tour 1\/4: press v/)
  await tourPrompt($)
  expect(await words($)).toMatch(/^Tour 1\/4: press v/)
  await tourPrompt($)
  expect(await words($)).toMatch(/^Tour 2\/4: select a few words/)
  await tourPrompt($)
  expect(await words($)).toMatch(/^Tour 2\/4/)
  await tourPrompt($)
  expect(await words($)).toMatch(/^Tour 3\/4: click a citation/)
  await hintUsed($, 'cite')
  expect(await words($)).toBe('Tour 4/4: press s for a shorter, plainer version of the answer.')
  // the count starts again for each step: one prompt is not enough
  await tourPrompt($)
  expect(await words($)).toMatch(/^Tour 4\/4/)
  await tourPrompt($)
  expect(await words($)).toBeNull()
})

test('a prompt sent while the bar did not show the step does not count for it', async () => {
  setOptions({})
  const { $ } = fake()
  await answeredOnce($)
  expect(await words($)).toMatch(/^Tour 1\/4/)
  // a failure line (or main at work) hid the step: register.ts drew none
  tourShown(null)
  await tourPrompt($)
  await tourPrompt($)
  expect(await words($)).toMatch(/^Tour 1\/4/)
  // two prompts with no drawing between them count once
  await tourPrompt($)
  await tourPrompt($)
  expect(await words($)).toMatch(/^Tour 1\/4/)
  await tourPrompt($)
  expect(await words($)).toMatch(/^Tour 2\/4/)
})

test('a tour not done goes on in the next session only after main answered there', async () => {
  setOptions({})
  const { $, nextSession } = fake()
  await answeredOnce($)
  await hintUsed($, 'visualize')
  expect(await words($)).toMatch(/^Tour 2\/4/)
  nextSession()
  expect(await introHint($)).toBeNull()
  // the session's start: no answer yet, so no step, and its first prompt does not count
  expect(await words($)).toBeNull()
  await tourPrompt($)
  await tourStart($)
  expect(await words($)).toMatch(/^Tour 2\/4: select a few words/)
  await tourPrompt($)
  expect(await words($)).toMatch(/^Tour 2\/4/)
})

test('a step whose feature is off is skipped, and the citation step says how citations work in each mode', async () => {
  const { $ } = fake()
  setOptions({ cards: 'off', squeezeAnswers: false })
  await answeredOnce($)
  expect(await words($)).toBe('Tour 1/2: select a few words in the answer and press e to explain them.')
  setOptions({ cards: 'off', squeezeAnswers: false, citations: 'manual' })
  await hintUsed($, 'explain')
  expect(await words($)).toBe(`Tour 2/2: select a claim in the answer and press c: ${CHECKED}`)
  // where no click or selection reaches thimble: no e step, and Claude's citations open with ]
  setOptions({ cards: 'off', squeezeAnswers: false })
  expect(await words($, false)).toBe(`Tour 1/1: press ] to open a citation and its evidence: ${CHECKED}`)
  // nothing left to show: the tour is over, and stays over when the features come back
  setOptions({ cards: 'off', squeezeAnswers: false, citations: 'off', explain: 'off' })
  expect(await words($)).toBeNull()
  setOptions({})
  expect(await words($)).toBeNull()
  expect(await tourRuns($)).toBe(false)
})

test('while main works the step does not show; no reminder shows while the tour runs; an install from before the tour gets none', async () => {
  setOptions({ explain: 'on demand' })
  const { $ } = fake()
  await answeredOnce($)
  await $.state.set({ plugin: 'thimble', key: 'mainTurn' }, 't2')
  expect(await words($)).toBeNull()
  await $.state.set({ plugin: 'thimble', key: 'mainTurn' }, null)
  expect(await words($)).toMatch(/^Tour 1\/4/)
  await remindAfterAnswer($)
  expect(await failLineNow($)).toBeNull()
  for (const f of ['visualize', 'explain', 'evidence', 'rewrite']) await hintUsed($, f)
  expect(await words($)).toBeNull()
  // the tour over, the reminders come back: c's, which the session has not used
  setOptions({ citations: 'manual' })
  await remindAfterAnswer($)
  expect((await failLineNow($))?.text).toContain('press c')

  // a person whose intro went before the tour existed: no tour
  setOptions({})
  const old = fake()
  await old.$.store.set('introDone', true)
  expect(await introHint(old.$)).toBeNull()
  await tourStart(old.$)
  expect(await words(old.$)).toBeNull()
})

const BAND = { plugin: 'thimble', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 120, scroll: { offset: 0, bodyRows: 12 }, view: {} }, viewport: { columns: 120, rows: 40, isFullscreen: true } } as never

function textOf(n: Any): string {
  if (n == null || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  return textOf(n.props?.children) + textOf(n.children)
}

test('in a session: the bar shows the intro, then after the first answer the tour step above it, and keeps its keys', { options: { labels: false, coverage: false } }, async ($, on) => {
  mock.env(on, { THIMBLE_HOME: '/made-up/.thimble', HOME: '/made-up/home', TMPDIR: '/made-up/tmp', PATH: '/usr/bin', THIMBLE_ROOT: '/made-up/data' })
  const clock = mock.clock(on, { now: 0 })
  mock.store(on)
  on('session.id', () => ({ value: 's-tour' }))
  on('session.cwd', () => ({ value: '/made-up/data' }))
  on('session.root', () => ({ value: '/made-up/data' }))
  on('session.messages', () => ({ value: [] }))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: promptStub(e.path) ?? '' }))
  on('tool.register', () => ({ value: undefined }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('fs.stat', () => ({ value: { kind: 'missing', size: 0 } }))
  on('env.set', () => ({ value: {} }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'thimble-settings' } }))
  on('process.run', (_$: unknown, e: { argv: string[] }) => ({ value: { exitCode: 0, stdout: '', stderr: '', ...tempRun(e.argv), isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }) as never)
  on('prompt.submit', (_$: unknown, e: { text: string }) => ({ text: e.text }))
  on('turn.complete', (_$: unknown, e: Any) => ({ text: e.answer }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the engine'] }) as never)

  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
  expect(textOf(await $.ui.render(BAND))).toContain('Hint: click thimble for settings.')
  await $.prompt.submit({ text: 'Why did runs fail?', origin: { kind: 'composer' } } as never)
  await $.session.append({ message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'Two runs failed.' }] }, door: 'response', origin: { kind: 'model', model: 'claude-made-up' }, uuid: 'row-answer-1' } as never)
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'Two runs failed.', durationMs: 10, isAborted: false } as never)
  await clock.advance(100)
  const line = textOf(await $.ui.render(BAND))
  // the step in the row above the bar, which keeps its keys
  expect(line).toContain('Tour 1/4: press v to draw a card of this answer.thimble  v visualize')
  expect(line).not.toContain('Hint:')
  // two prompts while it showed (the bar drawn before each): the next step
  for (const text of ['And the third?', 'Thanks.']) {
    await $.prompt.submit({ text, origin: { kind: 'composer' } } as never)
    await $.turn.complete({ turnId: `t-${text}`, reason: 'answer', answer: 'Yes.', durationMs: 10, isAborted: false } as never)
    await clock.advance(100)
    await $.ui.render(BAND)
  }
  await clock.advance(100)
  expect(textOf(await $.ui.render(BAND))).toContain('Tour 2/4: select a few words in the answer and press e to explain them.')
})
