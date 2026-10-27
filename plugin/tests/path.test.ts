// The session's temp folders (hooks/path.ts): Claude Code keeps its own temp folder where it started, which its Bash
// sandbox lets commands write, while the session's commands get thimble's folder as their TMPDIR. All data is made up.
// `claude plugin test plugin`.
import { expect, mock, test } from 'claude-code/testing'

import { claudeTempRoot } from '../hooks/path'
import { promptStub, tempRun } from './stubs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const START = { cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never
const TEMPS = ['CLAUDE_CODE_TMPDIR', 'TMPDIR']

/** A machine (`uname -s`, which fails for a null system) and an environment, which the hooks read and write: the temp
 *  folders they set, in order. */
function world(on: Any, o: { system: string | null; env: Record<string, string>; deny?: string }) {
  mock.clock(on, { now: 0 })
  const env: Record<string, string | undefined> = { THIMBLE_HOME: '/made-up/.thimble', HOME: '/made-up/home', PATH: '/usr/bin', ...o.env }
  const set: [string, string | undefined][] = []
  on('env.get', (_$: unknown, e: { name: string }) => ({ value: env[e.name] }))
  on('env.set', (_$: unknown, e: { name: string; value?: string }) => {
    if (e.name === o.deny) return { value: { deny: `${e.name} is unchanged: a made-up rule` } }
    if (TEMPS.includes(e.name)) set.push([e.name, e.value])
    env[e.name] = e.value
    return { value: {} }
  })
  on('process.run', (_$: unknown, e: { argv: string[] }) => {
    const a = e.argv
    const r = a[0] === 'uname' && o.system !== null ? { exitCode: 0, stdout: `${o.system}\n`, stderr: '' } : tempRun(a) ?? { exitCode: 1, stdout: '', stderr: 'made-up: no such command' }
    return { value: { ...r, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.id', () => ({ value: 's-temp' }))
  on('session.cwd', () => ({ value: '/made-up/data' }))
  on('session.root', () => ({ value: '/made-up/data' }))
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }) as never)
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: promptStub(e.path) ?? '' }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('fs.list', () => ({ value: [] }))
  on('fs.stat', () => ({ value: { kind: 'missing', size: 0 } }))
  on('tool.register', (_$: unknown, e: { name: string }) => ({ value: { tool: `mcp__thimble__${e.name}` } }))
  on('ui.toast', () => ({ value: undefined }))
  return { env, set }
}

test('Claude Code keeps its temp folder where it started, by its own rule on each system', async () => {
  // macOS: /tmp, whatever TMPDIR says; elsewhere the first of TMPDIR, TMP and TEMP that is set, else /tmp
  expect(claudeTempRoot('Darwin', { TMPDIR: '/made-up/var/folders/T/' })).toBe('/tmp')
  expect(claudeTempRoot('Linux', {})).toBe('/tmp')
  expect(claudeTempRoot('Linux', { TMPDIR: '/made-up/tmp/' })).toBe('/made-up/tmp')
  expect(claudeTempRoot('Linux', { TMP: '/made-up/tmp2', TEMP: '/made-up/tmp3' })).toBe('/made-up/tmp2')
  expect(claudeTempRoot('Linux', { TEMP: '/made-up/tmp3' })).toBe('/made-up/tmp3')
  // a TMPDIR that is set but empty names no folder, and TMP does not stand in for it
  expect(claudeTempRoot('Linux', { TMPDIR: '', TMP: '/made-up/tmp2' })).toBe('/tmp')
})

test('Linux with no TMPDIR: Claude Code\'s temp folder stays in /tmp when the commands\' TMPDIR moves', async ($, on) => {
  const w = world(on, { system: 'Linux', env: {} })
  await $.session.start(START)
  // CLAUDE_CODE_TMPDIR first, so Claude Code never follows TMPDIR into thimble's folder
  expect(w.set).toEqual([['CLAUDE_CODE_TMPDIR', '/tmp'], ['TMPDIR', '/made-up/.thimble/tmp']])
  // a reload of the plugin, or a resumed session: nothing moves again
  await $.session.start(START)
  expect(w.set.length).toBe(2)
})

test('Linux with a TMPDIR of the person\'s: Claude Code\'s temp folder stays in it', async ($, on) => {
  const w = world(on, { system: 'Linux', env: { TMPDIR: '/made-up/tmp/' } })
  await $.session.start(START)
  expect(w.set).toEqual([['CLAUDE_CODE_TMPDIR', '/made-up/tmp'], ['TMPDIR', '/made-up/tmp/thimble']])
})

test('macOS: Claude Code\'s temp folder stays in /tmp, not in the TMPDIR macOS gives each user', async ($, on) => {
  const w = world(on, { system: 'Darwin', env: { TMPDIR: '/made-up/var/folders/T/' } })
  await $.session.start(START)
  expect(w.set).toEqual([['CLAUDE_CODE_TMPDIR', '/tmp'], ['TMPDIR', '/made-up/var/folders/T/thimble']])
})

test('a CLAUDE_CODE_TMPDIR the person set stays', async ($, on) => {
  const w = world(on, { system: 'Linux', env: { TMPDIR: '/made-up/tmp', CLAUDE_CODE_TMPDIR: '/made-up/cc' } })
  await $.session.start(START)
  expect(w.set).toEqual([['TMPDIR', '/made-up/tmp/thimble']])
  expect(w.env.CLAUDE_CODE_TMPDIR).toBe('/made-up/cc')
})

test('when CLAUDE_CODE_TMPDIR cannot be set, TMPDIR stays the person\'s', async ($, on) => {
  const w = world(on, { system: 'Linux', env: { TMPDIR: '/made-up/tmp' }, deny: 'CLAUDE_CODE_TMPDIR' })
  await $.session.start(START)
  expect(w.set).toEqual([])
  expect(w.env.TMPDIR).toBe('/made-up/tmp')
})

test('when the system is not known, nothing moves either: where Claude Code keeps its temp folder is not guessed', async ($, on) => {
  const w = world(on, { system: null, env: { TMPDIR: '/made-up/tmp' } })
  await $.session.start(START)
  expect(w.set).toEqual([])
})
