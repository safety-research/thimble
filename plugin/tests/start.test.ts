// The folder citations are read and checked from after Claude `cd`s (shell/shell.tsx startDir, rootHere, checkRoot):
// the folder the session started in, THIMBLE_START, never the working folder a `cd` moved. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { checkRoot, rootHere, startDir } from '../shell/shell'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** The engine's calls these use: the environment, the session's folders, which paths exist, and no latest object. */
function engine(o: { env: Record<string, string>; cwd: string; root: string; have: Set<string> }): Any {
  return {
    env: { get: async (name: string) => o.env[name] },
    session: { cwd: async () => o.cwd, root: async () => o.root },
    fs: { exists: async (p: string) => o.have.has(p) },
    state: { get: async () => ({ value: undefined }) },
  }
}

test('after a cd, citations are read and checked from the start folder, with or without a thimble/ folder there', async () => {
  const have = new Set<string>()
  const $ = engine({ env: { THIMBLE_START: '/data/toy' }, cwd: '/data/toy/incident', root: '/data/toy', have })
  expect(await startDir($)).toBe('/data/toy')
  // no thimble/ yet: no folder keeps records, and the pass checks file citations from the start folder
  expect(await rootHere($)).toBe(null)
  expect(await checkRoot($)).toBe('/data/toy')
  // a thimble/ folder only inside the working folder is found, as the kernel finds it
  have.add('/data/toy/incident/thimble/queries')
  expect(await rootHere($)).toBe('/data/toy/incident')
  // the start folder's records stay the folder's after the cd
  have.add('/data/toy/thimble/queries')
  expect(await rootHere($)).toBe('/data/toy')
  expect(await checkRoot($)).toBe('/data/toy')
})

test('with no THIMBLE_START, the start folder is the session root, else the working folder', async () => {
  const o = { env: {}, cwd: '/work/sub', root: '/work', have: new Set<string>() }
  expect(await startDir(engine(o))).toBe('/work')
  o.root = ''
  expect(await startDir(engine(o))).toBe('/work/sub')
})
