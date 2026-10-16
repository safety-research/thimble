// @vitest-environment jsdom
// New comments (src/report/newComments.ts, src/chat/Notice.tsx NewCommentsNotice): when a check that is on ends a run
// that left comments, the chat's notice strip says how many new comments there are and on what, in one notice for the
// batch, with Show, which opens the first surface they are on with its Comments pane and its first new comment, and ×.
// The runs that had ended when this browser first read the workspace's checks are not news; a run is looked at once
// Show opens it, × dismisses it, or the analyst opens one of its comments, and that holds across a reload. Feedback on
// 0.8.0: "add a notification banner to comments".
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { NoticeStrip } from '../../src/chat/Notice.tsx'
import { bus } from '../../src/lib/bus.ts'
import { dispatch } from '../../src/lib/events.ts'
import type { Check, CheckRun } from '../../src/lib/types.ts'
import { storageKey } from '../../src/lib/workspace.ts'
import { CommentsPane, type Checks } from '../../src/report/Checks.tsx'
import { CANVAS } from '../../src/report/checkComments.ts'
import { newCommentsText, newRuns, PANE_KEY, resetSeen, REVEAL_WAIT_MS, revealComments, surfaceName, takeReveal, useLookedAt, useReveal, useTakeReveal, type NewRun } from '../../src/report/newComments.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const run = (id: string, comments: number, ended: string, status = 'done'): CheckRun => ({ run: id, status, chat: '', started: ended, ended, covered: [], seen: [], comments, summary: '' })
const check = (id: string, shown: boolean, runs: Record<string, CheckRun> = {}): Check => ({ id, name: id, prompt: 'p', colour: 2, shown, builtin: true, created_by: 'thimble', ts: '', version: 1, covers: ['documents', 'cards'], runs })

beforeEach(() => {
  window.localStorage.clear()
  resetSeen()
  takeReveal()
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('what the notice tells', () => {
  test('the runs of the checks that are on that ended done with comments, not looked at, in the order they ended', () => {
    const list = [
      check('important-details', true, { report: run('r3', 2, '2026-10-15T10:03:00Z'), [CANVAS]: run('r1', 1, '2026-10-15T10:01:00Z') }),
      check('judgment', false, { report: run('r4', 5, '2026-10-15T10:04:00Z') }),
      check('mine', true, { report: run('r5', 0, '2026-10-15T10:05:00Z'), slides: run('r6', 3, '2026-10-15T10:06:00Z', 'running'), story: run('r2', 4, '2026-10-15T10:02:00Z') }),
    ]
    expect(newRuns(list, new Set()).map((r) => r.run)).toEqual(['r1', 'r2', 'r3'])
    expect(newRuns(list, new Set(['r2'])).map((r) => r.run)).toEqual(['r1', 'r3'])
  })

  test('how many new comments, and on what: the cards, a built-in document after "the", a custom one by its name', () => {
    const r = (surface: string, comments: number): NewRun => ({ check: 'c', surface, run: `${surface}-${comments}`, comments, ended: '' })
    const name = (s: string) => surfaceName(s, s === 'report' ? 'Report' : 'Findings')
    expect(newCommentsText([r('report', 1)], name)).toBe('1 new comment on the Report')
    expect(newCommentsText([r('report', 3), r(CANVAS, 2)], name)).toBe('5 new comments on the Report and the cards')
    expect(newCommentsText([r('findings', 1), r('report', 2), r(CANVAS, 1), r('report', 1)], name)).toBe('5 new comments on Findings, the Report and the cards')
  })
})

describe('the notice in the strip', () => {
  let server: Check[] = []
  beforeEach(() => {
    server = [check('judgment', false), check('unverified', false), check('important-details', true, { report: run('old', 4, '2026-10-15T09:00:00Z') })]
    vi.stubGlobal('fetch', async (url: string) => {
      const u = String(url)
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } })
      if (u.endsWith('/checks')) return json(server)
      if (u.endsWith('/notices')) return json([])
      return json({})
    })
  })

  const strip = async (ws: string) => {
    const el = await mount(<NoticeStrip ws={ws} current="main" onOpen={() => undefined} />)
    await settle()
    return el
  }
  /** A run of `id` on `doc` ended: the server lists it, and the stream's `check` record makes the page read the list. */
  const ended = async (id: string, doc: string, r: CheckRun) => {
    server = server.map((c) => (c.id === id ? { ...c, runs: { ...c.runs, [doc]: r } } : c))
    await act(async () => dispatch({ type: 'check', id, doc, status: r.status, run: r.run } as never))
    await act(async () => void (await new Promise((res) => setTimeout(res, 250)))) // the list's read again after its debounce
    await settle()
  }
  const notices = (el: HTMLElement) => [...el.querySelectorAll('.chat-notice')].map((n) => n.querySelector('.chat-notice-text')?.textContent)
  const click = (el: Element | null | undefined) => act(async () => (el as HTMLButtonElement).click())

  test('what ended before this browser read the checks is no news; a run that ends with comments is, one notice for the batch', async () => {
    const el = await strip('nc-batch')
    expect(notices(el)).toEqual([])
    expect(JSON.parse(window.localStorage.getItem(storageKey('nc-batch', 'comments-seen')) ?? 'null')).toEqual(['old'])

    await ended('important-details', 'report', run('r1', 3, '2026-10-15T10:00:00Z'))
    expect(notices(el)).toEqual(['3 new comments on the Report Show'])
    const n = el.querySelector('.chat-notice')!
    expect(n.getAttribute('data-kind')).toBe('comments')
    expect([...n.querySelectorAll('button')].map((b) => b.textContent || b.getAttribute('aria-label'))).toEqual(['Show', 'Dismiss'])

    server = server.map((c) => (c.id === 'judgment' ? { ...c, shown: true } : c)) // the analyst turned it on
    await ended('judgment', CANVAS, run('r2', 2, '2026-10-15T10:01:00Z'))
    expect(notices(el)).toEqual(['5 new comments on the Report and the cards Show'])
    await ended('unverified', 'report', run('r3', 4, '2026-10-15T10:02:00Z')) // off: its comments do not show, so no news
    await ended('important-details', CANVAS, run('r4', 0, '2026-10-15T10:03:00Z'))
    expect(notices(el)).toEqual(['5 new comments on the Report and the cards Show'])
  })

  test('Show opens the first surface at its new comments, and the notice keeps what is left; × dismisses the rest, across a reload', async () => {
    const seen: unknown[] = []
    const offs = [bus.on('showTab', (e) => void seen.push(['showTab', e.tab])), bus.on('openRef', (e) => void seen.push(['openRef', e.ref]))]
    let asked: ReturnType<typeof useReveal> = null
    const Report = () => {
      asked = useReveal('nc-show', 'report')
      return null
    }
    const el = await strip('nc-show')
    await mount(<Report />)
    server = server.map((c) => (c.id === 'judgment' ? { ...c, shown: true } : c))
    await ended('important-details', 'report', run('r1', 3, '2026-10-15T10:00:00Z'))
    await ended('judgment', CANVAS, run('r2', 2, '2026-10-15T10:01:00Z'))

    await click([...el.querySelectorAll('.chat-notice button')].find((b) => b.textContent === 'Show'))
    expect(seen).toEqual([['showTab', 'report'], ['openRef', 'report:report']])
    expect(asked).toMatchObject({ surface: 'report', runs: ['r1'] })
    expect(window.localStorage.getItem(storageKey('nc-show', PANE_KEY))).toBe('true')
    expect(notices(el)).toEqual(['2 new comments on the cards Show'])

    await click(el.querySelector('.chat-notice [aria-label="Dismiss"]'))
    expect(notices(el)).toEqual([])
    unmountAll()
    resetSeen() // a reload reads what this browser kept
    const again = await strip('nc-show')
    expect(notices(again)).toEqual([])
    await ended('important-details', 'report', run('r5', 1, '2026-10-15T10:05:00Z'))
    expect(notices(again)).toEqual(['1 new comment on the Report Show'])
    offs.forEach((off) => off())
  })

  test('opening one of the new comments on the page is looking at it: the notice goes', async () => {
    const el = await strip('nc-look')
    await ended('important-details', 'report', run('r1', 3, '2026-10-15T10:00:00Z'))
    expect(notices(el)).toEqual(['3 new comments on the Report Show'])
    const Open = () => {
      useLookedAt('nc-look', 'r1')
      return null
    }
    await mount(<Open />)
    await settle()
    expect(notices(el)).toEqual([])
  })
})

describe("a surface's part of Show", () => {
  type C = { id: string; run?: string | null }
  test('it opens the first comment of the runs Show named, in reading order, once its checks are read', async () => {
    const got: (C | null)[] = []
    const comments: C[] = [{ id: 'a', run: 'r0' }, { id: 'b', run: 'r1' }, { id: 'c', run: 'r1' }]
    const Surface = ({ ready }: { ready: boolean }) => {
      useTakeReveal('nc-take', 'report', comments, ready, (c) => void got.push(c))
      return null
    }
    await mount(<Surface ready={false} />)
    act(() => revealComments('nc-take', 'report', ['r1']))
    await settle()
    expect(got).toEqual([])
    unmountAll()
    await mount(<Surface ready />)
    await settle()
    expect(got).toEqual([{ id: 'b', run: 'r1' }])
    let left: unknown = 'unread'
    const Probe = () => {
      left = useReveal('nc-take', 'report')
      return null
    }
    await mount(<Probe />)
    expect(left).toBeNull()
  })

  test('with none of their comments after a while, it gives up and shows the Comments pane alone', async () => {
    vi.useFakeTimers()
    const got: (C | null)[] = []
    const Surface = () => {
      useTakeReveal('nc-wait', CANVAS, [{ id: 'a', run: 'r0' }], true, (c) => void got.push(c))
      return null
    }
    await mount(<Surface />)
    act(() => revealComments('nc-wait', CANVAS, ['r9']))
    await act(async () => void vi.advanceTimersByTime(REVEAL_WAIT_MS - 10))
    expect(got).toEqual([])
    await act(async () => void vi.advanceTimersByTime(20))
    expect(got).toEqual([null])
  })

  test("a document's Comments pane that the analyst folded opens for Show", async () => {
    window.localStorage.setItem(storageKey('nc-pane', PANE_KEY), 'false')
    const checks: Checks = { list: [check('important-details', true)], ready: true, on: new Set(['important-details']), look: { colour: () => '', name: (id) => id ?? '', rank: () => 0 }, toggle: () => undefined, create: async () => true, editPrompt: async () => true }
    const el = await mount(<CommentsPane ws="nc-pane" doc="report" checks={checks} comments={[]} />)
    expect(el.querySelector('.wu-checks-list')).toBeNull()
    await act(async () => revealComments('nc-pane', 'report', ['r1']))
    await settle()
    expect(el.querySelector('.wu-checks-list .wu-check[data-check="important-details"]')).not.toBeNull()
  })
})
