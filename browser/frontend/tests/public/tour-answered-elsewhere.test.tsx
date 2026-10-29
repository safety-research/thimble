// @vitest-environment jsdom
// The tour's welcome is offered once to the person, whichever page they answer it in (src/shell/TourHost.tsx, backend
// tour.py): a welcome that waits for its answer here goes once the server says the offer was answered in another page,
// within a few seconds, or as soon as this page comes back into view, and this page records nothing itself. The
// server's state is a stand-in here; the tour is the real one.
import { act } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { api } from '../../src/lib/api.ts'
import { TourHost } from '../../src/shell/TourHost.tsx'
import { currentTour } from '../../src/tour/run.ts'
import { mount, unmountAll } from './mount.tsx'

/** How soon a welcome waiting here follows an answer given in another page. */
const SOON_MS = 3000

/** The server's record of the offer (POST /tour/seen), which another page can set. */
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

const welcome = () => document.querySelector('.tour-pop.tour-welcome')
const tourShows = () => !!document.querySelector('.tour-root')
/** Waits up to `ms` for `ok`, real time, letting React and the tour run; whether it came. */
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

test('a welcome waiting here goes once the person answers the offer in another page, and this page records nothing', async () => {
  await mount(<TourHost />)
  expect(await until(() => !!welcome(), 5000)).toBe(true)
  // unanswered anywhere, it stays
  expect(await until(() => !tourShows(), SOON_MS)).toBe(false)
  // the person answers it in another page
  seen = true
  expect(await until(() => !tourShows(), SOON_MS)).toBe(true)
  expect(recorded).toBe(0)
}, 20_000)

test('a page that comes back into view drops a welcome answered elsewhere at once', async () => {
  await mount(<TourHost />)
  expect(await until(() => !!welcome(), 5000)).toBe(true)
  seen = true
  await act(async () => void document.dispatchEvent(new Event('visibilitychange')))
  expect(await until(() => !tourShows(), 500)).toBe(true)
  expect(recorded).toBe(0)
}, 15_000)

test('the welcome answered here is recorded once, and an answer in another page no longer touches the tour it began', async () => {
  await mount(<TourHost />)
  expect(await until(() => !!welcome(), 5000)).toBe(true)
  await act(async () => document.querySelector<HTMLElement>('.tour-pop [data-tour="begin"]')!.click())
  expect(recorded).toBe(1)
  expect(await until(() => !tourShows(), SOON_MS)).toBe(false)
  await act(async () => void document.dispatchEvent(new Event('visibilitychange')))
  expect(tourShows()).toBe(true)
}, 20_000)
