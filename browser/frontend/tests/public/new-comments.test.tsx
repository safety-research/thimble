// @vitest-environment jsdom
// New comments (src/report/newComments.ts): when a check that is on ends a run that left comments, the Comments control
// of the surface they are on carries the accent dot ("New comments"): for the cards the canvas's Comments button
// (canvas/Controls.tsx CommentsButton), for the documents the top bar's Comments (shell/TopBar.tsx) and, for its own
// document's runs, the head of the Comments pane beside the slides, the story or a page (report/Checks.tsx
// CommentsPane). The runs that had ended when this browser first read the workspace's checks are not news; a run is
// looked at once the analyst opens a Comments control it shows on (the canvas's menu, the sidebar on Comments, the
// pane's head), and that holds across a reload. The sidebar the tour opens on Comments, under its example, looks at
// nothing.
import { act, useState } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { CommentsButton } from '../../src/canvas/Controls.tsx'
import { NoticeStrip } from '../../src/chat/Notice.tsx'
import { dispatch } from '../../src/lib/events.ts'
import { setTouring } from '../../src/lib/touring.ts'
import type { Check, CheckRun } from '../../src/lib/types.ts'
import { storageKey } from '../../src/lib/workspace.ts'
import { CommentsPane, useChecks } from '../../src/report/Checks.tsx'
import { CANVAS } from '../../src/report/checkComments.ts'
import { newRuns, resetSeen} from '../../src/report/newComments.ts'
import type { SideSection } from '../../src/shell/LabelsSidebar.tsx'
import { TopBar } from '../../src/shell/TopBar.tsx'
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
  setTouring(false)
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

describe("the dot on each surface's Comments control", () => {
  let server: Check[] = []
  beforeEach(() => {
    server = [check('judgment', false), check('unverified', false), check('important-details', true, { report: run('old', 4, '2026-10-15T09:00:00Z') })]
    vi.stubGlobal('fetch', async (url: string) => {
      const u = String(url)
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } })
      if (u.endsWith('/checks')) return json(server)
      if (u.endsWith('/notices')) return json([])
      if (u.includes('/concepts')) return json([])
      return json({})
    })
    // jsdom has no ResizeObserver, which the Comments button's popover watches its size with
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  })

  /** The canvas's Comments button, holding the workspace's checks as the canvas does, the top bar with its Comments
   * button, which opens the sidebar on Comments, the Comments pane beside the slides, and the chat's notice strip. */
  const Surfaces = ({ ws }: { ws: string }) => {
    const canvas = useChecks(ws)
    const slides = useChecks(ws)
    const [side, setSide] = useState<SideSection | null>(null)
    return (
      <>
        <div data-surface="canvas">
          <CommentsButton ws={ws} checks={canvas} comments={[]} />
        </div>
        <div data-surface="top">
          <TopBar ws={ws} tabs={[]} onTab={() => undefined} onTabDrag={() => undefined} side={side} onSide={setSide} />
        </div>
        <div data-surface="slides">
          <CommentsPane ws={ws} doc="slides" checks={slides} comments={[]} />
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
  const TOP = '[data-surface="top"] .shell-side-btn[data-side="comments"]'
  const SLIDES = '[data-surface="slides"] .wu-checks-head .wu-sec-head'
  /** The surfaces whose Comments control carries the dot named "New comments": the canvas's button for the cards, the
   * top bar's Comments for the documents, the slides' pane's head for the slides. */
  const dots = (el: HTMLElement) => {
    const on: string[] = []
    if (el.querySelector('[data-surface="canvas"] .bctl-comments .dot[aria-label="New comments"]')) on.push('canvas')
    if (el.querySelector(`${TOP} .dot[aria-label="New comments"]`)) on.push('documents')
    if (el.querySelector(`${SLIDES} .dot[aria-label="New comments"]`)) on.push('slides')
    return on
  }
  const click = (el: Element | null | undefined) => act(async () => (el as HTMLButtonElement).click())

  test("what ended before this browser read the checks is no news; a run that ends with comments marks the Comments control of its surface alone", async () => {
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
    await ended('judgment', 'slides', run('r4', 2, '2026-10-15T10:03:00Z'))
    expect(dots(el)).toEqual(['canvas', 'documents', 'slides'])
    const top = el.querySelector(`${TOP} .dot`)!
    expect([top.getAttribute('role'), top.getAttribute('title')]).toEqual(['img', 'New comments'])
  })

  test("opening a surface's Comments control clears its dot alone, across a reload; a later run marks it again", async () => {
    const el = await surfaces('nc-open')
    await ended('important-details', 'report', run('r1', 3, '2026-10-15T10:00:00Z'))
    await ended('important-details', CANVAS, run('r2', 2, '2026-10-15T10:01:00Z'))
    expect(dots(el)).toEqual(['canvas', 'documents'])

    await click(el.querySelector('[data-surface="canvas"] .bctl-comments'))
    expect(document.querySelector('.bcomments')).not.toBeNull()
    expect(dots(el)).toEqual(['documents'])
    // a run that ends on the cards while their menu is open is looked at there
    server = server.map((c) => (c.id === 'judgment' ? { ...c, shown: true } : c))
    await ended('judgment', CANVAS, run('r3', 1, '2026-10-15T10:02:00Z'))
    expect(dots(el)).toEqual(['documents'])

    // the top bar's Comments opens the sidebar on Comments: the documents' new comments are looked at, and so is a run
    // that ends on a document while it stays open
    await click(el.querySelector(TOP))
    expect(el.querySelector(TOP)?.getAttribute('aria-pressed')).toBe('true')
    expect(dots(el)).toEqual([])
    await ended('judgment', 'report', run('r5', 2, '2026-10-15T10:03:00Z'))
    expect(dots(el)).toEqual([])

    unmountAll()
    resetSeen() // a reload reads what this browser kept
    const again = await surfaces('nc-open')
    expect(dots(again)).toEqual([])
    await ended('important-details', 'report', run('r4', 1, '2026-10-15T10:05:00Z'))
    expect(dots(again)).toEqual(['documents'])
    await ended('important-details', CANVAS, run('r6', 1, '2026-10-15T10:06:00Z'))
    expect(dots(again)).toEqual(['canvas', 'documents'])
    // the slides' pane looks at the slides' runs alone: the run on the report is still new in the top bar
    await ended('important-details', 'slides', run('r7', 1, '2026-10-15T10:07:00Z'))
    expect(dots(again)).toEqual(['canvas', 'documents', 'slides'])
    await click(again.querySelector(SLIDES))
    expect(dots(again)).toEqual(['canvas', 'documents'])
  })

  test('the sidebar the tour opens on Comments looks at nothing: the dot stays after the tour and across a reload, until the analyst opens it', async () => {
    const seen = () => JSON.parse(window.localStorage.getItem(storageKey('nc-tour', 'comments-seen')) ?? 'null')
    const el = await surfaces('nc-tour')
    await ended('important-details', 'report', run('r1', 3, '2026-10-15T10:00:00Z'))
    expect(dots(el)).toEqual(['documents'])
    // the tour's Checks step opens the real sidebar with the top bar's Comments (tour/steps.ts holdSide), lays its
    // example over it, and closes it at the step's end
    await act(async () => setTouring(true))
    await click(el.querySelector(TOP))
    expect(el.querySelector(TOP)?.getAttribute('aria-pressed')).toBe('true')
    await click(el.querySelector(TOP))
    await act(async () => setTouring(false))
    expect(dots(el)).toEqual(['documents'])
    expect(seen()).toEqual(['old'])
    unmountAll()
    resetSeen() // a reload reads what this browser kept
    const again = await surfaces('nc-tour')
    expect(dots(again)).toEqual(['documents'])
    // the analyst's own click looks at them
    await click(again.querySelector(TOP))
    expect(dots(again)).toEqual([])
    expect(seen()).toEqual(['r1'])
    // the sidebar the analyst left open on Comments: a run that ends during a tour is looked at once the tour ends
    await act(async () => setTouring(true))
    await ended('important-details', 'report', run('r2', 1, '2026-10-15T10:05:00Z'))
    expect(dots(again)).toEqual(['documents'])
    await act(async () => setTouring(false))
    expect(dots(again)).toEqual([])
  })
})
