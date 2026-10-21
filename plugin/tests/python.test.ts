// thimble's own Python, made at session start for a plugin installed without scripts/install.sh (hooks/python.ts):
// once per machine, one line while it installs, one line with the fix when that fails, and nothing when it is there.
// `claude plugin test plugin`.
import { expect, mock, test } from 'claude-code/testing'

import { INSTALLING } from '../hooks/python'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/+$/, '')
const BIN = `${ROOT}/bin/thimble`

function world(on: Any, { made = false, hasPandas = false, setup = { exitCode: 0, stdout: '' } } = {}) {
  mock.env(on, { PATH: `${ROOT}/bin:/usr/bin:/bin`, THIMBLE_HOME: '/th', HOME: '/home/t' })
  on('env.set', () => ({ value: {} }))
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: made && e.path === '/th/python/bin/python' }))
  const runs: string[][] = []
  on('process.run', (_$: unknown, e: { argv: string[] }) => {
    const mine = e.argv[0] === BIN && e.argv[1] === 'setup'
    if (mine) runs.push(e.argv)
    const r = !mine ? { exitCode: 0, stdout: '{}' } : e.argv.includes('--check') ? { exitCode: hasPandas ? 0 : 1, stdout: '' } : setup
    return { value: { ...r, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const toasts: string[] = []
  // the other modules' own lines are not this test's
  on('ui.toast', (_$: unknown, e: { text?: string }) => { if (String(e.text).includes('pandas')) toasts.push(String(e.text ?? '')); return { value: undefined } })
  on('session.id', () => ({ value: 's-1' }))
  on('session.cwd', () => ({ value: '/data' }))
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }) as never)
  return { runs, toasts }
}

// the setup runs on after the session-start hook returns: wait for it here
async function start($: Any) {
  await $.session.start({ cwd: '/data', surface: 'terminal', isInteractive: true } as never)
  for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 5))
}

test('with no Python with pandas, session start runs thimble setup once, with one line while it installs', async ($, on) => {
  const w = world(on)
  await start($)
  expect(w.runs).toEqual([[BIN, 'setup', '--check'], [BIN, 'setup']])
  expect(w.toasts).toEqual([INSTALLING])
})

test('when setup fails, one line says why and names the command that installs it', async ($, on) => {
  const why = 'thimble: could not install pandas, which its queries need, into its own Python (Permission denied: /th).'
  const w = world(on, { setup: { exitCode: 1, stdout: `${why}\n` } })
  await start($)
  expect(w.toasts).toEqual([INSTALLING, `${why} Fix that, then run this in a terminal: ${BIN} setup`])
})

test('once it is made, session start runs nothing and shows nothing', async ($, on) => {
  const w = world(on, { made: true })
  await start($)
  expect(w.runs).toEqual([])
  expect(w.toasts).toEqual([])
})

test('when python3 has pandas, the local check alone runs, and nothing shows', async ($, on) => {
  const w = world(on, { hasPandas: true })
  await start($)
  expect(w.runs).toEqual([[BIN, 'setup', '--check']])
  expect(w.toasts).toEqual([])
})
