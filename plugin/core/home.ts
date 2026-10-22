// home.ts: thimble's home folder and the session's temp folder, from the hooks. The layout under the home is
// core/layout.mjs; this module only finds the two folders.
//
//   thimbleHome($)   $THIMBLE_HOME, else ~/.thimble
//   tempDir($)       where Claude writes the files it makes for thimble (a card's rows): a folder only this user can
//                    open, `thimble/` in the person's TMPDIR, else the home's tmp/
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

/** The folder, made when missing: its real path when it is a folder this user owns and no link (then mode 700), else ''. */
async function ownFolder($: Engine, dir: string): Promise<string> {
  const r = await $.process.run(['sh', '-c', 'mkdir -p -m 700 "$1" && [ -d "$1" ] && [ ! -h "$1" ] && [ -O "$1" ] && chmod 700 "$1" && cd "$1" && pwd -P', 'sh', dir])
  return r.exitCode === 0 ? String(r.stdout).trim() : ''
}
