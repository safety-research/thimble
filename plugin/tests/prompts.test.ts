// The registry from the hooks (prompts/prompts.ts): a text is its file's words, read once per load of the module, and
// the session's events name the plugin's version once per session. `claude plugin test plugin`.
import { expect, mock, test } from 'claude-code/testing'

import { promptText, resetPrompts } from '../prompts/prompts'
import { promptStub } from './stubs'

type Json = Record<string, unknown>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

function world(on: Any) {
  mock.env(on, { THIMBLE_HOME: '/made-up/.thimble', TMPDIR: '/made-up/tmp' })
  const clock = mock.clock(on, { now: 0 })
  on('session.id', () => ({ value: 's-1' }))
  on('session.cwd', () => ({ value: '/data' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', (_$: unknown, e: { path: string }) => {
    if (e.path.endsWith('/.claude-plugin/plugin.json')) return { value: JSON.stringify({ version: '9.9.9' }) }
    return { value: promptStub(e.path) ?? '' }
  })
  const events: Json[] = []
  on('process.run', (_$: unknown, e: { argv: string[]; init?: { stdin?: string } }) => {
    if (e.argv.some(a => a.endsWith('telemetry/append.mjs'))) for (const l of String(e.init?.stdin ?? '').split('\n').filter(Boolean)) events.push(JSON.parse(l))
    return { value: { exitCode: 0, stdout: '{}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { clock, events }
}

test('a text is its file, read once', async () => {
  resetPrompts()
  const reads: string[] = []
  const $ = { plugin: { root: '/made-up/plugin' }, fs: { read: async (p: string) => { reads.push(p); return promptStub(p) ?? '' } } } as Any
  expect(await promptText($, 'labels')).toContain('LABEL {{NAME}}')
  await promptText($, 'labels')
  expect(reads).toEqual(['/made-up/plugin/prompts/labels.md'])
})

test("the session's events name the plugin's version once, at session start", async ($, on) => {
  const w = world(on)
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }) as never)
  await $.session.start({ cwd: '/data', surface: 'terminal', isInteractive: false } as never)
  await w.clock.advance(100)
  expect(w.events.filter(e => e.kind === 'prompts')).toEqual([expect.objectContaining({ kind: 'prompts', plugin: '9.9.9' })])
})
