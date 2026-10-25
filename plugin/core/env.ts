// env.ts: the session's folders as thimble reads them, and how the plugin runs its own `thimble` calls.
//
//   keptDir($), readKept, writeKept  what thimble keeps of this conversation for a resumed session, as JSON files
//   startDir($)             the folder the session started in, which a shell `cd` does not move
//   rootHere($)             the folder under analysis as the kernel finds it (engine/kernel/store.py find_root), or null
//   labelsDir($, root)      the folder that holds the labels this conversation made in a root, or null
//                           (engine/kernel/store.py kept_dir)
//   runThimble($, root, args, o)  `thimble …` as the person's own command: its records go under a session of the
//                           person's (`person-…`), so nothing it reads counts as what Claude read, and it reads and
//                           writes this conversation's labels
import type { EngineInterface } from 'claude-code'

import { sessionKey } from '../hooks/conversation'
import { thimbleHome } from './home'
import { conversationDir, labelsDirOf } from './layout.mjs'
import { runWhy } from './why.js'

type Engine = EngineInterface

/** The folder of what thimble keeps of this conversation for a resumed session (core/layout.mjs): the marks' checks,
 *  the cards, the texts Claude reads with the next prompt, the answer v draws under. */
export async function keptDir($: Engine): Promise<string> {
  return conversationDir(await thimbleHome($), await sessionKey($))
}

/** A JSON value kept in the conversation's folder, or null when there is none or it cannot be read. */
export async function readKept<T>($: Engine, name: string): Promise<T | null> {
  try {
    return JSON.parse(String(await $.fs.read(`${await keptDir($)}/${name}`))) as T
  } catch {
    return null
  }
}

/** Keep a JSON value in the conversation's folder. */
export async function writeKept($: Engine, name: string, value: unknown): Promise<void> {
  await $.fs.write(`${await keptDir($)}/${name}`, JSON.stringify(value))
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

/** The folder that holds the labels this conversation made in `root`: the one kept in the conversation's folder for
 *  the root's real path (core/layout.mjs). Null when there is none: a new conversation shows no folder's labels, not
 *  even those an earlier conversation made there. */
export async function labelsDir($: Engine, root: string): Promise<string | null> {
  const real = (await $.fs.stat(root, { resolve: true }).catch(() => null))?.realPath ?? root
  const kept = labelsDirOf(await thimbleHome($), await sessionKey($), real)
  return (await $.fs.exists(kept)) ? kept : null
}

/** The folder under analysis: THIMBLE_ROOT, else the nearest folder at or above the session's start folder for which
 *  this conversation keeps labels (so a `cd` does not move it); with none there, the nearest at or above a working
 *  folder inside the start folder, or at or above a working folder outside it. Null when no folder holds records. */
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

/** The session the person's own `thimble` commands run under (runThimble): its records are never Claude's, and its
 *  change feed is its own (core/feed.ts withPersonFeed). */
const personOf = (key: string) => `person-${key.slice(0, 8)}`
export async function personSession($: Engine): Promise<string> {
  return personOf(await sessionKey($))
}

/** `thimble …` in `root`, as the person's own command, over this conversation's labels. `stdin`: what it reads (the
 *  secret of a key press, the model's answers); `session`: the session its records go under (coverage counts Claude's
 *  own session). A run that gives no result (stopped, past its time, not started) throws why in words (core/why.js). */
export async function runThimble($: Engine, root: string, args: string[], o: { stdin?: string; session?: string; timeoutMs?: number } = {}): Promise<Ran> {
  const dir = $.plugin.root.replace(/\/+$/, '')
  const key = await sessionKey($)
  const session = o.session ?? personOf(key)
  const r = await $.process.run([`${dir}/bin/thimble`, ...args], {
    cwd: root, env: { THIMBLE_ROOT: root, THIMBLE_SESSION: session, THIMBLE_CONVERSATION: key }, timeoutMs: o.timeoutMs ?? 120000,
    ...(o.stdin != null ? { stdin: o.stdin } : {}),
  }).catch((err: unknown) => { throw new Error(runWhy(err)) })
  return { code: r.exitCode ?? 1, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') }
}
