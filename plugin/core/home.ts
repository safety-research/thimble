// home.ts: thimble's home folder and the session's temp folders, from the hooks. The layout under the home is
// core/layout.mjs; this module only finds the folders.
//
//   thimbleHome($)    $THIMBLE_HOME, else ~/.thimble
//   tempDir($)        where Claude writes the files it makes for thimble (a card's rows): a folder only this user can
//                     open, `thimble/` in the person's TMPDIR, else the home's tmp/
//   claudeTempDir($)  Claude Code's own temp folder, `claude-<uid>/` in CLAUDE_CODE_TMPDIR: a command in Claude Code's
//                     Bash sandbox gets it as its TMPDIR in place of tempDir, so such a command writes those files there
//   claudeTempFolder($, name)  a folder of thimble's in Claude Code's temp folder, made with it when missing: a command
//                     in Claude Code's Bash sandbox may write it (hooks/handoff.ts)
import type { EngineInterface } from 'claude-code'

import { tmpDir } from './layout.mjs'

type Engine = EngineInterface

export async function thimbleHome($: Engine): Promise<string> {
  return String((await $.env.get('THIMBLE_HOME')) || `${(await $.env.get('HOME')) || '.'}/.thimble`).replace(/\/+$/, '')
}

const TEMP = { plugin: 'thimble', key: 'tempDir' } as const

/** The session's temp folder, as a real path: `thimble/` in the person's TMPDIR, else the home's tmp/, a folder this
 *  user owns, mode 700, and no link, so another user cannot read it or plant a link in it. The session's commands get it
 *  as their TMPDIR (hooks/path.ts), and reads there need no dialog (hooks/temp_allow.py), so it is found once per session
 *  and kept in $.state, where a reload of the plugin finds it. */
export async function tempDir($: Engine): Promise<string> {
  const kept = (await $.state.get(TEMP)).value
  if (kept) return kept
  const own = String((await $.env.get('TMPDIR')) || '').replace(/\/+$/, '')
  const dir = (own && (await ownFolder($, `${own}/thimble`))) || (await ownFolder($, tmpDir(await thimbleHome($))))
  if (!dir) throw new Error(`thimble could not make a temp folder of its own in ${own || 'TMPDIR'} or in its home folder`)
  await $.state.set(TEMP, dir)
  return dir
}

/** Claude Code's own temp folder, as a real path: `claude-<uid>/` in CLAUDE_CODE_TMPDIR, where hooks/path.ts keeps it,
 *  when it is a folder this user owns and no link. Claude Code's Bash sandbox lets a command write only there and in
 *  the working folder, and gives it that folder as its TMPDIR, not tempDir, so the files such a command makes for thimble
 *  land there. '' while there is none. */
export async function claudeTempDir($: Engine): Promise<string> {
  const root = String((await $.env.get('CLAUDE_CODE_TMPDIR')) || '').replace(/\/+$/, '')
  if (!root) return ''
  const r = await $.process.run(['sh', '-c', 'd="$1"; case "$d" in */claude-"$(id -u)") ;; *) d="$d/claude-$(id -u)" ;; esac; [ -d "$d" ] && [ ! -h "$d" ] && [ -O "$d" ] && cd "$d" && pwd -P', 'sh', root])
  return r.exitCode === 0 ? String(r.stdout).trim() : ''
}

/** The folder `name` in Claude Code's own temp folder (claudeTempDir), made when missing, Claude Code's folder with it:
 *  its real path when both are folders this user owns and no link (then mode 700), else '', as with no
 *  CLAUDE_CODE_TMPDIR. A command in Claude Code's Bash sandbox may write it. */
export async function claudeTempFolder($: Engine, name: string): Promise<string> {
  const root = String((await $.env.get('CLAUDE_CODE_TMPDIR')) || '').replace(/\/+$/, '')
  if (!root) return ''
  const r = await $.process.run(['sh', '-c', 'd="$1"; case "$d" in */claude-"$(id -u)") ;; *) d="$d/claude-$(id -u)" ;; esac; mkdir -p -m 700 "$d/$2" && for f in "$d" "$d/$2"; do [ -d "$f" ] && [ ! -h "$f" ] && [ -O "$f" ] && chmod 700 "$f" || exit 1; done && cd "$d/$2" && pwd -P', 'sh', root, name])
  return r.exitCode === 0 ? String(r.stdout).trim() : ''
}

/** The folder, made when missing: its real path when it is a folder this user owns and no link (then mode 700), else ''. */
async function ownFolder($: Engine, dir: string): Promise<string> {
  const r = await $.process.run(['sh', '-c', 'mkdir -p -m 700 "$1" && [ -d "$1" ] && [ ! -h "$1" ] && [ -O "$1" ] && chmod 700 "$1" && cd "$1" && pwd -P', 'sh', dir])
  return r.exitCode === 0 ? String(r.stdout).trim() : ''
}
