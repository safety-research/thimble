// The plugin's bin/ first on the PATH of the session's commands (hooks/path.ts): put first once, the rest kept in its
// order, never twice; and when the PATH cannot be set while another thimble comes first, one line says the fix.
// `claude plugin test plugin`.
import { expect, mock, test } from 'claude-code/testing'

import { binFirst, otherThimbleLine } from '../hooks/path'

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
  mock.env(on, { PATH: path, THIMBLE_HOME: '/th', HOME: '/home/t' })
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

test('a PATH that has bin/ first already (a reload, or a session started inside another) is left as it is', async ($, on) => {
  const w = world(on, `${BIN}:/home/t/.local/bin:/usr/bin`)
  await $.session.start({ cwd: '/data', surface: 'terminal', isInteractive: true } as never)
  expect(w.sets).toEqual([])
})

test('a PATH the engine will not set, with another thimble on it, shows one line that names the fix', async ($, on) => {
  const w = world(on, '/home/t/.local/bin:/usr/bin', 'held by the organization')
  await $.session.start({ cwd: '/data', surface: 'terminal', isInteractive: true } as never)
  expect(w.toasts).toEqual([otherThimbleLine('held by the organization', '/home/t/.local/bin/thimble')])
  expect(w.toasts[0]).toContain('Remove thimble 0.9: its plugin and its ~/.local/bin/thimble launcher.')
})
