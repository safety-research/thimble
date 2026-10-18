// @vitest-environment jsdom
// The thread switcher at the top of the chat column (src/components/ThreadTree.tsx): open, it folds when a thread is
// picked, on Escape, and on a press outside it, anywhere on the page; a press inside it keeps it open. The composer's
// placeholder (src/chat/threads.ts replyIn) names a thread whose name was cut with one ellipsis, not two (bug hunt E6).
// An agent's thread is named by its title, a writer's by its document's name and a view build's by the view's name,
// never by a slug, and a running agent's row counts its steps in words, never as a fraction that reads as done (bug hunt
// G11).
import { act, useState } from 'react'
import { afterEach, expect, test } from 'vitest'
import { ThreadTree, type ThreadNode } from '../../src/components/ThreadTree.tsx'
import { stepProgress } from '../../src/chat/ChatPanel.tsx'
import { foldRecords } from '../../src/chat/model.ts'
import { ThreadChip, ThreadsContext } from '../../src/chat/Notes.tsx'
import { pickItems, replyIn, threadLabels, threadNodes } from '../../src/chat/threads.ts'
import type { ChatMeta, ChatRecord } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(unmountAll)

const NODES: ThreadNode[] = [
  { id: 'main', name: 'main', parent: null, fixed: true },
  { id: 'kettle', name: 'why did the kettle whistle twice…', path: 'main/why did the kettle whistle twice…', parent: 'main' },
  { id: 'teapot', name: 'teapot spout', path: 'main/teapot spout', parent: 'main' },
]

/** The tree, open, beside an element outside it; what the analyst sees of it. */
async function openTree() {
  const picked: string[] = []
  function Host() {
    const [collapsed, setCollapsed] = useState(false)
    const [current, setCurrent] = useState('main')
    return (
      <>
        <ThreadTree nodes={NODES} current={current} collapsed={collapsed} onCollapsedChange={setCollapsed} onPick={(id) => (picked.push(id), setCurrent(id))} />
        <div id="elsewhere">the canvas</div>
      </>
    )
  }
  const el = await mount(<Host />)
  const isOpen = () => !!el.querySelector('[role="listbox"]')
  const press = async (target: Element) => {
    await act(async () => {
      target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await settle()
  }
  const row = (id: string) => el.querySelector(`[data-thread="${id}"]`)!
  const reopen = async () => {
    await press(el.querySelector('.tt-summary')!)
    expect(isOpen()).toBe(true)
  }
  return { el, picked, isOpen, press, row, reopen }
}

test('the open thread switcher folds on a pick, on Escape and on a press outside it, and stays open for a press inside it', async () => {
  const t = await openTree()
  expect(t.isOpen()).toBe(true)

  // a press inside the list that picks no thread keeps it open
  await t.press(t.el.querySelector('[role="listbox"]')!)
  expect(t.isOpen()).toBe(true)
  await t.press(t.row('kettle'))
  expect(t.picked).toEqual(['kettle'])
  expect(t.isOpen()).toBe(false)

  await t.reopen()
  await act(async () => {
    const row = t.row('teapot') as HTMLElement
    row.focus()
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  expect(t.isOpen()).toBe(false)
  // the keys go back to the folded card
  expect(document.activeElement?.classList.contains('tt-summary')).toBe(true)

  await t.reopen()
  await t.press(document.getElementById('elsewhere')!)
  expect(t.isOpen()).toBe(false)
})

test("the composer's placeholder names a cut thread name with one ellipsis", () => {
  expect(replyIn('main/why did the kettle whistle twice…')).toBe('Reply in main/why did the kettle whistle twice…')
  expect(replyIn('main/teapot spout')).toBe('Reply in main/teapot spout…')
  expect(replyIn('main')).toBe('Reply in main…')
})

const meta = (m: Partial<ChatMeta> & { id: string; created_at: string }): ChatMeta =>
  ({ kind: 'agent', role: 'dev', title: '', parent: null, anchor: null, anchor_text: null, model: null, effort: null, group: null, ...m }) as ChatMeta

test("an agent's thread is named by its title: a writer by its document's name, a view build by the view's name", async () => {
  const chats = [
    meta({ id: 'm', kind: 'main', role: 'main', created_at: '2026-10-17T10:00:00Z' }),
    meta({ id: 'w1', role: 'writer', title: 'Write kettle-notes', doc: 'kettle-notes', status: 'done', created_at: '2026-10-17T10:01:00Z' }),
    meta({ id: 'w2', role: 'writer', title: 'Write kettle-notes', doc: 'kettle-notes', status: 'running', created_at: '2026-10-17T10:02:00Z' }),
    meta({ id: 'w3', role: 'writer', title: 'Write report', doc: 'report', status: 'done', created_at: '2026-10-17T10:03:00Z' }),
    meta({ id: 'v1', title: 'view: Kettle Board', view: 'kettle-board', asked: true, status: 'done', created_at: '2026-10-17T10:04:00Z' }),
    meta({ id: 'v2', title: 'review: Kettle Board', view: 'kettle-board', review: true, asked: true, status: 'done', created_at: '2026-10-17T10:05:00Z' }),
    meta({ id: 'v3', title: 'view: Kettle Board', view: 'kettle-board', asked: true, status: 'running', created_at: '2026-10-17T10:06:00Z' }),
    meta({ id: 't1', title: 'ticket #3: Wider teapot pane please', ticket: 't3', status: 'done', created_at: '2026-10-17T10:07:00Z' }),
  ]
  const names: Record<string, string> = { 'kettle-notes': 'Kettle notes' }
  const items = pickItems(chats, (m) => m.status === 'running', () => false, { docName: (slug) => names[slug] ?? (slug === 'report' ? 'Report' : slug) })
  const labels = threadLabels(items)
  expect(Object.fromEntries(labels)).toEqual({
    m: 'main',
    w1: 'Kettle notes',
    w2: 'Kettle notes (2)',
    w3: 'Report',
    v1: 'dev/Kettle Board',
    v2: 'dev/Kettle Board review',
    v3: 'dev/Kettle Board (2)',
    t1: 'dev/wider-teapot-pane-please',
  })
  for (const label of labels.values()) expect(label).not.toMatch(/write-|kettle-board/)
  // the tree's rows: the name after the group
  const rows = Object.fromEntries(threadNodes(items).map((n) => [n.id, n.name]))
  expect(rows.v1).toBe('Kettle Board')
  expect(rows.w1).toBe('Kettle notes')
  // the chat's note "Writing started in" names the writer's thread so
  const el = await mount(
    <ThreadsContext.Provider value={{ labels }}>
      <ThreadChip id="w2" />
    </ThreadsContext.Provider>,
  )
  expect(el.textContent).toBe('Kettle notes (2)')
  // with no names to hand, a built-in document keeps its type's name
  expect(threadLabels(pickItems(chats, () => false, () => false)).get('w3')).toBe('Report')
})

test("a running agent's row counts its steps in words, never as a fraction that reads as done", () => {
  const call = (id: string, done: boolean): ChatRecord[] => [
    { type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } },
    ...(done ? [{ type: 'tool_result', id, summary: 'ok' } as ChatRecord] : []),
  ]
  expect(stepProgress(foldRecords([...call('a', true), ...call('b', true)]))).toBe('2 steps')
  expect(stepProgress(foldRecords(call('a', false)))).toBe('1 step')
  expect(stepProgress([])).toBe('')
})
