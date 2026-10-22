// env.ts: where thimble's records are, and how the plugin runs its own `thimble` calls.
//
//   thimbleHome($)          $THIMBLE_HOME, else ~/.thimble
//   startDir($)             the folder the session started in, which a shell `cd` does not move
//   rootHere($)             the folder under analysis as the kernel finds it (engine/kernel/store.py find_root), or null
//   labelsDir($, root)      the folder that holds a root's labels, or null (engine/kernel/store.py records_dir)
//   runThimble($, root, args, o)  `thimble …` as the person's own command: its records go under a session of the
//                           person's (`person-…`), so nothing it reads counts as what Claude read
import type { EngineInterface } from 'claude-code'

import { sessionKey } from '../hooks/conversation'

type Engine = EngineInterface

export async function thimbleHome($: Engine): Promise<string> {
  return String((await $.env.get('THIMBLE_HOME')) || `${(await $.env.get('HOME')) || '.'}/.thimble`).replace(/\/+$/, '')
}

/** The folder the session started in: THIMBLE_START, which hooks/watch.ts sets from $.session.root(); that root when
 *  the variable is not set here; the working folder only when neither is known. */
export async function startDir($: Engine): Promise<string> {
  let start = String((await $.env.get('THIMBLE_START')) || '')
  if (!start) {
    try {
      start = String((await $.session.root()) || '')
    } catch {
      // an engine with no project root: the working folder
    }
  }
  if (!start.startsWith('/')) start = String(await $.session.cwd())
  return start.replace(/\/+$/, '')
}

/** The folder that holds the labels of `root`: <root>/thimble/labels, or, for a folder thimble may not write in, the
 *  one kept under $THIMBLE_HOME/lean/folders/, named by the end of the folder's real path. Null when neither is there. */
export async function labelsDir($: Engine, root: string): Promise<string | null> {
  const real = (await $.fs.stat(root, { resolve: true }).catch(() => null))?.realPath ?? root
  const kept = `${await thimbleHome($)}/lean/folders/${real.replace(/[^A-Za-z0-9_-]/g, '-').slice(-120)}/thimble/labels`
  if (await $.fs.exists(kept)) return kept
  const own = `${root.replace(/\/+$/, '')}/thimble/labels`
  return (await $.fs.exists(own)) ? own : null
}

/** The folder under analysis: THIMBLE_ROOT, else the nearest folder at or above the session's start folder that holds
 *  a thimble/ record folder (so a `cd` does not move it); with none there, the nearest at or above a working folder
 *  inside the start folder, or at or above a working folder outside it. Null when no folder holds records. */
export async function rootHere($: Engine): Promise<string | null> {
  const env = await $.env.get('THIMBLE_ROOT')
  if (env) return env
  const holding = async (from: string): Promise<string | null> => {
    for (let d = from; d; d = d.slice(0, d.lastIndexOf('/'))) {
      if (await labelsDir($, d)) return d
    }
    return null
  }
  const start = await startDir($)
  const cwd = String(await $.session.cwd()).replace(/\/+$/, '')
  const inside = cwd === start || cwd.startsWith(`${start}/`)
  if (!inside) return holding(cwd)
  return (await holding(start)) || (cwd !== start ? holding(cwd) : null)
}

export type Ran = { code: number; stdout: string; stderr: string }

/** `thimble …` in `root`, as the person's own command. `stdin`: what it reads (the secret of a key press, the
 *  model's answers); `session`: the session its records go under (coverage counts Claude's own session). */
export async function runThimble($: Engine, root: string, args: string[], o: { stdin?: string; session?: string; timeoutMs?: number } = {}): Promise<Ran> {
  const dir = $.plugin.root.replace(/\/+$/, '')
  const session = o.session ?? `person-${(await sessionKey($)).slice(0, 8)}`
  const r = await $.process.run([`${dir}/bin/thimble`, ...args], {
    cwd: root, env: { THIMBLE_ROOT: root, THIMBLE_SESSION: session }, timeoutMs: o.timeoutMs ?? 120000,
    ...(o.stdin != null ? { stdin: o.stdin } : {}),
  })
  return { code: r.exitCode ?? 1, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') }
}
