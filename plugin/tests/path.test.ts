// The session's environment (hooks/path.ts): while Labels is off, the session's commands get the line `thimble label`
// answers Claude with (THIMBLE_LABELS_OFF). All data is made up. `claude plugin test plugin`.
import { expect, mock } from 'claude-code/testing'

import { resetPrompts } from '../prompts/prompts'
import { test } from './kit'
import { promptStub, tempRun } from './stubs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const START = { cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never

/** A Linux machine and an environment, which the hooks read and write. */
function world(on: Any) {
  mock.clock(on, { now: 0 })
  const env: Record<string, string | undefined> = { THIMBLE_HOME: '/made-up/.thimble', HOME: '/made-up/home', PATH: '/usr/bin' }
  on('env.get', (_$: unknown, e: { name: string }) => ({ value: env[e.name] }))
  on('env.set', (_$: unknown, e: { name: string; value?: string }) => {
    env[e.name] = e.value
    return { value: {} }
  })
  on('process.run', (_$: unknown, e: { argv: string[] }) => {
    const a = e.argv
    const r = a[0] === 'uname' ? { exitCode: 0, stdout: 'Linux\n', stderr: '' } : tempRun(a) ?? { exitCode: 1, stdout: '', stderr: 'made-up: no such command' }
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
  on('tool.register', (_$: unknown, e: { name: string }) => ({ value: { tool: `mcp__thimble__${e.name}` } }))
  on('ui.toast', () => ({ value: undefined }))
  return { env }
}

/** What THIMBLE_LABELS_OFF holds as each Bash call reaches Claude Code, in order: the test's engine runs a call after
 *  thimble's hooks. */
function bashSees(on: Any, w: { env: Record<string, string | undefined> }): (string | undefined)[] {
  const seen: (string | undefined)[] = []
  on('tool.call', () => {
    seen.push(w.env.THIMBLE_LABELS_OFF)
    return { result: '' }
  })
  return seen
}

const BASH = { tool: 'Bash', command: 'ls' } as never

test("with Labels off, the session's commands get the line of prompts/labels-off.md, which `thimble label` answers Claude with, from the session's start and at each Bash call", { options: { labels: false } }, async ($, on) => {
  resetPrompts()
  const w = world(on)
  const seen = bashSees(on, w)
  await $.session.start(START)
  expect(w.env.THIMBLE_LABELS_OFF).toBe('PROMPT labels-off')
  await $.tool.call(BASH)
  expect(seen).toEqual(['PROMPT labels-off'])
})
