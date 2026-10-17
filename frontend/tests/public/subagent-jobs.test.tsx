// @vitest-environment jsdom
// The jobs of thimble's agents in the browser: a view build's chip (src/chat/ViewChip.tsx) queued with the pool's count,
// building with the tray's direction, a repair's count, failed or stopped by main's quit with Retry and its Build menu
// (Retry is a click to the build route with the run's model and effort), a refused start with Start it; a report
// check's row that went stale after the analyst's own edits, with Run (src/report/Checks.tsx); a writer's start that
// did not happen, which stays on its document, and a writer the analyst stopped, which is no failure
// (src/report/writeFailures.ts).
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ViewChip } from '../../src/chat/ViewChip.tsx'
import { invalidateSettings } from '../../src/lib/models.ts'
import { refreshProposals } from '../../src/lib/proposals.ts'
import type { Proposal } from '../../src/lib/types.ts'
import { writingAfter } from '../../src/report/writeFailures.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const P = (slug: string, extra: Partial<Proposal> = {}): Proposal => ({ slug, name: slug, description: '', task: '', claims: [], arrangement: '', proposed_by: 'orient', status: 'building', ts: '', chat: `c-${slug}`, ...extra }) as Proposal
let proposals: Proposal[] = []
let posted: [string, unknown][] = []
beforeEach(() => {
  posted = []
  invalidateSettings('jobs')
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posted.push([String(url), JSON.parse(String(init.body ?? '{}'))])
      return new Response(JSON.stringify({ agentId: 'b1' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const body = String(url).endsWith('/views/proposals') ? proposals : { models: { dev: { model: 'claude-opus-5-5', effort: 'high', fast: false } } }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

const chip = async (slug: string) => {
  await act(async () => refreshProposals('jobs'))
  const el = await mount(<ViewChip ws="jobs" slug={slug} name={slug} />)
  await settle()
  return el
}

describe('a view build\'s chip', () => {

  test("a build main's quit stopped says so, and Retry starts a builder with the Build menu's model and effort", async () => {
    proposals = [P('posts', { status: 'failed', stopped_by: 'quit', values: { model: 'claude-opus-5-5', effort: 'max' } })]
    const el = await chip('posts')
    expect(el.querySelector('.view-chip-word')?.textContent).toBe('stopped')
    expect(el.querySelector('.view-chip-values')?.textContent).toBe('Opus 5.5 · max')
    await act(async () => el.querySelector<HTMLButtonElement>('.view-chip-retry')!.click())
    await settle()
    expect(posted).toEqual([['/api/ws/jobs/views/posts/build', { model: 'claude-opus-5-5', effort: 'max' }]])
  })
})

describe("a writer's start that did not happen", () => {
  test('ends the Writing state its start began, so the refused card shows (live check L19)', () => {
    // the server says `generating` as the write begins, then `refused` when the module refuses the start (Claude
    // Code's concurrency limit): the button must not stay on Writing, which hides the card
    expect(writingAfter('generating')).toBe(true)
    expect(writingAfter('refused')).toBe(false)
    expect(writingAfter('generated')).toBe(false)
    expect(writingAfter('failed')).toBe(false)
    expect(writingAfter('edited')).toBeNull()
  })
})
