// python.ts: thimble's own Python with pandas, which `thimble run` needs (engine/kernel/pyenv.py). scripts/install.sh
// makes it up front. A plugin installed from the marketplace alone has no install script, so this is its installation:
// at session start, when no Python with pandas is there, it runs `thimble setup` once per machine (after that the
// Python is there and it runs nothing). It runs after the session has started, so the first prompt never waits on it;
// `thimble run` waits for a setup that runs now. It shows one line while it installs, and one line with the fix when
// that fails. `thimble setup` holds a lock, so parallel sessions install it once.
import type { EngineInterface } from 'claude-code'

type Engine = EngineInterface

/** The line shown while `thimble setup` installs pandas. */
export const INSTALLING = "thimble: installing pandas, which Claude's queries need, into thimble's own Python, once (up to a minute)"

/** The line shown when `thimble setup` failed: what it said, and the command that installs it. */
export function failedLine(said: string, bin: string): string {
  const why = said.trim().split('\n').filter(Boolean).pop() || 'thimble: could not install pandas, which its queries need.'
  return `${why} Fix that, then run this in a terminal: ${bin} setup`
}

/** Makes thimble's own Python when this machine has no Python with pandas for thimble. */
export async function ensurePython($: Engine): Promise<void> {
  if (await $.env.get('THIMBLE_PYTHON')) return // a Python the person named: thimble installs nothing into it
  const root = $.plugin.root.replace(/\/+$/, '')
  const home = (await $.env.get('THIMBLE_HOME')) || `${(await $.env.get('HOME')) || '.'}/.thimble`
  if ((await $.fs.exists(`${home}/python/bin/python`)) || (await $.fs.exists(`${root}/.venv/bin/python`))) return
  const bin = `${root}/bin/thimble`
  // python3 may have pandas already: a local check, with no install
  if ((await $.process.run([bin, 'setup', '--check'], { timeoutMs: 30_000 })).exitCode === 0) return
  $.ui.toast(INSTALLING, { timeoutMs: 60_000 })
  let said = ''
  try {
    const r = await $.process.run([bin, 'setup'], { timeoutMs: 600_000 })
    if (r.exitCode === 0) return
    said = String(r.stdout || r.stderr || '')
  } catch (err) {
    said = `thimble: could not install pandas, which its queries need (${String((err as Error)?.message || err)}).`
  }
  $.ui.toast(failedLine(said, bin), { timeoutMs: 30_000 })
}
