// @vitest-environment jsdom
// New comments (src/report/newComments.ts): when a check that is on ends a run that left comments, the Comments pane of
// the surface they are on carries the accent dot ("New comments"): on the canvas the toolbar's Comments button
// (canvas/Controls.tsx CommentsButton), beside a document its Comments pane's head (report/Checks.tsx CommentsPane).
// Nothing shows in the chat's notice strip. The runs that had ended when this browser first read the workspace's checks
// are not news; a run is looked at once the analyst opens its surface's Comments pane or one of its comments, and that
// holds across a reload.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { CommentsButton } from '../../src/canvas/Controls.tsx'
import { NoticeStrip } from '../../src/chat/Notice.tsx'
import { dispatch } from '../../src/lib/events.ts'
import type { Check, CheckRun } from '../../src/lib/types.ts'
import { storageKey } from '../../src/lib/workspace.ts'
import { CommentsPane, useChecks } from '../../src/report/Checks.tsx'
import { CANVAS } from '../../src/report/checkComments.ts'
import { newRuns, resetSeen, useLookedAt } from '../../src/report/newComments.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const run = (id: string, comments: number, ended: string, status = 'done'): CheckRun => ({ run: id, status, chat: '', started: ended, ended, covered: [], seen: [], comments, summary: '' })
const check = (id: string, shown: boolean, runs: Record<string, CheckRun> = {}): Check => ({ id, name: id, prompt: 'p', colour: 2, shown, builtin: true, created_by: 'thimble', ts: '', version: 1, covers: ['documents', 'cards'], runs })

beforeEach(() => {
  window.localStorage.clear()
  resetSeen()
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('what is new', () => {
  test('the runs of the checks that are on that ended done with comments, not looked at, in the order they ended', () => {
    const list = [
      check('important-details', true, { report: run('r3', 2, '2026-10-15T10:03:00Z'), [CANVAS]: run('r1', 1, '2026-10-15T10:01:00Z') }),
      check('judgment', false, { report: run('r4', 5, '2026-10-15T10:04:00Z') }),
      check('mine', true, { report: run('r5', 0, '2026-10-15T10:05:00Z'), slides: run('r6', 3, '2026-10-15T10:06:00Z', 'running'), story: run('r2', 4, '2026-10-15T10:02:00Z') }),
    ]
    expect(newRuns(list, new Set()).map((r) => r.run)).toEqual(['r1', 'r2', 'r3'])
    expect(newRuns(list, new Set(['r2'])).map((r) => r.run)).toEqual(['r1', 'r3'])
  })
})

describe('the dot on the Comments pane', () => {
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
    // jsdom has no ResizeObserver, which the Comments button's popover watches its size with
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  })

  /** The canvas's Comments button and the Report's Comments pane, each holding the workspace's checks as its surface
   * does, and the chat's notice strip. */
  const Surfaces = ({ ws }: { ws: string }) => {
    const canvas = useChecks(ws)
    const report = useChecks(ws)
    return (
      <>
        <div data-surface="canvas">
          <CommentsButton ws={ws} checks={canvas} comments={[]} />
        </div>
        <div data-surface="report">
          <CommentsPane ws={ws} doc="report" checks={report} comments={[]} />
        </div>
        <div data-surface="chat">
          <NoticeStrip ws={ws} current="main" onOpen={() => undefined} />
        </div>
      </>
    )
  }
  const surfaces = async (ws: string) => {
    const el = await mount(<Surfaces ws={ws} />)
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
  /** The surfaces whose Comments pane's control carries the dot named "New comments". */
  const dots = (el: HTMLElement) => {
    const on: string[] = []
    if (el.querySelector('[data-surface="canvas"] .bctl-comments .dot[aria-label="New comments"]')) on.push('canvas')
    if (el.querySelector('[data-surface="report"] .wu-checks-head .wu-sec-head .dot[aria-label="New comments"]')) on.push('report')
    return on
  }
  const click = (el: Element | null | undefined) => act(async () => (el as HTMLButtonElement).click())

  test('what ended before this browser read the checks is no news; a run that ends with comments marks the pane of its surface alone', async () => {
    const el = await surfaces('nc-dot')
    expect(dots(el)).toEqual([])
    expect(JSON.parse(window.localStorage.getItem(storageKey('nc-dot', 'comments-seen')) ?? 'null')).toEqual(['old'])

    await ended('important-details', CANVAS, run('r1', 3, '2026-10-15T10:00:00Z'))
    expect(dots(el)).toEqual(['canvas'])
    const dot = el.querySelector('[data-surface="canvas"] .bctl-comments .dot')!
    expect([dot.getAttribute('role'), dot.getAttribute('title')]).toEqual(['img', 'New comments'])

    await ended('unverified', 'report', run('r2', 4, '2026-10-15T10:01:00Z')) // off: its comments do not show, so no news
    await ended('important-details', 'report', run('r3', 0, '2026-10-15T10:02:00Z')) // no comments
    expect(dots(el)).toEqual(['canvas'])
    server = server.map((c) => (c.id === 'judgment' ? { ...c, shown: true } : c)) // the analyst turned it on
    await ended('judgment', 'slides', run('r4', 2, '2026-10-15T10:03:00Z')) // another document's pane, not the Report's
    expect(dots(el)).toEqual(['canvas'])
    await ended('judgment', 'report', run('r5', 2, '2026-10-15T10:04:00Z'))
    expect(dots(el)).toEqual(['canvas', 'report'])
  })

  test('the chat strip tells nothing of new comments: no notice above the reply box', async () => {
    const el = await surfaces('nc-strip')
    await ended('important-details', 'report', run('r1', 3, '2026-10-15T10:00:00Z'))
    await ended('important-details', CANVAS, run('r2', 2, '2026-10-15T10:01:00Z'))
    expect(dots(el)).toEqual(['canvas', 'report'])
    expect(el.querySelector('[data-surface="chat"]')!.innerHTML).toBe('')
    expect(document.querySelector('.chat-notice, [data-kind="comments"]')).toBeNull()
  })

  test("opening a surface's Comments pane clears its dot alone, across a reload; a later run marks it again", async () => {
    const el = await surfaces('nc-open')
    await ended('important-details', 'report', run('r1', 3, '2026-10-15T10:00:00Z'))
    await ended('important-details', CANVAS, run('r2', 2, '2026-10-15T10:01:00Z'))
    expect(dots(el)).toEqual(['canvas', 'report'])

    await click(el.querySelector('[data-surface="canvas"] .bctl-comments'))
    expect(document.querySelector('.bcomments')).not.toBeNull()
    expect(dots(el)).toEqual(['report'])
    // a run that ends on the cards while their pane is open is looked at there
    server = server.map((c) => (c.id === 'judgment' ? { ...c, shown: true } : c))
    await ended('judgment', CANVAS, run('r3', 1, '2026-10-15T10:02:00Z'))
    expect(dots(el)).toEqual(['report'])

    await click(el.querySelector('[data-surface="report"] .wu-checks-head .wu-sec-head'))
    expect(dots(el)).toEqual([])

    unmountAll()
    resetSeen() // a reload reads what this browser kept
    const again = await surfaces('nc-open')
    expect(dots(again)).toEqual([])
    await ended('important-details', 'report', run('r4', 1, '2026-10-15T10:05:00Z'))
    expect(dots(again)).toEqual(['report'])
  })

  test('opening one of the new comments on the page is looking at it: the dot goes', async () => {
    const el = await surfaces('nc-look')
    await ended('important-details', 'report', run('r1', 3, '2026-10-15T10:00:00Z'))
    expect(dots(el)).toEqual(['report'])
    const Open = () => {
      useLookedAt('nc-look', 'r1')
      return null
    }
    await mount(<Open />)
    await settle()
    expect(dots(el)).toEqual([])
  })
})
