// The plugin's one hooks module (plugin/hooks/register.ts): thimble.ts's hooks are registered first and the terminal
// UI's after them, so the file guard's tool.call is the outermost (a plugin's registrations nest in order, first
// outermost); in a session both parts' tool.call hooks fire; and a terminal UI whose register throws leaves the file
// guard refusing a token file and the bridge's hooks firing. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { register } from '../register'
import { register as term } from '../term/register'
import { CLI, CWD, world } from '../term/tests/fixtures'
import { PRIVATE_FALLBACK, register as bridge } from '../thimble'

type Hook = (...args: never[]) => unknown
type Reg = { pattern: string; matched: boolean; hook: Hook }

/** An `on` that keeps each registration, in order, and answers `.catch` as Claude Code's does; with `throwAt`, the
 *  registration at that place throws once, as a register that fails part way. */
function recorder(throwAt = -1): { on: On; regs: Reg[] } {
  const regs: Reg[] = []
  let thrown = false
  const on = ((pattern: string, matcher: unknown, hook?: unknown) => {
    if (!thrown && regs.length === throwAt) {
      thrown = true
      throw new Error('the terminal UI broke')
    }
    regs.push(hook === undefined ? { pattern, matched: false, hook: matcher as Hook } : { pattern, matched: true, hook: hook as Hook })
    return { catch: () => undefined }
  }) as unknown as On
  return { on, regs }
}

const names = (regs: Reg[]) => regs.map(r => (r.matched ? `${r.pattern} (matched)` : r.pattern))

test('register.ts registers thimble.ts first, then the terminal UI, whose hooks on the events thimble.ts hooks carry a matcher', () => {
  const all = recorder()
  register(all.on, {} as never)
  const first = recorder()
  bridge(first.on, {} as never)
  const second = recorder()
  term(second.on, {} as never)
  expect(names(all.regs)).toEqual([...names(first.regs), ...names(second.regs)])
  expect(names(first.regs)).toContain('tool.call')
  expect(names(second.regs)).toContain('tool.call (matched)')
  // no event is hooked twice without a matcher (claude plugin validate refuses that)
  const bare = all.regs.filter(r => !r.matched).map(r => r.pattern)
  expect(bare.length).toBe(new Set(bare).size)
})

// a session start reads a dozen fixture states: more than the default 5 s when the machine is busy
test("in one session both parts' tool.call hooks fire: the file guard refuses a token file, the terminal UI reads the card a call made", { timeoutMs: 30_000 }, async ($, on) => {
  // thimble on in this session from its start (the fixtures' session marker), with thimble.ts not held off: the
  // fixtures set THIMBLE_NO_MODULE for the terminal UI's own tests, so this matched hook, registered first and so
  // outermost, answers that one variable as unset
  on('env.get', { name: 'THIMBLE_NO_MODULE' }, () => ({ value: undefined }) as never)
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
  const denied = await $.tool.call({ tool: 'Read', file_path: '/home/a/.thimble/server.json', tool_use_id: 'r1' } as never)
  expect(JSON.stringify(denied)).toContain(PRIVATE_FALLBACK.slice(0, 40))
  const before = w.calls.length
  await $.tool.call({ tool: 'mcp__plugin_thimble_thimble__add_card', tool_use_id: 'u1' } as never)
  await w.clock.settle()
  expect(w.calls.slice(before).some(c => c[0] === CLI && c[1] === 'state' && c.includes('ff73e071'))).toBe(true)
  // the session ends: thimble.ts's polls stop at their next wake, before the test's environment goes
  await $.session.end({ reason: 'other', sessionId: 's1' } as never)
  await w.clock.advance(5000)
  await w.clock.settle()
})

// ------------------------------------------------------------------------------------------- a throwing terminal UI

/** A fake engine for thimble.ts's start in a session the launcher started, with no server: env, files, clock. */
function engine(env: Record<string, string>) {
  const logs: string[] = []
  const $ = {
    env: { get: async (k: string) => env[k] },
    fs: {
      read: async (p: string) => {
        throw new Error(`ENOENT: ${p}`)
      },
      stat: async (p: string) => ({ kind: 'file', size: 1, mtimeMs: 1, isLink: false, realPath: p }),
      write: async () => undefined,
    },
    session: { id: async () => 's1' },
    plugin: { root: '/tree/plugin' },
    clock: { now: async () => Date.now(), sleep: () => new Promise<void>(() => undefined), every: () => undefined, after: () => undefined },
    http: {
      fetch: async () => {
        throw new Error('no server')
      },
    },
    ui: { log: (t: string) => void logs.push(t) },
  }
  return { $, logs }
}

/** The chain of `regs` for one event: each hook in order, first outermost, then `bottom`, the engine's own answer. */
function dispatch(regs: Reg[], name: string, $: unknown, e: Record<string, unknown>, bottom: (e: unknown) => unknown): Promise<unknown> {
  const hooks = regs.filter(r => r.pattern === name).map(r => r.hook as unknown as ($: unknown, e: unknown, next: unknown) => unknown)
  const run = async (i: number, ev: unknown): Promise<unknown> => {
    const hook = hooks[i]
    if (!hook) return bottom(ev)
    const next = Object.assign((x?: unknown) => run(i + 1, x ?? ev), { called: false })
    return hook($, ev, next)
  }
  return run(0, e)
}

test("a terminal UI whose register throws leaves the file guard refusing a token file and the bridge's hooks firing", async () => {
  // the terminal UI's register throws at its first registration, after thimble.ts's
  const first = recorder()
  bridge(first.on, {} as never)
  const r = recorder(first.regs.length)
  register(r.on, {} as never)
  expect(names(r.regs)).toEqual([...names(first.regs), 'session.start (matched)'])
  const { $, logs } = engine({ HOME: '/home/a', THIMBLE_HOME: '/home/a/.thimble', THIMBLE_LAUNCHED: '1' })
  await dispatch(r.regs, 'session.start', $, { cwd: CWD, surface: 'terminal', isInteractive: true }, () => ({ cwd: CWD }))
  expect(logs.some(l => l.includes('the terminal UI did not load') && l.includes('the terminal UI broke'))).toBe(true)
  let ran = 0
  const denied = await dispatch(r.regs, 'tool.call', $, { tool: 'Read', file_path: '/home/a/.thimble/server.json' }, () => {
    ran += 1
    return { text: 'the token' }
  })
  expect(denied).toEqual({ deny: PRIVATE_FALLBACK })
  expect(ran).toBe(0)
  // a file the guard does not keep reaches the engine
  const read = await dispatch(r.regs, 'tool.call', $, { tool: 'Read', file_path: `${CWD}/events.jsonl` }, () => {
    ran += 1
    return { text: 'records' }
  })
  expect(read).toEqual({ text: 'records' })
  expect(ran).toBe(1)
})
