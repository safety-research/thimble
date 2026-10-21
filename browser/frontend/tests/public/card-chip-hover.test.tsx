// @vitest-environment jsdom
// Hovering a chip of a card a program draws shows the card's question and its takeaway's first sentence in plain words,
// never the list of parts Claude reads (the drawing's text, written for Claude, with its ids and warnings).
import { act } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { plainLine, RefChip } from '../../src/components/RefChip.tsx'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
const forClaude = '11 parts (cite one as card:<id>#<part id>):\n  page-a  Page A\nwarning: region id "page/a" uses characters ids cannot hold; it is "page-a"'

test("a program card's chip hovers as its question and one plain line", async () => {
  expect(plainLine('One page leads: [[2,327|card:aaaaaa#page-a]] edits, **five times** the next. More text.')).toBe('One page leads: 2,327 edits, five times the next.')
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('fetch', async (url: string) => {
    if (!String(url).includes('/ref?')) return new Response('{"detail":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } })
    const record = {
      id: 'aaaaaa', notebook: 'n', kind: 'program', title: 'Which pages have the most edits?', created_by: 'main', ts: '',
      takeaway: 'One page leads with [[2,327|card:aaaaaa#page-a]] edits. The rest trail.',
      outputs: [{ 'application/vnd.thimble.kit+json': { drawing: { regions: [{ id: 'page-a' }] }, w: 80 }, 'text/plain': forClaude }],
    }
    return json({ ref: 'card:aaaaaa', kind: 'cell', excerpt: '', record })
  })
  const el = await mount(<RefChip ref="card:aaaaaa" compact workspace="w" />)
  const chip = el.querySelector<HTMLElement>('.refchip')!
  await act(async () => {
    chip.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 150))
  })
  await settle()
  const pop = document.body.querySelector<HTMLElement>('.refchip-pop')!
  expect(pop.querySelector('.refchip-cell-title')?.textContent).toBe('Which pages have the most edits?')
  expect(pop.querySelector('.refchip-pop-note')?.textContent).toBe('One page leads with 2,327 edits.')
  expect(pop.textContent).not.toContain('parts (cite')
  expect(pop.textContent).not.toContain('warning')
})
