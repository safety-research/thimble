// @vitest-environment jsdom
// A toast's one button (src/shell/Toasts.tsx `action`), such as Reopen after a comment is resolved: a click acts.
import { act } from 'react'
import { afterEach, expect, test } from 'vitest'
import { bus } from '../../src/lib/bus'
import { Toasts } from '../../src/shell/Toasts'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(() => unmountAll())

test('a toast with an action shows its button, and a click on it runs the action', async () => {
  await mount(<Toasts />)
  let ran = 0
  await act(async () => bus.emit('toast', { text: 'Comment resolved.', action: { label: 'Reopen', run: () => void ran++ } }))
  await settle()
  const button = document.querySelector<HTMLButtonElement>('.shell-toast-action')
  expect(button?.textContent).toBe('Reopen')
  await act(async () => button!.click())
  expect(ran).toBe(1)
})
