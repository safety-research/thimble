// @vitest-environment jsdom
// The comments beside the cards (src/canvas/layout.ts commentPlaces, src/canvas/CommentLayer.tsx shownCanvasComments)
// and the Comments pane's rows per surface (src/report/Checks.tsx CheckRows, src/report/checkComments.ts): a comment
// sits right of its card's outermost frame at its card's top, or at its step's row; the comments of one column stack
// without overlapping; a comment hides with its check, its card's frame collapsed or its card filtered out; a check's
// rows show where it comments (the documents, the cards), each with its count on that surface; a tagged comment shows
// its tag, its title and the rest.
import { afterEach, describe, expect, test } from 'vitest'
import { CheckRows, type Checks } from '../../src/report/Checks.tsx'
import { CANVAS, checksFor, coversSurface, knowable, noteParts } from '../../src/report/checkComments.ts'
import { shownCanvasComments } from '../../src/canvas/CommentLayer.tsx'
import { boardOf, COMMENT_GAP_X, COMMENT_GAP_Y, COMMENT_LIFT, commentPlaces, layoutBoard, rootFrameOf } from '../../src/canvas/layout.ts'
import type { CanvasComment, CanvasResponse, Cell, Check, Group } from '../../src/lib/types.ts'
import { mount, unmountAll } from './mount.tsx'

afterEach(unmountAll)

const group = (id: string, over: Partial<Group> = {}): Group => ({ id, title: id, parent: null, kind: 'sequence', anchor: null, chat: null, ...over }) as Group
const cell = (id: string, notebook: string): Cell => ({ id, notebook, kind: 'note', title: id, takeaway: '' }) as unknown as Cell
const comment = (id: string, card: string, over: Partial<CanvasComment> = {}): CanvasComment => ({ id, card, step: null, n: null, ref: `card:${card}`, check: 'ysk', run: 'r1', author: 'check', tag: 'Heads up', title: 'A title', body: 'A sentence.', text: 'Heads up: a title. A sentence.', ts: '', status: 'open', ...over })

// a root frame `g` holding the plan card `p` and a nested frame `n` holding the card `t`, and a loose card `l`
const data = { groups: [group('g'), group('n', { parent: 'g' }), group('loose', { kind: 'loose' })], cells: [cell('p', 'g'), cell('t', 'n'), { ...cell('l', 'loose'), pos: { x: 2000, y: 100 } }] } as unknown as CanvasResponse
const board = boardOf(data)
const heights = { p: 300, t: 200, l: 120 }

describe('where the comments beside the cards sit', () => {
  test("a comment sits right of its card's outermost frame, at the card's top or at its step's row", () => {
    const lay = layoutBoard(board, new Set(['g', 'n']), heights)
    const g = lay.rects.get('g')!
    const p = lay.rects.get('p')!
    const t = lay.rects.get('t')!
    expect(rootFrameOf(board, 't')).toBe('g')
    const places = commentPlaces(board, lay, [
      { id: 'a', card: 'p', dy: COMMENT_LIFT, h: 80 },
      { id: 'b', card: 'p', dy: 180, h: 60 },
      { id: 'c', card: 't', dy: COMMENT_LIFT, h: 60 },
    ])
    const a = places.get('a')!
    expect(a.x).toBe(g.x + g.w + COMMENT_GAP_X)
    expect(a.y).toBe(p.y + COMMENT_LIFT)
    expect([a.ax, a.ay]).toEqual([p.x + p.w, p.y + COMMENT_LIFT])
    expect(places.get('b')!.y).toBe(p.y + 180)
    // the nested card's comment goes beside the outermost frame too, where it points at its own card's edge
    expect(places.get('c')!.x).toBe(a.x)
    expect(places.get('c')!.ax).toBe(t.x + t.w)
  })

  test('the comments of one column stack in the order of their wanted tops, none overlapping', () => {
    const lay = layoutBoard(board, new Set(['g', 'n']), heights)
    const p = lay.rects.get('p')!
    const places = commentPlaces(board, lay, [
      { id: 'low', card: 'p', dy: 40, h: 100 },
      { id: 'top', card: 'p', dy: 14, h: 120 },
      { id: 'third', card: 'p', dy: 60, h: 50 },
    ])
    const top = places.get('top')!
    const low = places.get('low')!
    const third = places.get('third')!
    expect(top.y).toBe(p.y + 14)
    expect(low.y).toBe(top.y + 120 + COMMENT_GAP_Y)
    expect(third.y).toBe(low.y + 100 + COMMENT_GAP_Y)
    expect(low.ay).toBe(p.y + 40)
  })

  test("a loose card's comment sits right of the card itself, and a card that is not drawn gets no place", () => {
    const lay = layoutBoard(board, new Set(['g']), heights)
    const l = lay.rects.get('l')!
    const places = commentPlaces(board, lay, [
      { id: 'loose', card: 'l', dy: COMMENT_LIFT, h: 60 },
      { id: 'hidden', card: 't', dy: COMMENT_LIFT, h: 60 },
    ])
    expect(places.get('loose')!.x).toBe(l.x + l.w + COMMENT_GAP_X)
    // `n` is collapsed and `t` its first card, so it is drawn; a card a collapsed frame hides is not
    const shut = layoutBoard(board, new Set(), heights)
    expect(shut.rects.has('t')).toBe(true)
    const two = boardOf({ ...data, cells: [...data.cells, cell('t2', 'n')] } as unknown as CanvasResponse)
    const lay2 = layoutBoard(two, new Set(['g']), heights)
    expect(commentPlaces(two, lay2, [{ id: 'h', card: 't2', dy: 14, h: 60 }]).has('h')).toBe(false)
  })

  test("a comment hides with its check, its card not drawn or its card filtered out; Claude's own always shows", () => {
    const list = [comment('a', 'p'), comment('b', 'p', { check: 'judgment' }), comment('c', 'gone'), comment('d', 't', { check: null, author: 'claude' }), comment('e', 't')]
    const drawn = (id: string) => id !== 'gone'
    expect(shownCanvasComments(list, new Set(['ysk']), drawn, null).map((c) => c.id)).toEqual(['a', 'd', 'e'])
    expect(shownCanvasComments(list, new Set(['ysk']), drawn, new Set(['p'])).map((c) => c.id)).toEqual(['a'])
    expect(shownCanvasComments(list, new Set(), drawn, null).map((c) => c.id)).toEqual(['d'])
  })
})

describe("a comment's words", () => {
  test('a tagged comment shows its tag, its title and the rest; one with no tag shows its text', () => {
    expect(noteParts(comment('a', 'p'))).toEqual({ tag: 'Heads up', title: 'A title', body: 'A sentence.' })
    expect(noteParts({ text: 'No card shows this.', tag: false })).toEqual({ tag: null, title: null, body: 'No card shows this.' })
    expect(noteParts({ text: 'You should know: x', noteTag: 'You should know', title: null, body: 'x' })).toEqual({ tag: 'You should know', title: null, body: 'x' })
    expect(knowable(comment('a', 'p'))).toBe(true)
    expect(knowable({ tag: true })).toBe(false)
  })
})

const check = (id: string, covers: Check['covers'], over: Partial<Check> = {}): Check => ({ id, name: id, prompt: 'p', colour: 2, shown: true, builtin: true, created_by: 'thimble', ts: '', version: 1, runs: {}, covers, ...over })
const LIST = [check('unverified', ['documents'], { shown: false }), check('ysk', ['documents', 'cards'], { name: 'You should know', runs: { '@canvas': { run: 'r', status: 'done', chat: '', started: '', covered: [], seen: [], comments: 2, summary: '' } } }), check('risks', ['cards'], { name: 'Risks', shown: false })]

describe("the Comments pane's rows", () => {
  test('a check shows where it comments: the documents, the cards or both', () => {
    expect(checksFor(LIST, CANVAS).map((c) => c.id)).toEqual(['ysk', 'risks'])
    expect(checksFor(LIST, 'report').map((c) => c.id)).toEqual(['unverified', 'ysk'])
    expect(coversSurface({ covers: undefined }, 'report')).toBe(true)
    expect(coversSurface({ covers: undefined }, CANVAS)).toBe(false)
  })

  test("on the canvas each row counts the check's open comments on the cards, and its square switches it", async () => {
    const toggled: string[] = []
    const checks: Checks = { list: LIST, on: new Set(['ysk']), look: { colour: () => '', name: (id) => id ?? '', rank: () => 0 }, toggle: (id) => void toggled.push(id), create: async () => true, editPrompt: async () => true }
    const el = await mount(<CheckRows ws="w" surface={CANVAS} checks={checks} comments={[comment('a', 'p'), comment('b', 'p'), comment('c', 't', { check: null })]} adding={null} onAdding={() => {}} />)
    const rows = [...el.querySelectorAll<HTMLElement>('.wu-check')]
    expect(rows.map((r) => r.dataset.check)).toEqual(['ysk', 'risks'])
    expect(rows[0].querySelector('.wu-check-name')!.textContent).toBe('You should know')
    expect(rows[0].querySelector('.wu-count')!.textContent).toBe('2')
    expect(rows[0].querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('true')
    expect(rows[1].querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('false')
    expect(rows[1].querySelector('.wu-count')!.textContent).toBe('–')
    rows[1].querySelector<HTMLElement>('[role="switch"]')!.click()
    expect(toggled).toEqual(['risks'])
  })
})
