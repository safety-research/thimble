// path.ts: the session's environment, at session start.
//
// The plugin's bin/ first on the PATH of the session's commands. Claude Code adds a plugin's bin/ folder at the end of
// the Bash tool's PATH, so another `thimble` earlier on it (thimble 0.9's launcher in ~/.local/bin) would run in its
// place. This module puts bin/ first, keeps the rest of the PATH in its order, and never adds the folder twice (a
// reload of the module, or a session started from inside another one, finds it there already).
//
// A TMPDIR. Claude writes the files it makes for thimble (a card's rows) in the session's temp folder, and the texts
// call it `$TMPDIR`. A session with no TMPDIR gets thimble's own (core/home.ts tempDir), so `$TMPDIR` in a command is
// the folder the texts name, and no such file lands in a folder other users share.
import type { EngineInterface, Register } from 'claude-code'

import { tempDir } from '../core/home'

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

export const registerPath: Register = on => {
  // the cwd matcher keeps this hook apart from the other modules' (one hook per event and matcher in a module)
  on('session.start', { cwd: /^\// }, async ($, e, next) => {
    const r = await next(e)
    try {
      await putBinFirst($)
    } catch {
      // the PATH stays as Claude Code made it
    }
    try {
      if (!(await $.env.get('TMPDIR'))) await $.env.set('TMPDIR', await tempDir($))
    } catch {
      // the texts name thimble's temp folder by its path
    }
    return r
  })
}
