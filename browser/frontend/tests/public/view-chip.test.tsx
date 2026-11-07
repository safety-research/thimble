// @vitest-environment jsdom
// A view's chip in the chat (src/chat/ViewChip.tsx): a failed build shows ✕, Retry and the Build menu, whose trigger
// names the run's model and effort. A click on that trigger opens the menu, and the click goes no further than the chip.
import { act } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ViewChip } from '../../src/chat/ViewChip.tsx'
import { invalidateSettings } from '../../src/lib/models.ts'
import { refreshProposals } from '../../src/lib/proposals.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const WS = 'view-chip'
const FAILED = { slug: 'decisions', name: 'Decisions', description: 'Each decision as a row.', task: 'list the decisions', claims: ['notes/*.md'], status: 'failed', chat: 'c-decisions', error: 'the build was stopped', ts: '2026-11-06T19:59:00Z', values: { model: 'claude-opus-5-5', effort: 'high' } }
const SETTINGS = { models: { dev: { model: 'claude-opus-5-5', effort: 'high' } } }

beforeEach(() => {
  invalidateSettings(WS)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', async (url: string) => {
    const u = String(url)
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })
    if (u.endsWith('/views/proposals')) return json([FAILED])
    if (u.endsWith('/settings')) return json(SETTINGS)
    return json({ detail: 'not found' }, 404)
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

test("a failed view's Build menu opens on a click of its trigger, and the click does not reach what holds the chip", async () => {
  const row = vi.fn()
  const el = await mount(
    <div onClick={row}>
      <ViewChip ws={WS} slug="decisions" name="Decisions" />
    </div>,
  )
  await act(async () => {
    await refreshProposals(WS)
  })
  await settle()
  const trigger = el.querySelector<HTMLButtonElement>('.view-chip-values')
  expect(trigger, 'the failed chip shows its model and effort').not.toBeNull()
  expect(document.querySelector('[role="menu"]')).toBeNull()
  await act(async () => trigger!.click())
  await settle()
  const menu = document.querySelector('[role="menu"]')
  expect(menu, 'the Build menu opens').not.toBeNull()
  expect(trigger!.getAttribute('aria-expanded')).toBe('true')
  expect([...menu!.querySelectorAll('.menu-item')].map((b) => b.textContent)).toContain('high')
  expect(row).not.toHaveBeenCalled()
})
