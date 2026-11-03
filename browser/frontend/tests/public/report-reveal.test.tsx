// @vitest-environment jsdom
// A teleport into a document (src/report/ReportTab.tsx), as Go to it on a comment in the top bar's Comments makes: the
// document it names comes forward and its passage comes into view, and so does a passage of the document already shown.
import { act } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { teleport } from '../../src/lib/teleport.ts'
import { ReportTab } from '../../src/report/ReportTab.tsx'
import { mount, unmountAll } from './mount.tsx'

// the document views (BlockNote) stand in as one passage per document, with its anchor
vi.mock('../../src/report/Documents.tsx', async () => {
  const { createElement } = await import('react')
  return { DocumentView: ({ slug }: { slug: string }) => createElement('p', null, createElement('span', { 'data-anchor': `report:${slug}#s1` }, slug)) }
})

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const settle = () => act(async () => new Promise((r) => setTimeout(r, 30)))
const TYPES = {
  report: { exists: true, renderer: 'document', name: 'Report' },
  slides: { exists: false, renderer: 'slides', name: 'Slides' },
  story: { exists: false, renderer: 'story', name: 'Story' },
  'case-file': { exists: true, renderer: 'document', name: 'Case file' },
}

let revealed: string[] = []
beforeEach(() => {
  window.localStorage.clear()
  revealed = []
  vi.stubGlobal('fetch', async (url: string) => {
    const u = String(url)
    if (u.endsWith('/investigations/main/types')) return json(TYPES)
    if (u.endsWith('/frame')) return json({ detail: 'written' }, 404)
    const doc = /\/investigations\/main\/types\/([^/?]+)$/.exec(u)
    if (doc) return json({ title: doc[1], sections: [], comments: [] })
    if (u.includes('/chats') || u.endsWith('/presets')) return json([])
    return json({})
  })
  // jsdom lays nothing out: a reveal is the element's scrollIntoView
  Element.prototype.scrollIntoView = function (this: Element) {
    revealed.push(this.getAttribute('data-anchor') ?? '')
  }
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

test('a teleport into the document shown brings its passage into view, and one into another document opens it there', async () => {
  const el = await mount(<ReportTab ws="w-reveal" active />)
  await settle()
  await settle()
  expect(el.querySelector('[data-anchor="report:report#s1"]')).not.toBeNull()

  await act(async () => teleport('report:report#s1'))
  await settle()
  expect(revealed).toEqual(['report:report#s1'])
  expect(el.querySelector('[data-anchor="report:report#s1"]')?.classList.contains('anchor-flash')).toBe(true)

  await act(async () => teleport('report:case-file#s1'))
  await settle()
  await settle()
  expect(el.querySelector('.wu-root')?.getAttribute('data-doc')).toBe('case-file')
  expect(revealed).toEqual(['report:report#s1', 'report:case-file#s1'])
})
