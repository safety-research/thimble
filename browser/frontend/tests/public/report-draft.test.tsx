// @vitest-environment jsdom
// An empty report is a document the person types into (src/report/ReportTab.tsx): the tab shows its editor at once,
// with no Write-first state, the report's tab, + New, and Write's field for instructions; Write sends the instructions to
// Claude in the chat (POST /write {doc, text}), and while Claude writes the report's tab and the button say so.
import { act } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ReportTab } from '../../src/report/ReportTab.tsx'
import { mount, settle, unmountAll } from './mount.tsx'

const posted: { url: string; body: unknown }[] = []
let status: string | undefined
beforeEach(() => {
  posted.length = 0
  status = undefined
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const u = String(url)
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } })
    if ((init?.method ?? 'GET') === 'POST') {
      posted.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : null })
      if (u.endsWith('/write')) status = 'generating'
      return json({ chat: 'main' })
    }
    if (/\/investigations\/main\/types$/.test(u)) return json({ report: { exists: false, renderer: 'document', name: 'Report', ...(status ? { status } : {}) } })
    if (/\/investigations\/main\/types\/report$/.test(u)) return json({ id: 'report', title: '', sections: [], frame: false, comments: [] })
    if (/\/filters$/.test(u)) return json({})
    return json([])
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

test('an empty report opens ready to type in, and Write sends the instructions to Claude', async () => {
  const el = await mount(<ReportTab ws="w-draft" active />)
  await settle()
  await settle()
  expect([...el.querySelectorAll('.wu-tabs-bar .reader-tab-name')].map((t) => t.textContent)).toEqual(['Report'])
  expect(el.querySelector('.wu-tabs-bar button.wu-new')).not.toBeNull()
  expect(el.textContent).not.toContain('Could not load the document')
  const field = el.querySelector<HTMLInputElement>('input.wu-write-field')!
  expect(field.disabled).toBe(false)
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    set.call(field, 'keep my order, two pages')
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => el.querySelector<HTMLButtonElement>('.wu-write button.btn-primary')!.click())
  await settle()
  expect(posted).toEqual([{ url: '/api/ws/w-draft/write', body: { doc: 'report', text: 'keep my order, two pages' } }])
  expect(el.querySelector('.wu-write button.btn-primary')!.textContent).toBe('Writing')
})
