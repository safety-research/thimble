// @vitest-environment jsdom
// A card pointed at in a chat reply (`[[card:<id>]]`) is the card's chip: its glyph and its short name, as the chips
// under a step's Cards are, a click opening the card and a hover showing it (components/RefChip). A file pointed at
// stays its glyph alone, and a part of a card (a table's cell) too.
import { act } from 'react'
import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import { ChatMarkdown } from '../../src/chat/markdown.tsx'
import { RefChip } from '../../src/components/RefChip.tsx'
import { api } from '../../src/lib/api.ts'
import { bus } from '../../src/lib/bus.ts'
import { registerCells } from '../../src/lib/cellName.ts'
import type { ResolvedRef } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

beforeAll(() => {
  registerCells([{ id: 'ab12cd34', title: 'Wiki edits per agent', slug: 'wiki-edits' }])
  // the hover label places itself as it resizes; jsdom has no ResizeObserver
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

const chip = (el: HTMLElement, ref: string) => el.querySelector<HTMLElement>(`[data-ref="${ref}"]`)!

test("a card pointed at in a reply is a chip with the card's glyph and short name", async () => {
  const el = await mount(<ChatMarkdown text="Agents that edit the wiki merge fewer [[card:ab12cd34]]." />)
  const c = chip(el, 'card:ab12cd34')
  expect(c.textContent).toBe('wiki-edits')
  expect(c.classList.contains('refchip-icon')).toBe(false)
  expect(c.classList.contains('chip')).toBe(true)
  expect(c.querySelector('svg.chip-ico')?.classList.contains('icon-cell')).toBe(true)
})

test('it reads as the chip that lists what a step made', async () => {
  const el = await mount(<ChatMarkdown text="See [[card:ab12cd34]]." />)
  const step = await mount(<RefChip ref="card:ab12cd34" compact workspace="ws" />)
  const a = chip(el, 'card:ab12cd34')
  const b = chip(step, 'card:ab12cd34')
  expect(a.textContent).toBe(b.textContent)
  expect(a.getAttribute('data-tone') ?? a.className.match(/chip-(accent|evidence)/)?.[0]).toBe(b.getAttribute('data-tone') ?? b.className.match(/chip-(accent|evidence)/)?.[0])
})

test('a file, and a cell of a card, pointed at in a reply stay their glyph alone', async () => {
  const el = await mount(<ChatMarkdown text="Notes say so [[NOTES.md]] and the table too [[card:ab12cd34#merged/agent-07]]." />)
  for (const ref of ['NOTES.md', 'card:ab12cd34#merged/agent-07']) {
    expect(chip(el, ref).classList.contains('refchip-icon'), ref).toBe(true)
    expect(chip(el, ref).textContent, ref).toBe('')
  }
})

test("hovering the card's chip shows the card, and a click opens it", async () => {
  vi.spyOn(api, 'cellNames').mockResolvedValue([])
  const resolve = vi.spyOn(api, 'resolveRef').mockResolvedValue({ ref: 'card:ab12cd34', kind: 'cell', excerpt: 'wiki edits per agent' } as unknown as ResolvedRef)
  const el = await mount(<ChatMarkdown text="fewer [[card:ab12cd34]]." />)
  const c = chip(el, 'card:ab12cd34')
  await act(async () => {
    c.focus()
    await new Promise((r) => setTimeout(r, 200))
  })
  expect(resolve).toHaveBeenCalled()
  expect(document.body.querySelector('.refchip-pop')).not.toBeNull()
  const refs: string[] = []
  const off = bus.on('openRef', (e) => void refs.push(e.ref))
  await act(async () => c.click())
  await settle()
  off()
  expect(refs).toEqual(['card:ab12cd34'])
})
