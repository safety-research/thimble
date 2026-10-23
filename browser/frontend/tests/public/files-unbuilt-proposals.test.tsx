// @vitest-environment jsdom
// A view proposal shows in Files only once its view is built (src/files/ViewsBar.tsx): one queued, building or failed
// is no entry of the views bar, so nothing in Files names it or opens anything for it; its build is the chat's chip and
// its thread. FilesTab is mounted over a server that answers the calls it makes.
import { act } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { FilesTab } from '../../src/files/FilesTab.tsx'
import { refreshProposals } from '../../src/lib/proposals.ts'
import { refreshViews } from '../../src/lib/views.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const WS = 'unbuilt'
const T = '2026-10-15T10:00:00Z'
const BOARD = { slug: 'board', origin: 'workspace', name: 'Board', description: '', claims: ['board.jsonl'], accepts: [], units: [], libs: [], built: T, ok: true, forms: [], first_file: 'board.jsonl', files: ['board.jsonl'], n_files: 1 }
const LISTING = { path: '', folders: [], files: [{ path: 'board.jsonl', name: 'board.jsonl', size_bytes: 100, kind: 'jsonl' }], n_files: 1 }
const row = (slug: string, name: string, status: string, extra: Record<string, unknown> = {}) =>
  ({ slug, name, description: `What ${name} shows.`, task: 'compare the agents', claims: ['board.jsonl'], arrangement: '', proposed_by: 'proposer', status, ts: T, ...extra })
const PROPOSALS = [
  row('board', 'Board', 'built'),
  row('agent-timeline', 'Agent Timeline', 'building', { chat: 'c-timeline', answer: 'accepted', offered: { at: T, after: 'main' } }),
  row('pr-flow', 'PR Flow', 'queued', { asked: true }),
  row('reviews', 'Reviews', 'failed', { chat: 'c-reviews', error: 'the page did not load' }),
  row('posts', 'Posts', 'suggested', { offered: { at: T, after: 'main' } }),
]
const UNBUILT = ['agent-timeline', 'pr-flow', 'reviews', 'posts']

beforeEach(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  localStorage.clear()
  vi.stubGlobal('fetch', async (input: string) => {
    const url = new URL(String(input), 'http://thimble.test')
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } })
    const p = url.pathname
    if (p.endsWith('/views/proposals')) return json(PROPOSALS)
    if (p.endsWith('/views') && !url.search) return json([BOARD])
    if (p.endsWith('/views') || p.endsWith('/chats') || p.endsWith('/concepts')) return json([])
    if (p.endsWith('/filters') || p.endsWith('/labels/presence')) return json({})
    if (p.endsWith('/sources')) return json(LISTING)
    return new Response('{"detail":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

test('the views bar lists the File browser and the built view only: no proposal queued, building, failed or waiting for an answer', async () => {
  const el = await mount(<FilesTab ws={WS} active />)
  await act(async () => {
    await Promise.all([refreshProposals(WS), refreshViews(WS)])
  })
  await settle()
  const bar = el.querySelector<HTMLElement>('.files-views')!
  expect([...bar.querySelectorAll('[role="radio"]')].map((o) => o.textContent?.trim())).toEqual(['File browser', 'Board'])
  for (const slug of UNBUILT) expect(el.querySelector(`[data-anchor="view:${slug}"]`), slug).toBeNull()
  // nothing to click for them: no button names them, and no Retry
  const buttons = [...bar.querySelectorAll('button')].map((b) => `${b.textContent ?? ''} ${b.getAttribute('aria-label') ?? ''}`)
  expect(buttons.filter((b) => /Agent Timeline|PR Flow|Reviews|Posts|Retry/.test(b))).toEqual([])
  expect(bar.querySelector('.spinner')).toBeNull()
})
