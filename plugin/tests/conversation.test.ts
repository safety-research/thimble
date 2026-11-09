// What a session tells Claude belongs to its conversation (hooks/conversation.ts, hooks/turnover.ts): after a /clear
// the new conversation's Claude hears nothing the earlier one was owed, and a /resume back brings it. All data is made
// up. `claude plugin test plugin`.
import { expect, mock } from 'claude-code/testing'

import { test } from './kit'
import { NOTICES, tempRun } from './stubs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const HOME = '/made-up/.thimble'
const DATA = '/made-up/data'

/** One Claude Code process: its session id changes as a /clear or a /resume changes it. */
type World = { id: string; messages: Any[]; files: Record<string, string>; env: Record<string, string | undefined>; context: string[][]; runs: Any[]; clock: Any }

function world(on: Any): World {
  const w: World = { id: 'conv-a', messages: [], files: {}, env: {}, context: [], runs: [], clock: null }
  mock.env(on, { THIMBLE_HOME: HOME, HOME: '/made-up/home', TMPDIR: '/made-up/tmp', PATH: '/usr/bin' })
  const clock = mock.clock(on, { now: 0 })
  on('env.set', (_$: unknown, e: Any) => { w.env[e.name] = e.value; return { value: {} } })
  on('session.id', () => ({ value: w.id }))
  on('session.messages', () => ({ value: w.messages }))
  on('session.cwd', () => ({ value: DATA }))
  on('session.root', () => ({ value: DATA }))
  on('fs.write', (_$: unknown, e: Any) => { w.files[e.path] = e.text; return { value: undefined } })
  on('fs.read', (_$: unknown, e: Any) => {
    // the text that frames thimble's reports, which the plugin reads as it tells Claude (core/tell.ts)
    if (e.path.endsWith('/prompts/notices.md')) return { value: NOTICES }
    if (!(e.path in w.files)) throw new Error(`made-up: no file ${e.path}`)
    return { value: w.files[e.path] }
  })
  on('fs.exists', (_$: unknown, e: Any) => ({ value: e.path in w.files || Object.keys(w.files).some(p => p.startsWith(`${e.path}/`)) }))
  on('fs.list', () => ({ value: [] }))
  on('fs.stat', () => ({ value: { kind: 'missing', size: 0 } }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', (_$: unknown, e: { argv: string[]; init?: Any }) => {
    w.runs.push({ argv: e.argv, env: e.init?.env })
    return { value: { ...(tempRun(e.argv) ?? { exitCode: 0, stdout: '[]', stderr: '' }), isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }) as never)
  on('prompt.submit', (_$: unknown, e: Any) => {
    w.context.push([...(e.context ?? [])])
    return { text: e.text, context: e.context ?? [] }
  })
  on('tool.call', () => ({ result: '' }))
  w.clock = clock
  return w
}

/** The person's prompt; what it carried for Claude from thimble's own work (its report, not the guidance). */
async function ask($: Any, w: World, text: string): Promise<string> {
  await $.prompt.submit({ text, origin: { kind: 'composer' } })
  return w.context.at(-1)!.filter(c => c.startsWith("thimble's report")).join('\n')
}

test("a /clear leaves what thimble owed the earlier conversation's Claude in it, and a /resume back brings it", async ($, on) => {
  const w = world(on)
  // the first conversation owes its Claude a report (kept in its folder, as core/tell.ts keeps one)
  w.files[`${HOME}/conversations/conv-a/tell.json`] = JSON.stringify({ 'label:made-up': "The model's reads of the label sorry are done." })
  await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
  // a /clear before the person's next prompt: the new conversation's Claude hears nothing of it
  w.id = 'conv-b'
  expect(await ask($, w, 'Hello')).toBe('')
  // a /resume back to the first conversation (its transcript comes back with it): its Claude hears it now, once
  w.id = 'conv-a'
  w.messages = [{ role: 'user', content: [{ type: 'text', text: 'Which runs failed?' }] }]
  expect(await ask($, w, 'And the label?')).toContain("The model's reads of the label sorry are done.")
  expect(await ask($, w, 'Thanks')).toBe('')
})
