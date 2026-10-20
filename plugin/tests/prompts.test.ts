// The registry from the hooks (prompts/prompts.ts): the card guide (skills/thimble/cards.md) comes once per session
// beside Claude's first data command, and again after a compaction; a conversation's first message carries the thimble
// block; a THIMBLE_PROMPTS pair that cannot be read is said in one line; each delivery is a line in the session's events.
// `claude plugin test plugin`.
import { expect, mock, test } from 'claude-code/testing'

import { promptStub } from './stubs'

type Json = Record<string, unknown>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

function world(on: Any, env: Record<string, string> = {}) {
  mock.env(on, { THIMBLE_HOME: '/home/t/.thimble', ...env })
  const clock = mock.clock(on, { now: 0 })
  on('session.id', () => ({ value: 's-1' }))
  on('session.cwd', () => ({ value: '/data' }))
  on('fs.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: promptStub(e.path) ?? '' }))
  // a call answered as core does: the file's text for a Read, a saved line for a save
  on('tool.call', (_$: unknown, e: { tool: string; file_path?: string; command?: string }) => ({ result: { type: 'text' }, text: /thimble save/.test(String(e.command)) ? 'saved 01-x v1: thimble/objects/01-x.json' : `the file ${e.file_path}` }))
  const toasts: string[] = []
  on('ui.toast', (_$: unknown, e: unknown) => { toasts.push(typeof e === 'string' ? e : String((e as { text?: string })?.text ?? '')); return { value: undefined } })
  const events: Json[] = []
  on('process.run', (_$: unknown, e: { argv: string[]; init?: { stdin?: string } }) => {
    if (e.argv.some(a => a.endsWith('telemetry/append.mjs'))) for (const l of String(e.init?.stdin ?? '').split('\n').filter(Boolean)) events.push(JSON.parse(l))
    return { value: { exitCode: 0, stdout: '{}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { events, clock, toasts }
}

const bash = ($: Any, command: string) => $.tool.call({ tool: 'Bash', command } as never) as Promise<Any>

test('the first data command of a session carries the card guide, once; a save or another command never does', async ($, on) => {
  const w = world(on)
  expect((await bash($, "thimble save x <<'JSON'\n{}\nJSON")).context ?? []).toEqual([])
  expect((await bash($, 'ls -la')).context ?? []).toEqual([])
  const q = await bash($, "cd /data && thimble run \"saves per day\" <<'PY'\ntally(df, 'day')\nPY")
  expect(q.context.length).toBe(1)
  expect(q.context[0]).toContain('/skills/thimble/cards.md')
  expect(q.context[0]).toContain('THE WORKED FORMS')
  for (const command of ['thimble rows revisions.jsonl -n 3', 'thimble resolve r1#day=2026-06-18@n', 'thimble save y --from y.json']) {
    expect((await bash($, command)).context ?? []).toEqual([])
  }
  await w.clock.advance(100)
  expect(w.events.filter(e => e.kind === 'prompt').map(e => [e.prompt, e.via])).toEqual([['forms', 'thimble run']])
})

test('a compaction may drop the guide: the next data command brings it again', async ($, on) => {
  world(on)
  on('session.compact', (_$: unknown, e: { messages: unknown[] }) => ({ kind: 'compacted', messages: e.messages }))
  expect((await bash($, 'thimble rows a.jsonl')).context.length).toBe(1)
  expect((await bash($, 'thimble rows a.jsonl')).context ?? []).toEqual([])
  await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'the summary', toolUses: [] }] } as never)
  expect((await bash($, 'thimble rows a.jsonl')).context.length).toBe(1)
})

test('a version or a text that cannot be off: every text is read, and one line says so', async ($, on) => {
  const w = world(on, { THIMBLE_PROMPTS: 'squeeze:v8, forms:off' })
  expect((await bash($, 'thimble sources')).context.length).toBe(1)
  expect(w.toasts.length).toBe(1)
  expect(w.toasts[0]).toContain('squeeze:v8')
  await w.clock.advance(100)
  expect(w.events.find(e => e.kind === 'prompts')).toMatchObject({ off: [], problems: [expect.stringContaining('squeeze:v8'), expect.stringContaining('forms cannot be turned off')] })
})

test("a conversation's first message carries one thimble block: thimble is on here, so the skill comes for a question about these files", async ($, on) => {
  const w = world(on)
  on('prompt.context', () => ({ blocks: [{ name: 'currentDate', text: 'Today is Jun 18.' }] }))
  const r = (await ($ as Any).prompt.context({ blocks: [] })) as Any
  expect(r.blocks.map((b: Any) => b.name)).toEqual(['currentDate', 'thimble'])
  expect(r.blocks[1].text).toContain('PROMPT context')
  await w.clock.advance(100)
  expect(w.events.filter(e => e.kind === 'prompt').map(e => e.prompt)).toEqual(['context'])
})
