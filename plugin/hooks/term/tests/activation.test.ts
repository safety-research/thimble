// thimble on from the session's start, as a regular Claude Code plugin (the owner, 10-16): one `thimble activate --mod`
// and no push of `load_thimble` (the first prompt carries the guide); a session with no person at the terminal stays
// off; a refused folder stays off quietly; a hook that throws still answering the Read once; /clear and /resume
// rekeying; tools that Claude Code lists a moment after the start, and tools it never lists.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { LISTED_CHECK_MS, NOT_LISTED_TEXT, REFUSED_TEXT } from '../activate'
import { CLI, CWD, GUIDE, HOME, SID, call, corpus, reads, startSession, trailOf, world } from './fixtures'
import type { World } from './fixtures'

const SLOW = { timeoutMs: 30000 }
// the row above the prompt, wide enough for a notice's words and acts whole
const ABOVE = { plugin: 'thimble', component: 'AbovePrompt', requestId: 'above', surface: 'terminal', viewport: { columns: 200, rows: 40 }, props: { hasSurvey: false, isWorking: false, view: {}, bodyColumns: 200 } } as never

async function dataRead($: Engine, w: World, path = 'events.jsonl', agentId?: string): Promise<Record<string, unknown>> {
  return call($, 'Read', { file_path: `${CWD}/${path}` }, agentId)
}

// bug hunt F3: a push at the start was a tool use of the plugin's, which Claude Code asks about in Manual mode before
// the person has typed anything; the shim lists thimble's tools once it sees the session's marker
test('a session start turns thimble on, as a regular plugin: one activate with --mod and no load_thimble call; the first prompt carries the guide; reading data starts nothing more', SLOW, async ($, on) => {
  const w = world(on, { active: false })
  reads(w)
  corpus(w, ['events.jsonl', 'prs.csv'])
  await startSession($, w)
  expect(w.activations).toEqual([[CLI, 'activate', '--cwd', CWD, '--session', SID, '--via', 'command', '--mod', '--json']])
  expect(w.mcp).toEqual([])
  expect(trailOf(w)).toContain('no-push')
  const p = (await $.prompt.submit({ text: 'what is in this folder?', origin: { kind: 'composer' }, wait: false } as never)) as { context?: string[] }
  expect(p.context).toEqual([GUIDE])
  // a data read later: the tool's own result, and no second activation
  const r = await dataRead($, w)
  expect(r.text).toBe('the file')
  expect(w.activations.length).toBe(1)
  expect(w.mcp).toEqual([])
  expect(w.sleeps).toBe(0)
})

test('a session where no person is at the terminal stays off', SLOW, async ($, on) => {
  const w = world(on, { active: false })
  reads(w)
  corpus(w, ['events.jsonl'])
  await startSession($, w, { isInteractive: false })
  await dataRead($, w)
  expect(w.activations).toEqual([])
})

test('a refused folder (the home folder) stays off at the start with no notice; /thimble there asks again and says why', SLOW, async ($, on) => {
  const w = world(on, { active: false })
  w.activate = { ok: false, error: { code: 'REFUSED_HOME', message: 'thimble does not open your home folder', fix: 'cd into the data folder' } }
  reads(w)
  corpus(w, ['a.csv'])
  await startSession($, w)
  expect(w.activations.length).toBe(1)
  expect(w.toasts.filter(t => t === REFUSED_TEXT).length).toBe(0)
  await dataRead($, w, 'a.csv')
  expect(w.activations.length).toBe(1)
  expect(w.mcp).toEqual([])
  // /thimble in that folder asks again (the person asked), and now says why it stays off, once
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  expect(w.activations.length).toBe(2)
  expect(w.toasts.filter(t => t === REFUSED_TEXT).length).toBe(1)
})

test("a hook that throws still answers the Read with the tool's own result, once", SLOW, async ($, on) => {
  const w = world(on, { active: false })
  reads(w)
  corpus(w, ['events.jsonl'])
  await startSession($, w)
  w.sidFails = true
  const r = await dataRead($, w)
  expect(r.text).toBe('the file')
  expect(r.context).toBeUndefined()
  expect(w.toolCalls.length).toBe(1)
  // only the session start's own activation; the Read starts none
  expect(w.activations.length).toBe(1)
})

test('/clear: the next prompt of the new conversation rekeys thimble and carries the guide; /resume rekeys and sends it only if owed', SLOW, async ($, on) => {
  const w = world(on)
  await startSession($, w)
  await $.session.end({ reason: 'clear', sessionId: SID, resume: { id: SID } } as never)
  w.sid = 's2'
  w.guideOwed = true
  const p = (await $.prompt.submit({ text: 'hello', origin: { kind: 'composer' }, wait: false } as never)) as { context?: string[] }
  expect(w.activations.length).toBe(1)
  expect(w.activations[0]).toEqual([CLI, 'activate', '--cwd', CWD, '--session', 's2', '--via', 'command', '--rekey-from', SID, '--mod', '--json'])
  expect(p.context).toEqual([GUIDE])
  expect(trailOf(w)).toEqual(expect.arrayContaining(['rekey:clear', 'bridge']))
  // /resume to a conversation whose guide was sent: rekeyed, no guide
  await $.session.end({ reason: 'resume', sessionId: 's2', resume: { id: 's2' } } as never)
  w.sid = 's3'
  w.guideOwed = false
  const q = (await $.prompt.submit({ text: 'again', origin: { kind: 'composer' }, wait: false } as never)) as { context?: string[] }
  expect(w.activations.length).toBe(2)
  expect(w.activations[1]).toContain('s3')
  expect(q.context ?? []).toEqual([])
})

// bug hunt C15: the shim went live on the session's marker before the push, so Claude Code's tools/list (and the shim's
// listed.json record) came a moment after the push answered
test("tools Claude Code lists a moment after the push: no line in main's chat, and no notice", SLOW, async ($, on) => {
  const w = world(on, { active: false })
  w.listed = false
  await startSession($, w)
  expect(w.activations.length).toBe(1)
  expect(w.said.filter(l => /did not load|listed\.json|push/.test(l))).toEqual([])
  w.files.set(`${HOME}/up/${SID}/listed.json`, JSON.stringify({ digest: 'd', count: 36, names: [], at: w.clock.now() / 1000 + 1 }))
  await w.clock.advance(LISTED_CHECK_MS + 100)
  await w.clock.settle()
  expect(w.toasts.filter(t => t.includes('did not load'))).toEqual([])
  expect(w.said.filter(l => /did not load|listed\.json|push/.test(l))).toEqual([])
})

test('tools Claude Code never lists: one notice in plain words, whose act opens /mcp to reconnect thimble', SLOW, async ($, on) => {
  const w = world(on, { active: false })
  w.listed = false
  await startSession($, w)
  await w.clock.advance(LISTED_CHECK_MS + 100)
  await w.clock.settle()
  expect(w.said.filter(l => /did not load|listed\.json|push/.test(l))).toEqual([])
  expect(w.toasts).toContain(NOT_LISTED_TEXT)
  expect(NOT_LISTED_TEXT).not.toMatch(/push|listed\.json|thimble: thimble/)
  const m = (await $.ui.mount(ABOVE)) as unknown as Mounted<'terminal'>
  const row = JSON.stringify(await m.find({ type: 'Box', key: 'above-mod-tools-not-listed' }))
  expect(row).toContain('reconnect in /mcp')
  await m.press({ key: 'above-mod-tools-not-listed-act-0' })
  await w.clock.settle()
  expect(w.commands).toContain('/mcp')
  await m.unmount()
})
