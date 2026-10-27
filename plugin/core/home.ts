// home.ts: thimble's home folder and the session's temp folder, from the hooks. The layout under the home is
// core/layout.mjs; this module only finds the two folders.
//
//   thimbleHome($)   $THIMBLE_HOME, else ~/.thimble
//   tempDir($)       where Claude writes the files it makes for thimble (a card's rows): a folder only this user can
//                    open, `thimble/` in Claude Code's own temp folder, which its Bash sandbox lets commands write,
//                    else `thimble/` in the person's TMPDIR, else the home's tmp/
import type { EngineInterface } from 'claude-code'

import { tmpDir } from './layout.mjs'

type Engine = EngineInterface

export async function thimbleHome($: Engine): Promise<string> {
  return String((await $.env.get('THIMBLE_HOME')) || `${(await $.env.get('HOME')) || '.'}/.thimble`).replace(/\/+$/, '')
}

const TEMP = { plugin: 'thimble', key: 'tempDir' } as const

/** The session's temp folder, as a real path: `thimble/` in Claude Code's own temp folder, `claude-<uid>/` in
 *  CLAUDE_CODE_TMPDIR (hooks/path.ts sets it at session start, before any module asks for this folder), where Claude
 *  Code's Bash sandbox lets commands write; else `thimble/` in the person's TMPDIR; else the home's tmp/. Each a folder
 *  this user owns, mode 700, and no link, so another user cannot read it or plant a link in it. The session's commands
 *  get it as their TMPDIR (hooks/path.ts), and reads there need no dialog (hooks/temp_allow.py), so it is found once
 *  per session and kept in $.state, where a reload of the plugin finds it. */
export async function tempDir($: Engine): Promise<string> {
  const kept = await keptTempDir($)
  if (kept) return kept
  const claude = String((await $.env.get('CLAUDE_CODE_TMPDIR')) || '').replace(/\/+$/, '')
  const uid = claude ? await userId($) : ''
  const own = String((await $.env.get('TMPDIR')) || '').replace(/\/+$/, '')
  const dir = (uid && (await ownFolder($, `${claude}/claude-${uid}`, `${claude}/claude-${uid}/thimble`)))
    || (own && (await ownFolder($, `${own}/thimble`))) || (await ownFolder($, tmpDir(await thimbleHome($))))
  if (!dir) throw new Error(`thimble could not make a temp folder of its own in ${claude || own || 'TMPDIR'} or in its home folder`)
  await $.state.set(TEMP, dir)
  return dir
}

/** The session's temp folder when a load of the plugin in this session found it already, else ''. */
export async function keptTempDir($: Engine): Promise<string> {
  return (await $.state.get(TEMP)).value || ''
}

/** This user's id, which Claude Code names its temp folder after (`claude-<uid>`); '' when `id` does not say it. */
async function userId($: Engine): Promise<string> {
  const r = await $.process.run(['id', '-u'])
  const uid = String(r.stdout).trim()
  return r.exitCode === 0 && /^\d+$/.test(uid) ? uid : ''
}

/** The folders, each made when missing: the real path of the last when each is a folder this user owns and no link
 *  (then mode 700), else ''. */
async function ownFolder($: Engine, ...dirs: string[]): Promise<string> {
  const own = 'for d in "$@"; do mkdir -p -m 700 "$d" && [ -d "$d" ] && [ ! -h "$d" ] && [ -O "$d" ] && chmod 700 "$d" || exit 1; done && cd "$d" && pwd -P'
  const r = await $.process.run(['sh', '-c', own, 'sh', ...dirs])
  return r.exitCode === 0 ? String(r.stdout).trim() : ''
}
