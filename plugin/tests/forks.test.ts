// The line that closes a turn of main's while thimble's forks still run (core/forks.ts): Claude Code counts a fork as a
// background agent, so the line would say `Waiting for 2 background agents to finish` and the next turn's line would
// count their time. The line that waits only on thimble's forks reads as a finished turn of its own time, and so does
// the next one; a line that waits on any other agent stays Claude Code's. All data is made up.
// `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { registerForks, spawnFork, turnLine } from '../core/forks'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const line = (requestId: string, durationMs: number, agents?: string[]) => ({
  component: 'TurnDuration', requestId,
  props: { word: 'Brewed', durationMs, ...(agents ? { waitingFor: { agents: agents.map(id => ({ id, agentType: 'fork' })), workflows: 0 } } : {}) },
})

test("a turn's line that waits only on thimble's forks reads as a finished turn, and the next turn's line keeps its own time", async () => {
  const hooks: Record<string, Any> = {}
  const on: Any = (event: string, a: Any, b?: Any) => { hooks[event] = typeof a === 'function' ? a : b; return { catch: () => undefined } }
  registerForks(on, {} as never)
  const state = new Map<string, unknown>()
  let now = 1_000_000
  const $: Any = {
    agent: { spawn: async () => ({ model: 'claude-made-up', agentId: 'fork-1' }) },
    state: {
      get: async (k: Any) => ({ value: state.get(JSON.stringify(k)), version: 0 }),
      set: async (k: Any, v: unknown) => { state.set(JSON.stringify(k), v); return { isSet: true, version: 1 } },
    },
    clock: { now: async () => now },
    ui: { resolve: () => ({ Text: (p: Any) => ({ type: 'Text', props: p }), Box: (p: Any) => ({ type: 'Box', props: p }) }) },
  }
  const set = (key: string, value: unknown, id?: string) => state.set(JSON.stringify({ plugin: 'thimble', key, ...(id ? { id } : {}) }), value)
  const draw = (e: Any) => hooks['ui.render']($, e, async (x: Any) => ({ type: 'engine', props: { children: `engine ${x.props.durationMs}${x.props.waitingFor ? ' waiting' : ''}` } }))
  const textOf = (n: Any): string => (typeof n === 'string' ? n : Array.isArray(n) ? n.map(textOf).join('') : n?.props ? textOf(n.props.children) : '')
  const text = async (e: Any) => textOf(await draw(e))
  expect(turnLine('Brewed', 23_400)).toBe('✻ Brewed for 23s')
  expect(turnLine('Cooked', 371_000)).toBe('✻ Cooked for 6m 11s')
  // a fork thimble started (a citation check)
  expect((await spawnFork($, { kind: 'checker', prompt: 'check', description: 'checking citations' })).agentId).toBe('fork-1')
  expect(await text(line('d1', 5000, ['fork-1']))).toBe('✻ Brewed for 5s')
  // a line that also waits on another agent of the session's stays Claude Code's
  expect(await text(line('d1', 5000, ['fork-1', 'agent-9']))).toBe('engine 5000 waiting')
  expect(await text(line('d1', 5000, ['fork-1']))).toBe('✻ Brewed for 5s')
  // the next turn of main's took 4 s and ended after the forks did: Claude Code counts from the earlier turn's start
  set('answerTurns', ['t2'])
  set('answerTurn', { turnId: 't2', n: 2, prompt: { text: 'next', by: 'composer', row: null }, rows: [], answer: null, reason: 'answer', startedAt: now - 4000, endedAt: now, labels: [], cards: [], seq: 0 }, 't2')
  expect(await text(line('d2', 77_000))).toBe('engine 4000')
  // drawn again, the same; a later line with no wait before it is Claude Code's own
  expect(await text(line('d2', 77_000))).toBe('engine 4000')
  now += 60_000
  expect(await text(line('d3', 9000))).toBe('engine 9000')
})
