// The feature tour (tour/tour.ts, skills/tour/SKILL.md): /thimble:tour or Claude's Skill call starts it, and when a
// step is done (the sample answer written, or what the person does), thimble sends Claude one prompt of its own that
// names the next step, only while a tour runs and once per step. A step done early, a step whose feature is off and
// step 1 where no click reaches thimble are left out; v that drew no card lets the tour go on. After the sample answer,
// the tour's turns and the replies to the person's own prompts answer nothing, so s acts on the sample answer. The
// person's own prompt gets the step again; the third at one step ends the tour, and Claude says so. All data is made
// up. `claude plugin test plugin`.
import { expect, mock } from 'claude-code/testing'

import { remindAfterAnswer } from '../bar/hints'
import { failLineNow } from '../bar/notice'
import { noteViewport } from '../cards/draw'
import { cardIdOf } from '../cards/store'
import { spawnFork } from '../core/forks'
import { registerDesigner } from '../designer/v'
import { setOptions } from '../settings/features.mjs'
import { answersNothing } from '../core/answers'
import { aside, STOPPED, TAG, tourDid, tourMissed, tourNow, tourPrompt, tourRuns, tourStart, turnTour } from '../tour/tour'
import { test } from './kit'
import { promptStub, tempRun } from './stubs'

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
  await tourDid($, 'answer')
  await tourDid($, 'e')
  // a step done again sends nothing more
  await tourDid($, 'e')
  await tourDid($, 'cite')
  await tourDid($, 'v')
  await tourDid($, 'v')
  await tourDid($, 's')
  expect(await sentNow(sent)).toEqual([
    `${TAG} Step 0 done. Say step 1.`,
    `${TAG} Step 1 done. Say step 2.`,
    `${TAG} Step 2 done. Say step 3.`,
    `${TAG} Step 3 done. Say step 4.`,
    `${TAG} Step 4 done. Say step 5.`,
  ])
  expect(await tourRuns($)).toBe(false)
  // the tour over, steps send nothing
  await tourDid($, 'v')
  expect((await sentNow(sent)).length).toBe(5)
})

test('a step done before its turn is left out; /thimble:tour again starts over', async () => {
  setOptions({})
  noteViewport({ isFullscreen: true })
  const { $, sent } = fake()
  await tourStart($)
  await tourDid($, 'answer')
  // the person pressed s and v while step 1 waited: no prompt yet
  await tourDid($, 's')
  await tourDid($, 'v')
  expect(await sentNow(sent)).toEqual([`${TAG} Step 0 done. Say step 1.`])
  await tourDid($, 'e')
  await tourDid($, 'cite')
  expect((await sentNow(sent)).slice(1)).toEqual([`${TAG} Step 1 done. Say step 2.`, `${TAG} Step 2 done. Say step 5.`])
  expect(await tourRuns($)).toBe(false)
  await tourStart($)
  expect(await tourNow($)).toEqual({ at: 'answer', done: [], asides: 0 })
})

test('where no click reaches thimble, step 1 is left out, and steps 2k and 5k name the keyboard path; a feature that is off is left out', async () => {
  setOptions({})
  const { $, sent } = fake()
  noteViewport({ isFullscreen: false })
  await tourStart($)
  await tourDid($, 'answer')
  await tourDid($, 'cite')
  await tourDid($, 'v')
  await tourDid($, 's')
  expect(await sentNow(sent)).toEqual([`${TAG} Step 0 done. Say step 2k.`, `${TAG} Step 2k done. Say step 3.`, `${TAG} Step 3 done. Say step 4.`, `${TAG} Step 4 done. Say step 5k.`])
  // Simplify off: the card step is the last before the end
  noteViewport({ isFullscreen: true })
  setOptions({ squeezeAnswers: false })
  const b = fake()
  await tourStart(b.$)
  await tourDid(b.$, 'answer')
  await tourDid(b.$, 'e')
  await tourDid(b.$, 'cite')
  await tourDid(b.$, 'v')
  expect((await sentNow(b.sent)).slice(1)).toEqual([`${TAG} Step 1 done. Say step 2.`, `${TAG} Step 2 done. Say step 3.`, `${TAG} Step 3 done. Say step 5.`])
  setOptions({})
})

test('v that drew no card lets the tour go on, once, and only while step 3 waits', async () => {
  setOptions({})
  noteViewport({ isFullscreen: true })
  const { $, sent } = fake()
  await tourStart($)
  await tourDid($, 'answer')
  // step 1 waits: a design that failed changes nothing
  await tourMissed($, 'v')
  expect(await sentNow(sent)).toEqual([`${TAG} Step 0 done. Say step 1.`])
  await tourDid($, 'e')
  await tourDid($, 'cite')
  await tourMissed($, 'v')
  await tourMissed($, 'v')
  expect((await sentNow(sent)).slice(1)).toEqual([`${TAG} Step 1 done. Say step 2.`, `${TAG} Step 2 done. Say step 3.`, `${TAG} Step 3 did not work. Say step 4.`])
})

test("while step 3 waits, a card call of v's copy that drew a version sends step 3 done, once; one that did not draw sends nothing", async () => {
  setOptions({})
  noteViewport({ isFullscreen: true })
  const { $, sent } = fake()
  // the designer's hooks (designer/v.ts) on this made-up engine, and v's copy started
  const hooks: Record<string, Any[]> = {}
  const on: Any = (event: string, a: Any, b?: Any) => {
    ;(hooks[event] ??= []).push(typeof a === 'function' ? a : b)
    return { catch: () => undefined }
  }
  registerDesigner(on, {} as never)
  $.agent = { spawn: async () => ({ model: 'claude-made-up', agentId: 'agent-made-up-v' }) }
  const fork = await spawnFork($, { kind: 'designer', prompt: 'PROMPT designer', description: 'card of the last answer (v)' })
  expect(fork.agentId).toBe('agent-made-up-v')
  await tourStart($)
  await tourDid($, 'answer')
  await tourDid($, 'e')
  await tourDid($, 'cite')
  const before = (await sentNow(sent)).length
  // a card call of the copy, whose result the card tool kept: `calls`, each call of the card with its version or error
  const id = cardIdOf('toolu_made_up_1')
  const card = async (toolUseId: string, version: number, calls: Record<string, unknown>) => {
    await $.state.set({ plugin: 'thimble', key: 'cardCall', id: toolUseId }, { id })
    await $.state.set({ plugin: 'thimble', key: 'card', id }, { id, version, calls })
    const next = Object.assign(async () => ({ result: 'made up' }), { called: true, origin: { plugin: 'thimble' } })
    await hooks['tool.call']![0]($, { tool: 'mcp__thimble__card', agentId: fork.agentId, tool_use_id: toolUseId }, next)
    await sentNow(sent)
  }
  // the view did not parse: no version is on the screen
  await card('toolu_made_up_1', 0, { toolu_made_up_1: { version: 0, error: 'the view does not parse' } })
  expect((await sentNow(sent)).length).toBe(before)
  // the next call drew version 1
  await card('toolu_made_up_2', 1, { toolu_made_up_1: { version: 0, error: 'the view does not parse' }, toolu_made_up_2: { version: 1 } })
  expect((await sentNow(sent)).slice(before)).toEqual([`${TAG} Step 3 done. Say step 4.`])
  // version 2 sends nothing more
  await card('toolu_made_up_3', 2, { toolu_made_up_2: { version: 1 }, toolu_made_up_3: { version: 2 } })
  expect((await sentNow(sent)).length).toBe(before + 1)
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

test("a turn the tour's prompt started answers nothing; the person's own answers nothing only after the sample answer", async () => {
  noteViewport({ isFullscreen: true })
  expect(tourPrompt({ text: `${TAG} Step 1 done. Say step 2.`, by: 'plugin' })).toBe(true)
  expect(tourPrompt({ text: `The thimble plugin sent a message:\n${TAG} Step 1 done. Say step 2.`, by: 'unknown' })).toBe(true)
  expect(tourPrompt({ text: `${TAG} Step 1 done. Say step 2.`, by: 'composer' })).toBe(false)
  expect(tourPrompt({ text: 'Why did two runs fail?', by: 'plugin' })).toBe(false)
  // a turn of the person's own (its record aside): it answers nothing only while the tour runs after its sample answer
  const { $ } = fake()
  expect(await answersNothing($, 't-mine')).toBe(false)
  await tourStart($)
  // the turn that writes the sample answer is an answer
  expect(await answersNothing($, 't-mine')).toBe(false)
  await tourDid($, 'answer')
  expect(await answersNothing($, 't-mine')).toBe(true)
  await turnTour($)
  expect(await answersNothing($, 't-mine')).toBe(false)
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
  on('prompt.change', (_$: unknown, e: Any) => ({ text: e.text, cursor: e.cursor }))
  on('model.fork', () => ({ value: { isAnswered: true, text: '{}' } }))
  on('process.run', (_$: unknown, e: { argv: string[] }) => ({ value: { ...(tempRun(e.argv) ?? { exitCode: 0, stdout: '', stderr: '' }), isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }) as never)
  on('turn.start', (_$: unknown, e: Any) => ({ turnId: e.turnId }))
  on('turn.complete', (_$: unknown, e: Any) => ({ text: e.answer }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the engine'] }) as never)
}

const SAMPLE = 'Customers placed [36 orders](#) in March 2026. The shop refunded [7 orders](#). Most of the refunded orders arrived on time, so late delivery does not explain the refunds.'
const STEP4 = 'Press s for a shorter, plainer version of the Fernhill Tea answer.'

/** A session where the tour's steps run through the whole hooks module: the prompts as they reach Claude (with what
 *  thimble put beside them), Simplify's calls, and a turn of main's. */
async function session($: Any, on: Any) {
  NO_FILES(on)
  const clock = mock.clock(on, { now: 0 })
  const got: { text: string; by: string; context: string[] }[] = []
  const asked: Any[] = []
  on('prompt.submit', (_$: unknown, e: Any) => {
    got.push({ text: String(e.text), by: String(e.origin?.kind ?? ''), context: [...(e.context ?? [])] })
    return { text: e.text }
  })
  on('prompt.edit', (_$: unknown, e: Any) => ({ text: e.text, cursor: e.cursor }))
  on('prompt.fill', () => ({ isFilled: true }) as never)
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
  const tour = () => got.filter(p => p.by !== 'composer' && p.text.startsWith(TAG)).map(p => p.text)
  const ask = (text: string) => $.prompt.submit({ text, origin: { kind: 'composer' } } as never)
  const press = async (k: string) => { const r = await $.prompt.edit({ origin: { kind: 'composer' }, key: { key: k }, text: '', cursor: 0, start: 0, end: 0, inputText: k } as never); await clock.advance(400); return r }
  return { clock, got, asked, turn, tour, ask, press }
}

test("in a session: the person's question at step 4 gets the step again, and s still simplifies the sample answer; the simpler version sends step 4 done, once", { options: { cards: 'off', explain: 'off', citations: 'off' } }, async ($, on) => {
  noteViewport({ isFullscreen: true })
  const t = await session($, on)
  await $.prompt.submit({ text: '/thimble:tour', command: { name: 'thimble:tour', args: '' }, origin: { kind: 'composer' } } as never)
  await t.turn('t1', '<command-name>/thimble:tour</command-name>', SAMPLE)
  // the sample answer is step 0 done; Cards, Explainers and Citations are off, so the tour goes on to step 4
  expect(t.tour()).toEqual([`${TAG} Step 0 done. Say step 4.`])
  await t.turn('t2', t.tour()[0]!, STEP4)
  // the person's own question: Claude reads beside it to answer and say step 4 again
  await t.ask('What does s do?')
  expect(t.got.at(-1)?.context).toContain(aside('4'))
  await t.turn('t3', 'What does s do?', `It writes a simpler version of the answer. ${STEP4}`)
  // neither the step nor the reply is an answer: s acts on the sample answer
  await t.press('s')
  await t.clock.advance(5000)
  expect(t.asked.length).toBe(1)
  const prompt = String(t.asked[0].prompt)
  expect(prompt).toContain('late delivery does not explain the refunds')
  expect(prompt).not.toContain('It writes a simpler version')
  expect(t.tour()).toEqual([`${TAG} Step 0 done. Say step 4.`, `${TAG} Step 4 done. Say step 5.`])
  // the tour is over: the person's next prompt is no aside
  await t.ask('Thanks.')
  expect(t.got.at(-1)?.context.join('\n') ?? '').not.toContain(TAG)
})

test("in a session: Claude's Skill call starts the tour, and the turn that called it holds the sample answer", { options: { cards: 'off', explain: 'off', citations: 'off', squeezeAnswers: false } }, async ($, on) => {
  noteViewport({ isFullscreen: true })
  const t = await session($, on)
  await t.ask('Yes, show me the tour.')
  await t.turn('t1', 'Yes, show me the tour.', SAMPLE, () => $.tool.call({ tool: 'Skill', skill: 'thimble:tour', tool_use_id: 'toolu_made_up_1' } as never))
  // with every step's feature off, the sample answer goes on to the end
  expect(t.tour()).toEqual([`${TAG} Step 0 done. Say step 5.`])
})

test("in a session: the third prompt of the person's own at one step ends the tour, Claude says so, and its reply is an answer again", { options: { cards: 'off', explain: 'off', citations: 'off' } }, async ($, on) => {
  noteViewport({ isFullscreen: true })
  const t = await session($, on)
  await $.prompt.submit({ text: '/thimble:tour', command: { name: 'thimble:tour', args: '' }, origin: { kind: 'composer' } } as never)
  await t.turn('t1', '<command-name>/thimble:tour</command-name>', SAMPLE)
  expect(t.tour()).toEqual([`${TAG} Step 0 done. Say step 4.`])
  await t.turn('t2', t.tour()[0]!, STEP4)
  for (const [i, q] of ['What is Simplify?', 'Is it slow?'].entries()) {
    await t.ask(q)
    expect(t.got.at(-1)?.context).toContain(aside('4'))
    await t.turn(`t${3 + i}`, q, `A short reply. ${STEP4}`)
  }
  await t.ask('Show me the late orders.')
  expect(t.got.at(-1)?.context).toContain(STOPPED)
  expect(STOPPED).toContain('Type /thimble:tour to start it again.')
  await t.turn('t5', 'Show me the late orders.', 'Six orders arrived late. The tour stopped. Type /thimble:tour to start it again.')
  // the tour ended: the reply is an answer again, which s simplifies, and s sends no step
  await t.press('s')
  await t.clock.advance(5000)
  expect(String(t.asked.at(-1)?.prompt)).toContain('Six orders arrived late')
  expect(t.tour()).toEqual([`${TAG} Step 0 done. Say step 4.`])
})
