// @vitest-environment jsdom
// The chat composer keeps a draft per thread (src/chat/Composer.tsx): text typed in main stays in main when another
// thread is shown, is never sent from it, and is there again on the way back; a send that did not go out hands its
// text back to the thread it was typed in.
import { act, useState } from 'react'
import { afterEach, expect, test } from 'vitest'
import { Composer, withDraft } from '../../src/chat/Composer.tsx'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(unmountAll)

let show: (thread: string) => void = () => undefined
const sent: { thread: string; text: string }[] = []
let answer = true

function Chat() {
  const [thread, setThread] = useState('main')
  show = setThread
  return <Composer thread={thread} sending={false} placeholder={`Reply in ${thread}…`} onSend={(text) => (sent.push({ thread, text }), Promise.resolve(answer))} />
}

const field = (root: HTMLElement) => root.querySelector<HTMLTextAreaElement>('textarea')!

function type(root: HTMLElement, text: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  act(() => {
    set.call(field(root), text)
    field(root).dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const enter = (root: HTMLElement) => act(() => void field(root).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))

test("text typed in main stays in main while a thread is shown, and a send there sends only the thread's own text", async () => {
  sent.length = 0
  answer = true
  const root = await mount(<Chat />)
  type(root, 'How many refunds in week two?')
  act(() => show('a1b2c3d4'))
  expect(field(root).value).toBe('')
  enter(root)
  expect(sent).toEqual([])
  type(root, 'And for the Pro plan?')
  enter(root)
  await settle()
  expect(sent).toEqual([{ thread: 'a1b2c3d4', text: 'And for the Pro plan?' }])
  expect(field(root).value).toBe('')
  act(() => show('main'))
  expect(field(root).value).toBe('How many refunds in week two?')
})

test('a send that did not go out puts the text back in its own thread only', async () => {
  sent.length = 0
  answer = false
  const root = await mount(<Chat />)
  type(root, 'Which accounts deleted posts?')
  enter(root)
  act(() => show('e5f6a7b8'))
  await settle()
  expect(field(root).value).toBe('')
  act(() => show('main'))
  expect(field(root).value).toBe('Which accounts deleted posts?')
})

test("withDraft sets one thread's draft and drops an empty one", () => {
  const a = withDraft({}, 'main', 'hi')
  expect(a).toEqual({ main: 'hi' })
  expect(withDraft(a, 'main', 'hi')).toBe(a)
  expect(withDraft(withDraft(a, 't1', 'x'), 'main', '')).toEqual({ t1: 'x' })
})
