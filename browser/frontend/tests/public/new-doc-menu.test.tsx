// @vitest-environment jsdom
// + New (src/report/DocMenus.tsx) lists the presets the server gives, beside a page and a document of the analyst's own.
import { act } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { docsApi } from '../../src/lib/api.ts'
import type { DocPreset } from '../../src/lib/types.ts'
import { NewDocMenu } from '../../src/report/DocMenus.tsx'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const preset = (id: string, name: string): DocPreset => ({ id, name, description: '', renderer: 'document' })

test('+ New lists the presets the server gives', async () => {
  // jsdom has no ResizeObserver, which the menu's popover watches its size with
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.spyOn(docsApi, 'presets').mockImplementation(async () => [preset('report', 'Report'), preset('digest', 'Digest')])
  const el = await mount(<NewDocMenu ws="w" onMade={() => undefined} />)
  await settle()
  await act(async () => el.querySelector<HTMLButtonElement>('button.wu-new')!.click())
  await settle()
  const items = [...document.querySelectorAll('[role=menu] [role=menuitem]')].map((b) => b.textContent?.trim())
  expect(items).toContain('Report')
  expect(items).toContain('Digest')
})
