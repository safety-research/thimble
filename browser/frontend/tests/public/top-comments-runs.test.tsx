// @vitest-environment jsdom
// The top bar's Comments (src/shell/LabelsSidebar.tsx) shows each check's runs on the documents as the canvas's
// Comments button shows its runs on the cards, with the same parts (src/report/Checks.tsx): on the check's row a spinner
// while it runs, which opens the run, ✕ when it failed, and under the row the passages changed since it checked them,
// with Run; in its detail its Last run, with Stop while it runs and Re-run once it ended. A check's runs on several
// documents name their document, a run on a document that is not written shows nothing, and its runs on the cards stay
// on the canvas's button.
import { act } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { bus } from '../../src/lib/bus.ts'
import { hhmm } from '../../src/lib/time.ts'
import type { CheckRun } from '../../src/lib/types.ts'
import { LabelsSidebar } from '../../src/shell/LabelsSidebar.tsx'
import { mount, unmountAll } from './mount.tsx'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const settle = () => act(async () => new Promise((r) => setTimeout(r, 10)))
const at = (min: number) => `2026-10-15T10:${String(min).padStart(2, '0')}:00Z`
const run = (over: Partial<CheckRun>): CheckRun => ({ run: 'r0', status: 'done', chat: '', started: at(0), ended: at(1), covered: [], seen: [], comments: 0, summary: '', ...over })
const check = (id: string, name: string, shown: boolean, covers: string[], runs: Record<string, CheckRun>) => ({ id, name, prompt: `${name}: look.`, colour: 1, builtin: false, shown, covers, runs, created_by: 'analyst', ts: '', version: 1 })
const written = (...slugs: string[]) => Object.fromEntries(['report', 'slides', 'story', ...slugs].map((s) => [s, { exists: slugs.includes(s), renderer: 'document', name: s === 'report' ? 'Report' : s === 'slides' ? 'Slides' : s }]))

let posts: { url: string; body: unknown }[] = []
let opened: string[] = []
let offs: (() => void)[] = []

/** The server: these checks, these document types, no comment; each POST is kept. */
function serve(checks: unknown[], types: unknown) {
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push({ url: url.replace(/^.*\/ws\/[^/]+/, ''), body: init.body ? JSON.parse(String(init.body)) : null })
      return json(url.endsWith('/stop') ? checks[0] : run({ status: 'running' }), url.endsWith('/stop') ? 200 : 202)
    }
    if (url.endsWith('/investigations/main/types')) return json(types)
    if (url.endsWith('/checks')) return json(checks)
    if (url.includes('/canvas/comments')) return json({ comments: [] })
    if (url.includes('/answer-comments')) return json({ comments: [], running: [] })
    if (url.includes('/concepts')) return json([])
    return json({})
  })
}

beforeEach(() => {
  posts = []
  opened = []
  offs = [bus.on('openChat', (e) => void opened.push(e.chatId))]
  // the popovers and tips the parts show in watch their size
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => {
  offs.forEach((off) => off())
  unmountAll()
  vi.unstubAllGlobals()
})

/** The sidebar open on Comments in workspace `ws` (each test its own, so each reads its own document types). */
async function comments(ws: string) {
  const el = await mount(<LabelsSidebar ws={ws} section="comments" onClose={() => undefined} />)
  await settle()
  return el
}
const row = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(`.lside-row[data-category="${id}"]`)!
const marks = (el: Element) => [...el.querySelectorAll<HTMLButtonElement>('.wu-check-run')].map((b) => b.getAttribute('aria-label'))
const button = (el: Element, text: string) => [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text)!
const click = (el: Element) => act(async () => (el as HTMLButtonElement).click())
async function open(el: HTMLElement, id: string) {
  await click(row(el, id).querySelector('.lside-name')!)
  return el.querySelector<HTMLElement>(`.lside-detail[data-category="${id}"]`)!
}

test("a check's row shows its run on the documents: a spinner that opens the run, ✕ for a failed run, the changed passages with Run; its runs on the cards stay on the canvas's button", async () => {
  serve(
    [
      check('heads', 'Heads up', true, ['documents', 'cards'], { report: run({ run: 'r1', status: 'running', chat: 'c-heads', ended: null }), '@canvas': run({ run: 'r2', status: 'failed', chat: 'c-cards', summary: 'no card' }) }),
      // a summary's own full stop is not doubled before Open its run
      check('calls', 'Judgment calls', true, ['documents'], { report: run({ run: 'r3', status: 'failed', chat: 'c-calls', summary: 'the session ended early.' }) }),
      check('causes', 'Causes', true, ['documents'], { report: run({ run: 'r4', comments: 2, stale: 2 }) }),
    ],
    written('report'),
  )
  const el = await comments('runs-row')
  expect(marks(row(el, 'heads'))).toEqual(['Heads up is running: open its run'])
  expect(marks(row(el, 'calls'))).toEqual(['Judgment calls failed: the session ended early. Open its run'])
  expect(marks(row(el, 'causes'))).toEqual([])

  await click(row(el, 'heads').querySelector('.wu-check-run')!)
  await click(row(el, 'calls').querySelector('.wu-check-run')!)
  expect(opened).toEqual(['c-heads', 'c-calls'])

  const stale = row(el, 'causes').querySelector('.wu-check-stale')!
  expect(stale.textContent).toBe('2 passages changed since checked · Run')
  expect(row(el, 'heads').querySelector('.wu-check-stale')).toBeNull()
  await click(button(stale, 'Run'))
  await settle()
  expect(posts).toEqual([{ url: '/checks/causes/run', body: { doc: 'report' } }])
})

test("a check's detail shows its Last run on the documents, with Stop while it runs and Re-run once it ended", async () => {
  serve(
    [
      check('heads', 'Heads up', true, ['documents'], { report: run({ run: 'r1', status: 'running', chat: 'c-heads', started: at(5), ended: null }) }),
      check('causes', 'Causes', true, ['documents'], { report: run({ run: 'r4', comments: 2, ended: at(7), stale: 1 }) }),
      check('calls', 'Judgment calls', false, ['documents'], { report: run({ run: 'r3', status: 'failed', ended: at(9), summary: 'the session ended early' }) }),
    ],
    written('report'),
  )
  const el = await comments('runs-detail')
  let detail = await open(el, 'heads')
  const line = (d: HTMLElement) => d.querySelector('.lside-run .wu-check-runline-text')?.textContent
  expect(detail.querySelector('.lside-label')?.textContent).toBe('Last run')
  expect(line(detail)).toBe(`Running since ${hhmm(at(5))}`)
  expect(marks(detail)).toEqual(['Heads up is running: open its run'])
  expect(button(detail, 'Re-run')).toBeUndefined()
  await click(button(detail, 'Stop'))
  await settle()
  expect(posts).toEqual([{ url: '/checks/heads/runs/report/stop', body: null }])

  await click(el.querySelector('.lside-back')!)
  detail = await open(el, 'causes')
  expect(line(detail)).toBe(`Ran at ${hhmm(at(7))}, 2 comments`)
  expect(detail.querySelector('.wu-check-stale')?.textContent).toBe('1 passage changed since checked · Run')
  expect(button(detail, 'Stop')).toBeUndefined()
  await click(button(detail, 'Re-run'))
  await settle()
  expect(posts.slice(1)).toEqual([{ url: '/checks/causes/run', body: { doc: 'report' } }])

  // a check that is off says how its last run ended, and runs again once it is turned on
  await click(el.querySelector('.lside-back')!)
  detail = await open(el, 'calls')
  expect(line(detail)).toBe(`Failed at ${hhmm(at(9))}: the session ended early`)
  expect(marks(detail)).toEqual(['Judgment calls failed: the session ended early'])
  expect(button(detail, 'Re-run')).toBeUndefined()
})

test('a run that failed before its session started has no run to open: its ✕ opens the detail, which runs it again', async () => {
  serve([check('calls', 'Judgment calls', true, ['documents'], { report: run({ run: 'r3', status: 'failed', chat: '', summary: 'no free session' }) })], written('report'))
  const el = await comments('runs-nochat')
  await click(row(el, 'calls').querySelector('.wu-check-run')!)
  expect(opened).toEqual([])
  const detail = el.querySelector<HTMLElement>('.lside-detail[data-category="calls"]')!
  expect(detail).not.toBeNull()
  await click(button(detail, 'Re-run'))
  await settle()
  expect(posts).toEqual([{ url: '/checks/calls/run', body: { doc: 'report' } }])
})

test('the runs of a check on several documents name their document; a run on a document that is not written shows nothing', async () => {
  serve(
    [
      check('heads', 'Heads up', true, ['documents'], {
        report: run({ run: 'r1', comments: 3, ended: at(2), stale: 1 }),
        slides: run({ run: 'r2', status: 'running', chat: 'c-slides', started: at(4), ended: null }),
        // a document since deleted
        notes: run({ run: 'r3', status: 'failed', chat: 'c-notes' }),
      }),
    ],
    written('report', 'slides'),
  )
  const el = await comments('runs-docs')
  expect(marks(row(el, 'heads'))).toEqual(['Heads up on Slides is running: open its run'])
  expect([...row(el, 'heads').querySelectorAll('.wu-check-stale')].map((p) => p.textContent)).toEqual(['Report: 1 passage changed since checked · Run'])
  await click(button(row(el, 'heads').querySelector('.wu-check-stale')!, 'Run'))
  await settle()
  expect(posts).toEqual([{ url: '/checks/heads/run', body: { doc: 'report' } }])

  const detail = await open(el, 'heads')
  const lines = [...detail.querySelectorAll<HTMLElement>('.lside-run')].map((r) => [r.dataset.doc, r.querySelector('.lside-run-doc')?.textContent, r.querySelector('.wu-check-runline-text')?.textContent, [...r.querySelectorAll('button')].map((b) => b.textContent)])
  expect(lines).toEqual([
    ['report', 'Report', `Ran at ${hhmm(at(2))}, 3 comments`, ['Re-run']],
    ['slides', 'Slides', `Running since ${hhmm(at(4))}`, ['Stop']],
  ])
})

test('a document written while the list was closed shows its runs when the list opens again', async () => {
  const checks = [check('heads', 'Heads up', true, ['documents'], { report: run({ run: 'r1', comments: 1 }), slides: run({ run: 'r2', status: 'running', chat: 'c-slides', ended: null }) })]
  serve(checks, written('report'))
  await comments('runs-again')
  expect(marks(row(document.body, 'heads'))).toEqual([])
  unmountAll()
  serve(checks, written('report', 'slides'))
  const el = await comments('runs-again')
  expect(marks(row(el, 'heads'))).toEqual(['Heads up on Slides is running: open its run'])
})
