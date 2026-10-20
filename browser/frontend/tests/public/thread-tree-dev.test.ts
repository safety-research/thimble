// The thread tree (src/chat/threads.ts pickItems): the build of a view the analyst accepted is its own row named
// dev/<view>, under the dev row, not a row under main.
import { expect, test } from 'vitest'
import { DEV_GROUP, pickItems, threadNodes } from '../../src/chat/threads.ts'
import type { ChatMeta } from '../../src/lib/types.ts'

const meta = (m: Partial<ChatMeta> & { id: string }): ChatMeta =>
  ({ kind: 'agent', role: 'dev', title: '', created_at: '2026-09-28T20:00:00Z', parent: 'main', anchor: null, anchor_text: null, model: null, effort: null, group: null, ...m }) as ChatMeta

test('a view build sits at the top level as dev/<view>', () => {
  const chats = [
    meta({ id: 'main', kind: 'main', role: 'main', title: 'main', parent: null }),
    meta({ id: 'b1', title: 'View: Relay Threads', view: 'relay-threads', asked: true, status: 'running' } as Partial<ChatMeta> & { id: string }),
  ]
  const b = pickItems(chats, () => true, () => false).find((i) => i.id === 'b1')!
  expect([b.label, b.parent, b.title]).toEqual(['dev/relay-threads', null, 'relay-threads'])
})

test('a finished view build is listed even when not shown', () => {
  const chats = [
    meta({ id: 'main', kind: 'main', role: 'main', title: 'main', parent: null }),
    meta({ id: 'b2', title: 'View: Wiki Pages', view: 'wiki-pages', status: 'done' } as Partial<ChatMeta> & { id: string }),
  ]
  const b = pickItems(chats, () => false, () => false).find((i) => i.id === 'b2')!
  expect([b.label, b.parent, b.hidden]).toEqual(['dev/wiki-pages', null, false])
})

test('the view builds hang under one dev row that folds and is no thread', () => {
  const chats = [
    meta({ id: 'main', kind: 'main', role: 'main', title: 'main', parent: null }),
    meta({ id: 'b1', title: 'View: Relay Threads', view: 'relay-threads', status: 'running' } as Partial<ChatMeta> & { id: string }),
    meta({ id: 'b3', title: 'View: Tray Agents', view: 'tray-agents', status: 'done' } as Partial<ChatMeta> & { id: string }),
  ]
  const nodes = threadNodes(pickItems(chats, (m) => m.id === 'b1', () => false))
  const group = nodes.find((n) => n.id === DEV_GROUP)!
  expect([group.name, group.parent, group.group, group.running]).toEqual(['dev', null, true, true])
  expect(nodes.filter((n) => n.parent === DEV_GROUP).map((n) => n.path).sort()).toEqual(['dev/relay-threads', 'dev/tray-agents'])
  expect(nodes[0].id).toBe('main')
})

test('the open tree keeps the order it opened with; a new thread goes after', async () => {
  const { inKeptOrder } = await import('../../src/components/ThreadTree.tsx')
  const n = (id: string) => ({ id, name: id, parent: null })
  expect(inKeptOrder([n('c'), n('a'), n('new'), n('b')], ['a', 'b', 'c']).map((x) => x.id)).toEqual(['a', 'b', 'c', 'new'])
  expect(inKeptOrder([n('c'), n('a')], null).map((x) => x.id)).toEqual(['c', 'a'])
})

test("a view's builds each take a name of their own, numbered in the order they started", () => {
  const at = (n: number) => `2026-09-28T20:0${n}:00Z`
  const chats = [
    meta({ id: 'main', kind: 'main', role: 'main', title: 'main', parent: null }),
    meta({ id: 'b1', title: 'View: Wiki Page History', view: 'wiki-page-history', created_at: at(1) }),
    meta({ id: 'b2', title: 'View: Wiki Page History', view: 'wiki-page-history', created_at: at(3) }),
  ]
  const label = new Map(pickItems(chats, () => false, () => false).map((i) => [i.id, i.label]))
  expect(['b1', 'b2'].map((id) => label.get(id))).toEqual(['dev/wiki-page-history', 'dev/wiki-page-history-2'])
})
