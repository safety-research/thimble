// The session's temp folders (hooks/path.ts, core/home.ts tempDir): Claude Code keeps its own temp folder where it
// started, which its Bash sandbox lets commands write, and the session's commands get thimble's folder, `thimble/` in
// Claude Code's, as their TMPDIR. All data is made up. `claude plugin test plugin`.
import { expect, mock, test } from 'claude-code/testing'

import { claudeTempRoot } from '../hooks/path'
import { promptStub, tempRun } from './stubs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const START = { cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never
const TEMPS = ['CLAUDE_CODE_TMPDIR', 'TMPDIR']

/** A machine (`uname -s`, which fails for a null system, and `id -u`) and an environment, which the hooks read and
 *  write: the temp folders they set, in order. `kept`: the temp folder an earlier load of the plugin kept in $.state. */
function world(on: Any, o: { system: string | null; uid: string; env: Record<string, string>; deny?: string; kept?: string }) {
  mock.clock(on, { now: 0 })
  if (o.kept) on('state.get', async (_$: unknown, e: Any, next: Any) => (e.key === 'tempDir' ? { value: { value: o.kept, version: 1 } } : next(e)))
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
    const said = a[0] === 'uname' ? o.system : a[0] === 'id' ? o.uid : null
    const r = said !== null ? { exitCode: 0, stdout: `${said}\n`, stderr: '' } : tempRun(a) ?? { exitCode: 1, stdout: '', stderr: 'made-up: no such command' }
    return { value: { ...r, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.id', () => ({ value: 's-temp' }))
  on('session.cwd', () => ({ value: '/made-up/data' }))
  on('session.root', () => ({ value: '/made-up/data' }))
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }) as never)
  // the card tool's guide names the temp folder, as the guidance does: what the cards module was told at session start
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: e.path.endsWith('/prompts/card-tool.md') ? 'Rows in {{TMPDIR}}.' : promptStub(e.path) ?? '' }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('fs.list', () => ({ value: [] }))
  on('fs.stat', () => ({ value: { kind: 'missing', size: 0 } }))
  const guides: string[] = []
  const datas: string[] = []
  on('tool.register', (_$: unknown, e: { name: string; description: string; inputSchema: Any }) => {
    if (e.name === 'card') {
      guides.push(e.description)
      datas.push(e.inputSchema.properties.data.description)
    }
    return { value: { tool: `mcp__thimble__${e.name}` } }
  })
  on('ui.toast', () => ({ value: undefined }))
  return { env, set, guides, datas }
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

test('Linux with no TMPDIR: Claude Code\'s temp folder stays in /tmp, and the commands\' TMPDIR is thimble\'s folder in it', async ($, on) => {
  const w = world(on, { system: 'Linux', uid: '1000', env: {} })
  await $.session.start(START)
  // CLAUDE_CODE_TMPDIR first, so Claude Code never follows TMPDIR into thimble's folder; and set before the later
  // modules asked for thimble's folder, so the card tool's guide names the same one
  expect(w.set).toEqual([['CLAUDE_CODE_TMPDIR', '/tmp'], ['TMPDIR', '/tmp/claude-1000/thimble']])
  expect(w.guides).toEqual(['Rows in /tmp/claude-1000/thimble.'])
  // the card tool's data names it by its path too: a command in Claude Code's Bash sandbox has another TMPDIR
  expect(w.datas[0]).toContain('/tmp/claude-1000/thimble')
  // a reload of the plugin, or a resumed session: nothing moves again
  await $.session.start(START)
  expect(w.set.length).toBe(2)
})

test('Linux with a TMPDIR of the person\'s: Claude Code\'s temp folder stays in it', async ($, on) => {
  const w = world(on, { system: 'Linux', uid: '1000', env: { TMPDIR: '/made-up/tmp/' } })
  await $.session.start(START)
  expect(w.set).toEqual([['CLAUDE_CODE_TMPDIR', '/made-up/tmp'], ['TMPDIR', '/made-up/tmp/claude-1000/thimble']])
})

test('macOS: Claude Code\'s temp folder stays in /tmp, not in the TMPDIR macOS gives each user', async ($, on) => {
  const w = world(on, { system: 'Darwin', uid: '501', env: { TMPDIR: '/made-up/var/folders/T/' } })
  await $.session.start(START)
  expect(w.set).toEqual([['CLAUDE_CODE_TMPDIR', '/tmp'], ['TMPDIR', '/tmp/claude-501/thimble']])
})

test('a CLAUDE_CODE_TMPDIR the person set stays, and thimble\'s folder is in Claude Code\'s temp folder there', async ($, on) => {
  const w = world(on, { system: 'Linux', uid: '1000', env: { TMPDIR: '/made-up/tmp', CLAUDE_CODE_TMPDIR: '/made-up/cc' } })
  await $.session.start(START)
  expect(w.set).toEqual([['TMPDIR', '/made-up/cc/claude-1000/thimble']])
  expect(w.env.CLAUDE_CODE_TMPDIR).toBe('/made-up/cc')
})

test('when CLAUDE_CODE_TMPDIR cannot be set, TMPDIR stays the person\'s, and thimble\'s folder is in it as before', async ($, on) => {
  const w = world(on, { system: 'Linux', uid: '1000', env: { TMPDIR: '/made-up/tmp' }, deny: 'CLAUDE_CODE_TMPDIR' })
  await $.session.start(START)
  expect(w.set).toEqual([])
  expect(w.env.TMPDIR).toBe('/made-up/tmp')
  expect(w.guides).toEqual(['Rows in /made-up/tmp/thimble.'])
})

test('when the system is not known, nothing moves either: where Claude Code keeps its temp folder is not guessed', async ($, on) => {
  const w = world(on, { system: null, uid: '1000', env: { TMPDIR: '/made-up/tmp' } })
  await $.session.start(START)
  expect(w.set).toEqual([])
  expect(w.guides).toEqual(['Rows in /made-up/tmp/thimble.'])
})

test('a reload over thimble 0.10.5, which moved TMPDIR into its temp folder alone: Claude Code\'s temp folder goes back where it started', async ($, on) => {
  // 0.10.5 found no TMPDIR, so the home's tmp/ became the session's temp folder, kept in $.state, and the commands' TMPDIR
  const w = world(on, { system: 'Linux', uid: '1000', env: { TMPDIR: '/made-up/.thimble/tmp' }, kept: '/made-up/.thimble/tmp' })
  await $.session.start(START)
  // Claude Code's folder is claude-1000/ in /tmp again, where it started and where its sandbox lets commands write; the
  // temp folder the guidance named already stays the session's
  expect(w.set).toEqual([['CLAUDE_CODE_TMPDIR', '/tmp']])
  expect(w.guides).toEqual(['Rows in /made-up/.thimble/tmp.'])
})

test('a reload over thimble 0.10.5, which made thimble/ in the person\'s TMPDIR its temp folder: Claude Code\'s goes back to that TMPDIR', async ($, on) => {
  const w = world(on, { system: 'Linux', uid: '1000', env: { TMPDIR: '/made-up/tmp/thimble' }, kept: '/made-up/tmp/thimble' })
  await $.session.start(START)
  expect(w.set).toEqual([['CLAUDE_CODE_TMPDIR', '/made-up/tmp']])
})

test('a session started in a command of a thimble 0.10.5 session keeps the TMPDIR it got, thimble/ though it is', async ($, on) => {
  // nothing in $.state: this Claude Code started with that TMPDIR, and keeps its own temp folder and its sandbox's in it
  const w = world(on, { system: 'Linux', uid: '1000', env: { TMPDIR: '/made-up/outer/thimble' } })
  await $.session.start(START)
  expect(w.set[0]).toEqual(['CLAUDE_CODE_TMPDIR', '/made-up/outer/thimble'])
})
