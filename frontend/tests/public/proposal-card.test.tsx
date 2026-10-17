// @vitest-environment jsdom
// The view proposal above the chat's composer (src/chat/ProposalCard.tsx): the oldest open proposal (a `suggested` row
// with `offered`), with its name and what it shows in view, never behind a click, and not the task it names, in the
// terminal row's words; Build it and Don't build it are clicks of their own routes, each tracked; Stop suggesting pages
// turns view proposals off and says where to turn them on again; nothing shows while view proposals are off; a click in the first ARM_MS does nothing; an Accept that cannot
// start says why under the buttons.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ARM_MS } from '../../src/chat/PermissionCard.tsx'
import { ProposalCard } from '../../src/chat/ProposalCard.tsx'
import { bus } from '../../src/lib/bus.ts'
import { invalidateSettings } from '../../src/lib/models.ts'
import { track } from '../../src/lib/telemetry.ts'
import type { Proposal } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

vi.mock('../../src/lib/telemetry.ts', async (orig) => ({ ...(await orig<typeof import('../../src/lib/telemetry.ts')>()), track: vi.fn() }))

const row = (slug: string, at: string | null, extra: Partial<Proposal> = {}): Proposal =>
  ({ slug, name: slug.replace(/-/g, ' '), description: `What ${slug} shows.`, task: 'compare how the agents coordinated', claims: ['agents/*.jsonl'], status: 'suggested', ...(at ? { offered: { at, after: 'main' } } : {}), ...extra }) as Proposal

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

  test('the card says what the terminal row says: what thimble can build, Build it, Don\'t build it, Stop suggesting pages', async () => {
    // bug hunt round 9, friction 7: the browser said "View proposal · Accept · Reject · Don't ask again" for the row the
    // terminal shows as "thimble can build a page for these records: … · build it · don't build it · stop suggesting pages"
    const el = await card('pc-words')
    const text = (sel: string) => el.querySelector(sel)?.textContent?.trim()
    expect(text('.chat-offer-head')).toBe('thimble can build a page for these records:')
    expect(text('.chat-offer-name')).toBe('agent timeline')
    expect([text('.chat-offer-accept'), text('.chat-offer-reject'), text('.chat-offer-off')]).toEqual(['Build it', "Don't build it", 'Stop suggesting pages'])
    await click(el, '.chat-offer-off')
    await settle()
    expect(toasts).toEqual(['thimble will suggest no more pages. Settings turns suggestions back on.'])
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
})
