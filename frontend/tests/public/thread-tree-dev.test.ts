// The thread tree (src/chat/threads.ts pickItems): a dev ticket, a view build among them, is its own top-level row
// named dev/…, not a row under main.
import { expect, test } from 'vitest'
import { DEV_GROUP, pickItems, threadNodes } from '../../src/chat/threads.ts'
import type { ChatMeta } from '../../src/lib/types.ts'

const meta = (m: Partial<ChatMeta> & { id: string }): ChatMeta =>
  ({ kind: 'agent', role: 'dev', title: '', created_at: '2026-09-28T20:00:00Z', parent: 'main', anchor: null, anchor_text: null, model: null, effort: null, group: null, ...m }) as ChatMeta

test('a view build and a code ticket sit at the top level as dev/<view> and dev/<title words>', () => {
  const chats = [
    meta({ id: 'main', kind: 'main', role: 'main', title: 'main', parent: null }),
    meta({ id: 'b1', title: 'view: Relay Threads', view: 'relay-threads', asked: true, status: 'running' } as Partial<ChatMeta> & { id: string }),
    meta({ id: 't1', title: 'Ticket #1: tray agent cannot find wait_session', status: 'running', created_at: '2026-09-28T20:01:00Z' }),
  ]
  const items = pickItems(chats, () => true, () => false)
  const b = items.find((i) => i.id === 'b1')!
  const t = items.find((i) => i.id === 't1')!
  expect([b.label, b.parent, b.title]).toEqual(['dev/relay-threads', null, 'relay-threads'])
  expect([t.label, t.parent]).toEqual(['dev/tray-agent-cannot-find', null])
})

test("the orientation's view build is listed even when finished and not shown", () => {
  const chats = [
    meta({ id: 'main', kind: 'main', role: 'main', title: 'main', parent: null }),
    meta({ id: 'b2', title: 'view: Wiki Pages', view: 'wiki-pages', status: 'done' } as Partial<ChatMeta> & { id: string }),
  ]
  const b = pickItems(chats, () => false, () => false).find((i) => i.id === 'b2')!
  expect([b.label, b.parent, b.hidden]).toEqual(['dev/wiki-pages', null, false])
})


test('the dev tickets hang under one dev row that folds and is no thread', () => {
  const chats = [
    meta({ id: 'main', kind: 'main', role: 'main', title: 'main', parent: null }),
    meta({ id: 'b1', title: 'view: Relay Threads', view: 'relay-threads', status: 'running' } as Partial<ChatMeta> & { id: string }),
    meta({ id: 't1', title: 'Ticket #1: tray agent', status: 'done' }),
  ]
  const nodes = threadNodes(pickItems(chats, (m) => m.id === 'b1', () => false))
  const group = nodes.find((n) => n.id === DEV_GROUP)!
  expect([group.name, group.parent, group.group, group.running]).toEqual(['dev', null, true, true])
  expect(nodes.filter((n) => n.parent === DEV_GROUP).map((n) => [n.name, n.path])).toEqual([['relay-threads', 'dev/relay-threads'], ['tray-agent', 'dev/tray-agent']])
  expect(nodes[0].id).toBe('main')
})

test('the open tree keeps the order it opened with; a new thread goes after', async () => {
  const { inKeptOrder } = await import('../../src/components/ThreadTree.tsx')
  const n = (id: string) => ({ id, name: id, parent: null })
  expect(inKeptOrder([n('c'), n('a'), n('new'), n('b')], ['a', 'b', 'c']).map((x) => x.id)).toEqual(['a', 'b', 'c', 'new'])
  expect(inKeptOrder([n('c'), n('a')], null).map((x) => x.id)).toEqual(['c', 'a'])
})
