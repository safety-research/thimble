// thimble on from the session's start, as a regular Claude Code plugin (the owner, 10-16): one `thimble activate --mod`,
// the push of `load_thimble` to the shim with $.mcp.call; a session with no person at the terminal stays off; a refused
// folder stays off quietly; a hook that throws still answering the Read once; /clear and /resume rekeying.
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { REFUSED_TEXT } from '../activate'
import { CLI, CWD, GUIDE, SID, call, corpus, reads, startSession, trailOf, world } from './fixtures'
import type { World } from './fixtures'

const SLOW = { timeoutMs: 30000 }

async function dataRead($: Engine, w: World, path = 'events.jsonl', agentId?: string): Promise<Record<string, unknown>> {
  return call($, 'Read', { file_path: `${CWD}/${path}` }, agentId)
}

test('a session start turns thimble on, as a regular plugin: one activate with --mod, one push of load_thimble; reading data starts nothing more', SLOW, async ($, on) => {
  const w = world(on, { active: false })
  reads(w)
  corpus(w, ['events.jsonl', 'prs.csv'])
  await startSession($, w)
  expect(w.activations).toEqual([[CLI, 'activate', '--cwd', CWD, '--session', SID, '--via', 'command', '--mod', '--json']])
  expect(w.mcp).toEqual([{ server: 'plugin:thimble:thimble', tool: 'load_thimble' }])
  // a data read later: the tool's own result, and no second activation
  const r = await dataRead($, w)
  expect(r.text).toBe('the file')
  expect(w.activations.length).toBe(1)
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
