// The model the checker of the citations runs on (the setting Checker, marks/register.ts): a fork keeps the
// conversation's model, so each request of a checker fork's turn names the model the setting names, by its id
// (core/models.js); unset, or same as Claude, the request goes as it is. Main's requests and another fork's never
// change. All data is made up. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { spawnFork } from '../core/forks'
import { registerMarks } from '../marks/register'
import { setOptions } from '../settings/features.mjs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** The marks module's hooks, on an engine whose forks start: the model each step of an agent's turn is sent with. */
async function setup() {
  const hooks: Record<string, Any[]> = {}
  const on: Any = (event: string, a: Any, b?: Any) => {
    ;(hooks[event] ??= []).push(typeof a === 'function' ? a : b)
    return { catch: () => undefined }
  }
  registerMarks(on, {} as never)
  let n = 0
  const state = new Map<string, unknown>()
  const $: Any = {
    agent: { spawn: async () => ({ model: 'claude-made-up-opus', agentId: `agent-${++n}` }) },
    state: { get: async (k: Any) => ({ value: state.get(JSON.stringify(k)), version: 0 }), set: async (k: Any, v: unknown) => { state.set(JSON.stringify(k), v); return { isSet: true, version: 1 } } },
  }
  const checker = (await spawnFork($, { kind: 'checker', prompt: 'CHECK', description: 'checking citations' })).agentId!
  const designer = (await spawnFork($, { kind: 'designer', prompt: 'DESIGN', description: 'designing a card' })).agentId!
  /** The model a step of `agentId`'s turn (main's when none) is sent with, through the marks module's turn.step hooks. */
  const sent = async (agentId?: string): Promise<string> => {
    let model = ''
    const chain = hooks['turn.step'] ?? []
    const at = (i: number): ((e: Any) => AsyncGenerator<unknown, Any>) => async function* (e: Any) {
      if (i < chain.length) return yield* chain[i]($, e, at(i + 1))
      model = e.model
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] }
    }
    for await (const _ of at(0)({ turnId: 't1', index: 0, model: 'claude-made-up-opus', effort: 'high', messageCount: 3, ...(agentId ? { agentId } : {}) })) { /* the step's pieces */ }
    return model
  }
  return { sent, checker, designer }
}

test("with Checker haiku, each request of the checker's turn names Haiku's id; main's and the designer's keep their model", async () => {
  const { sent, checker, designer } = await setup()
  setOptions({ checkerModel: 'haiku' })
  try {
    expect(await sent(checker)).toBe('claude-haiku-5-5')
    expect(await sent()).toBe('claude-made-up-opus')
    expect(await sent(designer)).toBe('claude-made-up-opus')
    expect(await sent('agent-of-someone-else')).toBe('claude-made-up-opus')
    setOptions({ checkerModel: 'sonnet' })
    expect(await sent(checker)).toBe('claude-sonnet-5-5')
  } finally {
    setOptions({})
  }
})

test("unset, or same as Claude, the checker's requests keep the conversation's model", async () => {
  const { sent, checker } = await setup()
  setOptions({})
  expect(await sent(checker)).toBe('claude-made-up-opus')
  setOptions({ checkerModel: 'same as Claude' })
  expect(await sent(checker)).toBe('claude-made-up-opus')
  // a value that is no choice of the setting is its default
  setOptions({ checkerModel: 'claude-made-up-tiny' })
  expect(await sent(checker)).toBe('claude-made-up-opus')
  setOptions({})
})
