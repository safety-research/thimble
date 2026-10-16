// thimble on at the first data read (SPEC-v2 3.3): one `thimble activate --mod`, the push of `load_thimble` to the shim
// with $.mcp.call, the guide as the Read's context; a refused folder asked once; a hook that throws still answering the
// Read once; /clear and /resume rekeying. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { FIRST_TOAST, REFUSED_TEXT } from '../activate'
import { CLI, CWD, GUIDE, SID, call, corpus, reads, startSession, trailOf, world } from './fixtures'
import type { World } from './fixtures'

const SLOW = { timeoutMs: 30000 }

async function dataRead($: Engine, w: World, path = 'events.jsonl', agentId?: string): Promise<Record<string, unknown>> {
  return call($, 'Read', { file_path: `${CWD}/${path}` }, agentId)
}

test("the first data read turns thimble on: one activate with --mod, one push of load_thimble, the guide as the Read's context, one toast naming the switch", SLOW, async ($, on) => {
  const w = world(on, { active: false })
  reads(w)
  corpus(w, ['events.jsonl', 'prs.csv'])
  await startSession($, w)
  const r = await dataRead($, w)
  expect(w.activations).toEqual([[CLI, 'activate', '--cwd', CWD, '--session', SID, '--via', 'data', '--mod', '--json']])
  expect(w.mcp).toEqual([{ server: 'plugin:thimble:thimble', tool: 'load_thimble' }])
  expect(r.context).toEqual([GUIDE])
  // the Read itself ran once, and its own result is kept
  expect(w.toolCalls.length).toBe(1)
  expect(r.text).toBe('the file')
  // thimble.ts was told before the hook returned (the trail: activate, bridge, push, then the context)
  expect(trailOf(w).slice(0, 4)).toEqual(['activate:data', 'bridge', 'push', 'context'])
  expect(w.toasts.filter(t => t === FIRST_TOAST).length).toBe(1)
  // later reads: no second activation, no second toast, no guide (it is pending its stored row)
  const again = await dataRead($, w, 'prs.csv')
  expect(w.activations.length).toBe(1)
  expect(again.context).toBeUndefined()
  expect(w.toasts.filter(t => t === FIRST_TOAST).length).toBe(1)
  // no sleep in any hook
  expect(w.sleeps).toBe(0)
})

test('a refused folder: `thimble activate` runs once and activate:refused shows once over five data reads', SLOW, async ($, on) => {
  const w = world(on, { active: false })
  w.activate = { ok: false, error: { code: 'REFUSED_HOME', message: 'thimble does not open your home folder', fix: 'cd into the data folder' } }
  reads(w)
  corpus(w, ['a.csv', 'b.csv', 'c.csv', 'd.csv', 'e.csv'])
  await startSession($, w)
  for (const f of ['a.csv', 'b.csv', 'c.csv', 'd.csv', 'e.csv']) {
    const r = await dataRead($, w, f)
    expect(r.context).toBeUndefined()
  }
  expect(w.activations.length).toBe(1)
  expect(w.toasts.filter(t => t === `thimble: ${REFUSED_TEXT}`).length).toBe(1)
  expect(w.mcp).toEqual([])
  // /thimble in that folder asks again (the person asked)
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  expect(w.activations.length).toBe(2)
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
  expect(w.activations).toEqual([])
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
