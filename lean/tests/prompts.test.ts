// The registry from the hooks (prompts/prompts.ts): a verb's skill never replaces the lean skill (loaded first, the
// lean skill's text comes with it, once), another version of a skill is served in place of its file's text, a skill
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
  on('fs.list', (_$: unknown, e: { path?: string }) => ({ value: String(e.path).endsWith('/prompts/lean') ? [{ name: 'v1.md', kind: 'file', size: 1, mtimeMs: 0, isLink: false }] : [] }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: e.path.endsWith('/skills/lean/SKILL.md') ? '---\nname: lean\ndescription: x\n---\n\nLEAN BODY: cite what you show.\n\n## What the person sees\n\nTHE CARD SECTION\n\n## Example: one\n\nx\n' : promptStub(e.path) ?? '' }))
  // the engine's own expansion: the text as the skill computed it
  on('skill.prompt', (_$: unknown, e: { text: string }) => ({ text: e.text }))
  // a Read answered as core does: the file's text, as the model reads it
  on('tool.call', (_$: unknown, e: { tool: string; file_path?: string; command?: string }) => ({ result: { type: 'text' }, text: /lean save/.test(String(e.command)) ? 'saved 01-x v1: thimble/objects/01-x.json' : `the file ${e.file_path}` }))
  const events: Json[] = []
  on('process.run', (_$: unknown, e: { argv: string[]; init?: { stdin?: string } }) => {
    if (e.argv.some(a => a.endsWith('telemetry/append.mjs'))) for (const l of String(e.init?.stdin ?? '').split('\n').filter(Boolean)) events.push(JSON.parse(l))
    return { value: { exitCode: 0, stdout: '{}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { events, clock }
}

const load = ($: Any, skill: string, body: string, plugin = 'thimble-lean') =>
  $.skill.prompt({ skill: `${plugin}:${skill}`, text: `Base directory for this skill: /p/${skill}\n\n${body}`, pluginName: plugin, source: 'plugin' })

test("a verb's skill loaded before the lean skill brings the lean skill's text first, once", async ($, on) => {
  const w = world(on)
  const map = String((await load($, 'map', '# Map: lay the work out')).text)
  expect(map.startsWith('LEAN BODY: cite what you show.')).toBe(true)
  expect(map).toContain('The map skill, which builds on the lean skill above:')
  expect(map).toContain('Base directory for this skill: /p/map\n\n# Map: lay the work out')
  // the lean skill is in the conversation now: the next verb skill comes alone
  const trace = String((await load($, 'trace', '# Trace')).text)
  expect(trace).toBe('Base directory for this skill: /p/trace\n\n# Trace')
  await w.clock.advance(100)
  const lines = w.events.filter(e => e.kind === 'prompt')
  expect(lines.map(e => e.via)).toEqual(['skill map', 'skill trace'])
  expect(lines[0]!.with_lean).toBe(true)
  expect(lines[0]!.prompt).toBe('map:skill')
})

test('the lean skill loaded first: a verb skill after it comes alone; a skill of another plugin is left as it is', async ($, on) => {
  world(on)
  const lean = String((await load($, 'lean', 'LEAN BODY as the file says')).text)
  expect(lean).toBe('Base directory for this skill: /p/lean\n\nLEAN BODY as the file says')
  expect(String((await load($, 'explore', '# Explore')).text)).toBe('Base directory for this skill: /p/explore\n\n# Explore')
  expect(String((await load($, 'commit', '# Commit', 'other')).text)).toBe('Base directory for this skill: /p/commit\n\n# Commit')
})

test("another version of a skill's feature is served in place of its file's text, its base folder kept", async ($, on) => {
  world(on, { LEAN_PROMPTS: 'lean:v1' })
  const lean = String((await load($, 'lean', 'LEAN BODY as the file says')).text)
  expect(lean).toBe('Base directory for this skill: /p/lean\n\nPROMPT lean:v1')
})

test('the first read of the toolkit in a session carries the card guidance as context, once; another file reads as it is', async ($, on) => {
  const w = world(on, { LEAN_PROMPTS: 'forms:principles' })
  // the plugin's folder: the one above this test's
  const root = new URL('..', import.meta.url).pathname.replace(/\/+$/, '')
  const r1 = await $.tool.call({ tool: 'Read', file_path: `${root}/draw/TOOLKIT.md` } as never) as Any
  expect(r1.text).toBe(`the file ${root}/draw/TOOLKIT.md`)
  expect(r1.context.length).toBe(1)
  expect(r1.context[0]).toContain('The card guidance (forms:principles), which thimble adds when you read the toolkit before a card.')
  expect(r1.context[0]).toContain(`Paths in it are relative to ${root}/verbs/visualize.`)
  expect(r1.context[0]).toContain('PROMPT forms:principles')
  const r2 = await $.tool.call({ tool: 'Read', file_path: `${root}/draw/TOOLKIT.md` } as never) as Any
  expect(r2.context ?? []).toEqual([])
  const r3 = await $.tool.call({ tool: 'Read', file_path: '/data/notes/TOOLKIT.md' } as never) as Any
  expect(r3.context ?? []).toEqual([])
  await w.clock.advance(100)
  expect(w.events.filter(e => e.kind === 'prompt').map(e => [e.prompt, e.via])).toEqual([['forms:principles', 'Read of draw/TOOLKIT.md']])
})

test("a toolkit read with sed in Bash carries the card guidance too: the lean skill's card section and the worked forms", async ($, on) => {
  world(on)
  const r = await $.tool.call({ tool: 'Bash', command: 'sed -n 1,80p /x/../plugin/draw/TOOLKIT.md' } as never) as Any
  expect(r.context.length).toBe(1)
  expect(r.context[0]).toContain('The card guidance (forms:runtime)')
  expect(r.context[0]).toContain('## What the person sees\n\nTHE CARD SECTION')
  expect(r.context[0]).toContain('## Worked examples\n\nTHE WORKED FORMS')
  expect(r.context[0]).not.toContain('OLD PRINCIPLES')
  const again = await $.tool.call({ tool: 'Bash', command: 'cat lean/draw/TOOLKIT.md' } as never) as Any
  expect(again.context ?? []).toEqual([])
})

test('with the lean skill loaded, its card section is in the conversation already: only the worked forms come', async ($, on) => {
  world(on)
  await load($, 'lean', 'LEAN BODY as the file says')
  const r = await $.tool.call({ tool: 'Bash', command: 'cat lean/draw/TOOLKIT.md' } as never) as Any
  expect(r.context[0]).toContain('THE WORKED FORMS')
  expect(r.context[0]).not.toContain('THE CARD SECTION')
})

test('a card saved with no toolkit read before it: the guidance comes with that first save, once', async ($, on) => {
  const w = world(on)
  const r = await $.tool.call({ tool: 'Bash', command: "lean save x <<'JSON'\n{}\nJSON" } as never) as Any
  expect(r.context[0]).toContain('which thimble adds with the first card of a session when the toolkit was not read before it')
  expect(r.context[0]).toContain('THE WORKED FORMS')
  const again = await $.tool.call({ tool: 'Bash', command: 'lean save y --from y.json' } as never) as Any
  expect(again.context ?? []).toEqual([])
  await w.clock.advance(100)
  expect(w.events.filter(e => e.kind === 'prompt').map(e => e.via)).toEqual(['the first lean save'])
})

