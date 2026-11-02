// A `thimble` command in Claude Code's Bash sandbox, run by the plugin outside it (hooks/handoff.ts; the command's side
// is engine/kernel/handoff.py, tested in test_handoff.py). Before a Bash call that names thimble, the session's
// commands get THIMBLE_HANDOFF, a folder of the session's own in Claude Code's temp folder; while the call runs, each
// command left there runs once, outside the sandbox, as it asked. All data is made up. `claude plugin test plugin`.
import { expect } from 'claude-code/testing'

import { registerHandoff } from '../hooks/handoff'
import { tempRun } from './stubs'
import { test } from './kit'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const BOX = '/made-up/cc/claude-1000/thimble-s-1'
const BIN = '/made-up/plugin/bin/thimble'

/** The module's hooks on an engine that keeps the environment, files and timers in memory. Its shell takes and runs a
 *  command as hooks/handoff.ts's TAKE does: the rename that takes it, then the output and the exit code beside it.
 *  `stops`: the run is stopped before its end once taken (it ran too long, or the plugin reloaded). */
function setup(o: { env?: Record<string, string>; stops?: boolean } = {}) {
  const hooks: Record<string, Any[]> = {}
  const on: Any = (event: string, a: Any, b?: Any) => {
    ;(hooks[event] ??= []).push(typeof a === 'function' ? a : b)
    return { catch: () => undefined }
  }
  registerHandoff(on, {} as never)
  const env: Record<string, string> = { THIMBLE_HOME: '/made-up/.thimble', CLAUDE_CODE_TMPDIR: '/made-up/cc', ...o.env }
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  const runs: Any[] = []
  const timers: { every: boolean; fn: () => void; cancelled: boolean }[] = []
  const $: Any = {
    plugin: { root: '/made-up/plugin', name: 'thimble' },
    env: { get: async (k: string) => env[k], set: async (k: string, v: string) => { env[k] = v; return {} } },
    session: { id: async () => 's-1' },
    fs: {
      read: async (p: string) => { if (files.has(p)) return files.get(p); throw new Error(`no file ${p}`) },
      write: async (p: string, t: string) => { files.set(p, t) },
      exists: async (p: string) => files.has(p) || dirs.has(p),
      list: async (d: string) => { if (!dirs.has(d)) throw new Error(`no folder ${d}`); return [...files.keys()].filter(p => p.startsWith(`${d}/`)).map(p => ({ name: p.slice(d.length + 1), kind: 'file' })) },
    },
    process: {
      run: async (argv: string[], init: Any = {}) => {
        const t = tempRun(argv)
        if (t) { dirs.add(t.stdout.trim()); return t }
        const [at, cwd, bin, ...args] = argv.slice(4)
        if (!files.delete(`${at}.ask`)) return { exitCode: 0, stdout: '', stderr: '' }
        files.set(`${at}.took`, '')
        runs.push({ cwd, bin, args, env: init.env, stdin: init.stdin, timeoutMs: init.timeoutMs })
        if (o.stops) throw new Error('thimble: $.process.run(sh) aborted')
        files.set(`${at}.out`, `ran ${args.join(' ')}\n`)
        files.set(`${at}.err`, '')
        files.set(`${at}.done`, '0\n')
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
    clock: {
      every: (_ms: number, fn: () => void) => { const t = { every: true, fn, cancelled: false }; timers.push(t); return { cancel() { t.cancelled = true } } },
      after: (_ms: number, fn: () => void) => { const t = { every: false, fn, cancelled: false }; timers.push(t); return { cancel() { t.cancelled = true } } },
    },
  }
  /** A Bash call through the module's hook; `runs` stands for the command in the sandbox. */
  const bash = (input: Any, runs: (e: Any) => Promise<Any> = async () => ({ result: 'ok' })) => hooks['tool.call']![0]($, { tool: 'Bash', tool_use_id: 'tu-1', ...input }, runs)
  /** The intervals that run, fired once each, and the commands they started settled. */
  const tick = async () => {
    for (const t of timers.filter(x => x.every && !x.cancelled)) t.fn()
    await new Promise(r => setTimeout(r, 5))
  }
  /** What a command in the sandbox leaves in the folder THIMBLE_HANDOFF names: itself, as engine/kernel/handoff.py has it. */
  const ask = (id: string, argv: string[], more: Any = {}) => files.set(`${env.THIMBLE_HANDOFF}/${id}.ask`, JSON.stringify({ argv, cwd: '/made-up/cc/claude-1000', env: { THIMBLE_CONVERSATION: 'c-1', THIMBLE_START: '/made-up/data' }, stdin: '', ...more }))
  return { env, files, runs, timers, bash, tick, ask }
}

test("R2: a thimble command in Claude Code's Bash sandbox, which may not write thimble's home, runs outside it once while its call runs: the plugin's thimble, in its folder, with its THIMBLE_ variables and its stdin", async () => {
  const w = setup()
  const out = await w.bash({ command: 'cd "$TMPDIR" && thimble label run_failed --in runs.csv --regex failed' }, async () => {
    // the command sees the folder, a folder of the session's own in Claude Code's temp folder, which the sandbox lets it write
    expect(w.env.THIMBLE_HANDOFF).toBe(BOX)
    w.ask('77-ab', ['label', 'run_failed', '--in', 'runs.csv', '--regex', 'failed'], { stdin: 'def label(u): ...' })
    await w.tick()
    await w.tick()
    expect(w.files.get(`${BOX}/77-ab.done`)).toBe('0\n')
    return { result: w.files.get(`${BOX}/77-ab.out`) }
  })
  expect(out.result).toBe('ran label run_failed --in runs.csv --regex failed\n')
  // once, though the folder was read twice; THIMBLE_HANDOFF empty for it, so it never hands itself on
  expect(w.runs).toEqual([{ cwd: '/made-up/cc/claude-1000', bin: BIN, args: ['label', 'run_failed', '--in', 'runs.csv', '--regex', 'failed'],
    env: { THIMBLE_CONVERSATION: 'c-1', THIMBLE_START: '/made-up/data', THIMBLE_HANDOFF: '' }, stdin: 'def label(u): ...', timeoutMs: 600000 }])
  // once the call ends, nothing more is run: the folder is looked in only while a call that names thimble runs
  w.ask('78-cd', ['coverage'])
  await w.tick()
  expect(w.runs.length).toBe(1)
  // the next such call finds the folder already named
  await w.bash({ command: 'thimble coverage' }, async () => { await w.tick(); return { result: 'ok' } })
  expect(w.runs.map(r => r.args)).toEqual([['label', 'run_failed', '--in', 'runs.csv', '--regex', 'failed'], ['coverage']])
})

test('a Bash call that names no thimble command neither names the folder nor looks in it', async () => {
  const w = setup()
  await w.bash({ command: 'python3 -c "print(1)"' }, async () => ({ result: '1' }))
  expect(w.env.THIMBLE_HANDOFF).toBe(undefined)
  expect(w.timers).toEqual([])
})

test('Claude Code with no temp folder of its own known (no CLAUDE_CODE_TMPDIR): the command runs as it would', async () => {
  const w = setup({ env: { CLAUDE_CODE_TMPDIR: '' } })
  const out = await w.bash({ command: 'thimble label' })
  expect(out).toEqual({ result: 'ok' })
  expect(w.env.THIMBLE_HANDOFF).toBe(undefined)
  expect(w.timers).toEqual([])
})

test('a call in the background is served after it returns, for as long as a Bash call may run', async () => {
  const w = setup()
  await w.bash({ command: 'thimble label tickets --wait 300', run_in_background: true })
  w.ask('80-ef', ['label', 'tickets', '--wait', '300'])
  await w.tick()
  expect(w.runs.map(r => r.args)).toEqual([['label', 'tickets', '--wait', '300']])
  // then the interval ends
  for (const t of w.timers.filter(x => !x.every)) t.fn()
  w.ask('81-gh', ['coverage'])
  await w.tick()
  expect(w.runs.length).toBe(1)
})

test('a command that took itself back is not run; one stopped before its end ends with an error that says why', async () => {
  const w = setup({ stops: true })
  await w.bash({ command: 'thimble label' }, async () => {
    w.ask('90-ij', ['label'])
    // it waited too long, and took itself back before the folder was read
    w.files.delete(`${BOX}/90-ij.ask`)
    await w.tick()
    expect(w.runs).toEqual([])
    w.ask('91-kl', ['label', 'x', '--wait'])
    await w.tick()
    return { result: 'ok' }
  })
  expect(w.runs.map(r => r.args)).toEqual([['label', 'x', '--wait']])
  expect(w.files.get(`${BOX}/91-kl.done`)).toBe('1\n')
  expect(w.files.get(`${BOX}/91-kl.err`)).toBe('thimble: Claude Code stopped it before it finished, as it does when thimble reloads or the session ends\n')
})
