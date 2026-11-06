// @vitest-environment jsdom
// The views in Files (src/files/ViewsBar.tsx, src/lib/views.ts): the views bar lists the File browser and each view
// built for the workspace, and a view built later joins it once the stream says so. A view proposal shows only once its
// view is built: one queued, building or failed is no entry, so nothing in Files names it or opens anything for it.
// FilesTab is mounted over a server that answers the calls it makes.
import { act } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { FilesTab } from '../../src/files/FilesTab.tsx'
import { dispatch } from '../../src/lib/events.ts'
import { refreshProposals } from '../../src/lib/proposals.ts'
import { refreshViews } from '../../src/lib/views.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const WS = 'views-bar'
const T = '2026-10-15T10:00:00Z'
const view = (slug: string, name: string) => ({ slug, origin: 'workspace', name, description: '', claims: ['board.jsonl'], accepts: [], units: [], libs: [], built: T, ok: true, forms: [], first_file: 'board.jsonl', files: ['board.jsonl'], n_files: 1 })
const LISTING = { path: '', folders: [], files: [{ path: 'board.jsonl', name: 'board.jsonl', size_bytes: 100, kind: 'jsonl' }], n_files: 1 }
const row = (slug: string, name: string, status: string, extra: Record<string, unknown> = {}) =>
  ({ slug, name, description: `What ${name} shows.`, task: 'compare the agents', claims: ['board.jsonl'], arrangement: '', proposed_by: 'proposer', status, ts: T, ...extra })
const PROPOSALS = [
  row('board', 'Board', 'built'),
  row('agent-timeline', 'Agent Timeline', 'building', { chat: 'c-timeline', answer: 'accepted', offered: { at: T, after: 'main' } }),
  row('pr-flow', 'PR Flow', 'queued', { asked: true }),
  row('reviews', 'Reviews', 'failed', { chat: 'c-reviews', error: 'the page did not load' }),
]
/** The views GET /views answers. */
let views = [view('board', 'Board')]

beforeEach(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  localStorage.clear()
  views = [view('board', 'Board')]
  vi.stubGlobal('fetch', async (input: string) => {
    const url = new URL(String(input), 'http://thimble.test')
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } })
    const p = url.pathname
    if (p.endsWith('/views/proposals')) return json(PROPOSALS)
    if (p.endsWith('/views') && !url.search) return json(views)
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

test("Files' views bar lists the File browser and each built view, a view built later joining it, and no proposal not built yet", async () => {
  const el = await mount(<FilesTab ws={WS} active />)
  await act(async () => {
    await Promise.all([refreshProposals(WS), refreshViews(WS)])
  })
  await settle()
  const bar = () => [...el.querySelectorAll<HTMLElement>('.files-views [role="radio"]')].map((o) => o.textContent?.trim())
  expect(bar()).toEqual(['File browser', 'Board'])
  for (const slug of ['agent-timeline', 'pr-flow', 'reviews']) expect(el.querySelector(`[data-anchor="view:${slug}"]`), slug).toBeNull()
  // the timeline's build ends, and the stream says so
  views = [view('board', 'Board'), view('agent-timeline', 'Agent Timeline')]
  await act(async () => dispatch({ type: 'view', slug: 'agent-timeline', status: 'built' } as never))
  await act(async () => new Promise((r) => setTimeout(r, 400)))
  expect(bar()).toEqual(['File browser', 'Board', 'Agent Timeline'])
})
