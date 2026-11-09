// @vitest-environment jsdom
// The report in a narrow pane (src/report/ReportPage.tsx, Margin.tsx): the margin of comment cards docks beside the
// text only while the page holds both, the margin and a column of 40-character lines (shell/dock.tsx useDock,
// report.css `.wu-page > .read-probe`). In a page too narrow for both, the margin stands over the page
// (`.wu-rail.is-over`, which takes no room), so the text column keeps the page's width less its gutters. It then shows
// only the comment a click on its tinted passage opens, and a click elsewhere on the page closes it.
import { act } from 'react'
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import type { Writeup } from '../../src/lib/types'
import { ReportPage } from '../../src/report/ReportPage.tsx'
import { mount, settle, unmountAll } from './mount.tsx'

// the block editor needs a real browser: in its place, each sentence as the editor's decorations mark it, with the
// comments that tint it
vi.mock('../../src/report/Editor', async () => {
  const { createElement } = await import('react')
  type Props = { doc: Writeup; flags: Map<string, { cids: string[] }> }
  return {
    ReportEditor: ({ doc, flags }: Props) =>
      createElement(
        'div',
        { className: 'wu-editor' },
        doc.sections.flatMap((s) => s.paragraphs.flatMap((p) => p.sentences)).map((s) => createElement('span', { key: s.id, 'data-sid': s.id, 'data-cids': flags.get(s.id)?.cids.join(' ') }, s.text)),
      ),
  }
})
vi.mock('../../src/files/Ruler', () => ({ PageRuler: () => null }))

/** the readable minimum each probe stands for (report.css --read-min): the margin's 40 characters plus gutters, the
 * sidebar's 60 */
const RAIL_MIN = 444
const SIDE_MIN = 604
let pageWidth = 0

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  // jsdom lays nothing out: the page is `pageWidth` wide, the report as much more as the ruler takes, and each probe
  // as wide as its minimum
  const own = Element.prototype.getBoundingClientRect
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      if (this.classList.contains('wu-page')) return pageWidth
      if (this.classList.contains('wu-report')) return pageWidth + 43
      return 0
    },
  })
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (!this.parentElement?.classList.contains('read-probe')) return own.call(this)
    const width = this.parentElement.parentElement?.classList.contains('wu-page') ? RAIL_MIN : SIDE_MIN
    return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: 0, width, height: 0, toJSON: () => ({}) } as DOMRect
  }
})

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
beforeEach(() => {
  vi.stubGlobal('fetch', async (url: string) => {
    if (url.endsWith('/canvas')) return json({ cells: [], groups: [] })
    if (url.endsWith('/checks')) return json([])
    return json({})
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

const sentence = (id: string, text: string) => ({ id, text, refs: [], tags: [] })
const comment = (id: string, sid: string, text: string) => ({ id, sentence_id: sid, text, author: 'analyst', ts: '2026-11-09T10:00:00Z', reply: null, status: 'open' })
const DOC = {
  title: 'Kestrel failed less on config B',
  sections: [
    {
      id: 's1',
      heading: '',
      paragraphs: [{ id: 'p1', sentences: [sentence('a1', 'Kestrel is a support agent.'), sentence('a2', 'Config A failed 10 of 24 task runs.'), sentence('a3', 'Config B failed 4 of 24.')] }],
      figures: [],
    },
  ],
  comments: [comment('c1', 'a1', 'Check this against the 10-03 run file.'), comment('c3', 'a3', 'Only four nights ran on config B.')],
} as unknown as Writeup

/** The report on a page `width` wide. */
async function report(width: number) {
  pageWidth = width
  const el = await mount(<ReportPage ws="w-narrow" slug="report" doc={DOC} filter={null} client="t1" onSaved={() => undefined} />)
  await settle()
  return el
}

const shownCards = (el: HTMLElement) => [...el.querySelectorAll('.wu-rail .wu-cm')].map((c) => c.getAttribute('data-comment'))
const click = (node: Element) => act(async () => (node as HTMLElement).click())

test('a page too narrow for the margin keeps the text at its width: the margin stands over it and shows the comment a click opens', async () => {
  // a half-width pane: the page holds the text column or the margin, not both
  const el = await report(499)
  const rail = el.querySelector('.wu-rail')!
  expect(rail.classList.contains('is-over')).toBe(true)
  expect(shownCards(el)).toEqual([])
  // a click on a tinted passage opens its comment over the page; one on another opens that one instead
  await click(el.querySelector('[data-sid="a3"]')!)
  expect(shownCards(el)).toEqual(['c3'])
  await click(el.querySelector('[data-sid="a1"]')!)
  expect(shownCards(el)).toEqual(['c1'])
  // a click in the card keeps it; a click on the page outside the tints closes it
  await click(el.querySelector('.wu-cm .wu-cm-statement')!)
  expect(shownCards(el)).toEqual(['c1'])
  await click(el.querySelector('[data-sid="a2"]')!)
  expect(shownCards(el)).toEqual([])
})

test('a page wide enough for both docks the margin beside the text, with every comment at its passage', async () => {
  const el = await report(1100)
  const rail = el.querySelector('.wu-rail')!
  expect(rail.classList.contains('is-over')).toBe(false)
  expect(shownCards(el)).toEqual(['c1', 'c3'])
})
