// home.ts: thimble's home folder and the session's temp folder, from the hooks. The layout under the home is
// core/layout.mjs; this module only finds the two folders.
//
//   thimbleHome($)   $THIMBLE_HOME, else ~/.thimble
//   tempDir($)       where Claude writes the files it makes for thimble (a card's rows): $TMPDIR, else the home's tmp/,
//                    made with mode 700, so no file of the session lands in a folder other users share
import type { EngineInterface } from 'claude-code'

import { tmpDir } from './layout.mjs'

type Engine = EngineInterface

export async function thimbleHome($: Engine): Promise<string> {
  return String((await $.env.get('THIMBLE_HOME')) || `${(await $.env.get('HOME')) || '.'}/.thimble`).replace(/\/+$/, '')
}

// the home's tmp/ once it is made, for this load of the module
let made = ''

export async function tempDir($: Engine): Promise<string> {
  const own = String((await $.env.get('TMPDIR')) || '').replace(/\/+$/, '')
  if (own) return own
  const dir = tmpDir(await thimbleHome($))
  if (made !== dir) {
    const r = await $.process.run(['mkdir', '-p', '-m', '700', dir])
    if (r.exitCode !== 0) throw new Error(`thimble could not make its temp folder ${dir} (${String(r.stderr).trim().slice(0, 160)})`)
    made = dir
  }
  return dir
}
