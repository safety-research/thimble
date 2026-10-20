// @vitest-environment jsdom
// New (src/report/DocMenus.tsx) makes another report, of the one kind the server makes, from a name: what it offers is
// what the server can make (POST /report-types/new {kind: document, name}), so it never asks for a kind the server
// refuses. The new report opens as a tab (src/report/ReportTab.tsx openTabs), and closing a tab leaves the report.
import { act } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { docsApi } from '../../src/lib/api.ts'
import { NewDocMenu } from '../../src/report/DocMenus.tsx'
import { nextOpen, openTabs } from '../../src/report/ReportTab.tsx'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test('New asks for a name and makes a report of the kind the server makes', async () => {
  // jsdom has no ResizeObserver, which the popover watches its size with
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const create = vi.spyOn(docsApi, 'createDoc').mockResolvedValue({ slug: 'team-update', name: 'Team update', description: '', renderer: 'document', builtin: false })
  const onMade = vi.fn()
  const el = await mount(<NewDocMenu ws="w" onMade={onMade} />)
  await act(async () => el.querySelector<HTMLButtonElement>('button.wu-new')!.click())
  await settle()
  const field = document.querySelector<HTMLInputElement>('#wu-doc-name')!
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    set.call(field, 'Team update')
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => field.form!.requestSubmit())
  await settle()
  // every kind New offers is one the server makes: a document, with its name
  expect(create).toHaveBeenCalledWith('w', { kind: 'document', name: 'Team update' })
  expect(onMade).toHaveBeenCalledWith(expect.objectContaining({ slug: 'team-update' }))
})

test('the tabs open are the ones kept that still exist, and the current one; a closed tab gives way to its neighbor', () => {
  const types = { report: { exists: true, renderer: 'document', name: 'Report' }, notes: { exists: false, renderer: 'document', name: 'Notes' } }
  expect(openTabs(['report', 'gone', 'notes'], types, 'notes')).toEqual(['report', 'notes'])
  expect(openTabs(['report'], types, 'notes')).toEqual(['report', 'notes'])
  expect(nextOpen(['report', 'notes', 'plan'], 'notes')).toBe('plan')
  expect(nextOpen(['report', 'notes'], 'notes')).toBe('report')
  expect(nextOpen(['notes'], 'notes')).toBe('report')
})
