// The artifact of a card (cards/head.ts), on a plain engine whose $.agent.spawn names the fork it started: while the
// fork works the card says `creating artifact…`; its last message's link shows under the card, and a message with no
// link says why there is none. All data is made up. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { artifactLine, launch, registerCardHead } from '../cards/head'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

function setup() {
  const hooks: Record<string, Any> = {}
  const on: Any = (event: string, a: Any, b?: Any) => {
    if (!hooks[event]) hooks[event] = []
    hooks[event].push(typeof a === 'function' ? a : b)
    return { catch: () => undefined }
  }
  registerCardHead(on, {} as never)
  const state = new Map<string, unknown>()
  let n = 0
  const $: Any = {
    state: {
      get: async (k: Any) => ({ value: state.get(JSON.stringify(k)) }),
      set: async (k: Any, v: unknown) => { state.set(JSON.stringify(k), v); return { isSet: true } },
    },
    agent: { spawn: async () => ({ model: 'claude-made-up', agentId: `agent-made-up-${++n}` }) },
    ui: { invalidate: () => undefined },
  }
  const el = (type: string) => (props: Any) => ({ type, props })
  const E = { Box: el('Box'), Text: el('Text'), Link: el('Link') }
  const ended = async (agentId: string, answer: string, reason = 'answer') => {
    for (const h of hooks['turn.complete']) await h($, { agentId, reason, answer }, async () => ({}))
  }
  return { $, E, ended }
}

const words = (n: Any): string => (n == null ? '' : typeof n === 'string' ? n : Array.isArray(n) ? n.map(words).join('') : words(n.props?.children ?? n.props?.label))

test('a card being made an artifact says so, then shows the link the fork ended with', async () => {
  const { $, E, ended } = setup()
  await launch($, 'c-made-up-1', 'PROMPT artifact', 0).now()
  await new Promise(r => setTimeout(r, 0))
  expect(words(await artifactLine($, E, 'c-made-up-1'))).toBe('creating artifact…')
  await ended('agent-made-up-1', 'Published.\nhttps://claude.ai/artifact/made-up-123')
  const line = await artifactLine($, E, 'c-made-up-1')
  const link = line.props.children.find((c: Any) => c.type === 'Link')
  expect(link.props.href).toBe('https://claude.ai/artifact/made-up-123')
})

test('a fork that publishes nothing says why under the card; a card with no artifact has no line', async () => {
  const { $, E, ended } = setup()
  expect(await artifactLine($, E, 'c-made-up-2')).toBe(null)
  await launch($, 'c-made-up-2', 'PROMPT artifact', 0).now()
  await new Promise(r => setTimeout(r, 0))
  await ended('agent-made-up-1', 'No Artifact tool is available in this session.')
  expect(words(await artifactLine($, E, 'c-made-up-2'))).toBe('× no artifact: No Artifact tool is available in this session.')
})
