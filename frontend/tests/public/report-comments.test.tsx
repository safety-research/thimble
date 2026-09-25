// @vitest-environment jsdom
// Comments on a document's passages from the browser. The sentence a selection comments on (src/report/selection.ts):
// the one it starts in, else the next one of its block, as at a paragraph's first letter or in the space between two
// sentences, else a heading's own id. The Comment a selection offers where the document shows without its editor (a
// slide, a story's beat, a page's claims; src/report/SelectComment.tsx), which stores the analyst's comment on that
// sentence; a comment on a slide or a beat as a whole tints its lines (src/report/Evidence.tsx docComments). A written
// slide's line, which a click makes a field (src/report/Deck.tsx EditableCell), stays prose for a selection and for a
// click on a tinted sentence. And the name a comment's card shows (src/report/checkComments.ts commentName): its
// check's, Claude for main's note, You for the analyst's own. And the ends of a tint in the editor
// (src/report/decorations.ts tintEdges), which alone round their corners, so a tint over a citation reads as one span.
import { act, createElement as h, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { commentName } from '../../src/report/checkComments.ts'
import { tintEdges } from '../../src/report/decorations.ts'
import { EditableCell } from '../../src/report/Deck.tsx'
import { docComments } from '../../src/report/Evidence.tsx'
import { SelectComment, spotOf } from '../../src/report/SelectComment.tsx'
import { anchorId, sidAt } from '../../src/report/selection.ts'
import { mount, settle, unmountAll } from './mount.tsx'

/** A paragraph block as the editor's decorations mark it: two sentences with the space between them unmarked. */
function paragraph(): HTMLElement {
  const block = document.createElement('div')
  block.setAttribute('data-anchor-cell', '')
  block.setAttribute('data-anchor', 'report:report#p3ee5311d')
  block.innerHTML = '<p class="bn-inline-content"><span data-sid="a1">Alice deleted 27 pages.</span> <span data-sid="a2">She did it in one night.</span> </p>'
  document.body.appendChild(block)
  return block
}

afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

describe('the sentence a selection comments on', () => {
  test('the sentence it starts in, else the next one of its block, else the block\'s last', () => {
    const block = paragraph()
    const p = block.querySelector('p')!
    const [first, gap, second] = [...p.childNodes]
    expect(sidAt(second.firstChild, 4, block)).toBe('a2')
    // at the paragraph's first letter the point is the paragraph's own element, before its first mark
    expect(sidAt(p, 0, block)).toBe('a1')
    expect(sidAt(first.firstChild, 0, block)).toBe('a1')
    // in the space between the two sentences
    expect(sidAt(gap, 1, block)).toBe('a2')
    // after the last sentence, in the trailing space
    expect(sidAt(p.lastChild, 1, block)).toBe('a2')
    // outside the block, or with no block, nothing but the sentence it starts in
    expect(sidAt(gap, 0, null)).toBeNull()
    expect(sidAt(null, 0, block)).toBeNull()
  })

  test("a block with no sentence marked comments on its own id: a heading's, a slide's, never a paragraph's", () => {
    const heading = document.createElement('div')
    heading.setAttribute('data-anchor', 'report:report#d94b449a')
    heading.innerHTML = '<h2>What happened</h2>'
    document.body.appendChild(heading)
    expect(sidAt(heading.querySelector('h2')!.firstChild, 2, heading)).toBe('d94b449a')
    expect(anchorId(heading)).toBe('d94b449a')
    const para = document.createElement('div')
    para.setAttribute('data-anchor', 'report:report#p3ee5311d')
    expect(anchorId(para)).toBeNull()
    const title = document.createElement('div')
    title.setAttribute('data-anchor', 'report:report')
    expect(anchorId(title)).toBeNull()
  })
})

/** A slide as Deck.tsx draws it: the slide's anchor, its heading, and a line of Prose. */
function slide(root: HTMLElement): void {
  root.innerHTML =
    '<div class="wu-slide" data-anchor="report:slides#11e06db3"><span class="wu-slide-title">The orders were identical</span>' +
    '<p class="wu-prose"><span><span class="wu-s" data-anchor="report:slides#869069ba" data-sid="869069ba">Each agent got one order.</span></span></p></div>'
}

function select(node: Node, from: number, to: number): void {
  const range = document.createRange()
  range.setStart(node, from)
  range.setEnd(node, to)
  const sel = document.getSelection()!
  sel.removeAllRanges()
  sel.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
}

describe('Comment on a selection in a slide, a beat or a claim', () => {
  let posted: { url: string; body: unknown }[] = []
  beforeEach(() => {
    posted = []
    vi.stubGlobal('fetch', async (url: unknown, init: RequestInit = {}) => {
      const body = JSON.parse(String(init.body ?? '{}'))
      posted.push({ url: String(url), body })
      return new Response(JSON.stringify({ id: 'c1', sentence_id: body.sentence_id, text: body.text, author: 'analyst', ts: '', status: 'open', reply: null }), { status: 201 })
    })
  })

  test('a selection in a line names that line, and one in the heading the slide\'s first line', () => {
    const root = document.createElement('div')
    document.body.appendChild(root)
    slide(root)
    const line = root.querySelector('[data-sid]')!.firstChild!
    select(line, 0, 4)
    expect(spotOf(document.getSelection(), root)?.sid).toBe('869069ba')
    select(root.querySelector('.wu-slide-title')!.firstChild!, 4, 10)
    expect(spotOf(document.getSelection(), root)?.sid).toBe('869069ba')
    const outside = document.createElement('p')
    outside.textContent = 'elsewhere on the page'
    document.body.appendChild(outside)
    select(outside.firstChild!, 0, 5)
    expect(spotOf(document.getSelection(), root)).toBeNull()
  })

  test('the bar opens the card, and Enter stores the comment on the sentence', async () => {
    const added: string[] = []
    function View() {
      const ref = useRef<HTMLDivElement | null>(null)
      return h('div', null, h('div', { ref, className: 'view' }), h(SelectComment, { ws: 'demo', slug: 'slides', root: ref, onAdded: (c) => added.push(`${c.sentence_id}:${c.text}`) }))
    }
    const el = await mount(h(View))
    const root = el.querySelector<HTMLElement>('.view')!
    slide(root)
    await act(async () => select(root.querySelector('[data-sid]')!.firstChild!, 5, 10))
    const bar = document.querySelector('.wu-selbar')
    expect(bar).not.toBeNull()
    await act(async () => (bar!.querySelector('button') as HTMLButtonElement).click())
    const field = document.querySelector<HTMLTextAreaElement>('.wu-selcard textarea')!
    expect(field).not.toBeNull()
    expect(document.querySelector('.wu-selbar')).toBeNull()
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      set.call(field, 'Which run is this?')
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    await settle()
    expect(posted).toEqual([{ url: '/api/ws/demo/investigations/main/types/slides/comments', body: { sentence_id: '869069ba', text: 'Which run is this?' } }])
    expect(added).toEqual(['869069ba:Which run is this?'])
    expect(document.querySelector('.wu-selcard')).toBeNull()
  })
})

describe('a comment on a slide or a beat as a whole', () => {
  test("tints every line of it, since the deck and the story mark no heading; a line's comment tints that line", () => {
    const deck = {
      renderer: 'slides',
      title: 'Deck',
      slides: [
        { id: 's1', heading: 'One', sentences: [{ id: 'a', text: 'A.', refs: [], tags: [] }, { id: 'b', text: 'B.', refs: [], tags: [] }] },
        { id: 's2', heading: 'Two', sentences: [{ id: 'c', text: 'C.', refs: [], tags: [] }] },
      ],
      comments: [
        { id: 'n1', sentence_id: 's1', text: 'Say when.', author: 'claude', ts: '', status: 'open', reply: null },
        { id: 'n2', sentence_id: 'c', text: 'Which run?', author: 'analyst', ts: '', status: 'open', reply: null },
      ],
    }
    const got = docComments(deck as never).map((c) => [c.id, c.span])
    expect(got).toEqual([
      ['n1', ['a', 'b']],
      ['n2', ['c']],
    ])
  })
})

describe("a comment card's name", () => {
  const look = { name: (id: string | null) => (id === 'unverified' ? 'Unverified' : id ?? 'You') }
  test("its check's, Claude for main's note, You for the analyst's own", () => {
    expect(commentName({ check: 'unverified', author: 'check' }, look)).toBe('Unverified')
    expect(commentName({ check: null, author: 'claude' }, look)).toBe('Claude')
    expect(commentName({ check: null, author: 'analyst' }, look)).toBe('You')
  })
})

describe("a written slide's line", () => {
  test('a selection in it, or a click on a sentence a comment tints, leaves the prose; a click elsewhere or a double click opens the field', async () => {
    const lines = h('p', { className: 'wu-prose' }, h('span', { className: 'wu-s', 'data-sid': 'a', 'data-cids': 'c1' }, 'Alice deleted 27 pages.'), ' ', h('span', { className: 'wu-s', 'data-sid': 'b' }, 'She did it in one night.'))
    const el = await mount(h(EditableCell, { className: 'wu-cell-text', label: 'Lines', text: 'Alice deleted 27 pages.\nShe did it in one night.', onCommit: () => {}, onBlur: () => {}, children: lines }))
    const click = async (target: Element, type = 'click') => act(async () => void target.dispatchEvent(new MouseEvent(type, { bubbles: true })))
    const plain = el.querySelector('[data-sid="b"]')!
    // the click that ends a drag over the words: the selection stays for its Comment
    select(plain.firstChild!, 4, 10)
    await click(plain)
    expect(el.querySelector('textarea')).toBeNull()
    document.getSelection()!.removeAllRanges()
    // a click on the tinted sentence holds its comment's evidence card instead
    await click(el.querySelector('[data-sid="a"]')!)
    expect(el.querySelector('textarea')).toBeNull()
    await click(el.querySelector('[data-sid="a"]')!, 'dblclick')
    expect(el.querySelector('textarea')).not.toBeNull()
  })

  test('a plain click on an untinted line opens the field', async () => {
    const el = await mount(h(EditableCell, { className: 'wu-cell-text', label: 'Lines', text: 'One line.', onCommit: () => {}, onBlur: () => {}, children: h('p', null, h('span', { 'data-sid': 'x' }, 'One line.')) }))
    await act(async () => void el.querySelector('[data-sid="x"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(el.querySelector('textarea')).not.toBeNull()
  })
})

describe("a tint's ends in the editor", () => {
  // `Alice deleted [27] pages.` at 10..33: text to 24, the cited number an atom at 24..25, text to 33, a sentence at 10..33
  const cuts = [10, 24, 25, 33]

  test('a sentence over a cited number is one run: its head ends at the first cut inside it, its tail starts at the last', () => {
    expect(tintEdges([{ from: 10, to: 33, key: 'a' }], cuts)).toEqual([{ head: [10, 24], tail: [25, 33] }])
  })

  test('two sentences and the tinted space between them are one run; a tint drawn otherwise, or apart, is its own', () => {
    const tints = [
      { from: 10, to: 33, key: 'a' },
      { from: 33, to: 34, key: 'a' },
      { from: 34, to: 50, key: 'a' },
      { from: 51, to: 60, key: 'a' },
      { from: 60, to: 70, key: 'b' },
    ]
    expect(tintEdges(tints, [...cuts, 34, 40, 41, 50, 51, 60, 70])).toEqual([
      { head: [10, 24], tail: [41, 50] },
      { head: [51, 60], tail: [51, 60] },
      { head: [60, 70], tail: [60, 70] },
    ])
  })

  test('a run with no cut inside it is its own head and tail', () => {
    expect(tintEdges([{ from: 3, to: 9, key: 'a' }], [0, 3, 9, 12])).toEqual([{ head: [3, 9], tail: [3, 9] }])
    expect(tintEdges([{ from: 3, to: 3, key: 'a' }], [0, 3])).toEqual([])
  })
})
