// @vitest-environment jsdom
// A check of the analyst's own (src/shell/LabelsSidebar.tsx): the Comments sidebar's categories, the checks, end in
// + New check, whose card takes a name and a prompt; Run adds the check over the documents, and it is listed with the
// others.
import { act } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { LabelsSidebar } from '../../src/shell/LabelsSidebar.tsx'
import { mount, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const CHECKS = [
  { id: 'details', name: 'Important details', prompt: 'Mark what the reader should know.', colour: 1, builtin: true, shown: true, covers: ['documents', 'cards', 'answers'] },
  { id: 'judgment', name: 'Judgment calls', prompt: 'Mark the calls Claude made for the reader.', colour: 2, builtin: true, shown: false, covers: ['documents'] },
]
const settle = () => act(async () => new Promise((r) => setTimeout(r, 10)))

/** Type `text` into a field as React hears it. */
async function type(el: HTMLTextAreaElement | HTMLInputElement, text: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

test('+ New check, with a name and a prompt, adds a check over the documents, listed with the others', async () => {
  const posts: { url: string; body: unknown }[] = []
  let checks: unknown[] = CHECKS
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST' && url.endsWith('/checks')) {
      const body = JSON.parse(String(init.body))
      posts.push({ url, body })
      const made = { id: 'new', colour: 3, builtin: false, shown: true, runs: {}, ...body }
      checks = [...CHECKS, made]
      return json(made)
    }
    if (url.endsWith('/checks')) return json(checks)
    if (url.includes('/canvas/comments') || url.includes('/answer-comments')) return json({ comments: [], running: [] })
    if (url.includes('/types/report')) return json({ title: 'Report', sections: [], comments: [] })
    if (url.includes('/concepts')) return json([])
    return json({})
  })
  // the card's popover follows its own size
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const el = await mount(<LabelsSidebar ws="w1" section="comments" onClose={() => undefined} />)
  await settle()
  await act(async () => el.querySelector<HTMLButtonElement>('.lside-new .lside-add')!.click())
  await settle()
  const card = document.querySelector<HTMLElement>('[aria-label="New check"]')!
  await type(card.querySelector<HTMLInputElement>('input[aria-label="Name"]')!, 'Missing baselines')
  await type(card.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]')!, 'Ask what the baseline was.')
  await act(async () => [...card.querySelectorAll('button')].find((b) => b.textContent === 'Run')!.click())
  await settle()
  expect(posts).toEqual([{ url: '/api/ws/w1/checks', body: { name: 'Missing baselines', prompt: 'Ask what the baseline was.', covers: ['documents'] } }])
  expect(document.querySelector('[aria-label="New check"]')).toBeNull()
  expect([...el.querySelectorAll('[data-category]')].map((r) => r.getAttribute('data-category'))).toContain('new')
})
