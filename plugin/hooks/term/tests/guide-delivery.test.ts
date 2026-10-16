// thimble's guide marked sent only once the row that carries it is stored (SPEC-v2 3.4), and owed again after a
// compaction of main, which appends it whole as a hidden user row. `claude plugin test plugin`.
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
