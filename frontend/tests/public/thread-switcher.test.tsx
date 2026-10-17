// @vitest-environment jsdom
// The thread switcher at the top of the chat column (src/components/ThreadTree.tsx): open, it folds when a thread is
// picked, on Escape, and on a press outside it, anywhere on the page; a press inside it keeps it open. The composer's
// placeholder (src/chat/threads.ts replyIn) names a thread whose name was cut with one ellipsis, not two (bug hunt E6).
import { act, useState } from 'react'
import { afterEach, expect, test } from 'vitest'
import { ThreadTree, type ThreadNode } from '../../src/components/ThreadTree.tsx'
import { replyIn } from '../../src/chat/threads.ts'
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
