// @vitest-environment jsdom
// The top bar's Comments count and the sidebar it opens read one copy of the documents' comments
// (src/report/docComments.ts), so Done in the sidebar shows in both at once. A read that went out before Done and
// answers after it is dropped, and a document deleted leaves no comments at once, also when it is made again under its
// slug and its first read answers late.
import { act, useState } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { dispatch } from '../../src/lib/events.ts'
import { resetSeen } from '../../src/report/newComments.ts'
import { LabelsSidebar, type SideSection } from '../../src/shell/LabelsSidebar.tsx'
import { TopBar } from '../../src/shell/TopBar.tsx'
import { mount, unmountAll } from './mount.tsx'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const settle = (ms = 10) => act(async () => sleep(ms))
const check = (id: string, name: string) => ({ id, name, prompt: `${name}: look.`, colour: 1, builtin: false, shown: true, covers: ['documents'], runs: {}, created_by: 'analyst', ts: '', version: 1 })
const note = (id: string, sid: string, check: string | null, text: string, quote: string) => ({ id, sentence_id: sid, text, details: '', author: check ? 'check' : 'analyst', ts: '', reply: null, status: 'open', check, quote })
type Note = ReturnType<typeof note>
const doc = (...comments: Note[]) => ({ title: 'T', sections: [], comments })

const REPORT_NOTE = note('m1', 's3', 'heads', 'The rate has no source.', 'Night runs fail twice as often')
const CASE_NOTE = note('k1', 's2', 'heads', 'Run 12 retried; it did not give up.', 'Agent 3 gave up after two tries')
const CASE_MINE = note('k2', 's5', null, 'Say which agent.', 'It stopped')
const MEMO_NOTE = note('f1', 's1', 'calls', 'The reader should weigh this call.', 'We count a retry as a failure')

let types: Record<string, { exists: boolean; renderer: string; name: string }> = {}
let docs: Record<string, ReturnType<typeof doc>> = {}
// a document deleted: its read answers 404
let gone = new Set<string>()
// how long a document's read, or the types' read, takes to answer; each read answers what the server held when it came
let delay: Record<string, number> = {}
let typesDelay = 0

/** The server: the types, the documents in `docs` (204 for one not written), two checks, no comment on the cards or on
 * Claude's answers. Done marks the comment dismissed in its document and answers that document. */
function serve() {
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const u = String(url)
    const m = /\/investigations\/main\/types\/([^/?]+)(?:\/comments\/([^/?]+)\/dismiss)?$/.exec(u)
    if (init?.method === 'POST' && m?.[2]) {
      const d = docs[m[1]]
      d.comments = d.comments.map((c) => (c.id === m[2] ? { ...c, status: 'dismissed' } : c))
      return json(d)
    }
    if (u.endsWith('/investigations/main/types')) {
      const now = JSON.parse(JSON.stringify(types))
      if (typesDelay) await sleep(typesDelay)
      return json(now)
    }
    if (m) {
      const now = docs[m[1]] ? JSON.parse(JSON.stringify(docs[m[1]])) : null
      if (delay[m[1]]) await sleep(delay[m[1]])
      if (now) return json(now)
      return gone.has(m[1]) ? json({ detail: `no ${m[1]}` }, 404) : new Response(null, { status: 204 })
    }
    if (u.endsWith('/checks')) return json([check('heads', 'Heads up'), check('calls', 'Judgment calls')])
    if (u.includes('/canvas/comments')) return json({ comments: [] })
    if (u.includes('/answer-comments')) return json({ comments: [], running: [] })
    if (u.endsWith('/notices')) return json([])
    if (u.includes('/concepts')) return json([])
    return json({})
  })
}

beforeEach(() => {
  window.localStorage.clear()
  resetSeen()
  gone = new Set()
  delay = {}
  typesDelay = 0
  types = {
    report: { exists: true, renderer: 'document', name: 'Report' },
    slides: { exists: false, renderer: 'slides', name: 'Slides' },
    story: { exists: false, renderer: 'story', name: 'Story' },
    'case-file': { exists: true, renderer: 'document', name: 'Case file' },
    'findings-memo': { exists: true, renderer: 'document', name: 'Findings memo' },
  }
  docs = { report: doc(REPORT_NOTE), 'case-file': doc(CASE_NOTE, CASE_MINE), 'findings-memo': doc(MEMO_NOTE) }
  serve()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

/** The shell's top bar, and the sidebar its Comments button opens (shell/Shell.tsx). */
function Shell({ ws }: { ws: string }) {
  const [side, setSide] = useState<SideSection | null>(null)
  return (
    <>
      <TopBar ws={ws} tabs={[]} onTab={() => undefined} onTabDrag={() => undefined} side={side} onSide={setSide} />
      {side && <LabelsSidebar ws={ws} section={side} onClose={() => setSide(null)} />}
    </>
  )
}
async function shell(ws: string) {
  const el = await mount(<Shell ws={ws} />)
  await settle()
  await act(async () => el.querySelector<HTMLButtonElement>('.shell-side-btn[data-side="comments"]')!.click())
  await settle()
  return el
}
const click = (el: Element | null | undefined) => act(async () => (el as HTMLButtonElement).click())
const button = (el: Element, text: string) => [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text)!
async function open(el: HTMLElement, key: string) {
  await click(el.querySelector(`.lside-row[data-category="${key}"] .lside-name`))
  return el.querySelector<HTMLElement>(`.lside-detail[data-category="${key}"]`)!
}
const row = (detail: HTMLElement, where: string) => [...detail.querySelectorAll('.lside-comment')].find((r) => r.querySelector('.lside-comment-where')?.textContent === where)!
const wheres = (detail: HTMLElement) => [...detail.querySelectorAll('.lside-comment')].map((r) => r.querySelector('.lside-comment-where')?.textContent)
/** The top bar's count, and the sidebar's once back on its list. */
async function counts(el: HTMLElement) {
  if (el.querySelector('.lside-back')) await click(el.querySelector('.lside-back'))
  return [el.querySelector('.shell-side-btn[data-side="comments"] .shell-side-n')?.textContent, el.querySelector('.lside-heading .lside-n')?.textContent]
}

test("Done in the sidebar takes the comment out of the top bar's count at once, in the case file as in the report", async () => {
  const el = await shell('shared-done')
  expect(await counts(el)).toEqual(['4', '4'])
  await click(button(row(await open(el, 'heads'), 'Case file'), 'Done'))
  await settle()
  expect(await counts(el)).toEqual(['3', '3'])
  await click(button(row(await open(el, 'heads'), 'Report'), 'Done'))
  await settle()
  expect(await counts(el)).toEqual(['2', '2'])
})

test('a read that went out before Done and answers after it does not bring the resolved comment back', async () => {
  const el = await shell('shared-late-read')
  const detail = await open(el, 'heads')
  // the case file changed: its read goes out now and answers late, with the comment still open
  delay['case-file'] = 80
  await act(async () => dispatch({ type: 'report', slug: 'case-file', status: 'edited' } as never))
  delay['case-file'] = 0
  await click(button(row(detail, 'Case file'), 'Done'))
  await settle(150)
  expect(wheres(el.querySelector<HTMLElement>('.lside-detail[data-category="heads"]')!)).toEqual(['Report'])
  expect(await counts(el)).toEqual(['3', '3'])
})

test("a document deleted leaves no comments at once, and one made again under its slug never shows the old one's", async () => {
  const el = await shell('shared-deleted')
  delete types['case-file']
  delete docs['case-file']
  gone.add('case-file')
  // the types and the deleted document's read answer late: the stream's `deleted` alone takes its comments away
  typesDelay = 60
  delay['case-file'] = 60
  await act(async () => dispatch({ type: 'report', slug: 'case-file', status: 'deleted' } as never))
  await settle()
  expect(await counts(el)).toEqual(['2', '2'])
  await settle(120)
  expect(await counts(el)).toEqual(['2', '2'])
  // made again, with no comment: the types list it at once, its document answers late
  typesDelay = 0
  types['case-file'] = { exists: true, renderer: 'document', name: 'Case file' }
  docs['case-file'] = doc()
  gone.delete('case-file')
  delay['case-file'] = 150
  await act(async () => dispatch({ type: 'report', slug: 'case-file', status: 'created' } as never))
  const seen: (string | null | undefined)[] = []
  for (let i = 0; i < 10; i++) {
    await settle(20)
    seen.push((await counts(el))[0])
  }
  expect(seen).toEqual(Array(10).fill('2'))
})
