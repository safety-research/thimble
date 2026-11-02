// handoff.ts: a `thimble` command in Claude Code's Bash sandbox, run by the plugin outside it.
//
// Claude Code's Bash sandbox lets a command write only the working folder and Claude Code's own temp folder, so a
// `thimble label` there may not write its records in $THIMBLE_HOME ("Read-only file system"). Before a Bash call that
// names thimble, this module gives the session's commands THIMBLE_HANDOFF: a folder of the session's own in Claude
// Code's temp folder, which the sandbox lets them write (core/home.ts claudeTempFolder). A command that may not write
// $THIMBLE_HOME leaves itself there as <id>.ask, with its arguments, its folder, its THIMBLE_ variables and its stdin,
// and waits (engine/kernel/handoff.py). While the call runs, every POLL_MS, this module runs each one it finds with the
// plugin's bin/thimble, outside the sandbox: a shell takes it (renames it <id>.took), unless the command took it back
// first, runs it, and leaves its output (<id>.out, <id>.err) and its exit code (<id>.done) beside it, which the command
// prints and ends with. A call in the background is served for BACKGROUND_MS after it starts.
import type { EngineInterface, Register } from 'claude-code'

import { claudeTempFolder } from '../core/home'

type Engine = EngineInterface
type Ask = { argv: string[]; cwd: string; env: Record<string, string>; stdin: string }

const POLL_MS = 200
const RUN_MS = 600_000 // the longest a command may run, as long as Claude Code lets a Bash call run
const BACKGROUND_MS = 600_000
// the shell that runs one: the rename takes it, so a command that took it back first, or a second load of the plugin,
// leaves it alone; a folder that is gone is said in its output
const TAKE = 'f=$1; d=$2; shift 2; mv -- "$f.ask" "$f.took" 2>/dev/null || exit 0; (cd -- "$d" && exec "$@") >"$f.out" 2>"$f.err"; echo $? >"$f.code" && mv -- "$f.code" "$f.done"'
// the commands this load of the plugin started, by their path without the ending: each runs once
const started = new Set<string>()

/** The folder THIMBLE_HANDOFF names, made and named when there is none: `thimble-<session>/` in Claude Code's temp
 *  folder. '' when Claude Code has none. */
async function handoffDir($: Engine): Promise<string> {
  const had = String((await $.env.get('THIMBLE_HANDOFF')) || '')
  if (had && (await $.fs.exists(had))) return had
  const dir = await claudeTempFolder($, `thimble-${await $.session.id()}`)
  if (dir) await $.env.set('THIMBLE_HANDOFF', dir)
  return dir
}

/** Each command left in `dir` that this load did not start yet, started. */
async function serve($: Engine, dir: string): Promise<void> {
  for (const f of await $.fs.list(dir).catch(() => [])) {
    const id = /^([\w-]+)\.ask$/.exec(f.name)?.[1]
    if (!id || started.has(`${dir}/${id}`)) continue
    started.add(`${dir}/${id}`)
    void run($, `${dir}/${id}`)
  }
}

/** One command, `at` its path without the ending: the plugin's bin/thimble with its arguments, in its folder, with its
 *  THIMBLE_ variables over the session's and its stdin. THIMBLE_HANDOFF is empty for it, so it never hands itself
 *  on. */
async function run($: Engine, at: string): Promise<void> {
  let ask: Ask
  try {
    ask = JSON.parse(String(await $.fs.read(`${at}.ask`))) as Ask
  } catch {
    return // taken back
  }
  const bin = `${$.plugin.root.replace(/\/+$/, '')}/bin/thimble`
  await $.process.run(['sh', '-c', TAKE, 'sh', at, String(ask.cwd), bin, ...ask.argv.map(String)], {
    env: { ...ask.env, THIMBLE_HANDOFF: '' }, stdin: String(ask.stdin ?? ''), timeoutMs: RUN_MS,
  }).catch(async () => {
    // stopped before its end (it ran too long, or the plugin reloaded): the command ends with an error
    if ((await $.fs.exists(`${at}.took`)) && !(await $.fs.exists(`${at}.done`))) await $.fs.write(`${at}.done`, '1\n')
  })
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
