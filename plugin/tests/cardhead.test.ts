// The artifact of a card (cards/head.ts), on a plain engine whose $.agent.spawn runs this module's agent.spawn hook and
// names the fork it started: while the fork works the card and the bar's busy line say so; its last message's link
// shows under the card once, with a press that copies it, and a message with no link says why there is none; one press
// publishes a card once, and a word that starts with p leaves the card's link as it was; a reload of the plugin while
// a fork publishes loses neither the publish nor its end; main reads the link, or why there is none, with the next
// prompt. All data is made up. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { busySteps, busyWhile } from '../bar/busy'
import { artifactLine, artifactMaking, launch, registerCardHead } from '../cards/head'
import { registerForks } from '../core/forks'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

function setup() {
  const hooks: Record<string, Any> = {}
  const on: Any = (event: string, a: Any, b?: Any) => {
    if (!hooks[event]) hooks[event] = []
    hooks[event].push(typeof a === 'function' ? a : b)
    return { catch: () => undefined }
  }
  // the fork registry first, as hooks/register.ts has it: it wraps this module, so at a session start this module's
  // work after `next` runs before the registry knows the forks again (start)
  registerForks(on, {} as never)
  registerCardHead(on, {} as never)
  const state = new Map<string, unknown>()
  // the agents Claude Code runs, as $.agent.list() gives them
  const agents: Any[] = []
  // the forks Claude Code started: the spawns this module's agent.spawn hook let go
  const spawns: Any[] = []
  // the clock; a sleep (the word window's) lasts until the test wakes it, and the timers wait until it ticks
  const timers: (() => unknown)[] = []
  const clock = { now: 1000, wake: () => undefined as unknown, tick: async () => { for (const f of timers.splice(0)) f(); await settle() } }
  const started = async (a: Any) => { spawns.push(a); return { model: 'claude-made-up', agentId: `agent-made-up-${spawns.length}` } }
  const copies: Any[] = []
  let copyGoes: Any = { isCopied: true }
  const $: Any = {
    state: {
      get: async (k: Any) => ({ value: state.get(JSON.stringify(k)) }),
      set: async (k: Any, v: unknown) => { state.set(JSON.stringify(k), v); return { isSet: true } },
    },
    agent: { spawn: async (a: Any) => hooks['agent.spawn'][0]($, a, Object.assign(async () => started(a), { origin: { plugin: 'thimble' } })), list: async () => agents },
    clock: { now: async () => clock.now, sleep: () => new Promise<void>(r => { clock.wake = r }), after: (_ms: number, f: () => unknown) => { timers.push(f); return { cancel() {} } } },
    // the clipboard: what each copy put there, and how the copy went
    ui: { invalidate: () => undefined, copy: async (a: Any) => { copies.push(a); return copyGoes } },
  }
  const el = (type: string) => (props: Any) => ({ type, props })
  const E = { Box: el('Box'), Text: el('Text'), Link: el('Link'), Button: el('Button') }
  const ended = async (agentId: string, answer: string, reason = 'answer') => {
    for (const h of hooks['turn.complete']) await h($, { agentId, reason, answer }, async () => ({}))
  }
  // what an earlier load of the plugin kept in $.state
  const kept = (ref: Any, value: unknown) => { state.set(JSON.stringify(ref), value) }
  // a session start (the reload) as the engine runs it: the registry's hook calls this module's as its `next`, so this
  // module's work ends before the registry's begins; `between` comes in that gap
  const start = async (between?: () => Promise<unknown>) => {
    const [forks, head] = hooks['session.start']
    await forks($, { cwd: '/made-up/data' }, async (e: Any) => {
      const r = await head($, e, async () => ({}))
      await between?.()
      return r
    })
  }
  // the bar's next tick, which takes out each job that ended, earlier tests' too: a job begun for it asks for the tick,
  // and the clock stays, so the tick shows nothing and stops
  const barTick = async () => {
    await busyWhile($, 'a tick', () => false)
    await clock.tick()
  }
  // what main reads with the person's next prompt (core/tell.ts)
  const told = () => Object.values((state.get(JSON.stringify({ plugin: 'thimble', key: 'tell' })) ?? {}) as Record<string, string>).join('\n')
  return { $, E, ended, spawns, clock, barTick, copies, copyFails: (reason: string) => { copyGoes = { isCopied: false, reason } }, agents, kept, start, told }
}

/** A publish an earlier load of the plugin started: its fork, and the card's record. */
function earlier(s: ReturnType<typeof setup>, card: string, agentId: string) {
  s.kept({ plugin: 'thimble', key: 'forks' }, { [agentId]: 'artifact' })
  s.kept({ plugin: 'thimble', key: 'cardArtifacts', id: card }, { card, status: 'running', agentId, until: 0 })
  s.kept({ plugin: 'thimble', key: 'cardArtifactsNow' }, [card])
}

const settle = () => new Promise(r => setTimeout(r, 0))
/** The bar's steps of a publish, earlier tests' too. */
const steps = () => busySteps().filter(w => w === 'publishing an artifact').length

// the words as Claude Code draws them: a Link with words of its own (children, a label) draws them, then its address
const words = (n: Any): string => {
  if (n == null) return ''
  if (typeof n === 'string') return n
  if (Array.isArray(n)) return n.map(words).join('')
  const own = words(n.props?.children ?? n.props?.label)
  return n.type === 'Link' ? (own ? `${own} ${n.props.href}` : n.props.href) : own
}

// first in the file: the bar's jobs are the module's, and no test before it leaves one that runs
test('while a fork publishes the card, the bar\'s busy line names the step; it goes once the fork ended', async () => {
  const { $, ended, clock } = setup()
  await launch($, 'c-made-up-0', 'PROMPT artifact', 0).now()
  await settle()
  expect(busySteps()).toContain('publishing an artifact')
  // the step shows once it ran a while, and the line ticks
  clock.now += 1000
  await clock.tick()
  await ended('agent-made-up-1', 'https://claude.ai/artifact/made-up-0')
  // the next tick finds the fork ended
  await clock.tick()
  expect(busySteps()).not.toContain('publishing an artifact')
})

test('a card being made an artifact says so, then shows the link the fork ended with', async () => {
  const { $, E, ended } = setup()
  await launch($, 'c-made-up-1', 'PROMPT artifact', 0).now()
  await settle()
  expect(await artifactMaking($, 'c-made-up-1')).toBe(true)
  const making = words(await artifactLine($, E, 'c-made-up-1'))
  expect(making).toContain('link')
  expect(making).not.toContain('×')
  await ended('agent-made-up-1', 'Published.\nhttps://claude.ai/artifact/made-up-123')
  expect(await artifactMaking($, 'c-made-up-1')).toBe(false)
  const line = await artifactLine($, E, 'c-made-up-1')
  const link = line.props.children.find((c: Any) => c.type === 'Link')
  expect(link.props.href).toBe('https://claude.ai/artifact/made-up-123')
  // the address shows once
  expect(words(line).split('https://claude.ai/artifact/made-up-123').length - 1).toBe(1)
})

test('a press on `copy` beside the link puts the link on the clipboard of the surface pressed on, and says whether it took', async () => {
  const { $, E, ended, copies, copyFails } = setup()
  await launch($, 'c-made-up-6', 'PROMPT artifact', 0).now()
  await settle()
  await ended('agent-made-up-1', 'https://claude.ai/artifact/made-up-6')
  const copy = async () => (await artifactLine($, E, 'c-made-up-6')).props.children.find((c: Any) => c.type === 'Button')
  expect(words(await copy())).toBe('copy')
  await (await copy()).props.onPress({ surface: 'terminal' })
  expect(copies).toEqual([{ text: 'https://claude.ai/artifact/made-up-6', surface: 'terminal' }])
  expect(words(await copy())).toBe('copied')
  // a terminal with no clipboard: the press says so, and the link stays to select
  copyFails('no-clipboard')
  await (await copy()).props.onPress({ surface: 'terminal' })
  expect(words(await copy())).toContain('no clipboard')
  expect(words(await artifactLine($, E, 'c-made-up-6'))).toContain('https://claude.ai/artifact/made-up-6')
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

test('a reload of the plugin while a fork publishes the card: the publish shows again, with its busy step, and its end shows the link', async () => {
  const s = setup()
  earlier(s, 'c-made-up-7', 'agent-earlier-7')
  s.agents.push({ id: 'agent-earlier-7', status: 'running' })
  const before = steps()
  await s.start()
  expect(await artifactMaking(s.$, 'c-made-up-7')).toBe(true)
  expect(steps()).toBe(before + 1)
  await s.ended('agent-earlier-7', 'https://claude.ai/artifact/made-up-7')
  expect(await artifactMaking(s.$, 'c-made-up-7')).toBe(false)
  expect(words(await artifactLine(s.$, s.E, 'c-made-up-7'))).toContain('https://claude.ai/artifact/made-up-7')
})

test('a fork whose end comes at a reload before the fork registry knows it again still shows its link, and its busy step goes', async () => {
  // the end comes after this module's session start work, before the registry's
  const s = setup()
  await s.barTick()
  const before = steps()
  earlier(s, 'c-made-up-8', 'agent-earlier-8')
  s.agents.push({ id: 'agent-earlier-8', status: 'running' })
  await s.start(() => s.ended('agent-earlier-8', 'https://claude.ai/artifact/made-up-8'))
  expect(words(await artifactLine(s.$, s.E, 'c-made-up-8'))).toContain('https://claude.ai/artifact/made-up-8')
  await s.barTick()
  expect(steps()).toBe(before)
  // the end comes before the session start: the start neither shows the publish again nor says thimble lost the copy
  const r = setup()
  earlier(r, 'c-made-up-12', 'agent-earlier-12')
  r.agents.push({ id: 'agent-earlier-12', status: 'completed' })
  await r.ended('agent-earlier-12', 'https://claude.ai/artifact/made-up-12')
  await r.start()
  expect(words(await artifactLine(r.$, r.E, 'c-made-up-12'))).toContain('https://claude.ai/artifact/made-up-12')
  expect(steps()).toBe(before)
})

test('at a reload, a publish whose fork Claude Code no longer runs ends as failed, and says so under the card', async () => {
  const s = setup()
  earlier(s, 'c-made-up-9', 'agent-earlier-9')
  // its end came while the plugin loaded
  s.agents.push({ id: 'agent-earlier-9', status: 'completed' })
  await s.start()
  expect(await artifactMaking(s.$, 'c-made-up-9')).toBe(false)
  expect(words(await artifactLine(s.$, s.E, 'c-made-up-9'))).toContain('× no artifact')
})

test("main reads the artifact's link with the person's next prompt, or why no artifact was published", async () => {
  const s = setup()
  await launch(s.$, 'c-made-up-10', 'PROMPT artifact', 0).now()
  await settle()
  expect(s.told()).toBe('')
  await s.ended('agent-made-up-1', 'https://claude.ai/artifact/made-up-10')
  expect(s.told()).toContain('https://claude.ai/artifact/made-up-10')
  expect(s.told()).toContain('c-made-up-10')
  await launch(s.$, 'c-made-up-11', 'PROMPT artifact', 0).now()
  await settle()
  await s.ended('agent-made-up-2', 'No Artifact tool is available in this session.')
  expect(s.told()).toContain('No Artifact tool is available in this session')
})
