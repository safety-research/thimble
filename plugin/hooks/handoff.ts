// handoff.ts: a `thimble` command in Claude Code's Bash sandbox, run by the plugin outside it.
//
// Claude Code's Bash sandbox lets a command write only the working folder and Claude Code's own temp folder, so a
// `thimble label` there may not write its records in $THIMBLE_HOME ("Read-only file system"). Before a Bash call that
// names thimble, this module gives the session's commands THIMBLE_HANDOFF: a folder of the session's own in Claude
// Code's temp folder, which the sandbox lets them write (core/home.ts claudeTempFolder). A command that may not write
// $THIMBLE_HOME leaves itself there as <id>.ask, with its arguments, its folder, its stdin and the variables that say
// which session and folder it is for, and waits, touching <id>.live while it waits (engine/kernel/handoff.py). While the
// call runs, every POLL_MS, this module runs each one whose command still waits (waits) with the plugin's bin/thimble
// and the plugin's own environment, outside the sandbox: a shell takes it (renames it <id>.took), unless the command
// took it back first, and runs it with its output in <id>.out and <id>.err; its exit code goes in <id>.done, which the
// command prints and ends with. Of a request, which any command in the sandbox can write, only the arguments, the
// folder, the stdin and the variables of CARRIED are taken. A run whose command is gone (killed, or its call stopped)
// is stopped, and the files of a command that is gone are removed, so a request nobody waits for never runs. A call in
// the background is served for BACKGROUND_MS after it starts.
import type { EngineInterface, Register } from 'claude-code'

import { claudeTempFolder } from '../core/home'
import { STOPPED_WHY, lateWhy, runWhy } from '../core/why.js'

type Engine = EngineInterface
type Ask = { argv: string[]; cwd: string; env?: Record<string, unknown>; stdin: string }
// a command's heartbeat as last seen: its time, and how many looks in a row found it there and not fresh
type Beat = { mtime: number; still: number }

const POLL_MS = 200
const RUN_MS = 600_000 // the longest a command may run, as long as Claude Code lets a Bash call run
const BACKGROUND_MS = 600_000
// a heartbeat this recent is a command that waits: it touches <id>.live every 0.25 s (handoff.py BEAT_S)
const FRESH_MS = 2000
// a heartbeat that stood still for this many looks in a row, 3 s at POLL_MS, and is not fresh, is a command that is gone
const STILL_LOOKS = 15
// the variables a request carries, as engine/kernel/handoff.py CARRIED has them: which session and which folder the
// command is for. Each one the request has not is empty for the run, as the command had it unset
export const CARRIED = ['THIMBLE_SESSION', 'THIMBLE_CONVERSATION', 'THIMBLE_START', 'THIMBLE_ROOT'] as const
// a request's files, by their ending (.code: an earlier version's)
const ENDS = ['.live', '.part', '.ask', '.took', '.out', '.err', '.code', '.done']
// the shell that runs one: the rename takes it, so a command that took it back first, or a second load of the plugin,
// leaves it alone; `took` tells this module that its own shell took it. Then the shell becomes the command, so that
// stopping the run stops the command; a folder that is gone is said in its output
const TAKE = 'f=$1; d=$2; shift 2; mv -- "$f.ask" "$f.took" 2>/dev/null || exit 0; echo took; exec >"$f.out" 2>"$f.err"; cd -- "$d" && exec "$@"'
// the commands this load of the plugin runs, by their path without the ending, and the folders it looks in now
const running = new Set<string>()
const looking = new Set<string>()
const beats = new Map<string, Beat>()

/** The folder THIMBLE_HANDOFF names, made and named when there is none: `thimble-<session>/` in Claude Code's temp
 *  folder. '' when Claude Code has none. */
async function handoffDir($: Engine): Promise<string> {
  const had = String((await $.env.get('THIMBLE_HANDOFF')) || '')
  if (had && (await $.fs.exists(had))) return had
  const dir = await claudeTempFolder($, `thimble-${await $.session.id()}`)
  if (dir) await $.env.set('THIMBLE_HANDOFF', dir)
  return dir
}

/** Whether the command of `at` (a path without the ending) still waits, by its heartbeat, <id>.live, which it touches
 *  while it waits and removes when it ends: true while the heartbeat is fresh, or moved since the last look; false once
 *  it is gone, or stood still for STILL_LOOKS looks; null while that cannot be told yet (a heartbeat first seen old, as
 *  after the machine slept, until it moves or stands still long enough). */
async function waits($: Engine, at: string): Promise<boolean | null> {
  const st = await $.fs.stat(`${at}.live`).catch(() => null)
  if (!st) {
    beats.delete(at)
    return false
  }
  const mtime = Number(st.mtimeMs)
  const now = Number(await $.clock.now())
  const was = beats.get(at)
  if (!was || was.mtime !== mtime) {
    beats.set(at, { mtime, still: 0 })
    return was || now - mtime < FRESH_MS ? true : null
  }
  if (now - mtime < FRESH_MS) return true
  was.still += 1
  return was.still >= STILL_LOOKS ? false : null
}

/** The files of the command of `at`, removed. */
async function drop($: Engine, at: string): Promise<void> {
  beats.delete(at)
  await $.process.run(['rm', '-f', '--', ...ENDS.map(e => `${at}${e}`)]).catch(() => undefined)
}

/** The commands left in `dir`: each whose command still waits, that this load does not run yet, started; the files of
 *  each whose command is gone removed (a request nobody waits for, or what a run left). */
async function serve($: Engine, dir: string): Promise<void> {
  if (looking.has(dir)) return
  looking.add(dir)
  try {
    const ids = new Set<string>()
    for (const f of await $.fs.list(dir).catch(() => [])) {
      const id = /^([\w-]+)\.(?:live|part|ask|took|out|err|code|done)$/.exec(f.name)?.[1]
      if (id) ids.add(id)
    }
    for (const at of beats.keys()) if (at.startsWith(`${dir}/`) && !ids.has(at.slice(dir.length + 1))) beats.delete(at)
    for (const id of ids) {
      const at = `${dir}/${id}`
      if (running.has(at)) continue
      const w = await waits($, at)
      if (w === false) await drop($, at)
      else if (w && (await $.fs.exists(`${at}.ask`))) {
        running.add(at)
        void run($, at).catch(() => undefined).finally(() => running.delete(at))
      }
    }
  } finally {
    looking.delete(dir)
  }
}

/** The variables of a run, over the plugin's own environment: each of CARRIED as the request gives it as text, else
 *  empty; THIMBLE_HANDOFF empty, so that it never hands itself on; and the marks of a command in Claude Code, as the
 *  command had them, whatever the plugin's own process has: CLAUDECODE, and THIMBLE_HANDED_OFF, by which the kernel
 *  knows a run for a command in the sandbox (fixes.py in_claude_code: thimble update and reapply refuse it as they
 *  refuse a command in Claude Code; engine/kernel/codebox.py: a label's code runs in thimble's own sandbox). No other
 *  key of the request is taken. */
export function runEnv(asked: unknown): Record<string, string> {
  const given = (asked && typeof asked === 'object' ? asked : {}) as Record<string, unknown>
  const env: Record<string, string> = {}
  for (const k of CARRIED) {
    const v = given[k]
    env[k] = typeof v === 'string' ? v : ''
  }
  return { ...env, THIMBLE_HANDOFF: '', CLAUDECODE: '1', THIMBLE_HANDED_OFF: '1' }
}

/** One command, `at` its path without the ending: the plugin's bin/thimble with its arguments, in its folder, with the
 *  plugin's environment and runEnv's variables, and its stdin. While it runs, it is stopped once its command is gone
 *  (then its files are removed), or after RUN_MS. However it ends, its command gets an exit code, and the reason when
 *  it was stopped. A request that is no request is removed. */
async function run($: Engine, at: string): Promise<void> {
  let ask: Ask
  try {
    ask = JSON.parse(String(await $.fs.read(`${at}.ask`))) as Ask
  } catch {
    return // taken back
  }
  if (!Array.isArray(ask?.argv) || typeof ask.cwd !== 'string') return drop($, at)
  const bin = `${$.plugin.root.replace(/\/+$/, '')}/bin/thimble`
  const child = $.process.spawn({
    argv: ['sh', '-c', TAKE, 'sh', at, ask.cwd, bin, ...ask.argv.map(String)], env: runEnv(ask.env), input: String(ask.stdin ?? ''),
  })
  const t0 = Number(await $.clock.now())
  let stopped: '' | 'gone' | 'late' = ''
  const watch = $.clock.every(POLL_MS, () => {
    void (async () => {
      if (stopped) return
      if ((await waits($, at)) === false) stopped = 'gone'
      else if (Number(await $.clock.now()) - t0 > RUN_MS) stopped = 'late'
      if (stopped) void child.return?.(undefined as never)
    })()
  })
  let said = ''
  let end: { code: number | null; signal: string | null } | undefined
  let failed: unknown = null
  try {
    // pulled by hand, as a for-await loop drops what the stream returns at its end: how the run ended
    for (;;) {
      const piece = await child.next()
      if (piece.done) {
        end = piece.value
        break
      }
      if (piece.value.stream === 'stdout') said += piece.value.text
    }
  } catch (err) {
    failed = err
  } finally {
    watch.cancel()
  }
  if (!/\btook\b/.test(said)) return // its command took it back first, or another load took it, or it never started
  if (stopped === 'gone' || (await waits($, at)) === false) return drop($, at)
  const why = stopped === 'late' ? lateWhy(RUN_MS) : failed ? runWhy(failed) : end?.code == null ? STOPPED_WHY : ''
  if (why) await $.fs.write(`${at}.err`, `thimble: ${why}\n`)
  await $.fs.write(`${at}.done`, `${why ? 1 : end!.code}\n`)
}

export const registerHandoff: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const input = e as unknown as { command?: unknown; run_in_background?: unknown }
    if (!/\bthimble\b/.test(String(input.command ?? ''))) return next(e)
    const dir = await handoffDir($).catch(() => '')
    if (!dir) return next(e)
    const tick = $.clock.every(POLL_MS, () => { void serve($, dir) })
    try {
      return await next(e)
    } finally {
      if (input.run_in_background === true) $.clock.after(BACKGROUND_MS, () => tick.cancel())
      else tick.cancel()
    }
  }).catch(($, e, next) => next(e)) // it never gates: if it fails, the command runs as it would
}
