// @vitest-environment jsdom
// The theme's report to the server (src/lib/themeReport.ts; backend render.py put_theme), whose card harness draws an
// export's cards in it: a report the server refuses shows a notice in the strip above the composer, with what the
// server said and Send, which puts the failure after /thimble-fix in main's composer; the next report it takes clears
// it. A report with no answer adds nothing, since the server is down, which its own line says.
import { act } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { NoticeStrip } from '../../src/chat/Notice.tsx'
import { takeDrafts } from '../../src/chat/pending.ts'
import { reportTheme } from '../../src/lib/themeReport.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const WHY = "an accent's name must be lowercase letters, digits and hyphens, starting with a letter"

/** How the server answers the next report: takes it, refuses it with WHY, or does not answer. */
let server: 'takes' | 'refuses' | 'down' = 'takes'
let reports = 0

beforeEach(() => {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })
    if (!String(url).endsWith('/render/theme')) return json(String(url).endsWith('/notices') ? [] : {})
    reports += 1
    if (server === 'down') throw new TypeError('Failed to fetch')
    return server === 'refuses' ? json({ detail: WHY }, 400) : json(JSON.parse(String(init.body)))
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

const report = (as: typeof server) =>
  act(async () => {
    server = as
    await reportTheme('tr', 'warm', 'teal')
  })
const words = (el: HTMLElement) => [...el.querySelectorAll('.chat-notice-text')].map((n) => n.textContent)

test('a theme the server refuses shows a notice with what it said and Send to thimble-fix; the next theme it takes clears it, and no answer adds nothing', async () => {
  takeDrafts()
  const el = await mount(<NoticeStrip ws="tr" current="main" onOpen={() => undefined} />)
  await settle()
  await report('refuses')
  expect(words(el)).toEqual([`The server didn't take this theme, so exported cards keep the old colors: ${WHY}. Send to thimble-fix?`])
  expect([...el.querySelectorAll('.chat-notice button')].map((b) => b.textContent || b.getAttribute('aria-label'))).toEqual(['Send', 'Dismiss'])
  await report('takes')
  expect(el.querySelector('.chat-notice')).toBeNull()
  // refused again: Send opens main with the failure after /thimble-fix, and the notice goes
  await report('refuses')
  await act(async () => (el.querySelector('.chat-notice-act') as HTMLButtonElement).click())
  await settle()
  expect(takeDrafts()).toEqual([{ thread: 'main', text: `/thimble-fix The workbench's server didn't take the theme the page shows (paper warm, accent teal): ${WHY}. Make the server take every paper and accent the page offers.` }])
  expect(el.querySelector('.chat-notice')).toBeNull()
  await report('down')
  expect(el.querySelector('.chat-notice')).toBeNull()
  expect(reports).toBe(4)
})
