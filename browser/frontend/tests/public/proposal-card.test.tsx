// @vitest-environment jsdom
// The view proposal above the chat's composer (src/chat/ProposalCard.tsx): the oldest open proposal, with its name and
// what it shows; Accept and Reject are clicks of their own routes, and Reject hides the card at once.
import { act } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ARM_MS } from '../../src/chat/PermissionCard.tsx'
import { ProposalCard } from '../../src/chat/ProposalCard.tsx'
import { invalidateSettings } from '../../src/lib/models.ts'
import type { Proposal } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const PROPOSAL = { slug: 'agent-timeline', name: 'agent timeline', description: 'What agent-timeline shows.', task: 'compare how the agents coordinated', claims: ['agents/*.jsonl'], status: 'suggested', offered: { at: '2026-10-14T10:00:00Z', after: 'main' } } as unknown as Proposal
let proposals: Proposal[] = []
let sent: string[] = []

beforeEach(() => {
  proposals = [PROPOSAL]
  sent = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET'
    const u = String(url)
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })
    if (method !== 'GET') sent.push(`${method} ${u}`)
    if (u.endsWith('/views/proposals')) return json(proposals)
    if (u.endsWith('/settings')) return json({ models: {}, propose_views: true })
    if (u.endsWith('/accept')) return json({ ...proposals[0], status: 'queued' })
    if (u.endsWith('/reject')) {
      proposals = proposals.map((p) => ({ ...p, status: 'dropped' as const, answer: 'rejected' as const }))
      return json(proposals[0])
    }
    return json({ detail: 'not found' }, 404)
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

/** The card in workspace `ws` (one per mount, as the proposals store is kept per workspace), once it takes clicks. */
async function card(ws: string) {
  invalidateSettings(ws)
  const el = await mount(<ProposalCard ws={ws} />)
  await settle()
  await settle()
  await act(async () => new Promise((r) => setTimeout(r, ARM_MS + 30)))
  return el
}

test('a view proposal shows its name and what it shows; Accept asks for the view, and Reject hides the card at once', async () => {
  let el = await card('pc-accept')
  expect(el.querySelector('.chat-offer-name')?.textContent).toBe('agent timeline')
  expect(el.querySelector('.chat-offer-desc')?.textContent?.trim()).toBe('What agent-timeline shows.')
  await act(async () => el.querySelector<HTMLButtonElement>('.chat-offer-accept')!.click())
  await settle()
  expect(sent).toEqual(['POST /api/ws/pc-accept/views/proposals/agent-timeline/accept'])
  unmountAll()
  sent = []
  el = await card('pc-reject')
  await act(async () => el.querySelector<HTMLButtonElement>('.chat-offer-reject')!.click())
  expect(el.querySelector('.chat-offer')).toBeNull()
  await settle()
  expect(sent).toEqual(['POST /api/ws/pc-reject/views/proposals/agent-timeline/reject'])
})
