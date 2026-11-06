// The artifact of a card (cards/head.ts), on a plain engine whose $.agent.spawn runs this module's agent.spawn hook and
// names the fork it started: while the fork works the card says so, and its last message's link shows under the card
// once. All data is made up. `claude plugin test plugin`.
import { expect } from 'claude-code/testing'

import { artifactLine, launch, registerCardHead } from '../cards/head'
import { registerForks } from '../core/forks'
import { test } from './kit'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

function setup() {
  const hooks: Record<string, Any> = {}
  const on: Any = (event: string, a: Any, b?: Any) => {
    if (!hooks[event]) hooks[event] = []
    hooks[event].push(typeof a === 'function' ? a : b)
    return { catch: () => undefined }
  }
  // the fork registry first, as hooks/register.ts has it
  registerForks(on, {} as never)
  registerCardHead(on, {} as never)
  const state = new Map<string, unknown>()
  // the forks Claude Code started: the spawns this module's agent.spawn hook let go
  let spawns = 0
  const started = async () => ({ model: 'claude-made-up', agentId: `agent-made-up-${++spawns}` })
  const $: Any = {
    state: {
      // each read gives a copy of its own, as the engine's does
      get: async (k: Any) => {
        const v = state.get(JSON.stringify(k))
        return { value: v === undefined ? undefined : JSON.parse(JSON.stringify(v)) }
      },
      set: async (k: Any, v: unknown) => { state.set(JSON.stringify(k), v); return { isSet: true } },
    },
    agent: { spawn: async (a: Any) => hooks['agent.spawn'][0]($, a, Object.assign(async () => started(), { origin: { plugin: 'thimble' } })), list: async () => [] },
    clock: { now: async () => 1000, sleep: () => new Promise<void>(() => undefined), after: () => ({ cancel() {} }) },
    ui: { invalidate: () => undefined },
  }
  const el = (type: string) => (props: Any) => ({ type, props })
  const E = { Box: el('Box'), Text: el('Text'), Link: el('Link') }
  const ended = async (agentId: string, answer: string, reason = 'answer') => {
    for (const h of hooks['turn.complete']) await h($, { agentId, reason, answer }, async () => ({}))
  }
  return { $, E, ended }
}

const settle = () => new Promise(r => setTimeout(r, 0))
/** The line under a card while its artifact is being made. */
const MAKING = 'creating artifact…'
// the words as Claude Code draws them: a Link with words of its own (children, a label) draws them, then its address
const words = (n: Any): string => {
  if (n == null) return ''
  if (typeof n === 'string') return n
  if (Array.isArray(n)) return n.map(words).join('')
  const own = words(n.props?.children ?? n.props?.label)
  return n.type === 'Link' ? (own ? `${own} ${n.props.href}` : n.props.href) : own
}

test('a card being made an artifact says so, then shows the link the fork ended with', async () => {
  const { $, E, ended } = setup()
  await launch($, 'c-made-up-1', 'PROMPT artifact', 0).now()
  await settle()
  expect(words(await artifactLine($, E, 'c-made-up-1'))).toBe(MAKING)
  await ended('agent-made-up-1', 'Published.\nhttps://claude.ai/artifact/made-up-123')
  const line = await artifactLine($, E, 'c-made-up-1')
  const link = line.props.children.find((c: Any) => c.type === 'Link')
  expect(link.props.href).toBe('https://claude.ai/artifact/made-up-123')
  // the address shows once
  expect(words(line).split('https://claude.ai/artifact/made-up-123').length - 1).toBe(1)
})
