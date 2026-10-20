// The registry from the hooks (prompts/prompts.ts): a verb's skill never replaces the thimble skill (loaded first, the
// thimble skill's text comes with it, once), another version of a skill is served in place of its file's text, a skill
// of another plugin is left alone, and each load is a line in the session's events.
// `claude plugin test lean`.
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
  on('fs.list', (_$: unknown, e: { path?: string }) => ({ value: String(e.path).endsWith('/prompts/thimble') ? [{ name: 'v1.md', kind: 'file', size: 1, mtimeMs: 0, isLink: false }] : [] }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: e.path.endsWith('/skills/thimble/SKILL.md') ? '---\nname: thimble\ndescription: x\n---\n\nLEAN BODY: cite what you show.\n\n## Cards\n\nTHE CARD SECTION\n\n## Example: one\n\nx\n' : promptStub(e.path) ?? '' }))
  // the engine's own expansion: the text as the skill computed it
  on('skill.prompt', (_$: unknown, e: { text: string }) => ({ text: e.text }))
  // a Read answered as core does: the file's text, as the model reads it
  on('tool.call', (_$: unknown, e: { tool: string; file_path?: string; command?: string }) => ({ result: { type: 'text' }, text: /thimble save/.test(String(e.command)) ? 'saved 01-x v1: thimble/objects/01-x.json' : `the file ${e.file_path}` }))
  const events: Json[] = []
  on('process.run', (_$: unknown, e: { argv: string[]; init?: { stdin?: string } }) => {
    if (e.argv.some(a => a.endsWith('telemetry/append.mjs'))) for (const l of String(e.init?.stdin ?? '').split('\n').filter(Boolean)) events.push(JSON.parse(l))
    return { value: { exitCode: 0, stdout: '{}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { events, clock }
}

const load = ($: Any, skill: string, body: string, plugin = 'thimble') =>
  $.skill.prompt({ skill: `${plugin}:${skill}`, text: `Base directory for this skill: /p/${skill}\n\n${body}`, pluginName: plugin, source: 'plugin' })

test("a verb's skill loaded before the thimble skill brings the thimble skill's text first, once", async ($, on) => {
  const w = world(on)
  const map = String((await load($, 'map', '# Map: lay the work out')).text)
  expect(map.startsWith('LEAN BODY: cite what you show.')).toBe(true)
  expect(map).toContain('The map skill, which builds on the thimble skill above:')
  expect(map).toContain('Base directory for this skill: /p/map\n\n# Map: lay the work out')
  // the thimble skill is in the conversation now: the next verb skill comes alone
  const trace = String((await load($, 'trace', '# Trace')).text)
  expect(trace).toBe('Base directory for this skill: /p/trace\n\n# Trace')
  await w.clock.advance(100)
  const lines = w.events.filter(e => e.kind === 'prompt')
  expect(lines.map(e => e.via)).toEqual(['skill map', 'skill trace'])
  expect(lines[0]!.with_lean).toBe(true)
  expect(lines[0]!.prompt).toBe('map:skill')
})

test('the thimble skill loaded first: a verb skill after it comes alone; a skill of another plugin is left as it is', async ($, on) => {
  world(on)
  const lean = String((await load($, 'thimble', 'LEAN BODY as the file says')).text)
  expect(lean).toBe('Base directory for this skill: /p/thimble\n\nLEAN BODY as the file says')
  expect(String((await load($, 'explore', '# Explore')).text)).toBe('Base directory for this skill: /p/explore\n\n# Explore')
  expect(String((await load($, 'commit', '# Commit', 'other')).text)).toBe('Base directory for this skill: /p/commit\n\n# Commit')
})

test("another version of a skill's feature is served in place of its file's text, its base folder kept", async ($, on) => {
  world(on, { THIMBLE_PROMPTS: 'thimble:v1' })
  const lean = String((await load($, 'thimble', 'LEAN BODY as the file says')).text)
  expect(lean).toBe('Base directory for this skill: /p/thimble\n\nPROMPT thimble:v1')
})

test('the first read of the toolkit in a session carries the card guidance as context, once; another file reads as it is', async ($, on) => {
  const w = world(on, { THIMBLE_PROMPTS: 'forms:principles' })
  // the plugin's folder: the one above this test's
  const root = new URL('..', import.meta.url).pathname.replace(/\/+$/, '')
  const r1 = await $.tool.call({ tool: 'Read', file_path: `${root}/draw/TOOLKIT.md` } as never) as Any
  expect(r1.text).toBe(`the file ${root}/draw/TOOLKIT.md`)
  expect(r1.context.length).toBe(1)
  expect(r1.context[0]).toContain('The card guidance (forms:principles), which thimble adds when you read the toolkit before a card.')
  expect(r1.context[0]).toContain(`Paths in it are relative to ${root}/verbs/visualize.`)
  expect(r1.context[0]).toContain('## Cards\n\nTHE CARD SECTION')
  expect(r1.context[0]).toContain('## What makes a great output\n\nTHE PRINCIPLES')
  expect(r1.context[0]).not.toContain('POOL')
  const r2 = await $.tool.call({ tool: 'Read', file_path: `${root}/draw/TOOLKIT.md` } as never) as Any
  expect(r2.context ?? []).toEqual([])
  const r3 = await $.tool.call({ tool: 'Read', file_path: '/data/notes/TOOLKIT.md' } as never) as Any
  expect(r3.context ?? []).toEqual([])
  await w.clock.advance(100)
  expect(w.events.filter(e => e.kind === 'prompt').map(e => [e.prompt, e.via])).toEqual([['forms:principles', 'Read of draw/TOOLKIT.md']])
})

test("a toolkit read with sed in Bash carries the card guidance too: the thimble skill's card section and the worked forms", async ($, on) => {
  world(on)
  const r = await $.tool.call({ tool: 'Bash', command: 'sed -n 1,80p /x/../plugin/draw/TOOLKIT.md' } as never) as Any
  expect(r.context.length).toBe(1)
  expect(r.context[0]).toContain('The card guidance (forms:v3)')
  expect(r.context[0]).toContain('## Cards\n\nTHE CARD SECTION')
  expect(r.context[0]).toContain('## Making a card\n\nTHE WORKED FORMS')
  expect(r.context[0]).not.toContain('OLD PRINCIPLES')
  const again = await $.tool.call({ tool: 'Bash', command: 'cat lean/draw/TOOLKIT.md' } as never) as Any
  expect(again.context ?? []).toEqual([])
})

test('a loaded thimble skill is named to the session\'s commands, so `thimble guide cards` leaves its card section out; a compaction clears it', async ($, on) => {
  world(on)
  const sets: [string, string | undefined][] = []
  on('env.set', (_$: unknown, e: { name: string; value?: string }) => { if (e.name === 'THIMBLE_SKILL_LOADED') sets.push([e.name, e.value]); return { value: {} } })
  on('session.compact', (_$: unknown, e: { messages: unknown[] }) => ({ messages: e.messages }))
  await load($, 'thimble', 'LEAN BODY as the file says')
  expect(sets.at(-1)).toEqual(['THIMBLE_SKILL_LOADED', '1'])
  await $.session.compact({ messages: [{ role: 'user', text: 'the summary', toolUses: [] }] } as never)
  expect(sets.at(-1)).toEqual(['THIMBLE_SKILL_LOADED', ''])
})

test('with the thimble skill loaded, its card section is in the conversation already: only the worked forms come', async ($, on) => {
  world(on)
  await load($, 'thimble', 'LEAN BODY as the file says')
  const r = await $.tool.call({ tool: 'Bash', command: 'cat lean/draw/TOOLKIT.md' } as never) as Any
  expect(r.context[0]).toContain('THE WORKED FORMS')
  expect(r.context[0]).not.toContain('THE CARD SECTION')
})

test("the first data command of a session carries the card guidance, once; a save never does", async ($, on) => {
  const w = world(on)
  const save = await $.tool.call({ tool: 'Bash', command: "thimble save x <<'JSON'\n{}\nJSON" } as never) as Any
  expect(save.context ?? []).toEqual([])
  const plain = await $.tool.call({ tool: 'Bash', command: 'ls -la' } as never) as Any
  expect(plain.context ?? []).toEqual([])
  const q = await $.tool.call({ tool: 'Bash', command: "cd /data && thimble run \"saves per day\" <<'PY'\ntally(df, 'day')\nPY" } as never) as Any
  expect(q.context.length).toBe(1)
  expect(q.context[0]).toContain('which thimble adds once per session with your first data command')
  expect(q.context[0]).toContain('THE WORKED FORMS')
  for (const command of ['thimble rows revisions.jsonl -n 3', 'thimble resolve q1#day=2026-06-18@n', 'thimble save y --from y.json', 'cat lean/draw/TOOLKIT.md']) {
    const again = await $.tool.call({ tool: 'Bash', command } as never) as Any
    expect(again.context ?? []).toEqual([])
  }
  await w.clock.advance(100)
  const lines = w.events.filter(e => e.kind === 'prompt')
  expect(lines.map(e => [e.prompt, e.via])).toEqual([['forms:v3', 'thimble run']])
})

test('thimble q, the name run had before, is still a data command', async ($, on) => {
  const w = world(on)
  const q = await $.tool.call({ tool: 'Bash', command: 'thimble q "x" --code "1"' } as never) as Any
  expect(q.context.length).toBe(1)
  await w.clock.advance(100)
  expect(w.events.filter(e => e.kind === 'prompt').map(e => e.via)).toEqual(['thimble q'])
})

test('thimble sources, rows or resolve first: the guidance comes with whichever runs first', async ($, on) => {
  const w = world(on, { THIMBLE_PROMPTS: 'forms:principles' })
  const r = await $.tool.call({ tool: 'Bash', command: 'thimble sources' } as never) as Any
  expect(r.context[0]).toContain('The card guidance (forms:principles)')
  await w.clock.advance(100)
  expect(w.events.filter(e => e.kind === 'prompt').map(e => e.via)).toEqual(['thimble sources'])
})


test("a version that picks examples: the session's own few, named in its record", async ($, on) => {
  const w = world(on, { THIMBLE_PROMPTS: 'forms:rotate' })
  const r = await $.tool.call({ tool: 'Bash', command: 'cat lean/draw/TOOLKIT.md' } as never) as Any
  const text = String(r.context[0])
  expect(text).toContain('THE PRINCIPLES')
  expect(text).toContain('POOL examples')
  const shown = ['Alpha', 'Beta', 'Gamma', 'Delta'].filter(h => text.includes(`### ${h}`))
  expect(shown.length).toBe(3)
  await w.clock.advance(100)
  const line = w.events.find(e => e.kind === 'prompt') as Any
  expect(line.prompt).toBe('forms:rotate')
  expect(line.examples).toEqual(shown)
})

test('after `thimble guide cards` printed the guidance, no toolkit read or save brings it a second time', async ($, on) => {
  const w = world(on)
  const g = await $.tool.call({ tool: 'Bash', command: 'thimble guide cards' } as never) as Any
  expect(g.context ?? []).toEqual([])
  const save = await $.tool.call({ tool: 'Bash', command: 'thimble save x --from x.json' } as never) as Any
  expect(save.context ?? []).toEqual([])
  const read = await $.tool.call({ tool: 'Bash', command: 'cat lean/draw/TOOLKIT.md' } as never) as Any
  expect(read.context ?? []).toEqual([])
  const q = await $.tool.call({ tool: 'Bash', command: 'thimble run "x" --code "1"' } as never) as Any
  expect(q.context ?? []).toEqual([])
  await w.clock.advance(100)
  expect(w.events.filter(e => e.kind === 'prompt')).toEqual([])
})
