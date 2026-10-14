// @vitest-environment jsdom
// The view proposal above the chat's composer (src/chat/ProposalCard.tsx): the oldest open proposal (a `suggested` row
// with `offered`), with its name, what it shows and the analyst's task in view, never behind a click; Accept and Reject
// are clicks of their own routes, each tracked; Don't ask again turns view proposals off and says where to turn them on
// again; nothing shows while view proposals are off; a click in the first ARM_MS does nothing; an Accept that cannot
// start says why under the buttons.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ARM_MS } from '../../src/chat/PermissionCard.tsx'
import { offerFor, openOffer, PROPOSAL_HEAD, PROPOSALS_OFF_LINE, ProposalCard } from '../../src/chat/ProposalCard.tsx'
import { bus } from '../../src/lib/bus.ts'
import { invalidateSettings } from '../../src/lib/models.ts'
import { track } from '../../src/lib/telemetry.ts'
import type { Proposal } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

vi.mock('../../src/lib/telemetry.ts', async (orig) => ({ ...(await orig<typeof import('../../src/lib/telemetry.ts')>()), track: vi.fn() }))

const row = (slug: string, at: string | null, extra: Partial<Proposal> = {}): Proposal =>
  ({ slug, name: slug.replace(/-/g, ' '), description: `What ${slug} shows.`, task: 'compare how the agents coordinated', claims: ['agents/*.jsonl'], status: 'suggested', ...(at ? { offered: { at, turn: 2, after: 'main' } } : {}), ...extra }) as Proposal

describe('which proposal shows, and its line', () => {
  test('the oldest suggested row with `offered`; a row without it (an older version), one switched off or one answered never shows', () => {
    const rows = [row('legacy', null), row('later', '2026-10-14T10:05:00Z'), row('first', '2026-10-14T10:00:00Z'), row('off', '2026-10-14T09:00:00Z', { off: true }), row('built', '2026-10-14T08:00:00Z', { status: 'built' })]
    expect(openOffer(rows)?.slug).toBe('first')
    expect(openOffer([row('legacy', null)])).toBeNull()
    expect(openOffer(null)).toBeNull()
  })

  test("the analyst's task, or for a viewer of a file type the files it reads", () => {
    expect(offerFor({ task: ' compare the agents ', claims: ['a.jsonl'] })).toBe('Task: compare the agents')
    expect(offerFor({ task: '', claims: ['**/*.vtt'] })).toBe('For **/*.vtt')
    expect(offerFor({ task: '', claims: [] })).toBe('')
  })
})

describe('the card', () => {
  let proposals: Proposal[] = []
  let settings: Record<string, unknown> = {}
  let sent: { method: string; url: string; body: unknown }[] = []
  let toasts: string[] = []
  let off: () => void = () => undefined

  beforeEach(() => {
    proposals = [row('agent-timeline', '2026-10-14T10:00:00Z')]
    settings = { models: {}, propose_views: true }
    sent = []
    toasts = []
    off = bus.on('toast', (t) => void toasts.push(t.text))
    vi.mocked(track).mockClear()
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET'
      const u = String(url)
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })
      if (method !== 'GET') sent.push({ method, url: u, body: init.body ? JSON.parse(String(init.body)) : null })
      if (u.endsWith('/views/proposals')) return json(proposals)
      if (u.endsWith('/settings') && method === 'PUT') {
        settings = { ...settings, ...(JSON.parse(String(init.body)) as object) }
        return json(settings)
      }
      if (u.endsWith('/settings')) return json(settings)
      if (u.endsWith('/accept')) return json({ ...proposals[0], status: 'queued' })
      if (u.endsWith('/reject')) {
        proposals = proposals.map((p) => ({ ...p, status: 'dropped' as const, answer: 'rejected' as const }))
        return json(proposals[0])
      }
      return json({ detail: 'not found' }, 404)
    })
  })
  afterEach(() => {
    off()
    unmountAll()
    vi.unstubAllGlobals()
  })

  /** The card in workspace `ws` (one per test, as the proposals store is kept per workspace), armed when `armed`. */
  async function card(ws: string, armed = true) {
    invalidateSettings(ws)
    const el = await mount(<ProposalCard ws={ws} />)
    await settle()
    await settle()
    if (armed) await act(async () => new Promise((r) => setTimeout(r, ARM_MS + 30)))
    return el
  }
  const click = (el: HTMLElement, sel: string) => act(async () => el.querySelector<HTMLButtonElement>(sel)!.click())

  test('the head, the name in bold, what it shows and the task are in view, with Accept, Reject and Don’t ask again', async () => {
    const el = await card('pc-look', false)
    const c = el.querySelector('.chat-offer')!
    expect(c.getAttribute('aria-label')).toBe(PROPOSAL_HEAD)
    expect(c.querySelector('.chat-offer-head')?.textContent).toBe('View proposal')
    expect(c.querySelector('b.chat-offer-name')?.textContent).toBe('agent timeline')
    expect(c.querySelector('.chat-offer-desc')?.textContent?.trim()).toBe('What agent-timeline shows.')
    expect(c.querySelector('.chat-offer-task')?.textContent).toBe('Task: compare how the agents coordinated')
    expect([...c.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Accept', 'Reject', 'Don’t ask again'])
    expect(c.textContent).not.toMatch(/offer/i)
    expect(document.activeElement).toBe(document.body)
  })

  test('Accept posts accept and Reject posts reject, each tracked; Reject hides the card at once', async () => {
    let el = await card('pc-accept')
    await click(el, '.chat-offer-accept')
    await settle()
    expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual(['POST /api/ws/pc-accept/views/proposals/agent-timeline/accept'])
    expect(track).toHaveBeenCalledWith('view-build', { target: 'view:agent-timeline', detail: { offer: true } })
    unmountAll()
    sent = []
    el = await card('pc-reject')
    await click(el, '.chat-offer-reject')
    expect(el.querySelector('.chat-offer')).toBeNull()
    await settle()
    expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual(['POST /api/ws/pc-reject/views/proposals/agent-timeline/reject'])
    expect(track).toHaveBeenCalledWith('view-dismiss', { target: 'view:agent-timeline', detail: { offer: true } })
  })

  test('a click in the first ARM_MS after the proposal shows does nothing', async () => {
    const el = await card('pc-arm', false)
    await click(el, '.chat-offer-accept')
    await click(el, '.chat-offer-reject')
    await click(el, '.chat-offer-off')
    await settle()
    expect(sent).toEqual([])
    expect(el.querySelector('.chat-offer')).not.toBeNull()
  })

  test('Don’t ask again turns view proposals off, the card goes, and a toast says Settings turns them on again', async () => {
    const el = await card('pc-off')
    await click(el, '.chat-offer-off')
    await settle()
    await settle()
    expect(sent).toEqual([{ method: 'PUT', url: '/api/ws/pc-off/settings', body: { propose_views: false } }])
    expect(el.querySelector('.chat-offer')).toBeNull()
    expect(toasts).toEqual([PROPOSALS_OFF_LINE])
  })

  test('nothing shows while view proposals are off, nor once the proposal is dropped', async () => {
    settings = { models: {}, propose_views: false }
    let el = await card('pc-hidden', false)
    expect(el.querySelector('.chat-offer')).toBeNull()
    unmountAll()
    settings = { models: {}, propose_views: true }
    el = await card('pc-dropped', false)
    expect(el.querySelector('.chat-offer')).not.toBeNull()
    await act(async () => bus.emit('view', { slug: 'agent-timeline', status: 'dropped' }))
    expect(el.querySelector('.chat-offer')).toBeNull()
  })

  test('a viewer proposed for a file type shows the files it reads in place of a task', async () => {
    proposals = [row('vtt-viewer', '2026-10-14T10:00:00Z', { task: '', claims: ['**/*.vtt'], proposed_by: 'files', offered: { at: '2026-10-14T10:00:00Z', turn: 2, after: 'file' } } as Partial<Proposal>)]
    const el = await card('pc-file', false)
    expect(el.querySelector('.chat-offer-task')?.textContent).toBe('For **/*.vtt')
    expect(el.querySelector('.chat-offer')?.getAttribute('data-after')).toBe('file')
  })

  test('an Accept refused before this page opened still says why under the buttons', async () => {
    proposals = [row('agent-timeline', '2026-10-14T10:00:00Z', { refused: { kind: 'no-module', reason: "thimble's agents can't start in this session: Claude Code's hooks modules are off (off). Once modules are on, quit and run `thimble -c` in this folder." } })]
    const el = await card('pc-refused', false)
    expect(el.querySelector('.chat-offer-refused')?.textContent).toMatch(/hooks modules are off .* quit and run `thimble -c`/)
  })
})
