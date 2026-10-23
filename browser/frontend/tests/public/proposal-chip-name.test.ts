// A view chip on the orientation's card names the view as its propose_view call did, and finds the proposal by that
// name when the call's result gave no slug the browser could read (the result's summary is cut before its view ref).
// The server title-cases the name it stores (backend views.propose), so the match ignores case: live check L19 (group
// c) saw the chips of "Event counts" and "Wiki counts" show no build state, neither building, failed nor queued.
import { expect, test } from 'vitest'
import { findProposal } from '../../src/lib/proposals.ts'
import type { Proposal } from '../../src/lib/types.ts'

const proposals = [
  { slug: 'event-counts', name: 'Event Counts', status: 'building', ts: '2026-10-06T10:34:03Z' },
  { slug: 'wiki-counts', name: 'Wiki Counts', status: 'queued', ts: '2026-10-06T10:38:10Z' },
] as unknown as Proposal[]

test('a chip finds its proposal by name whatever its case, and by slug when it has one', () => {
  expect(findProposal(proposals, undefined, 'Event counts')?.slug).toBe('event-counts')
  expect(findProposal(proposals, null, ' wiki counts ')?.status).toBe('queued')
  expect(findProposal(proposals, 'wiki-counts', 'Anything')?.slug).toBe('wiki-counts')
  expect(findProposal(proposals, undefined, 'Other view')).toBeNull()
  expect(findProposal(proposals, undefined, '')).toBeNull()
})
