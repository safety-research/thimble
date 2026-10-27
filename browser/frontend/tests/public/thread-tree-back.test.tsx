// @vitest-environment jsdom
// The thread tree's folded card (src/components/ThreadTree.tsx) in any thread but main has a button back to main: a
// click, or Enter, goes to main and leaves the tree folded, as a click elsewhere on the card opens it. In main the card
// has none.
import { act } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { ThreadTree, type ThreadNode } from '../../src/components/ThreadTree.tsx'
import { mount, unmountAll } from './mount.tsx'

afterEach(() => unmountAll())

const nodes: ThreadNode[] = [
  { id: 'main', name: 'main', path: 'main', parent: null, fixed: true },
  // the dev tickets' row is fixed too, but it is no thread to go back to
  { id: '__dev', name: 'dev', path: 'dev', parent: null, fixed: true, group: true },
  { id: 'b1', name: 'deploy-timeline', path: 'dev/deploy-timeline', parent: '__dev', running: true },
]
const card = async (current: string) => {
  const onPick = vi.fn()
  const onCollapsedChange = vi.fn()
  const el = await mount(<ThreadTree nodes={nodes} current={current} collapsed onPick={onPick} onCollapsedChange={onCollapsedChange} />)
  return { el, onPick, onCollapsedChange, back: el.querySelector<HTMLButtonElement>('.tt-summary .tt-back') }
}

test("a side thread's folded card goes back to main with a click, the tree staying folded", async () => {
  const { el, onPick, onCollapsedChange, back } = await card('b1')
  expect(back?.textContent).toBe('main')
  expect(back?.getAttribute('aria-label')).toBe('Back to main')
  expect(el.querySelector('.tt-summary .tt-name')?.textContent).toBe('dev/deploy-timeline')
  await act(async () => back!.click())
  expect(onPick).toHaveBeenCalledWith('main')
  expect(onCollapsedChange).not.toHaveBeenCalled()
  // a click elsewhere on the card still opens the tree
  await act(async () => el.querySelector<HTMLElement>('.tt-summary .tt-name')!.click())
  expect(onCollapsedChange).toHaveBeenCalledWith(false)
})

test("Enter on the button is the button's, not the card's", async () => {
  const { onCollapsedChange, back } = await card('b1')
  await act(async () => back!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
  expect(onCollapsedChange).not.toHaveBeenCalled()
})

test("main's folded card has no button back", async () => {
  const { back } = await card('main')
  expect(back).toBeNull()
})
