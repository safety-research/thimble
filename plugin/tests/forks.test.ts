// A fork's commands (core/forks.ts): a fork of thimble's runs its Bash in the foreground, so it ends in its own turn
// and Claude Code sends main nothing of it. All data is made up.
// `claude plugin test plugin`.
import { expect } from 'claude-code/testing'

import { FORK_BASH_MS, registerForks, spawnFork } from '../core/forks'
import { test } from './kit'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

// N125, N128: a fork that ran a command in the background waited for it, its row in Claude Code's list of agents stood
// still, and its later end reached main's queue, where the drop left `Prompt dropped by a hook` in main's conversation.
// A fork's commands run in the foreground, as long as a foreground command may; main's, other agents' and the fixer's
// calls go as they are
test("a fork's Bash call runs in the foreground for as long as a foreground command may; main's, another agent's and the fixer's are left as they are", async () => {
  const hooks: Record<string, Any> = {}
  const on: Any = (event: string, a: Any, b?: Any) => { hooks[event] = typeof a === 'function' ? a : b; return { catch: () => undefined } }
  registerForks(on, {} as never)
  let n = 0
  const $: Any = {
    agent: { spawn: async () => ({ model: 'claude-made-up', agentId: `fork-bash-${++n}` }) },
    state: { get: async () => ({ value: undefined, version: 0 }), set: async () => ({ isSet: true, version: 1 }) },
  }
  const thread = (await spawnFork($, { kind: 'thread', prompt: 'ask', description: 'thread · made-up' })).agentId!
  const checker = (await spawnFork($, { kind: 'checker', prompt: 'check', description: 'checking citations' })).agentId!
  const fixer = (await spawnFork($, { kind: 'fixer', prompt: 'fix', description: 'fix' })).agentId!
  const call = async (input: Any) => hooks['tool.call']($, { tool: 'Bash', tool_use_id: 'toolu_made_up', ...input }, async (x: Any) => x)
  const scan = { command: "python3 - <<'EOF'\nprint(1)\nEOF", description: 'Scan the made-up traces' }
  expect(FORK_BASH_MS).toBe(600_000)
  // the fork asked for the background, or for a limit after which Claude Code would move the command there
  expect(await call({ ...scan, agentId: thread, run_in_background: true })).toEqual({ tool: 'Bash', tool_use_id: 'toolu_made_up', ...scan, agentId: thread, run_in_background: false, timeout: 600_000 })
  expect(await call({ ...scan, agentId: checker, timeout: 120_000 })).toEqual({ tool: 'Bash', tool_use_id: 'toolu_made_up', ...scan, agentId: checker, run_in_background: false, timeout: 600_000 })
  // main's, an agent thimble did not start, and the fixer's (fix/fixer.ts sets its own)
  expect(await call({ ...scan, run_in_background: true })).toEqual({ tool: 'Bash', tool_use_id: 'toolu_made_up', ...scan, run_in_background: true })
  expect(await call({ ...scan, agentId: 'agent-of-the-model', run_in_background: true })).toEqual({ tool: 'Bash', tool_use_id: 'toolu_made_up', ...scan, agentId: 'agent-of-the-model', run_in_background: true })
  expect(await call({ ...scan, agentId: fixer, timeout: 30_000 })).toEqual({ tool: 'Bash', tool_use_id: 'toolu_made_up', ...scan, agentId: fixer, timeout: 30_000 })
})
