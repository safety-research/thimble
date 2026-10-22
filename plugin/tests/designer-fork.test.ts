// The designer fork's life (designer/v.ts), on a plain engine whose $.agent.spawn names the fork it started: its cards
// anchor to the answer v was pressed on, the busy line names it while it runs, and its end says why it drew no card.
// All data is made up. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { busySteps } from '../bar/busy'
import { fixLineNow } from '../bar/fix'
import { saveMeta } from '../cards/store'
import { designAnchor, registerDesigner } from '../designer/v'
import { promptStub } from './stubs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const ROW = 'row-answer-1'
// each look at the clock, in any test, is a second later: no word window is open at the next look
let now = 0

/** The module's hooks by event, and an engine that keeps state and spawns in memory. */
function setup() {
  const hooks: Record<string, Any> = {}
  const on: Any = (event: string, a: Any, b?: Any) => {
    hooks[event] = typeof a === 'function' ? a : b
    return { catch: () => undefined }
  }
  registerDesigner(on, {} as never)
  const state = new Map<string, unknown>()
  const spawns: Any[] = []
  const $: Any = {
    plugin: { root: '/made-up/plugins/thimble/plugin', name: 'thimble' },
    env: { get: async () => undefined },
    fs: { read: async (p: string) => promptStub(p) ?? '' },
    state: {
      get: async (k: Any) => ({ value: state.get(JSON.stringify(k)) }),
      set: async (k: Any, v: unknown) => { state.set(JSON.stringify(k), v) },
    },
    clock: { now: async () => (now += 1000), sleep: async () => undefined, after: () => ({ cancel() {} }) },
    agent: { spawn: async (a: Any) => { spawns.push(a); return { model: 'claude-made-up', agentId: `agent-${spawns.length}` } } },
    session: { id: async () => 's-made-up' },
    // the card runner, as far as a text copy goes
    http: { fetch: async () => ({ text: JSON.stringify({ ok: true, lines: ['Who ran the failing test', '✕ ✕ ● ✕'] }) }) },
  }
  $.fs.write = async () => undefined
  const pass = async (e: Any) => e
  const call = (event: string, e: Any, next: Any = pass) => hooks[event]($, e, next)
  const failLine = async () => String((await fixLineNow($))?.text ?? '')
  return { $, call, failLine, spawns }
}

const settle = () => new Promise(r => setTimeout(r, 5))

/** Main answers, then the person presses v: the design runs. */
async function pressV(s: ReturnType<typeof setup>) {
  await s.call('session.append', { door: 'response', origin: { kind: 'model', model: 'claude-made-up' }, message: { content: [{ type: 'text', text: 'The revert undid a change.' }] } }, async () => ({ uuid: ROW }))
  const r = await s.call('prompt.edit', { origin: { kind: 'composer' }, key: { key: 'v' }, text: '', inputText: 'v' })
  expect(r.text).toBe('')
  await settle()
  expect(s.spawns.length).toBe(1)
}

/** A card the card tool drew for an agent, as cards/tool.ts keeps it. */
const card = (id: string, agentId: string) => ({ id, version: 2, title: 'Runs of the failing test', toolUseId: `tu-${id}`, agentId, anchorRow: ROW, keys: [], rows: 9, columns: [], file: 'runs.json', gen: 2, error: null, calls: {}, at: 1 })

const end = (reason: string, answer = '', more: Any = {}) => ({ turnId: 't-1', agentId: 'agent-1', reason, answer, durationMs: 5, isAborted: reason === 'aborted', ...more })

test("the fork's cards anchor to the answer v was pressed on, and a fork that drew none says why", async () => {
  const s = setup()
  await pressV(s)
  expect(s.spawns[0].prompt).toBe('PROMPT designer')
  expect(designAnchor('agent-1')).toBe(ROW)
  expect(designAnchor('agent-2')).toBe(null)
  expect(busySteps()).toContain('drawing a card')
  // a later answer does not move the design's anchor
  await s.call('session.append', { door: 'response', origin: { kind: 'model', model: 'claude-made-up' }, message: { content: [{ type: 'text', text: 'A later answer.' }] } }, async () => ({ uuid: 'row-answer-2' }))
  expect(designAnchor('agent-1')).toBe(ROW)
  await s.call('turn.complete', end('answer', 'The records hold no times to draw.\nMore words.'), async () => ({ text: '' }))
  expect(await s.failLine()).toContain('v drew no card: The records hold no times to draw.')
  expect(designAnchor('agent-1')).toBe(null)
})

test("a refused design says that the model's safeguards refused it, and how to switch models", async () => {
  const s = setup()
  await pressV(s)
  await s.call('turn.complete', end('refusal', '', { refusal: { category: null, explanation: null } }), async () => ({ text: '' }))
  expect(await s.failLine()).toContain("The model's safeguards refused to draw this card. /model can switch to another model")
  expect(designAnchor('agent-1')).toBe(null)
})

test('a fork that drew a card ends done, and main reads the card with the next prompt', async () => {
  const s = setup()
  await pressV(s)
  await saveMeta(s.$, card('c0000000000001', 'agent-1') as never)
  await s.call('turn.complete', end('answer', 'Runs of the failing test: a timeline.'), async () => ({ text: '' }))
  expect(await s.failLine()).toBe('')
  const told = Object.values(((await s.$.state.get({ plugin: 'thimble', key: 'tell' })).value ?? {}) as Record<string, string>).join('\n')
  expect(told).toContain('a copy of you drew a card under it')
  expect(told).toContain('“Runs of the failing test”\nWho ran the failing test\n✕ ✕ ● ✕')
})
