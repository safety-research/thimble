// @vitest-environment jsdom
// The review of a view's pictures as the analyst sees it: its line (files/ViewPane reviewLine), the view's name
// shimmering in the views bar while the review runs, and the mark at the view pane's head, which stops a running
// review, runs a failed one again and undoes a revision from its hover. The server is a fake fetch.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ViewPane, reviewLine } from '../../src/files/ViewPane.tsx'
import { ViewsBar } from '../../src/files/ViewsBar.tsx'
import type { FilesLabels } from '../../src/files/useLabels.ts'
import type { ViewReview } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

let calls: { url: string; method: string }[] = []
beforeEach(() => {
  calls = []
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET' })
    if (String(url).includes('/frame')) return new Response('<html><head></head><body></body></html>', { status: 200 })
    return new Response(JSON.stringify(String(url).includes('/proposals') ? [] : {}), { status: 200, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const labels: FilesLabels = { all: [], on: [], focus: null, setFocus: () => undefined, byId: new Map(), presence: new Map(), toggle: () => undefined, setClasses: () => undefined, save: async () => ({}) as never }

const pane = (review: ViewReview) => mount(<ViewPane ws="w" view={{ slug: 'threads', name: 'Threads', built: '1', review }} path="board.jsonl" kind="board" labels={labels} />)

describe("the review of a view's pictures", () => {
  test('its line says what it is doing or why it ended', () => {
    expect(reviewLine({ state: 'running' })).toBe("Reviewing the view's pictures")
    expect(reviewLine({ state: 'running', round: 1 })).toBe('Revising the view from its review (round 1)')
    expect(reviewLine({ state: 'failed', note: "The view's pictures were drawn without thimble's fonts" })).toBe("The view's pictures were drawn without thimble's fonts")
    expect(reviewLine({ state: 'done' })).toBe('Checked')
  })

  test("the view's name shimmers in the views bar while its review runs", async () => {
    const el = await mount(
      <ViewsBar ws="w" value="view:threads" onChange={() => undefined} proposals={[]} views={[{ slug: 'threads', name: 'Threads', review: { state: 'running' } }, { slug: 'links', name: 'Links', review: { state: 'done' } }]} />,
    )
    const opts = [...el.querySelectorAll<HTMLElement>('.files-views .seg-opt[data-anchor^="view:"]')]
    expect(opts.filter((o) => o.classList.contains('is-reviewing')).map((o) => o.dataset.anchor)).toEqual(['view:threads'])
  })

  test('a click on a running review stops it, and a failed one runs again', async () => {
    let el = await pane({ state: 'running' })
    await settle()
    const mark = () => el.querySelector<HTMLButtonElement>('.view-pane-head .view-pane-review .bcell-check-mark')!
    expect(mark().getAttribute('aria-label')).toBe("Reviewing the view's pictures. Stop the review")
    await act(async () => mark().click())
    expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/views/threads/review'))).toBe(true)
    unmountAll()
    el = await pane({ state: 'failed', note: 'The review did not finish: the reading ended refused' })
    await settle()
    await act(async () => mark().click())
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/views/threads/review'))).toBe(true)
  })

  test("a revised view's hover lists what was revised with Undo, and a flagged one what is left", async () => {
    const el = await pane({ state: 'done', revised: ['picture 1: the ticks overlap'], left: [] })
    await settle()
    const mark = el.querySelector<HTMLElement>('.view-pane-review')!
    await act(async () => mark.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    await act(async () => el.querySelector<HTMLButtonElement>('.view-pane-review .bcell-check-mark')!.focus())
    const pop = document.querySelector<HTMLElement>('.bcell-check-pop')!
    expect(pop.textContent).toContain('Revised: picture 1: the ticks overlap')
    const undo = [...pop.querySelectorAll('button')].find((b) => b.textContent === 'Undo')!
    await act(async () => undo.click())
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/views/threads/review/undo'))).toBe(true)
    unmountAll()
    const flagged = await pane({ state: 'done', revised: [], left: ['picture 3: the filter keeps everything'] })
    await settle()
    expect(flagged.querySelector('.view-pane-review .bcell-check-mark')!.classList.contains('is-flagged')).toBe(true)
  })

  test('a review that ended early after a revision still offers Undo beside Review again', async () => {
    const el = await pane({ state: 'failed', note: "The review did not finish: Anthropic's API is overloaded", revised: ['picture 1: the ticks overlap'] })
    await settle()
    await act(async () => el.querySelector<HTMLElement>('.view-pane-review')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    await act(async () => el.querySelector<HTMLButtonElement>('.view-pane-review .bcell-check-mark')!.focus())
    const pop = document.querySelector<HTMLElement>('.bcell-check-pop')!
    expect([...pop.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Undo', 'Review again'])
    await act(async () => [...pop.querySelectorAll('button')].find((b) => b.textContent === 'Undo')!.click())
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/views/threads/review/undo'))).toBe(true)
  })
})
