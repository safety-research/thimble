// The registry from the hooks (prompts/prompts.ts): the card guide (skills/thimble/cards.md) comes once per session
// beside Claude's first data command; Claude reading the guide itself counts as given; a compaction lets it come again;
// a version that does not exist keeps the default with one line; each delivery is a line in the session's events.
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
  expect(q.context[0]).toContain('which thimble adds once per session with your first data command')
  expect(q.context[0]).toContain('/skills/thimble/cards.md')
  expect(q.context[0]).toContain('THE WORKED FORMS')
  for (const command of ['thimble rows revisions.jsonl -n 3', 'thimble resolve r1#day=2026-06-18@n', 'thimble save y --from y.json']) {
    expect((await bash($, command)).context ?? []).toEqual([])
  }
  await w.clock.advance(100)
  expect(w.events.filter(e => e.kind === 'prompt').map(e => [e.prompt, e.via])).toEqual([['forms:v5', 'thimble run']])
})

test('thimble sources first: the guide comes with whichever data command runs first', async ($, on) => {
  const w = world(on)
  const r = await bash($, 'thimble sources')
  expect(r.context[0]).toContain('The card guide (forms:v5')
  await w.clock.advance(100)
  expect(w.events.filter(e => e.kind === 'prompt').map(e => e.via)).toEqual(['thimble sources'])
})

test('thimble q, the name run had before, is still a data command', async ($, on) => {
  const w = world(on)
  expect((await bash($, 'thimble q "x" --code "1"')).context.length).toBe(1)
  await w.clock.advance(100)
  expect(w.events.filter(e => e.kind === 'prompt').map(e => e.via)).toEqual(['thimble q'])
})

test('Claude reading the guide itself (v asks it to) counts as given: no data command brings it again', async ($, on) => {
  const w = world(on)
  const read = await $.tool.call({ tool: 'Read', file_path: '/p/skills/thimble/cards.md' } as never) as Any
  expect(read.context ?? []).toEqual([])
  expect((await bash($, 'thimble run "x" --code "1"')).context ?? []).toEqual([])
  await w.clock.advance(100)
  expect(w.events.filter(e => e.kind === 'prompt')).toEqual([])
})

test('a compaction may drop the guide: the next data command brings it again', async ($, on) => {
  world(on)
  on('session.compact', (_$: unknown, e: { messages: unknown[] }) => ({ kind: 'compacted', messages: e.messages }))
  expect((await bash($, 'thimble rows a.jsonl')).context.length).toBe(1)
  expect((await bash($, 'thimble rows a.jsonl')).context ?? []).toEqual([])
  await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'the summary', toolUses: [] }] } as never)
  expect((await bash($, 'thimble rows a.jsonl')).context.length).toBe(1)
})

test('a version that does not exist: the default is read, and one line says so', async ($, on) => {
  const w = world(on, { THIMBLE_PROMPTS: 'squeeze:v99' })
  expect((await bash($, 'thimble sources')).context.length).toBe(1)
  expect(w.toasts.some(t => t.includes('no version squeeze:v99, so squeeze stays at v6'))).toBe(true)
})

test("a conversation's first message carries one thimble block: thimble is on here, so the skill comes for a question about these files", async ($, on) => {
  const w = world(on)
  on('prompt.context', () => ({ blocks: [{ name: 'currentDate', text: 'Today is Jun 18.' }] }))
  const r = (await ($ as Any).prompt.context({ blocks: [] })) as Any
  expect(r.blocks.map((b: Any) => b.name)).toEqual(['currentDate', 'thimble'])
  expect(r.blocks[1].text).toContain('PROMPT context:v2')
  await w.clock.advance(100)
  expect(w.events.filter(e => e.kind === 'prompt').map(e => e.prompt)).toEqual(['context:v2'])
})

test('the thimble block can be turned off: THIMBLE_PROMPTS=context:off sends none', async ($, on) => {
  world(on, { THIMBLE_PROMPTS: 'context:off' })
  on('prompt.context', () => ({ blocks: [] }))
  const r = (await ($ as Any).prompt.context({ blocks: [] })) as Any
  expect(r.blocks).toEqual([])
})
