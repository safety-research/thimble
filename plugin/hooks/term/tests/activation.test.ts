// thimble on from the session's start, as a regular Claude Code plugin: one `thimble activate --mod`
// and no push of `load_thimble` (the first prompt carries the guide); a session with no person at the terminal stays
// off; a refused folder stays off quietly; a hook that throws still answering the Read once; /clear and /resume
// rekeying; tools that Claude Code lists a moment after the start, and tools it never lists.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { LISTED_CHECK_MS, NOT_LISTED_TEXT, REFUSED_TEXT } from '../activate'
import { CLI, CWD, GUIDE, HOME, SID, WS, aTurn, call, corpus, reads, startSession, trailOf, world } from './fixtures'
import { words } from './fixtures-panel'
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
  expect(w.activations).toEqual([[CLI, 'activate', '--cwd', CWD, '--session', SID, '--via', 'start', '--mod', '--json']])
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

// bug hunt 7, H13: a second plain `claude` in the folder took main at its start, as /thimble does, though the browser
// kept following the first session; H14: /thimble in a session another took main from only opened the home panel,
// though the refusal says "type /thimble in this terminal to take it back"
test('the start activates as `start`, a peer beside a live main; /thimble in a session thimble is on in makes it main (--take)', SLOW, async ($, on) => {
  const w = world(on, { active: false })
  w.activate = { ...w.activate, role: 'peer' }
  await startSession($, w)
  expect(w.activations).toEqual([[CLI, 'activate', '--cwd', CWD, '--session', SID, '--via', 'start', '--mod', '--json']])
  w.activate = { ...w.activate, role: 'main', took_over: 'sess-other' }
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  expect(w.activations.length).toBe(2)
  expect(w.activations[1]).toEqual([CLI, 'activate', '--cwd', CWD, '--session', SID, '--via', 'command', '--take', '--mod', '--json'])
  expect(trailOf(w)).toContain('took-main')
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

// bug hunt H18: right after /clear the thimble line read `threads 0  citations 0  checks 0`, and with the next answer
// threads was back while checks stayed 0: the workspace's counts (threads, the checks' comments) stay across /clear, and
// the conversation's (its citations) start over from none, as in any new conversation
test("/clear: the thimble line counts the workspace's threads and the checks' comments as before, and the new conversation's citations alone", SLOW, async ($, on) => {
  const w = world(on)
  const comment = (id: string) => ({ id, check: 'important-details', check_name: 'Important details', color: 2, turn: 'r1', row: 'r1', ref: `answer:r1#s${id.slice(1)}`, start: 0, end: 10, quote: 'The wiki h', text: 'which wiki?', status: 'open', at: '2026-10-16T16:06:00Z', sid: SID })
  w.comments = [comment('k1'), comment('k2')]
  await startSession($, w)
  await aTurn($, w, 'r1', 'The wiki has [4579](README.md#L3) pages.')
  w.stamps.set(`${WS}/answer-comments.json`, 2)
  await w.clock.advance(1100)
  await w.clock.settle()
  const line = async () => {
    const m = (await $.ui.mount(ABOVE)) as unknown as Mounted<'terminal'>
    const said = words(await m.find({ type: 'Box', key: 'above-summary' })).replace(/ +/g, ' ').trim()
    await m.unmount()
    return said
  }
  expect(await line()).toMatch(/threads 2 citations 1 (◌ )?labels 1 checks 2/)
  await $.session.end({ reason: 'clear', sessionId: SID, resume: { id: SID } } as never)
  w.sid = 's2'
  await w.clock.advance(1100)
  await w.clock.settle()
  expect(await line()).toMatch(/threads 2 citations 0 labels 1 checks 2/)
  // the new conversation's first answer: its own citation, the same threads and comments
  await aTurn($, w, 'r2', 'There are [14592](README.md#L5) revisions.')
  w.stamps.set(`${WS}/answer-comments.json`, 3)
  await w.clock.advance(1100)
  await w.clock.settle()
  expect(await line()).toMatch(/threads 2 citations 1 (◌ )?labels 1 checks 2/)
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
