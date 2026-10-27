// path.ts: the session's environment, at session start.
//
// The plugin's bin/ first on the PATH of the session's commands. Claude Code adds a plugin's bin/ folder at the end of
// the Bash tool's PATH, so another `thimble` earlier on it (thimble 0.9's launcher in ~/.local/bin) would run in its
// place. This module puts bin/ first, keeps the rest of the PATH in its order, and never adds the folder twice (a
// reload of the module, or a session started from inside another one, finds it there already).
//
// A TMPDIR. Claude writes the files it makes for thimble (a card's rows) in the session's temp folder, and the texts
// call it `$TMPDIR`. The session's commands get thimble's own (core/home.ts tempDir: `thimble/` in the person's
// TMPDIR, else the home's tmp/), so `$TMPDIR` in a command is the folder the texts name, and no such file lands in a
// folder other users can read.
//
// Claude Code's own temp folder stays where it started. Claude Code keeps it, `claude-<uid>/`, in CLAUDE_CODE_TMPDIR,
// else in /tmp on macOS and in TMPDIR elsewhere, and looks it up again for each command: a command in its Bash sandbox
// gets that folder as its TMPDIR and writes there the folder it ended in, while the sandbox lets commands write only
// the folder Claude Code started with. A TMPDIR moved alone would take Claude Code's folder along on Linux, out of the
// sandbox's reach, and every sandboxed command would fail. So CLAUDE_CODE_TMPDIR is set first to where Claude Code
// keeps its folder, unless the person set it, and TMPDIR moves only once it is.
import type { EngineInterface, Register } from 'claude-code'

import { keptTempDir, tempDir } from '../core/home'

type Engine = EngineInterface

/** `path` with `bin` first and nowhere else, the other entries in their order. */
export function binFirst(path: string, bin: string): string {
  const norm = (p: string) => p.replace(/\/+$/, '')
  const want = norm(bin)
  return [want, ...path.split(':').filter(p => norm(p) !== want)].join(':')
}

/** The line the person sees when bin/ could not go first and another `thimble` (`other`) is on the PATH. */
export function otherThimbleLine(why: string, other: string): string {
  return `thimble: another thimble command comes first on PATH (${other}), and this plugin could not put its own first (${why}). Remove thimble 0.9: its plugin and its ~/.local/bin/thimble launcher.`
}

async function putBinFirst($: Engine): Promise<void> {
  const path = await $.env.get('PATH')
  if (path === undefined) return
  const bin = `${$.plugin.root.replace(/\/+$/, '')}/bin`
  const next = binFirst(path, bin)
  if (next === path) return
  let why = ''
  try {
    why = (await $.env.set('PATH', next)).deny || ''
  } catch (err) {
    why = String((err as Error)?.message || err)
  }
  if (!why) return
  // not set: say so when another thimble would run in place of this plugin's
  for (const dir of path.split(':')) {
    if (dir && dir.replace(/\/+$/, '') !== bin && (await $.fs.exists(`${dir.replace(/\/+$/, '')}/thimble`))) {
      $.ui.toast(otherThimbleLine(why, `${dir.replace(/\/+$/, '')}/thimble`))
      return
    }
  }
}

/** Where Claude Code keeps its temp folder when CLAUDE_CODE_TMPDIR names none, by Claude Code's own rule: /tmp on macOS
 *  (`system` is what `uname -s` says), else the first of TMPDIR, TMP and TEMP that is set, else /tmp. */
export function claudeTempRoot(system: string, env: { TMPDIR?: string; TMP?: string; TEMP?: string }): string {
  if (system === 'Darwin') return '/tmp'
  const set = env.TMPDIR ?? env.TMP ?? env.TEMP
  return set ? set.replace(/\/+$/, '') || '/' : '/tmp'
}

/** CLAUDE_CODE_TMPDIR set to where Claude Code keeps its temp folder, unless it is set already; false when it could not
 *  be set, or the system is not known. */
async function keepClaudeTemp($: Engine): Promise<boolean> {
  if (await $.env.get('CLAUDE_CODE_TMPDIR')) return true
  const uname = await $.process.run(['uname', '-s'])
  if (uname.exitCode !== 0) return false
  const root = claudeTempRoot(String(uname.stdout).trim(), { TMPDIR: await startTmp($), TMP: await $.env.get('TMP'), TEMP: await $.env.get('TEMP') })
  return !(await $.env.set('CLAUDE_CODE_TMPDIR', root)).deny
}

/** The TMPDIR Claude Code started with. thimble 0.10.5 and before moved TMPDIR into its temp folder and left
 *  CLAUDE_CODE_TMPDIR unset, so after a reload of the plugin over such a load, TMPDIR is the temp folder $.state keeps
 *  (core/home.ts tempDir): then the TMPDIR that load replaced, the folder around `thimble/`, or none when the temp
 *  folder is the home's tmp/. */
async function startTmp($: Engine): Promise<string | undefined> {
  const tmp = await $.env.get('TMPDIR')
  const kept = await keptTempDir($)
  if (!tmp || !kept || tmp.replace(/\/+$/, '') !== kept) return tmp
  return kept.endsWith('/thimble') ? kept.slice(0, -'/thimble'.length) || '/' : undefined
}

export const registerPath: Register = on => {
  // the cwd matcher keeps this hook apart from the other modules' (one hook per event and matcher in a module)
  on('session.start', { cwd: /^\// }, async ($, e, next) => {
    // CLAUDE_CODE_TMPDIR whether TMPDIR moves or not: after a reload over thimble 0.10.5, TMPDIR has moved already
    const kept = await keepClaudeTemp($).catch(() => false)
    const r = await next(e)
    try {
      await putBinFirst($)
    } catch {
      // the PATH stays as Claude Code made it
    }
    try {
      const dir = await tempDir($)
      if (kept && (await $.env.get('TMPDIR')) !== dir) await $.env.set('TMPDIR', dir)
    } catch {
      // the texts name thimble's temp folder by its path
    }
    return r
  })
}
