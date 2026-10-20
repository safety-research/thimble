// @vitest-environment jsdom
// One rule for toasts: a toast confirms or fails the analyst's own click, or reports news with a link. A state that
// lasts shows once beside what it concerns and is never also a toast: an Accept that cannot start stays under the view
// proposal's buttons alone, and a write that failed stays on its document (src/report/writeFailures.ts), with no toast
// for either.
import { act } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ARM_MS } from '../../src/chat/PermissionCard.tsx'
import { ProposalCard } from '../../src/chat/ProposalCard.tsx'
import { bus } from '../../src/lib/bus.ts'
import { invalidateSettings } from '../../src/lib/models.ts'
import { useWriteFailures } from '../../src/report/writeFailures.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const toasts: string[] = []
let off: () => void = () => undefined

beforeEach(() => {
  toasts.length = 0
  off = bus.on('toast', (t) => void toasts.push(t.text))
  invalidateSettings('mini')
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => {
  off()
  unmountAll()
  vi.unstubAllGlobals()
})

const REFUSAL = 'Your Claude Code session is in plan mode, where thimble\'s agents would have to ask you before every card and every edit, so none of them starts or takes a message there. Switch out of plan mode first (shift+tab in your terminal).'
const OFFER = { slug: 'agent-timeline', name: 'Agent Timeline', description: 'Every agent on one time axis.', task: 'compare the agents', claims: ['agents/*.jsonl'], status: 'suggested', offered: { at: '2026-10-14T10:00:00Z', after: 'main' } }

test('an Accept that cannot start says why under the view proposal, once, and makes no toast', async () => {
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } })
    if (String(url).endsWith('/accept') && init?.method === 'POST') return json({ ...OFFER, refused: { kind: 'hook', reason: REFUSAL } })
    if (String(url).endsWith('/views/proposals')) return json([OFFER])
    return json({ models: {}, propose_views: true })
  })
  const el = await mount(<ProposalCard ws="toast-rule" />)
  await settle()
  await act(async () => new Promise((r) => setTimeout(r, ARM_MS + 30)))
  await act(async () => el.querySelector<HTMLButtonElement>('.chat-offer-accept')!.click())
  await settle()
  expect(el.querySelectorAll('.chat-offer-refused')).toHaveLength(1)
  expect(el.querySelector('.chat-offer-refused')?.textContent).toBe(REFUSAL)
  expect(toasts).toEqual([])
})

test('a write that failed stays on its document and makes no toast', async () => {
  let shown: Record<string, unknown> = {}
  function Probe() {
    shown = useWriteFailures('mini').failures
    return null
  }
  await mount(<Probe />)
  await act(async () => bus.emit('wsEvent', { type: 'report', slug: 'report', status: 'failed', note: 'The writer stopped.', seq: 7 } as never))
  expect(Object.keys(shown)).toEqual(['report'])
  expect(toasts).toEqual([])
})
