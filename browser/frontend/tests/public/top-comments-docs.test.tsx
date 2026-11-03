// @vitest-environment jsdom
// The top bar's Comments lists the open comments of every written document (src/shell/CommentsList.tsx), as it shows
// every document's check runs: a case file's and a document of the analyst's own as the report's. Once more than one
// document has comments, each comment names its document, as the runs on several documents do; the report's own read as
// before. Go to it opens the comment's document at its passage, Done resolves it in that document and Apply names it.
// The top bar's count, the sidebar's counts and the new comments' dot take them in.
import { act, useState } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { bus } from '../../src/lib/bus.ts'
import { dispatch } from '../../src/lib/events.ts'
import type { CheckRun } from '../../src/lib/types.ts'
import { resetSeen } from '../../src/report/newComments.ts'
import { LabelsSidebar, NOTES, type SideSection } from '../../src/shell/LabelsSidebar.tsx'
import { TopBar } from '../../src/shell/TopBar.tsx'
import { mount, unmountAll } from './mount.tsx'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const settle = () => act(async () => new Promise((r) => setTimeout(r, 10)))
const run = (id: string, comments: number, ended: string): CheckRun => ({ run: id, status: 'done', chat: '', started: ended, ended, covered: [], seen: [], comments, summary: '' })
const check = (id: string, name: string, runs: Record<string, CheckRun> = {}) => ({ id, name, prompt: `${name}: look.`, colour: 1, builtin: false, shown: true, covers: ['documents'], runs, created_by: 'analyst', ts: '', version: 1 })
const note = (id: string, sid: string, check: string | null, text: string, quote: string, details = '') => ({ id, sentence_id: sid, text, details, author: check ? 'check' : 'analyst', ts: '', reply: null, status: 'open', check, quote })

/** The workspace's documents: the report, a case file and a document of the analyst's own written, Slides and Story not. */
const TYPES = {
  report: { exists: true, renderer: 'document', name: 'Report' },
  slides: { exists: false, renderer: 'slides', name: 'Slides' },
  story: { exists: false, renderer: 'story', name: 'Story' },
  'case-file': { exists: true, renderer: 'document', name: 'Case file' },
  'findings-memo': { exists: true, renderer: 'document', name: 'Findings memo' },
}
const REPORT_NOTE = note('m1', 's3', 'heads', 'The rate has no source.', 'Night runs fail twice as often')
const CASE_NOTE = note('k1', 's2', 'heads', 'Run 12 retried; it did not give up.', 'Agent 3 gave up after two tries', 'The log shows a third try.')
const CASE_MINE = note('k2', 's5', null, 'Say which agent.', 'It stopped')
const MEMO_NOTE = note('f1', 's1', 'calls', 'The reader should weigh this call.', 'We count a retry as a failure')

let docs: Record<string, { title: string; sections: unknown[]; comments: ReturnType<typeof note>[] }> = {}
let checks: ReturnType<typeof check>[] = []
let posts: string[] = []
let offs: (() => void)[] = []

/** The server: TYPES, the documents in `docs` (a document not there is not written: 204), the checks in `checks`, no
 * comment on the cards or on Claude's answers. A comment's Done marks it dismissed in its document and answers that
 * document. */
function serve() {
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const u = String(url)
    const doc = /\/investigations\/main\/types\/([^/?]+)(?:\/comments\/([^/?]+)\/dismiss)?$/.exec(u)
    if (init?.method === 'POST' && doc?.[2]) {
      posts.push(u.replace(/^.*\/investigations\/main/, ''))
      const d = docs[doc[1]]
      d.comments = d.comments.map((c) => (c.id === doc[2] ? { ...c, status: 'dismissed' } : c))
      return json(d)
    }
    if (u.endsWith('/investigations/main/types')) return json(TYPES)
    if (doc) return docs[doc[1]] ? json(docs[doc[1]]) : new Response(null, { status: 204 })
    if (u.endsWith('/checks')) return json(checks)
    if (u.includes('/canvas/comments')) return json({ comments: [] })
    if (u.includes('/answer-comments')) return json({ comments: [], running: [] })
    if (u.endsWith('/notices')) return json([])
    if (u.includes('/concepts')) return json([])
    return json({})
  })
}

const doc = (...comments: ReturnType<typeof note>[]) => ({ title: 'T', sections: [], comments })

beforeEach(() => {
  window.localStorage.clear()
  resetSeen()
  posts = []
  checks = [check('heads', 'Heads up'), check('calls', 'Judgment calls')]
  docs = { report: doc(REPORT_NOTE, { ...REPORT_NOTE, id: 'm2', status: 'dismissed' }), 'case-file': doc(CASE_NOTE, CASE_MINE), 'findings-memo': doc(MEMO_NOTE) }
  serve()
  // the popovers and tips the sidebar shows watch their size
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => {
  offs.forEach((off) => off())
  offs = []
  unmountAll()
  vi.unstubAllGlobals()
})

/** The sidebar open on Comments in workspace `ws` (each test its own, so each reads its own document types). */
async function comments(ws: string) {
  const el = await mount(<LabelsSidebar ws={ws} section="comments" onClose={() => undefined} />)
  await settle()
  return el
}
const click = (el: Element | null | undefined) => act(async () => (el as HTMLButtonElement).click())
const button = (el: Element, text: string) => [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text)!
async function open(el: HTMLElement, key: string) {
  await click(el.querySelector(`.lside-row[data-category="${key}"] .lside-name`))
  return el.querySelector<HTMLElement>(`.lside-detail[data-category="${key}"]`)!
}
const wheres = (detail: HTMLElement) => [...detail.querySelectorAll('.lside-comment')].map((r) => [r.getAttribute('data-surface'), r.querySelector('.lside-comment-where')?.textContent, r.querySelector('.lside-comment-quote')?.textContent])

test("a case file's comments and those of a document of the analyst's own are listed with their document's name, and Go to it opens that document at the passage", async () => {
  const opened: { ref: string; comment?: string }[] = []
  const tabs: string[] = []
  offs.push(bus.on('openRef', (e) => void opened.push({ ref: e.ref, comment: e.comment })), bus.on('showTab', (e) => void tabs.push(e.tab)))
  const el = await comments('docs-named')
  expect(el.querySelector('.lside-heading')?.textContent).toBe('Comments 4')
  const counts = [...el.querySelectorAll('.lside-row')].map((r) => [r.getAttribute('data-category'), r.querySelector('.lside-name .lside-n')?.textContent])
  expect(counts).toEqual([['heads', '2'], ['calls', '1'], [NOTES, '1']])
  // Show in's Report counts the check's comments in every document
  expect(el.querySelector('.lside-row[data-category="heads"] .lside-chip:last-child')?.textContent).toBe('Report2')

  let detail = await open(el, 'heads')
  expect(wheres(detail)).toEqual([
    ['report', 'Report', '“Night runs fail twice as often”'],
    ['report', 'Case file', '“Agent 3 gave up after two tries”'],
  ])
  await click(button(detail.querySelectorAll('.lside-comment')[1], 'Go to it'))
  expect(opened).toEqual([{ ref: 'report:case-file#s2', comment: 'k1' }])
  expect(tabs).toEqual(['report'])
  // the link that names its document goes there too
  await click(detail.querySelectorAll('.lside-comment-where')[0])
  expect(opened[1]).toEqual({ ref: 'report:report#s3', comment: 'm1' })

  await click(el.querySelector('.lside-back'))
  detail = await open(el, 'calls')
  expect(wheres(detail)).toEqual([['report', 'Findings memo', '“We count a retry as a failure”']])
  await click(el.querySelector('.lside-back'))
  detail = await open(el, NOTES)
  expect(wheres(detail)).toEqual([['report', 'Case file', '“It stopped”']])
})

test("the report's comments read as before while no other document has comments, and name the report once the case file has some", async () => {
  docs = { report: docs.report, 'case-file': doc({ ...CASE_NOTE, status: 'dismissed' }), 'findings-memo': doc() }
  const asked: { chatId: string; send?: string }[] = []
  offs.push(bus.on('openChat', (e) => void asked.push(e)))
  const el = await comments('docs-report-alone')
  expect(el.querySelector('.lside-heading')?.textContent).toBe('Comments 1')
  const detail = await open(el, 'heads')
  expect(wheres(detail)).toEqual([['report', 'the report', '“Night runs fail twice as often”']])
  await click(button(detail, 'Apply'))
  expect(asked).toEqual([{ chatId: 'main', send: 'Apply this comment of the check “Heads up” in the report at “Night runs fail twice as often” (report:report#s3): The rate has no source.' }])

  // a check comments on the case file: the stream says the case file changed
  docs['case-file'] = doc(CASE_NOTE)
  await act(async () => dispatch({ type: 'report', slug: 'case-file', status: 'commented' } as never))
  await settle()
  expect(wheres(el.querySelector<HTMLElement>('.lside-detail[data-category="heads"]')!)).toEqual([
    ['report', 'Report', '“Night runs fail twice as often”'],
    ['report', 'Case file', '“Agent 3 gave up after two tries”'],
  ])
})

test('Done resolves a comment in its own document, and Apply names that document', async () => {
  const asked: { chatId: string; send?: string }[] = []
  offs.push(bus.on('openChat', (e) => void asked.push(e)))
  const el = await comments('docs-done')
  const detail = await open(el, 'heads')
  const caseRow = detail.querySelectorAll('.lside-comment')[1]
  await click(button(caseRow, 'Apply'))
  expect(asked).toEqual([{ chatId: 'main', send: 'Apply this comment of the check “Heads up” in the Case file at “Agent 3 gave up after two tries” (report:case-file#s2): Run 12 retried; it did not give up.\n\nThe log shows a third try.' }])
  await click(button(caseRow, 'Done'))
  await settle()
  expect(posts).toEqual(['/types/case-file/comments/k1/dismiss'])
  // the case file keeps its note, so two documents still have comments
  expect(wheres(el.querySelector<HTMLElement>('.lside-detail[data-category="heads"]')!)).toEqual([['report', 'Report', '“Night runs fail twice as often”']])
  await click(el.querySelector('.lside-back'))
  expect(el.querySelector('.lside-heading')?.textContent).toBe('Comments 3')
})

test("the top bar's Comments counts every document's comments, and a check's run that commented on the case file brings the dot and its comments", async () => {
  checks = [check('heads', 'Heads up', { report: run('r1', 1, '2026-10-15T10:00:00Z') }), check('calls', 'Judgment calls')]
  const Top = ({ ws }: { ws: string }) => {
    const [side, setSide] = useState<SideSection | null>(null)
    return <TopBar ws={ws} tabs={[]} onTab={() => undefined} onTabDrag={() => undefined} side={side} onSide={setSide} />
  }
  const el = await mount(<Top ws="docs-top" />)
  await settle()
  const btn = () => el.querySelector('.shell-side-btn[data-side="comments"]')!
  const dot = () => btn().querySelector('.dot[aria-label="New comments"]')
  expect(btn().querySelector('.shell-side-n')?.textContent).toBe('4')
  expect(dot()).toBeNull()

  // a run of Heads up on the case file ends with two comments: the stream says so, and that the case file changed
  docs['case-file'].comments.push(note('k3', 's7', 'heads', 'The outcome is not cited.', 'The export never ran'), note('k4', 's8', 'heads', 'Which retry?', 'After the retry'))
  checks = checks.map((c) => (c.id === 'heads' ? { ...c, runs: { ...c.runs, 'case-file': run('r2', 2, '2026-10-15T10:05:00Z') } } : c))
  await act(async () => dispatch({ type: 'check', id: 'heads', doc: 'case-file', status: 'done', run: 'r2' } as never))
  await act(async () => dispatch({ type: 'report', slug: 'case-file', status: 'commented' } as never))
  await act(async () => void (await new Promise((res) => setTimeout(res, 250)))) // the checks' list is read again after its debounce
  await settle()
  expect(btn().querySelector('.shell-side-n')?.textContent).toBe('6')
  expect(dot()).not.toBeNull()
})
