// @vitest-environment jsdom
// B21: a written document whose slug is `constructor` (SLUG_RE allows it; a document named "Constructor" gets it): the top
// bar alone, and the Report tab alone, with that document listed.
import { act } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { resetSeen } from '../../src/report/newComments.ts'
import { ReportTab } from '../../src/report/ReportTab.tsx'
import { TopBar } from '../../src/shell/TopBar.tsx'
import { mount, unmountAll } from './mount.tsx'

vi.mock('../../src/report/Documents.tsx', async () => {
  const { createElement: h } = await import('react')
  return { DocumentView: ({ slug }: { slug: string }) => h('p', { className: 'mock-view' }, slug) }
})

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const settle = (ms = 10) => act(async () => sleep(ms))
const note = (id: string, sid: string) => ({ id, sentence_id: sid, text: 'Which one?', details: '', author: 'check', ts: '', reply: null, status: 'open', check: 'heads', quote: 'Q' })

let errors: string[] = []
beforeEach(() => {
  window.localStorage.clear()
  resetSeen()
  errors = []
  const types = {
    report: { exists: true, renderer: 'document', name: 'Report' },
    constructor: { exists: true, renderer: 'document', name: 'Constructor' },
  }
  const docs: Record<string, unknown> = { report: { title: 'R', sections: [], comments: [note('m1', 's1')] } }
  docs.constructor = { title: 'C', sections: [], comments: [note('c1', 's1')] }
  vi.stubGlobal('fetch', async (url: string) => {
    const u = String(url)
    if (u.endsWith('/investigations/main/types')) return json(types)
    if (u.endsWith('/frame')) return json({ detail: 'written' }, 404)
    const m = /\/investigations\/main\/types\/([^/?]+)$/.exec(u)
    if (m) {
      await sleep(40)
      return Object.hasOwn(docs, m[1]) ? json(docs[m[1]]) : new Response(null, { status: 204 })
    }
    if (u.endsWith('/checks')) return json([])
    if (u.includes('/canvas/comments')) return json({ comments: [] })
    if (u.includes('/answer-comments')) return json({ comments: [], running: [] })
    if (u.includes('/chats') || u.endsWith('/presets') || u.endsWith('/notices') || u.includes('/concepts')) return json([])
    return json({})
  })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(' ').slice(0, 200)))
})
afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test('the top bar alone stands, with both comments counted', async () => {
  let thrown = ''
  let el: HTMLElement | null = null
  try {
    el = await mount(<TopBar ws="c-top" tabs={[]} onTab={() => undefined} onTabDrag={() => undefined} side={null} onSide={() => undefined} />)
    await settle(150)
  } catch (e) {
    thrown = (e as Error).message
  }
  expect(thrown).toBe('')
  expect(el?.querySelector('.shell-side-btn[data-side="comments"] .shell-side-n')?.textContent).toBe('2')
})

test('the Report tab alone stands', async () => {
  let thrown = ''
  let el: HTMLElement | null = null
  try {
    el = await mount(<ReportTab ws="c-report" active />)
    await settle(150)
  } catch (e) {
    thrown = (e as Error).message
  }
  expect(thrown).toBe('')
  expect(el?.querySelector('.wu-root')).not.toBeNull()
})
