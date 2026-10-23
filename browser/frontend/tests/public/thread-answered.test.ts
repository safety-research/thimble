// A thread the analyst left while it answered (src/chat/threads.ts answeredSince): once it stops running, the chat panel
// toasts its chip, unless it is the thread shown or it was not running when last looked at.
import { expect, test } from 'vitest'
import { answeredSince, threadsRunning } from '../../src/chat/threads.ts'
import type { ChatMeta } from '../../src/lib/types.ts'

const meta = (m: Partial<ChatMeta> & { id: string }): ChatMeta =>
  ({ kind: 'thread', role: 'thread', title: '', created_at: '2026-10-05T20:00:00Z', parent: 'main', anchor: null, anchor_text: null, model: null, effort: null, group: null, ...m }) as ChatMeta

test('a left thread that stops running has its answer; the shown one and an idle one do not', () => {
  const before = [
    meta({ id: 'main', kind: 'main', role: 'main', parent: null, running: true }),
    meta({ id: 't1', running: true }),
    meta({ id: 't2', running: true }),
    meta({ id: 't3', running: false }),
    meta({ id: 'o1', kind: 'agent', role: 'orient', running: true }),
  ]
  const was = threadsRunning(before)
  expect([...was.keys()]).toEqual(['t1', 't2', 't3'])
  const after = before.map((m) => ({ ...m, running: false }))
  expect(answeredSince(was, after, 't2')).toEqual(['t1'])
  expect(answeredSince(was, before, 'main')).toEqual([])
  expect(answeredSince(new Map(), after, 'main')).toEqual([])
})
