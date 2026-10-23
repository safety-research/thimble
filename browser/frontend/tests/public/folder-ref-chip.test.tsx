// @vitest-environment jsdom
// A ref to a folder (`[[harness/]]`) is the folder's chip, and its hover lists the folder's entries, never an error
// (components/RefChip; the ref route resolves a folder to "Folder · N items" over its entries). A folder named with no
// slash after it has the folder glyph as soon as the chat draws it: the chips that draw together ask the server what
// their paths name in one request (lib/pathKinds).
import { act } from 'react'
import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import { ChatMarkdown, ChipContext } from '../../src/chat/markdown.tsx'
import { RefChip } from '../../src/components/RefChip.tsx'
import { api, scaleApi } from '../../src/lib/api.ts'
import type { ResolvedRef } from '../../src/lib/types.ts'
import { mount, unmountAll } from './mount.tsx'

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})
afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
})

const hover = async (c: HTMLElement) =>
  act(async () => {
    c.focus()
    await new Promise((r) => setTimeout(r, 200))
  })

test("a folder's chip has the folder glyph, and its hover lists the folder's entries", async () => {
  const excerpt = 'Folder · 3 items\nruns/\nagent.py\nREADME.md'
  vi.spyOn(api, 'resolveRef').mockResolvedValue({ ref: 'harness/', kind: 'path', path: 'harness/', excerpt, meta: { folder: true, entries: 3 } } as unknown as ResolvedRef)
  const el = await mount(<RefChip ref="harness/" workspace="ws" />)
  const c = el.querySelector<HTMLElement>('[data-ref="harness/"]')!
  expect(c.querySelector('svg.chip-ico')?.classList.contains('icon-folder')).toBe(true)
  await hover(c)
  const pop = document.body.querySelector('.refchip-pop')!
  expect(pop.querySelector('.refchip-pop-error')).toBeNull()
  expect(pop.textContent).toContain('Folder · 3 items')
  expect(pop.textContent).toContain('agent.py')
})

test('a folder named with no slash takes the folder glyph once its hover finds it a folder', async () => {
  vi.spyOn(api, 'resolveRef').mockResolvedValue({ ref: 'harness', kind: 'path', path: 'harness/', excerpt: 'Folder · 1 item\nagent.py', meta: { folder: true, entries: 1 } } as unknown as ResolvedRef)
  const el = await mount(<RefChip ref="harness" workspace="ws" />)
  const c = el.querySelector<HTMLElement>('[data-ref="harness"]')!
  await hover(c)
  expect(c.querySelector('svg.chip-ico')?.classList.contains('icon-folder')).toBe(true)
  expect(document.body.querySelector('.refchip-pop-error')).toBeNull()
})

test('a folder named with no slash has the folder glyph as the chat draws it, before any hover', async () => {
  const resolve = vi.spyOn(api, 'resolveRef')
  const kinds = vi.spyOn(scaleApi, 'pathKinds').mockResolvedValue({ kinds: { harness: 'folder', NOTES: 'file' } })
  const el = await mount(
    <ChipContext.Provider value={{ workspace: 'ws-chat', broken: new Set() }}>
      <ChatMarkdown text="The agent's code is in [[harness]], its notes in [[NOTES]] and its runs in [[runs.csv]]." />
    </ChipContext.Provider>,
  )
  await act(async () => new Promise((r) => setTimeout(r, 0)))
  const glyph = (ref: string) => [...(el.querySelector(`[data-ref="${ref}"] svg`)?.classList ?? [])].find((c) => c.startsWith('icon-') && c !== 'icon')
  expect(glyph('harness')).toBe('icon-folder')
  expect(glyph('NOTES')).toBe('icon-page')
  expect(glyph('runs.csv')).not.toBe('icon-folder')
  // one request for the chips drawn together, and none for a name whose type its extension says
  expect(kinds).toHaveBeenCalledTimes(1)
  expect(kinds.mock.calls[0]).toEqual(['ws-chat', ['harness', 'NOTES']])
  expect(resolve).not.toHaveBeenCalled()
})
