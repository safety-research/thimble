// @vitest-environment jsdom
// + New (src/report/DocMenus.tsx) lists the report types the workspace's extensions give as they are when it opens, so
// an extension switched on or off shows there without a reload.
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

test('+ New reads the report types again each time it opens', async () => {
  // jsdom has no ResizeObserver, which the menu's popover watches its size with
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  let served = [preset('report', 'Report')]
  vi.spyOn(docsApi, 'presets').mockImplementation(async () => served)
  const el = await mount(<NewDocMenu ws="w" onMade={() => undefined} />)
  await settle()
  const items = () => [...document.querySelectorAll('[role=menu] [role=menuitem]')].map((b) => b.textContent?.trim())
  const toggle = async () => {
    await act(async () => el.querySelector<HTMLButtonElement>('button.wu-new')!.click())
    await settle()
  }
  await toggle()
  expect(items()).toContain('Report')
  expect(items()).not.toContain('Video')
  await toggle()
  served = [preset('report', 'Report'), preset('video', 'Video')]
  await toggle()
  expect(items()).toContain('Video')
})
