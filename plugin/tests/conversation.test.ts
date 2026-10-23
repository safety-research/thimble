// What a session shows and tells belongs to its conversation (hooks/conversation.ts, hooks/turnover.ts): a new
// conversation in the same folder (a new session, a /clear) starts with none of the earlier one's labels, texts for
// Claude, answers or counts, and a resumed one gets its own back. All data is made up. `claude plugin test plugin`.
import { expect, mock, test } from 'claude-code/testing'

import { labelsDir, rootHere } from '../core/env'
import { labelsDirOf } from '../core/layout.mjs'
import { tempRun } from './stubs'

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

/** An engine of the session `id` that has the files `files`, for core/env.ts's folder functions alone. */
function engineOf(id: string, files: Record<string, string>): Any {
  return {
    env: { get: async (k: string) => ({ THIMBLE_HOME: HOME, THIMBLE_START: DATA } as Any)[k] },
    fs: { stat: async () => null, exists: async (p: string) => Object.keys(files).some(f => f.startsWith(`${p}/`)) },
    session: { id: async () => id, messages: async () => [], usage: async () => ({}), cwd: async () => DATA, root: async () => DATA },
  }
}

/** The person's prompt; what it carried for Claude from thimble's own work (its report, not the guidance). */
async function ask($: Any, w: World, text: string): Promise<string> {
  await $.prompt.submit({ text, origin: { kind: 'composer' } })
  return w.context.at(-1)!.filter(c => c.startsWith("thimble's report")).join('\n')
}

test("a new conversation in the folder shows none of the earlier one's labels, and its commands run under its own key", async ($, on) => {
  const w = world(on)
  // the first conversation made a label in the folder: it finds the folder by it, a new conversation does not
  const files = { [`${labelsDirOf(HOME, 'conv-a', DATA)}/sorry.json`]: '{"name": "sorry"}' }
  expect(await labelsDir(engineOf('conv-a', files), DATA)).toBe(labelsDirOf(HOME, 'conv-a', DATA))
  expect(await rootHere(engineOf('conv-a', files))).toBe(DATA)
  expect(await labelsDir(engineOf('conv-b', files), DATA)).toBe(null)
  expect(await rootHere(engineOf('conv-b', files))).toBe(null)
  await $.session.start({ cwd: DATA, surface: 'terminal', isInteractive: true } as never)
  expect(w.env.THIMBLE_CONVERSATION).toBe('conv-a')
  // a /clear: the process goes on under a new session, with an empty conversation
  w.id = 'conv-b'
  await ask($, w, 'Which runs failed?')
  // Claude's next command keeps its labels in the new conversation's folder
  await $.tool.call({ tool: 'Bash', command: 'thimble label' } as never)
  expect(w.env.THIMBLE_SESSION).toBe('conv-b')
  expect(w.env.THIMBLE_CONVERSATION).toBe('conv-b')
  // the bar counts the new conversation's labels, with the plugin's own `thimble` calls
  await w.clock.advance(100)
  const calls = w.runs.filter(r => String(r.argv[0]).endsWith('/bin/thimble'))
  expect(calls.length).toBeGreaterThan(0)
  expect(calls.at(-1).env.THIMBLE_CONVERSATION).toBe('conv-b')
})

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
