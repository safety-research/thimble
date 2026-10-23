// The plugin's bin/ first on the PATH of the session's commands (hooks/path.ts), set as the hooks module starts with a
// session: put first once, the rest kept in its order, never twice.
// `claude plugin test plugin`.
import { expect, mock, test } from 'claude-code/testing'

import { binFirst } from '../hooks/path'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

// the plugin's folder: the one above this test's
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/+$/, '')
const BIN = `${ROOT}/bin`

test('binFirst puts the folder first, keeps the rest in its order, and never adds it twice', () => {
  expect(binFirst('/home/t/.local/bin:/usr/bin:/bin', '/p/bin')).toBe('/p/bin:/home/t/.local/bin:/usr/bin:/bin')
  expect(binFirst('/home/t/.local/bin:/usr/bin:/p/bin', '/p/bin')).toBe('/p/bin:/home/t/.local/bin:/usr/bin')
  expect(binFirst('/p/bin/:/usr/bin', '/p/bin')).toBe('/p/bin:/usr/bin')
  const once = binFirst('/usr/bin', '/p/bin')
  expect(binFirst(once, '/p/bin')).toBe(once)
})

function world(on: Any, path: string, deny = '') {
  mock.env(on, { PATH: path, THIMBLE_HOME: '/th', HOME: '/made-up/home', TMPDIR: '/made-up/tmp' })
  const sets: Record<string, string | undefined>[] = []
  on('env.set', (_$: unknown, e: { name: string; value?: string }) => {
    if (e.name === 'PATH') sets.push({ [e.name]: e.value })
    return { value: deny ? { deny } : {} }
  })
  const toasts: string[] = []
  // the other modules' own lines (the verb row, with no process here) are not this test's
  on('ui.toast', (_$: unknown, e: { text?: string }) => { if (String(e.text).includes('another thimble')) toasts.push(String(e.text ?? '')); return { value: undefined } })
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: e.path === '/home/t/.local/bin/thimble' }))
  on('session.id', () => ({ value: 's-1' }))
  on('session.cwd', () => ({ value: '/data' }))
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }) as never)
  return { sets, toasts }
}

test("at session start the plugin's bin/ goes first on the PATH, ahead of another thimble, and nothing shows", async ($, on) => {
  const w = world(on, '/home/t/.local/bin:/usr/bin:/bin')
  await $.session.start({ cwd: '/data', surface: 'terminal', isInteractive: true } as never)
  expect(w.sets).toEqual([{ PATH: `${BIN}:/home/t/.local/bin:/usr/bin:/bin` }])
  expect(w.toasts).toEqual([])
})
