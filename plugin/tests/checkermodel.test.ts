// The model the checker of the citations runs on (the setting Verifier model, marks/register.ts): each request of a
// checker fork's turn names the model the setting names, by its id (core/models.js); main's requests and another
// fork's never change. All data is made up. `claude plugin test plugin`.
import { expect } from 'claude-code/testing'

import { spawnFork } from '../core/forks'
import { registerMarks } from '../marks/register'
import { setOptions } from '../settings/features.mjs'
import { test } from './kit'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** The marks module's hooks, on an engine whose forks start: the model each step of an agent's turn is sent with, and its
 *  effort. */
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
    env: { get: async () => undefined },
  }
  const checker = (await spawnFork($, { kind: 'checker', prompt: 'CHECK', description: 'checking citations' })).agentId!
  const designer = (await spawnFork($, { kind: 'designer', prompt: 'DESIGN', description: 'designing a card' })).agentId!
  /** The model and the effort a step of `agentId`'s turn (main's when none) is sent with, through the marks module's
   *  turn.step hooks. */
  const step = async (agentId?: string): Promise<{ model: string; effort?: unknown }> => {
    let got: { model: string; effort?: unknown } = { model: '' }
    const chain = hooks['turn.step'] ?? []
    const at = (i: number): ((e: Any) => AsyncGenerator<unknown, Any>) => async function* (e: Any) {
      if (i < chain.length) return yield* chain[i]($, e, at(i + 1))
      got = { model: e.model, effort: e.effort }
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] }
    }
    for await (const _ of at(0)({ turnId: 't1', index: 0, model: 'claude-made-up-opus', effort: 'high', messageCount: 3, ...(agentId ? { agentId } : {}) })) { /* the step's pieces */ }
    return got
  }
  const sent = async (agentId?: string): Promise<string> => (await step(agentId)).model
  return { sent, checker, designer }
}

test("with Verifier model Haiku 5.5, each request of the checker's turn names Haiku's id; main's and the designer's keep their model", async () => {
  const { sent, checker, designer } = await setup()
  setOptions({ checkerModel: 'Haiku 5.5' })
  try {
    expect(await sent(checker)).toBe('claude-haiku-5-5')
    expect(await sent()).toBe('claude-made-up-opus')
    expect(await sent(designer)).toBe('claude-made-up-opus')
    expect(await sent('agent-of-someone-else')).toBe('claude-made-up-opus')
    setOptions({ checkerModel: 'Sonnet 5.5' })
    expect(await sent(checker)).toBe('claude-sonnet-5-5')
  } finally {
    setOptions({})
  }
})
