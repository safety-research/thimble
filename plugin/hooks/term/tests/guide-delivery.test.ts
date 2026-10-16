// thimble's guide delivered once per need and marked sent only once the row that carries it is stored (SPEC-v2 3.4):
// the activating Read's context marked by its stored row (and owed while none is stored); /thimble's context; after a
// compaction a hidden user row appended whole; a subagent's activation appended to main at once; a refused row leaves it
// owed. `claude plugin test plugin`.
import { expect, mock, test } from 'claude-code/testing'

import { CWD, GUIDE, MARKER, call, corpus, reads, startSession, trailOf, world } from './fixtures'

const SLOW = { timeoutMs: 30000 }
const MESSAGES = [{ role: 'user', text: 'What is in this folder?', toolUses: [] }]
const hookRow = (uuid: string, text: string) => ({ door: 'hook-context', origin: { kind: 'hook' }, uuid, message: { type: 'user', role: 'user', isMeta: true, content: [{ type: 'text', text }] } }) as never

test('the guide is marked sent when its row is stored, not when a hook hands it on; never stored, it stays owed', SLOW, async ($, on) => {
  const w = world(on, { active: false })
  reads(w)
  corpus(w, ['events.jsonl', 'prs.csv'])
  await startSession($, w)
  const r = await call($, 'Read', { file_path: `${CWD}/events.jsonl` })
  expect(r.context).toEqual([GUIDE])
  // handed on, not stored yet: not marked
  expect(w.marked).toBe(0)
  // a stored row of something else marks nothing
  await $.session.append(hookRow('h0', 'an unrelated reminder') as never)
  expect(w.marked).toBe(0)
  // a row in a subagent's conversation does not count
  await $.session.append({ ...(hookRow('h1', GUIDE) as object), agentId: 'a1' } as never).catch(() => undefined)
  expect(w.marked).toBe(0)
  // the row that carries it, stored in main's conversation: marked once
  await $.session.append(hookRow('h2', `thimble guidance ${MARKER}: …`) as never)
  expect(w.marked).toBe(1)
  await $.session.append(hookRow('h3', GUIDE) as never)
  expect(w.marked).toBe(1)
})

test("/thimble carries the guide as its context when it is owed, and marks it once that row is stored", SLOW, async ($, on) => {
  const w = world(on, { active: false })
  await startSession($, w)
  const r = (await $.command.run({ command: 'thimble:thimble', args: '' } as never)) as { text?: string; context?: string[] }
  expect(w.activations.length).toBe(1)
  expect(w.activations[0]).toContain('command')
  expect(r.context).toEqual([GUIDE])
  expect(w.marked).toBe(0)
  await $.session.append(hookRow('c1', GUIDE) as never)
  expect(w.marked).toBe(1)
  // a second /thimble: on already, the guide sent: no context
  const again = (await $.command.run({ command: 'thimble:thimble', args: '' } as never)) as { context?: string[] }
  expect(again.context).toBeUndefined()
  expect(w.activations.length).toBe(1)
})

test('after a compaction of main the guide is owed again and appended whole as a hidden user row, marked once stored', SLOW, async ($, on) => {
  const w = world(on)
  const session = mock.session(on)
  await startSession($, w)
  await $.session.compact({ trigger: 'manual', messages: MESSAGES } as never)
  await w.clock.advance(10)
  expect(w.unmarked).toBe(1)
  const rows = session.appended().filter(r => r.door === 'note')
  expect(rows.length).toBe(1)
  expect(JSON.stringify(rows[0]!.message.content)).toContain(`thimble guidance ${MARKER}:`)
  expect(rows[0]!.message.type).toBe('user')
  expect(w.marked).toBe(1)
  expect(trailOf(w)).toContain('append')
})

test('a skipped compaction, or a subagent’s, gives no guide', SLOW, async ($, on) => {
  const w = world(on)
  const session = mock.session(on)
  await startSession($, w)
  w.compactSkip = 'nothing to compact'
  await $.session.compact({ trigger: 'manual', messages: MESSAGES } as never)
  await w.clock.advance(10)
  w.compactSkip = undefined
  await $.session.compact({ trigger: 'auto', agentId: 'a1', messages: MESSAGES } as never).catch(() => undefined)
  await w.clock.advance(10)
  expect(session.appended().filter(r => r.door === 'note').length).toBe(0)
  expect(w.unmarked).toBe(0)
})

test("a subagent's data read turns thimble on: its result carries no guide, which goes to main's conversation at once", SLOW, async ($, on) => {
  const w = world(on, { active: false })
  const session = mock.session(on)
  reads(w)
  corpus(w, ['events.jsonl'])
  await startSession($, w)
  const r = await call($, 'Read', { file_path: `${CWD}/events.jsonl` }, 'agent-7')
  expect(w.activations.length).toBe(1)
  expect(r.context).toBeUndefined()
  const notes = session.appended().filter(x => x.door === 'note')
  expect(notes.length).toBe(1)
  expect(notes[0]!.agentId).toBeUndefined()
  expect(JSON.stringify(notes[0]!.message.content)).toContain(GUIDE.slice(0, 40))
  expect(w.marked).toBe(1)
})

test('a refused row leaves the guide owed: the next delivery point sends it', SLOW, async ($, on) => {
  const w = world(on)
  // the session refuses the plugin's own rows
  on('session.append', { door: 'note' }, () => ({ deny: 'no rows now' }) as never)
  await startSession($, w)
  await $.session.compact({ trigger: 'manual', messages: MESSAGES } as never)
  await w.clock.advance(10)
  expect(w.marked).toBe(0)
  // owed: the next prompt carries it
  const p = (await $.prompt.submit({ text: 'and now?', origin: { kind: 'composer' }, wait: false } as never)) as { context?: string[] }
  expect(p.context).toEqual([GUIDE])
})
