// @vitest-environment jsdom
// A toast (src/shell/Toasts.tsx) draws a span in backticks as code, as a notice does (src/chat/Notice.tsx): a write
// refused for a browser that is not signed in names `thimble up`, and the toast showed the backticks.
import { act } from 'react'
import { afterEach, expect, test } from 'vitest'
import { Toasts } from '../../src/shell/Toasts.tsx'
import { bus } from '../../src/lib/bus.ts'
import { mount, unmountAll } from './mount.tsx'

afterEach(() => unmountAll())

test("a toast's command in backticks is code, and its backticks do not show", async () => {
  const el = await mount(<Toasts />)
  // the server's 403 detail (backend hook_auth.WRITE_REFUSED) as lib/api puts it in an error
  const refused = "403 open thimble from the link shown under /thimble's reply, or printed by `thimble up` in a shell, to make changes"
  await act(async () => bus.emit('toast', { text: refused, kind: 'error' }))
  await act(async () => bus.emit('toast', { text: 'A lone ` stays as it is.' }))
  const [error, info] = [...el.querySelectorAll('.shell-toast-text')]
  expect(error.textContent).toBe("Open thimble from the link shown under /thimble's reply, or printed by thimble up in a shell, to make changes")
  expect([...error.querySelectorAll('code')].map((c) => c.textContent)).toEqual(['thimble up'])
  expect(info.textContent).toBe('A lone ` stays as it is.')
  expect(info.querySelectorAll('code')).toHaveLength(0)
})
