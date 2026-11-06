// A `thimble` command in Claude Code's Bash sandbox, run by the plugin outside it (hooks/handoff.ts; the command's side
// is engine/kernel/handoff.py, tested in test_handoff.py). Before a Bash call that names thimble, the session's
// commands get THIMBLE_HANDOFF, a folder of the session's own in Claude Code's temp folder; while the call runs, each
// command left there whose command still waits runs once, outside the sandbox, as it asked. All data is made up.
// `claude plugin test plugin`.
import { expect } from 'claude-code/testing'

import { registerHandoff } from '../hooks/handoff'
import { tempRun } from './stubs'
import { test } from './kit'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const BOX = '/made-up/cc/claude-1000/thimble-s-1'
const BIN = '/made-up/plugin/bin/thimble'
// what every run has besides the request's variables: THIMBLE_HANDOFF empty, so it never hands itself on, and the marks
// of a command in Claude Code
const MARKS = { THIMBLE_HANDOFF: '', CLAUDECODE: '1', THIMBLE_HANDED_OFF: '1' }
const ENDS = ['.live', '.part', '.ask', '.took', '.out', '.err', '.done']

/** The module's hooks on an engine that keeps the environment, files (with their times), timers and the time in
 *  memory. Its shell takes and runs a command as hooks/handoff.ts's TAKE does: the rename that takes it, `took` on its
 *  stdout, then the command, whose output goes beside it. `ends`: how the run of a request ends, by its id, when not on
 *  its own with exit code 0: `hangs` until it is stopped, or `killed` by a signal from elsewhere. */
function setup(o: { env?: Record<string, string>; ends?: Record<string, 'hangs' | 'killed'> } = {}) {
  const hooks: Record<string, Any[]> = {}
  const on: Any = (event: string, a: Any, b?: Any) => {
    ;(hooks[event] ??= []).push(typeof a === 'function' ? a : b)
    return { catch: () => undefined }
  }
  registerHandoff(on, {} as never)
  const env: Record<string, string> = { THIMBLE_HOME: '/made-up/.thimble', CLAUDE_CODE_TMPDIR: '/made-up/cc', ...o.env }
  const files = new Map<string, string>()
  const mtimes = new Map<string, number>()
  const dirs = new Set<string>()
  const runs: Any[] = []
  const stopped: string[] = []
  const timers: { every: boolean; fn: () => void; cancelled: boolean }[] = []
  const clock = { now: 1_800_000_000_000 }
  const put = (p: string, t: string) => { files.set(p, t); mtimes.set(p, clock.now) }
  const $: Any = {
    plugin: { root: '/made-up/plugin', name: 'thimble' },
    env: { get: async (k: string) => env[k], set: async (k: string, v: string) => { env[k] = v; return {} } },
    session: { id: async () => 's-1' },
    fs: {
      read: async (p: string) => { if (files.has(p)) return files.get(p); throw new Error(`no file ${p}`) },
      write: async (p: string, t: string) => put(p, t),
      exists: async (p: string) => files.has(p) || dirs.has(p),
      list: async (d: string) => { if (!dirs.has(d)) throw new Error(`no folder ${d}`); return [...files.keys()].filter(p => p.startsWith(`${d}/`)).map(p => ({ name: p.slice(d.length + 1), kind: 'file' })) },
      stat: async (p: string) => {
        if (!files.has(p)) throw new Error(`ENOENT: no file ${p}`)
        return { kind: 'file', size: files.get(p)!.length, mtimeMs: mtimes.get(p) ?? 0, isLink: false }
      },
    },
    process: {
      run: async (argv: string[]) => {
        const t = tempRun(argv)
        if (t) { dirs.add(t.stdout.trim()); return t }
        if (argv[0] === 'rm') {
          for (const p of argv.slice(3)) files.delete(p)
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        throw new Error(`made-up: no command ${argv[0]}`)
      },
      spawn: (req: Any) => {
        const [at, cwd, bin, ...args] = req.argv.slice(4)
        const how = o.ends?.[at.slice(at.lastIndexOf('/') + 1)]
        const took = files.has(`${at}.ask`)
        if (took) {
          put(`${at}.took`, files.get(`${at}.ask`)!)
          files.delete(`${at}.ask`)
          runs.push({ cwd, bin, args, env: req.env, stdin: req.input })
        }
        let stop = () => {}
        const stopping = new Promise<void>(r => { stop = r })
        let said = false
        return {
          async next() {
            if (took && !said) {
              said = true
              return { done: false, value: { stream: 'stdout', text: 'took\n' } }
            }
            if (!took) return { done: true, value: { code: 0, signal: null } }
            if (how === 'hangs') {
              await stopping
              return { done: true, value: { code: null, signal: 'SIGTERM' } }
            }
            if (how === 'killed') return { done: true, value: { code: null, signal: 'SIGKILL' } }
            put(`${at}.out`, `ran ${args.join(' ')}\n`)
            put(`${at}.err`, '')
            return { done: true, value: { code: 0, signal: null } }
          },
          async return() {
            stopped.push(at)
            stop()
            return { done: true, value: undefined }
          },
        }
      },
    },
    clock: {
      now: async () => clock.now,
      every: (_ms: number, fn: () => void) => { const t = { every: true, fn, cancelled: false }; timers.push(t); return { cancel() { t.cancelled = true } } },
      after: (_ms: number, fn: () => void) => { const t = { every: false, fn, cancelled: false }; timers.push(t); return { cancel() { t.cancelled = true } } },
    },
  }
  /** A Bash call through the module's hook; `runs` stands for the command in the sandbox. */
  const bash = (input: Any, runs: (e: Any) => Promise<Any> = async () => ({ result: 'ok' })) => hooks['tool.call']![0]($, { tool: 'Bash', tool_use_id: 'tu-1', ...input }, runs)
  /** The intervals that run, fired once each, and what they started settled. */
  const tick = async () => {
    for (const t of timers.filter(x => x.every && !x.cancelled)) t.fn()
    await new Promise(r => setTimeout(r, 5))
  }
  /** What a command in the sandbox leaves in the folder THIMBLE_HANDOFF names, as engine/kernel/handoff.py has it: its
   *  heartbeat (`live`: false, none; a number, from that long ago), then itself. */
  const ask = (id: string, argv: string[], more: Any = {}, live: boolean | number = true) => {
    const at = `${env.THIMBLE_HANDOFF}/${id}`
    if (live !== false) { put(`${at}.live`, ''); mtimes.set(`${at}.live`, clock.now - (live === true ? 0 : live)) }
    put(`${at}.ask`, JSON.stringify({ argv, cwd: '/made-up/cc/claude-1000', env: { THIMBLE_CONVERSATION: 'c-1', THIMBLE_START: '/made-up/data' }, stdin: '', ...more }))
  }
  /** The command of `id` touches its heartbeat. */
  const beat = (id: string) => mtimes.set(`${BOX}/${id}.live`, clock.now)
  /** The files of the request `id` that are there. */
  const left = (id: string) => ENDS.filter(e => files.has(`${BOX}/${id}${e}`))
  return { env, files, runs, stopped, timers, clock, bash, tick, ask, beat, left }
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
    env: { THIMBLE_SESSION: '', THIMBLE_CONVERSATION: 'c-1', THIMBLE_START: '/made-up/data', THIMBLE_ROOT: '', ...MARKS }, stdin: 'def label(u): ...' }])
  // once the call ends, nothing more is run: the folder is looked in only while a call that names thimble runs
  w.ask('78-cd', ['coverage'])
  await w.tick()
  expect(w.runs.length).toBe(1)
  // the next such call finds the folder already named
  await w.bash({ command: 'thimble coverage' }, async () => { await w.tick(); return { result: 'ok' } })
  expect(w.runs.map(r => r.args)).toEqual([['label', 'run_failed', '--in', 'runs.csv', '--regex', 'failed'], ['coverage']])
})

test('R2: a request carries only the variables that say which session and folder it is for: the plugin runs its own thimble with its own environment, whatever else the request names', async () => {
  const w = setup()
  await w.bash({ command: 'thimble coverage' }, async () => {
    // a request written by hand in the folder every command in the sandbox may write: other programs, another home, a
    // library to preload, git settings
    w.ask('82-mn', ['coverage'], { env: {
      THIMBLE_SESSION: 's-1', THIMBLE_CONVERSATION: 'c-1', THIMBLE_START: '/made-up/data', THIMBLE_ROOT: '/made-up/data/runs',
      THIMBLE_PYTHON: '/made-up/cc/claude-1000/py.sh', THIMBLE_HOME: '/made-up/cc/claude-1000/home', THIMBLE_CLAUDE: '/made-up/cc/claude-1000/claude',
      THIMBLE_GIT: '/made-up/cc/claude-1000/git', THIMBLE_UPDATE_URL: '/made-up/cc/claude-1000/release', PATH: '/made-up/cc/claude-1000/bin',
      LD_PRELOAD: '/made-up/cc/claude-1000/x.so', PYTHONPATH: '/made-up/cc/claude-1000/py', GIT_CONFIG_COUNT: '1', THIMBLE_HANDOFF: '/made-up/cc/claude-1000/box',
    } })
    await w.tick()
    return { result: 'ok' }
  })
  expect(w.runs.map(r => [r.bin, r.env])).toEqual([[BIN, {
    THIMBLE_SESSION: 's-1', THIMBLE_CONVERSATION: 'c-1', THIMBLE_START: '/made-up/data', THIMBLE_ROOT: '/made-up/data/runs', ...MARKS,
  }]])
  // a value that is not text is none
  await w.bash({ command: 'thimble coverage' }, async () => {
    w.ask('83-op', ['coverage'], { env: { THIMBLE_CONVERSATION: ['c-1'], THIMBLE_ROOT: 7 } })
    await w.tick()
    return { result: 'ok' }
  })
  expect(w.runs[1]!.env).toEqual({ THIMBLE_SESSION: '', THIMBLE_CONVERSATION: '', THIMBLE_START: '', THIMBLE_ROOT: '', ...MARKS })
})

test("R2: the plugin's run is a command in Claude Code, as the command was, though the request says it is not: thimble update and reapply refuse it", async () => {
  const w = setup()
  await w.bash({ command: 'thimble update' }, async () => {
    w.ask('84-qr', ['update'], { env: { THIMBLE_CONVERSATION: 'c-1', CLAUDECODE: '', THIMBLE_HANDED_OFF: '' } })
    await w.tick()
    return { result: 'ok' }
  })
  expect(w.runs.map(r => [r.args, r.env.CLAUDECODE, r.env.THIMBLE_HANDED_OFF])).toEqual([[['update'], '1', '1']])
})

test('R2: a request whose command is gone never runs, and its files go; a run whose command is gone is stopped, and its files go', async () => {
  const w = setup({ ends: { '96-gh': 'hangs', '97-ij': 'hangs' } })
  await w.bash({ command: 'thimble label' }, async () => {
    // no heartbeat: a request written by hand, or one whose command ended before it began to wait
    w.ask('92-ab', ['label', 'a', '--code'], {}, false)
    // a heartbeat that stopped a minute ago: its command was killed (Esc, the Bash call's time limit) while it waited
    w.ask('93-cd', ['label', 'b', '--code'], {}, 60_000)
    // a heartbeat first seen old that moves on: the machine slept, and its command waits all the same
    w.ask('94-ef', ['label', 'c', '--code'], {}, 60_000)
    // what a run left whose command is gone
    for (const e of ['.took', '.out', '.err', '.done']) w.files.set(`${BOX}/95-xy${e}`, '')
    await w.tick()
    expect(w.runs).toEqual([])
    expect(w.left('92-ab')).toEqual([])
    expect(w.left('95-xy')).toEqual([])
    w.beat('94-ef')
    await w.tick()
    expect(w.runs.map(r => r.args)).toEqual([['label', 'c', '--code']])
    for (let i = 0; i < 15; i++) await w.tick()
    expect(w.runs.length).toBe(1)
    expect(w.left('93-cd')).toEqual([])
    // two runs: the command of one ends (its files go with it), the other's is killed (its heartbeat stops)
    w.ask('96-gh', ['label', 'd', '--wait'])
    w.ask('97-ij', ['label', 'e', '--wait'])
    await w.tick()
    expect(w.runs.map(r => r.args).slice(1)).toEqual([['label', 'd', '--wait'], ['label', 'e', '--wait']])
    for (const e of ['.live', '.took']) w.files.delete(`${BOX}/96-gh${e}`)
    await w.tick()
    expect(w.stopped).toEqual([`${BOX}/96-gh`])
    expect(w.left('96-gh')).toEqual([])
    w.clock.now += 3000
    for (let i = 0; i < 15; i++) await w.tick()
    expect(w.stopped).toEqual([`${BOX}/96-gh`, `${BOX}/97-ij`])
    expect(w.left('97-ij')).toEqual([])
    return { result: 'ok' }
  })
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

test('R2: a command that took itself back is not run; a run stopped before its end gives its command an exit code and why, whoever stopped it', async () => {
  const w = setup({ ends: { '91-kl': 'hangs', '98-mn': 'killed' } })
  await w.bash({ command: 'thimble label' }, async () => {
    w.ask('90-ij', ['label'])
    // it waited too long, and took itself back before the folder was read
    w.files.delete(`${BOX}/90-ij.ask`)
    await w.tick()
    expect(w.runs).toEqual([])
    // one that runs past the time limit, its command waiting all along
    w.ask('91-kl', ['label', 'x', '--wait'])
    await w.tick()
    w.clock.now += 600_001
    w.beat('91-kl')
    await w.tick()
    // one ended by a signal from elsewhere (a run that settles with no exit code): before, the command waited on
    w.ask('98-mn', ['label', 'y', '--wait'])
    await w.tick()
    return { result: 'ok' }
  })
  expect(w.runs.map(r => r.args)).toEqual([['label', 'x', '--wait'], ['label', 'y', '--wait']])
  expect(w.stopped).toEqual([`${BOX}/91-kl`])
  expect(w.files.get(`${BOX}/91-kl.done`)).toBe('1\n')
  expect(w.files.get(`${BOX}/91-kl.err`)).toBe('thimble: it ran longer than 10 minutes, the most it may take, and was stopped\n')
  expect(w.files.get(`${BOX}/98-mn.done`)).toBe('1\n')
  expect(w.files.get(`${BOX}/98-mn.err`)).toBe('thimble: Claude Code stopped it before it finished, as it does when thimble reloads or the session ends\n')
})
