// @vitest-environment jsdom
// The line while thimble's server does not answer (src/shell/ServerDown.tsx) names the way back that this version has:
// thimble-browser --continue starts the server again on the folder's latest session (I48).
import { act, createElement } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { bus } from '../../src/lib/bus'
import { DOWN_AFTER_MS, ServerDown } from '../../src/shell/ServerDown'
import { mount, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.useRealTimers()
})

test('a server down longer than a restart takes shows a line that names thimble-browser --continue', async () => {
  vi.useFakeTimers()
  const el = await mount(createElement(ServerDown))
  act(() => bus.emit('wsStream', { connected: false }))
  act(() => vi.advanceTimersByTime(DOWN_AFTER_MS))
  const line = [...el.querySelectorAll('[role="alert"] > span')].find((s) => s.querySelector('code') || /answering/.test(s.textContent ?? ''))
  expect(line?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
    "thimble's server is not answering, so messages sent here do not arrive. To start it again, run " +
      'thimble-browser --continue in the same folder; your work is saved.',
  )
  expect([...el.querySelectorAll('code')].map((c) => c.textContent)).toEqual(['thimble-browser --continue'])
})
