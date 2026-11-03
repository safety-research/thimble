// @vitest-environment jsdom
// Go to it from another tab right after a reload (src/report/ReportTab.tsx): the Report tab comes forward for the first
// time, and its views' module (Documents.tsx) loads then, after the teleport. The passage comes into view once the
// document's view has rendered, in the document the tab holds as in another one, and stays in view while the page lays
// out around it (its figures drawn), until the analyst scrolls there (lib/teleport keepInView).
import { act, useEffect, useState } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { mount, unmountAll } from './mount.tsx'

// the views' chunk arrives a while after it is asked for, as over the network, after the document's read; its views
// stand in as one passage per document
vi.mock('../../src/lib/chunkRecovery.ts', async (original) => ({
  ...(await original<typeof import('../../src/lib/chunkRecovery.ts')>()),
  loadChunk: <T,>(load: () => Promise<T>) => new Promise((r) => setTimeout(r, 300)).then(load),
}))
vi.mock('../../src/report/Documents.tsx', async () => {
  const { createElement: h } = await import('react')
  return { DocumentView: ({ slug }: { slug: string }) => h('div', { className: 'page', style: { overflowY: 'auto' } }, h('p', null, h('span', { 'data-anchor': `report:${slug}#s1` }, slug))) }
})

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const settle = (ms = 30) => act(async () => new Promise((r) => setTimeout(r, ms)))
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

/** A page loaded afresh, its views' module not fetched yet: the Report tab behind another tab until a teleport brings it
 * forward (the shell's showTab), and the teleport. */
async function reloaded() {
  vi.resetModules()
  const { bus } = await import('../../src/lib/bus.ts')
  const { teleport } = await import('../../src/lib/teleport.ts')
  const { ReportTab } = await import('../../src/report/ReportTab.tsx')
  function Pane({ ws }: { ws: string }) {
    const [active, setActive] = useState(false)
    useEffect(() => bus.on('showTab', (e) => e.tab === 'report' && setActive(true)), [])
    return <ReportTab ws={ws} active={active} />
  }
  return { Pane, teleport }
}

/** Until the document's view shows the passage `ref`, then a frame more. */
async function rendered(el: HTMLElement, ref: string) {
  for (let i = 0; i < 150 && !el.querySelector(`[data-anchor="${ref}"]`); i++) await settle(20)
  expect(el.querySelector(`[data-anchor="${ref}"]`)).not.toBeNull()
  await settle(50)
}

test('Go to it into the document the tab holds, on its first show after a reload: the passage comes into view once the views load', async () => {
  const { Pane, teleport } = await reloaded()
  const el = await mount(<Pane ws="w-first" />)
  await settle()
  await act(async () => teleport('report:report#s1', { comment: 'm1' }))
  await rendered(el, 'report:report#s1')
  expect(el.querySelector('[data-anchor="report:report#s1"]')?.classList.contains('anchor-flash')).toBe(true)
  expect(revealed).toEqual(['report:report#s1'])
})

test('Go to it into another document, on the first show after a reload: it opens there and the passage comes into view', async () => {
  const { Pane, teleport } = await reloaded()
  const el = await mount(<Pane ws="w-first-other" />)
  await settle()
  await act(async () => teleport('report:case-file#s1', { comment: 'k1' }))
  await rendered(el, 'report:case-file#s1')
  expect(el.querySelector('.wu-root')?.getAttribute('data-doc')).toBe('case-file')
  expect(el.querySelector('[data-anchor="report:case-file#s1"]')?.classList.contains('anchor-flash')).toBe(true)
  expect(revealed).toEqual(['report:case-file#s1'])
})

test('the passage stays in the middle while the page lays out around it, until the analyst scrolls there', async () => {
  // what changes size is told here, as the browser tells a ResizeObserver after a layout
  const observers = new Set<{ cb: () => void }>()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(public cb: () => void) {}
      observe() {
        observers.add(this)
      }
      unobserve() {}
      disconnect() {
        observers.delete(this)
      }
    },
  )
  const laidOut = () => act(async () => observers.forEach((o) => o.cb()))
  const { Pane, teleport } = await reloaded()
  const el = await mount(<Pane ws="w-first-held" />)
  await settle()
  await act(async () => teleport('report:report#s1', { comment: 'm1' }))
  await rendered(el, 'report:report#s1')
  expect(revealed).toEqual(['report:report#s1'])
  // a figure above it drawn: the page grew, and the passage comes back to the middle
  await laidOut()
  expect(revealed).toEqual(['report:report#s1', 'report:report#s1'])
  // the analyst scrolls: the page is theirs from then on
  await act(async () => void el.querySelector('.page')!.dispatchEvent(new WheelEvent('wheel', { bubbles: true })))
  await laidOut()
  expect(revealed).toEqual(['report:report#s1', 'report:report#s1'])
})
