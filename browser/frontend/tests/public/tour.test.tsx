// @vitest-environment jsdom
// The tour's welcome (src/shell/TourHost.tsx, backend tour.py): offered to the person once a way to reach Claude is
// chosen; taking the tour records the offer once, in thimble's own state, so no page offers it again, and starts the
// tour. The server's state is a stand-in here; the tour is the real one.
import { act } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { api } from '../../src/lib/api.ts'
import { TourHost } from '../../src/shell/TourHost.tsx'
import { currentTour } from '../../src/tour/run.ts'
import { mount, unmountAll } from './mount.tsx'

// a way to reach Claude is chosen: the first run's step (shell/ClaudeAccess, beside TourHost in the shell), which the
// welcome waits for, is answered
vi.mock('../../src/shell/ClaudeAccess.tsx', () => ({ accessAnswered: () => Promise.resolve() }))

/** The server's record of the offer (POST /tour/seen). */
let seen = false
let recorded = 0

beforeEach(() => {
  seen = false
  recorded = 0
  vi.spyOn(api, 'tour').mockImplementation(async () => ({ seen }))
  vi.spyOn(api, 'tourSeen').mockImplementation(async () => {
    recorded += 1
    seen = true
    return { seen: true }
  })
  // the shell drawn with its session attached, the chat column folded: what the welcome waits for
  const shell = document.createElement('div')
  shell.className = 'shell'
  shell.dataset.session = 'session-1'
  shell.dataset.chat = 'closed'
  document.body.append(shell)
})
afterEach(() => {
  act(() => void currentTour()?.end())
  unmountAll()
  vi.restoreAllMocks()
})

/** Waits up to `ms` for `ok`, letting React and the tour run; whether it came. */
async function until(ok: () => boolean, ms: number): Promise<boolean> {
  const t0 = Date.now()
  while (!ok()) {
    if (Date.now() - t0 > ms) return false
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
  }
  return true
}

test('the first page offers the tour; taking it records the offer once and starts the tour', async () => {
  await mount(<TourHost />)
  expect(await until(() => !!document.querySelector('.tour-pop.tour-welcome'), 5000)).toBe(true)
  await act(async () => document.querySelector<HTMLElement>('.tour-pop [data-tour="begin"]')!.click())
  expect(recorded).toBe(1)
  expect(document.querySelector('.tour-root')).not.toBeNull()
  expect(document.querySelector('.tour-pop.tour-welcome')).toBeNull()
})
