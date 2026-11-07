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

/** The module's hooks on an engine that keeps the environment, files (with their times), timers and the time in
 *  memory. Its shell takes and runs a command as hooks/handoff.ts's TAKE does: the rename that takes it, `took` on its
 *  stdout, then the command, whose output goes beside it. */
function setup() {
  const hooks: Record<string, Any[]> = {}
  const on: Any = (event: string, a: Any, b?: Any) => {
    ;(hooks[event] ??= []).push(typeof a === 'function' ? a : b)
    return { catch: () => undefined }
  }
  registerHandoff(on, {} as never)
  const env: Record<string, string> = { THIMBLE_HOME: '/made-up/.thimble', CLAUDE_CODE_TMPDIR: '/made-up/cc' }
  const files = new Map<string, string>()
  const mtimes = new Map<string, number>()
  const dirs = new Set<string>()
  const runs: Any[] = []
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
        const took = files.has(`${at}.ask`)
        if (took) {
          put(`${at}.took`, files.get(`${at}.ask`)!)
          files.delete(`${at}.ask`)
          runs.push({ cwd, bin, args, env: req.env, stdin: req.input })
        }
        let said = false
        return {
          async next() {
            if (took && !said) {
              said = true
              return { done: false, value: { stream: 'stdout', text: 'took\n' } }
            }
            if (!took) return { done: true, value: { code: 0, signal: null } }
            put(`${at}.out`, `ran ${args.join(' ')}\n`)
            put(`${at}.err`, '')
            return { done: true, value: { code: 0, signal: null } }
          },
          async return() {
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
   *  heartbeat, then itself. */
  const ask = (id: string, argv: string[], more: Any = {}) => {
    const at = `${env.THIMBLE_HANDOFF}/${id}`
    put(`${at}.live`, '')
    put(`${at}.ask`, JSON.stringify({ argv, cwd: '/made-up/cc/claude-1000', env: { THIMBLE_CONVERSATION: 'c-1', THIMBLE_START: '/made-up/data' }, stdin: '', ...more }))
  }
  return { env, files, runs, bash, tick, ask }
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

test("R2: a request carries only the variables that say which session and folder it is for: the plugin runs its own thimble with its own environment, whatever else the request names, and as a command in Claude Code, which thimble update and reapply refuse, though the request says it is not one", async () => {
  const w = setup()
  await w.bash({ command: 'thimble coverage' }, async () => {
    // a request written by hand in the folder every command in the sandbox may write: other programs, another home, a
    // library to preload, git settings, and no mark of a command in Claude Code
    w.ask('82-mn', ['coverage'], { env: {
      THIMBLE_SESSION: 's-1', THIMBLE_CONVERSATION: 'c-1', THIMBLE_START: '/made-up/data', THIMBLE_ROOT: '/made-up/data/runs',
      THIMBLE_PYTHON: '/made-up/cc/claude-1000/py.sh', THIMBLE_HOME: '/made-up/cc/claude-1000/home', THIMBLE_CLAUDE: '/made-up/cc/claude-1000/claude',
      THIMBLE_GIT: '/made-up/cc/claude-1000/git', THIMBLE_UPDATE_URL: '/made-up/cc/claude-1000/release', PATH: '/made-up/cc/claude-1000/bin',
      THIMBLE_RELEASES_URL: '/made-up/cc/claude-1000/releases',
      LD_PRELOAD: '/made-up/cc/claude-1000/x.so', PYTHONPATH: '/made-up/cc/claude-1000/py', GIT_CONFIG_COUNT: '1', THIMBLE_HANDOFF: '/made-up/cc/claude-1000/box',
      CLAUDECODE: '', THIMBLE_HANDED_OFF: '',
    } })
    await w.tick()
    return { result: 'ok' }
  })
  expect(w.runs.map(r => [r.bin, r.env])).toEqual([[BIN, {
    THIMBLE_SESSION: 's-1', THIMBLE_CONVERSATION: 'c-1', THIMBLE_START: '/made-up/data', THIMBLE_ROOT: '/made-up/data/runs', ...MARKS,
  }]])
})
