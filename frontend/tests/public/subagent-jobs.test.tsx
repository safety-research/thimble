// @vitest-environment jsdom
// The jobs of thimble's agents in the browser: a view build's chip (src/chat/ViewChip.tsx) queued with the pool's count,
// building with the tray's direction, a repair's count, failed or stopped by main's quit with Retry and its Build menu
// (Retry is a click to the build route with the run's model and effort), a refused start with Start it; a report
// check's row that went stale after the analyst's own edits, with Run (src/report/Checks.tsx); a writer's start that
// did not happen, which stays on its document (src/report/writeFailures.ts).
import { act } from 'react'
import { buildStage } from '../../src/chat/ChatPanel.tsx'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ViewChip, buildingText, failedWhy, queuedText } from '../../src/chat/ViewChip.tsx'
import { ProposalOption } from '../../src/files/ViewsBar.tsx'
import { bus } from '../../src/lib/bus.ts'
import { invalidateSettings } from '../../src/lib/models.ts'
import { refreshProposals } from '../../src/lib/proposals.ts'
import type { Proposal } from '../../src/lib/types.ts'
import { staleOf, staleText } from '../../src/report/Checks.tsx'
import { runLine } from '../../src/report/checkComments.ts'
import { nextRefusals, useWriteRefusals } from '../../src/report/writeFailures.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const P = (slug: string, extra: Partial<Proposal> = {}): Proposal => ({ slug, name: slug, why: '', claims: [], arrangement: '', proposed_by: 'orient', status: 'building', ts: '', chat: `c-${slug}`, ...extra }) as Proposal
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
  test('queued says how many build of the pool; building names a repair\'s count', () => {
    expect(queuedText([P('a'), P('b'), P('c', { status: 'queued' })])).toBe('queued · 2 of 3 building')
    expect(queuedText([P('c', { status: 'queued' })])).toBe('queued')
    expect(buildingText(P('a', { repairs: 1 }))).toBe('repair 1 of 2')
    expect(buildingText(P('a'))).toBe('building')
    expect(buildStage('the view did not pass, so a new builder builds it again from what failed (repair 1 of 2)').label).toBe('Building again with a new builder · repair 1 of 2')
  })

  test("why a ✕: a refusal's line, a stop at main's quit, or the error", () => {
    expect(failedWhy(P('a', { refused: { kind: 'limit', reason: 'Maximum of 20 concurrent subagents' } }))).toMatch(/^Claude Code runs at most 20 subagents/)
    expect(failedWhy(P('a', { status: 'failed', stopped_by: 'quit' }))).toBe('Stopped when your Claude Code session ended.')
    expect(failedWhy(P('a', { status: 'failed', error: 'the page did not load' }))).toBe('the page did not load')
  })

  test('a repair builds with its count, and a queued build waits with the pool\'s', async () => {
    proposals = [P('posts', { repairs: 2 }), P('board'), P('graph', { status: 'queued' })]
    const posts = await chip('posts')
    expect(posts.querySelector('.view-chip-word')?.textContent).toBe('repair 2 of 2')
    const graph = await chip('graph')
    expect(graph.querySelector('.view-chip-word')?.textContent).toBe('queued · 2 of 3 building')
  })

  test("a build main's quit stopped says so, and Retry starts a builder with the Build menu's model and effort", async () => {
    proposals = [P('posts', { status: 'failed', stopped_by: 'quit', values: { model: 'claude-opus-5-5', effort: 'max' } })]
    const el = await chip('posts')
    expect(el.querySelector('.view-chip-word')?.textContent).toBe('stopped')
    expect(el.querySelector('.view-chip-values')?.textContent).toBe('Opus 5.5 · max')
    await act(async () => el.querySelector<HTMLButtonElement>('.view-chip-retry')!.click())
    await settle()
    expect(posted).toEqual([['/api/ws/jobs/views/posts/build', { model: 'claude-opus-5-5', effort: 'max' }]])
  })

  test("the views bar's warning on a build main's quit stopped says so, as the chip does (live check L14)", async () => {
    vi.useFakeTimers()
    try {
      const el = await mount(<ProposalOption ws="jobs" p={P('posts', { status: 'failed', stopped_by: 'quit', error: 'thimble stopped when its Claude Code session ended' })} onDismiss={() => undefined} size="md" />)
      const tipped = el.querySelector<HTMLElement>('.files-proposal-opt .tipped')!
      await act(async () => {
        tipped.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
        tipped.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false, pointerType: 'mouse' }))
        vi.advanceTimersByTime(1000)
      })
      expect(document.querySelector('[role=tooltip]')?.textContent).toBe('Stopped when your Claude Code session ended.')
    } finally {
      vi.useRealTimers()
    }
  })

  test('a typed build auto mode refused offers Start it, which posts start-it', async () => {
    proposals = [P('posts', { status: 'failed', refused: { kind: 'auto-mode', reason: '[Auto-Mode Bypass]', request: 'rv' } })]
    const el = await chip('posts')
    expect(el.querySelector('.view-chip')?.getAttribute('data-refused')).toBe('auto-mode')
    expect(el.querySelector('.view-chip-retry')).toBeNull()
    await act(async () => el.querySelector<HTMLButtonElement>('.view-chip-start-it')!.click())
    await settle()
    expect(posted).toEqual([['/api/ws/jobs/subagents/start-it', { request: 'rv' }]])
  })
})

describe("a report check's row", () => {
  test('stale after the analyst\'s own edits, with the count; a running run is never stale; queued says so', () => {
    expect(staleOf({ status: 'done', stale: 2 })).toBe(2)
    expect(staleOf({ status: 'running', stale: 2 })).toBe(0)
    expect(staleOf({ status: 'done', stale: 0 })).toBe(0)
    expect(staleText(2)).toBe('2 passages changed since checked')
    expect(staleText(1)).toBe('1 passage changed since checked')
    expect(runLine({ status: 'running', chat: '', started: '', comments: 0, summary: '', waiting: 'queued' })).toBe('Queued: at most 3 checks run at once')
  })
})

describe("a writer's start that did not happen", () => {
  test('stays on its document until a later write starts, and makes no toast', async () => {
    const toasts: string[] = []
    const off = bus.on('toast', (t) => void toasts.push(t.text))
    const r = nextRefusals({}, { type: 'report', slug: 'report', status: 'refused', refused: { kind: 'no-call', reason: 'I will not.', request: 'rw' }, seq: 3 } as never)
    expect(r.report.refusal).toEqual({ kind: 'no-call', reason: 'I will not.', request: 'rw' })
    expect(nextRefusals(r, { type: 'report', slug: 'report', status: 'generating' } as never)).toEqual({})
    let shown: Record<string, unknown> = {}
    function Probe() {
      shown = useWriteRefusals().refusals
      return null
    }
    await mount(<Probe />)
    await act(async () => bus.emit('wsEvent', { type: 'report', slug: 'story', status: 'refused', refused: { kind: 'limit', reason: '20 concurrent subagents' }, seq: 9 } as never))
    expect(Object.keys(shown)).toContain('story')
    expect(toasts).toEqual([])
    off()
  })
})
