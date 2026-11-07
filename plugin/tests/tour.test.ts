// The feature tour (tour/tour.ts, skills/tour/SKILL.md): /thimble:tour starts it, and when the person does a step,
// thimble sends Claude one prompt of its own that names the next step, only while a tour runs and once per step. A
// step done early, a step whose feature is off and step 2 where no click reaches thimble are left out. The person's
// second prompt of their own at one step ends the tour, and Claude reads that it ended. The tour's turns answer
// nothing, so the features act on the sample answer. All data is made up. `claude plugin test plugin`.
import { expect, mock } from 'claude-code/testing'

import { remindAfterAnswer } from '../bar/hints'
import { failLineNow } from '../bar/notice'
import { noteViewport } from '../cards/draw'
import { setOptions } from '../settings/features.mjs'
import { STOPPED, TAG, tourDid, tourNow, tourPrompt, tourRuns, tourStart, turnTour } from '../tour/tour'
import { test } from './kit'
import { promptStub } from './stubs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** A made-up engine with what the tour reads: the session's state, the environment, and the prompts it sends. */
function fake() {
  const state = new Map<string, unknown>()
  const sent: string[] = []
  const $: Any = {
    state: {
      get: async (k: Any) => ({ value: state.get(JSON.stringify(k)), version: 0 }),
      set: async (k: Any, v: unknown) => { state.set(JSON.stringify(k), v); return { isSet: true, version: 1 } },
    },
    env: { get: async () => undefined },
    prompt: { submit: async (a: Any) => { sent.push(String(a.text)); return { text: a.text } } },
    ui: { invalidate: () => undefined },
  }
  return { $, sent }
}

/** The prompts sent so far, after their sends (not awaited by the tour) ran. */
async function sentNow(sent: string[]): Promise<string[]> {
  await new Promise(r => setTimeout(r, 0))
  return [...sent]
}

test('each step done sends one prompt that names the next step, and step 5 ends the tour', async () => {
  setOptions({})
  noteViewport({ isFullscreen: true })
  const { $, sent } = fake()
  // no tour: a step done sends nothing
  await tourDid($, 'v')
  expect(await sentNow(sent)).toEqual([])
  await tourStart($)
  expect(await tourRuns($)).toBe(true)
  await tourDid($, 'v')
  // a step done again, or a second card of the same design, sends nothing more
  await tourDid($, 'v')
  await tourDid($, 'e')
  await tourDid($, 'cite')
  await tourDid($, 's')
  expect(await sentNow(sent)).toEqual([
    `${TAG} Step 1 done. Say step 2.`,
    `${TAG} Step 2 done. Say step 3.`,
    `${TAG} Step 3 done. Say step 4.`,
    `${TAG} Step 4 done. Say step 5.`,
  ])
  expect(await tourRuns($)).toBe(false)
  // the tour over, steps send nothing
  await tourDid($, 'v')
  expect((await sentNow(sent)).length).toBe(4)
})

test('a step done before its turn is left out; /thimble:tour again starts over', async () => {
  setOptions({})
  noteViewport({ isFullscreen: true })
  const { $, sent } = fake()
  await tourStart($)
  // the person pressed s and opened a citation while step 1 waited: no prompt yet
  await tourDid($, 's')
  await tourDid($, 'cite')
  expect(await sentNow(sent)).toEqual([])
  await tourDid($, 'v')
  await tourDid($, 'e')
  expect(await sentNow(sent)).toEqual([`${TAG} Step 1 done. Say step 2.`, `${TAG} Step 2 done. Say step 5.`])
  expect(await tourRuns($)).toBe(false)
  await tourStart($)
  expect(await tourNow($)).toEqual({ at: 'v', done: [], asides: 0 })
})

test('where no click reaches thimble, step 2 is left out and step 3k names ]; a feature that is off is left out', async () => {
  setOptions({})
  const { $, sent } = fake()
  noteViewport({ isFullscreen: false })
  await tourStart($)
  await tourDid($, 'v')
  await tourDid($, 'cite')
  expect(await sentNow(sent)).toEqual([`${TAG} Step 1 done. Say step 3k.`, `${TAG} Step 3k done. Say step 4.`])
  // Simplify off: the citation step is the last before the end
  noteViewport({ isFullscreen: true })
  setOptions({ squeezeAnswers: false })
  const b = fake()
  await tourStart(b.$)
  await tourDid(b.$, 'v')
  await tourDid(b.$, 'e')
  await tourDid(b.$, 'cite')
  expect(await sentNow(b.sent)).toEqual([`${TAG} Step 1 done. Say step 2.`, `${TAG} Step 2 done. Say step 3.`, `${TAG} Step 3 done. Say step 5.`])
  setOptions({})
})

test('no reminder shows while the tour runs; a /clear ends it', async () => {
  setOptions({ explain: 'on demand' })
  const { $ } = fake()
  $.clock = { after: () => ({ cancel() {} }) }
  await tourStart($)
  await remindAfterAnswer($)
  expect(await failLineNow($)).toBeNull()
  await turnTour($)
  expect(await tourRuns($)).toBe(false)
  await remindAfterAnswer($)
  expect((await failLineNow($))?.text).toContain('press e')
  setOptions({})
})

test("a turn the tour's prompt started is the tour's; the person's own is not", () => {
  expect(tourPrompt({ text: `${TAG} Step 1 done. Say step 2.`, by: 'plugin' })).toBe(true)
  expect(tourPrompt({ text: `The thimble plugin sent a message:\n${TAG} Step 1 done. Say step 2.`, by: 'unknown' })).toBe(true)
  expect(tourPrompt({ text: `${TAG} Step 1 done. Say step 2.`, by: 'composer' })).toBe(false)
  expect(tourPrompt({ text: 'Why did two runs fail?', by: 'plugin' })).toBe(false)
})

const NO_FILES = (on: Any) => {
  mock.env(on, { THIMBLE_HOME: '/made-up/.thimble', HOME: '/made-up/home', TMPDIR: '/made-up/tmp', PATH: '/usr/bin' })
  on('session.id', () => ({ value: 's-tour' }))
  on('session.cwd', () => ({ value: '/made-up/data' }))
  on('session.root', () => ({ value: '/made-up/data' }))
  on('session.messages', () => ({ value: [] }))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: promptStub(e.path) ?? '' }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('fs.stat', () => ({ value: { kind: 'missing', size: 0 } }))
  on('env.set', () => ({ value: {} }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.scroll', () => ({ value: undefined }))
  on('model.fork', () => ({ value: { isAnswered: true, text: '{}' } }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }) as never)
  on('turn.start', (_$: unknown, e: Any) => ({ turnId: e.turnId }))
  on('turn.complete', (_$: unknown, e: Any) => ({ text: e.answer }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the engine'] }) as never)
}

const ANSWER = (requestId: string, text: string) => ({ plugin: 'thimble', component: 'AssistantMessage', surface: 'terminal', requestId, viewport: { columns: 100, rows: 40, isFullscreen: true }, props: { text, isFirstOfReply: true } }) as never

function textOf(n: Any): string {
  if (n == null || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  return textOf(n.props?.children) + (n.type === 'Markdown' ? String(n.props.text) : '') + textOf(n.children)
}

test("in a session: /thimble:tour starts it, the tour's turn is no answer for the keys, and a second aside ends it", async ($, on) => {
  NO_FILES(on)
  const clock = mock.clock(on, { now: 0 })
  // the prompts as they reach Claude, with what thimble put beside them
  const got: { text: string; context: string[] }[] = []
  on('prompt.submit', (_$: unknown, e: Any) => {
    got.push({ text: e.text, context: [...(e.context ?? [])] })
    return { text: e.text }
  })
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
  const turn = async (id: string, text: string, answer: string) => {
    await $.turn.start({ text, turnId: id } as never)
    await $.session.append({ message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: answer }] }, door: 'response', origin: { kind: 'model', model: 'claude-made-up' }, uuid: `row-${id}` } as never)
    await $.turn.complete({ turnId: id, reason: 'answer', answer, durationMs: 10, isAborted: false } as never)
    await clock.advance(100)
  }
  const sample = 'Fernhill Tea refunded 7 orders in March 2026.'
  await $.prompt.submit({ text: '/thimble:tour', command: { name: 'thimble:tour', args: '' }, origin: { kind: 'composer' } } as never)
  await turn('t1', '<command-name>/thimble:tour</command-name>', sample)
  // the tour's prompt after the card was drawn, and Claude's step 2 in its turn
  const step = `${TAG} Step 1 done. Say step 2.`
  await $.prompt.submit({ text: step, origin: { kind: 'plugin' } } as never)
  await turn('t2', step, 'Select the words “average order value” in the answer with the mouse, then press e.')
  // the person's own question: Claude answers and says the step again; the tour goes on
  await $.prompt.submit({ text: 'What is a card?', origin: { kind: 'composer' } } as never)
  expect(got.at(-1)?.context.join('\n') ?? '').not.toContain(STOPPED)
  await turn('t3', 'What is a card?', 'A card is a chart of the data. Select the words “average order value” in the answer with the mouse, then press e.')
  // { steps from the newest answer to the one before: the sample answer, past the tour's turn, which is no answer
  await $.prompt.edit({ origin: { kind: 'composer' }, key: { key: '{' }, text: '', cursor: 0, start: 0, end: 0, inputText: '{' } as never)
  expect(textOf(await $.ui.render(ANSWER('row-t1', sample)))).toContain(`▸${sample}`)
  // a second prompt of the person's own at the same step ends the tour, and Claude reads so beside it
  await $.prompt.submit({ text: 'Show me the late orders.', origin: { kind: 'composer' } } as never)
  expect(got.at(-1)?.context).toContain(STOPPED)
})
