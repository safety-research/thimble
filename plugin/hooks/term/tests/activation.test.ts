// thimble on at the first data read (SPEC-v2 3.3): one `thimble activate --mod`, the push of `load_thimble` to the shim
// with $.mcp.call, thimble.ts told before the hook returns, the guide as the Read's context; a refused folder asked
// once; parallel reads sharing one activation within their hook budget; a hook that throws still answering the Read
// once; the tools:not-listed notice from a timer; `load_thimble` seen turns thimble on with no second activation; a
// module reload, /clear and /resume restore quietly. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { FIRST_TOAST, NOT_LISTED_LINE, NOT_LISTED_TEXT, REFUSED_TEXT } from '../activate'
import { CLI, CWD, GUIDE, HOME, SID, call, corpus, reads, startSession, trailOf, world } from './fixtures'
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

test('the toast shows once per folder, across sessions ($.store keeps the folders)', SLOW, async ($, on) => {
  const w = world(on, { active: false, store: { toasted: [CWD] } })
  reads(w)
  corpus(w, ['events.jsonl'])
  await startSession($, w)
  await dataRead($, w)
  expect(w.activations.length).toBe(1)
  expect(w.toasts).not.toContain(FIRST_TOAST)
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
  expect(w.toasts.filter(t => t === REFUSED_TEXT).length).toBe(1)
  expect(w.mcp).toEqual([])
  // /thimble in that folder asks again (the person asked)
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  expect(w.activations.length).toBe(2)
})

test('single flight: four parallel data reads run one activation; only the first gets the guide, the others return within their budget without it', SLOW, async ($, on) => {
  const w = world(on, { active: false })
  reads(w)
  corpus(w, ['a.csv', 'b.csv', 'c.csv', 'd.csv'])
  await startSession($, w)
  let release = () => undefined as void
  w.holdActivate = new Promise<void>(r => {
    release = r
  })
  const done: Record<string, unknown>[] = []
  const first = dataRead($, w, 'a.csv').then(r => (done.push(r), r))
  await w.clock.settle()
  const others = ['b.csv', 'c.csv', 'd.csv'].map(f => dataRead($, w, f).then(r => (done.push(r), r)))
  await w.clock.settle()
  // the others wait at most their budget less a second, on a timer
  await w.clock.advance(9500)
  const late = await Promise.all(others)
  expect(late.map(r => r.context)).toEqual([undefined, undefined, undefined])
  expect(late.map(r => r.text)).toEqual(['the file', 'the file', 'the file'])
  expect(done.length).toBe(3)
  release()
  const won = await first
  expect(won.context).toEqual([GUIDE])
  expect(w.activations.length).toBe(1)
  expect(w.toolCalls.length).toBe(4)
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

test("no listed.json record after the push: the one-line context, the guide kept owed, and tools:not-listed from a timer at 10 s", SLOW, async ($, on) => {
  const w = world(on, { active: false })
  w.listed = false
  reads(w)
  corpus(w, ['events.jsonl', 'prs.csv'])
  await startSession($, w)
  const r = await dataRead($, w)
  expect(r.context).toEqual([NOT_LISTED_LINE])
  expect(w.toasts).not.toContain(NOT_LISTED_TEXT)
  await w.clock.advance(10_000)
  expect(w.toasts.filter(t => t === NOT_LISTED_TEXT).length).toBe(1)
  // the guide stays owed: the next tool call of main's carries it
  const next = await dataRead($, w, 'prs.csv')
  expect(next.context).toEqual([GUIDE])
})

test("Claude's own load_thimble turns thimble on here with no second activation; its stored result marks the guide sent", SLOW, async ($, on) => {
  const w = world(on, { active: false })
  w.toolText = GUIDE
  await startSession($, w)
  // the shim activated the session (its marker) and answered the guide
  w.files.set(`${HOME}/up/${SID}.active`, JSON.stringify({ cwd: CWD, ws: 'wiki', path: '/home/a/.thimble/app/workspaces/wiki', via: 'tool', role: 'main', mod: false, at: 1 }))
  const r = await call($, 'mcp__plugin_thimble_thimble__load_thimble', {})
  expect(r.text).toBe(GUIDE)
  expect(w.activations).toEqual([])
  expect(trailOf(w)).toContain('saw-load')
  await $.session.append({ door: 'tool-result', origin: { kind: 'tool', tool: 'mcp__plugin_thimble_thimble__load_thimble' }, uuid: 'tr1', message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: [{ type: 'text', text: GUIDE }] }] } } as never)
  expect(w.marked).toBe(1)
})

test('a module reload (session.start where the session is on) restores quietly: no activate, no push, thimble.ts told again', SLOW, async ($, on) => {
  const w = world(on)
  await startSession($, w)
  expect(w.activations).toEqual([])
  expect(w.mcp).toEqual([])
  expect(trailOf(w).slice(0, 2)).toEqual(['restore', 'bridge'])
  // the guide only if owed: it is not, so a prompt carries none
  const p = (await $.prompt.submit({ text: 'hello', origin: { kind: 'composer' }, wait: false } as never)) as { context?: string[] }
  expect(p.context ?? []).toEqual([])
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
