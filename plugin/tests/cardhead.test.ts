// The artifact of a card (cards/head.ts), on a plain engine whose $.agent.spawn runs this module's agent.spawn hook and
// names the fork it started: while the fork works the card says `creating artifact…`; its last message's link shows
// under the card, and a message with no link says why there is none; one press publishes a card once, and a word that
// starts with p leaves the card's link as it was. All data is made up. `claude plugin test plugin`.
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
  // the forks Claude Code started: the spawns this module's agent.spawn hook let go
  const spawns: Any[] = []
  // the clock; a sleep (the word window's) lasts until the test wakes it
  const clock = { now: 1000, wake: () => undefined as unknown }
  const started = async (a: Any) => { spawns.push(a); return { model: 'claude-made-up', agentId: `agent-made-up-${spawns.length}` } }
  const $: Any = {
    state: {
      get: async (k: Any) => ({ value: state.get(JSON.stringify(k)) }),
      set: async (k: Any, v: unknown) => { state.set(JSON.stringify(k), v); return { isSet: true } },
    },
    agent: { spawn: async (a: Any) => hooks['agent.spawn'][0]($, a, Object.assign(async () => started(a), { origin: { plugin: 'thimble' } })) },
    clock: { now: async () => clock.now, sleep: () => new Promise<void>(r => { clock.wake = r }), after: () => ({ cancel() {} }) },
    ui: { invalidate: () => undefined },
  }
  const el = (type: string) => (props: Any) => ({ type, props })
  const E = { Box: el('Box'), Text: el('Text'), Link: el('Link') }
  const ended = async (agentId: string, answer: string, reason = 'answer') => {
    for (const h of hooks['turn.complete']) await h($, { agentId, reason, answer }, async () => ({}))
  }
  return { $, E, ended, spawns, clock }
}

const settle = () => new Promise(r => setTimeout(r, 0))

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

test('two presses on a card at once start one fork, and a press while it publishes starts none', async () => {
  const { $, E, ended, spawns } = setup()
  // a double click, or p and a click on `artifact`: each press made its fork's prompt before either started
  const presses = [launch($, 'c-made-up-3', 'PROMPT artifact', 0), launch($, 'c-made-up-3', 'PROMPT artifact', 0)]
  await Promise.all(presses.map(t => t.now()))
  await settle()
  expect(spawns.length).toBe(1)
  await launch($, 'c-made-up-3', 'PROMPT artifact', 0).now()
  await settle()
  expect(spawns.length).toBe(1)
  // once it ended, a press publishes the card again
  await ended('agent-made-up-1', 'https://claude.ai/artifact/made-up-3')
  expect(words(await artifactLine($, E, 'c-made-up-3'))).toContain('https://claude.ai/artifact/made-up-3')
  await launch($, 'c-made-up-3', 'PROMPT artifact', 0).now()
  await settle()
  expect(spawns.length).toBe(2)
})

test('a word that starts with p leaves the link under the card as it was, and starts no fork', async () => {
  const { $, E, ended, spawns, clock } = setup()
  await launch($, 'c-made-up-4', 'PROMPT artifact', 0).now()
  await settle()
  await ended('agent-made-up-1', 'https://claude.ai/artifact/made-up-4')
  const line = async () => words(await artifactLine($, E, 'c-made-up-4'))
  expect(await line()).toContain('https://claude.ai/artifact/made-up-4')
  // p at an empty prompt: its fork waits out the word window, and the card shows nothing of it meanwhile
  const p = launch($, 'c-made-up-4', 'PROMPT artifact', clock.now + 350)
  await p.now()
  await settle()
  expect(await line()).toContain('https://claude.ai/artifact/made-up-4')
  // a letter came in the window: the person typed a word ("page"), so the fork is refused, and the link stays
  await p.undo()
  clock.wake()
  await settle()
  expect(spawns.length).toBe(1)
  expect(await line()).toContain('https://claude.ai/artifact/made-up-4')
  // p alone: once the window closed, the publish starts and shows
  const again = launch($, 'c-made-up-4', 'PROMPT artifact', clock.now + 350)
  await again.now()
  await settle()
  clock.wake()
  await settle()
  expect(spawns.length).toBe(2)
  expect(await line()).not.toContain('https://claude.ai/artifact/made-up-4')
})
