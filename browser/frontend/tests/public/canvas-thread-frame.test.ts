// A side thread's frame on the canvas (src/canvas/layout.ts boardOf, layoutBoard): one that no one has moved stands
// to the right of the card the thread is about, its title level with the card's top, rather than in the column under
// the card, so the column keeps its cards together; two such frames that would overlap stack downward, and a frame the
// analyst moved stays where they put it.
import { describe, expect, test } from 'vitest'
import { boardOf, CARD_W, GAP, HEAD, layoutBoard, moveLocal, overlaps, PAD, removeLocal, ROOT_X, ROOT_Y, TITLE, type Rect } from '../../src/canvas/layout.ts'
import type { CanvasResponse, Cell, Group, Pos } from '../../src/lib/types.ts'

const group = (id: string, extra: Partial<Group> = {}): Group => ({ id, title: id, parent: null, kind: 'sequence', anchor: null, chat: null, role: 'analyst', ...extra })
const thread = (id: string, anchor: string, extra: Partial<Group> = {}) => group(id, { title: `main/${id}`, parent: 'g', anchor, chat: `c-${id}`, ...extra })
const card = (id: string, notebook: string): Cell => ({ id, notebook, kind: 'note', title: id, takeaway: '', created_by: 'user', ts: '', payload: { text: id }, pos: null }) as unknown as Cell
const H = 200
const heights: Record<string, number> = { a: H, b: H, c: H, t1: 100, t2: 100, u1: 100 }

/** Your work holds a, b and c in its column, with the thread frames given. */
function canvas(threads: Group[], cells: Cell[]): CanvasResponse {
  return { groups: [group('g'), ...threads], cells: [card('a', 'g'), card('b', 'g'), card('c', 'g'), ...cells] }
}
const lay = (d: CanvasResponse, open: string[]) => layoutBoard(boardOf(d), new Set(open), heights)
const top = (i: number) => ROOT_Y + HEAD + i * (H + GAP)

/** Every pair of drawn cards and frames that overlap, a frame being taken with its title; a frame holds what is in it. */
function overlapping(d: CanvasResponse, rects: Map<string, Rect>): string[] {
  const parent = new Map<string, string | null>([...d.groups.map((g) => [g.id, g.parent] as const), ...d.cells.map((c) => [c.id, c.notebook] as const)])
  const within = (id: string, of: string): boolean => {
    for (let p = parent.get(id) ?? null; p; p = parent.get(p) ?? null) if (p === of) return true
    return false
  }
  const groups = new Set(d.groups.map((g) => g.id))
  const box = (id: string) => {
    const r = rects.get(id)!
    return groups.has(id) ? { ...r, y: r.y - TITLE, h: r.h + TITLE } : r
  }
  const ids = [...rects.keys()]
  const out: string[] = []
  for (const [i, a] of ids.entries()) for (const b of ids.slice(i + 1)) if (!within(a, b) && !within(b, a) && overlaps(box(a), box(b))) out.push(`${a}/${b}`)
  return out
}

describe("a thread's frame that no one has moved", () => {
  test('stands right of the card it is about, its title level with the card, and the column stays together', () => {
    const d = canvas([thread('t', 'b')], [card('t1', 't'), card('t2', 't')])
    const r = lay(d, ['g', 't']).rects
    const b = r.get('b')!
    expect(r.get('t')).toMatchObject({ x: b.x + CARD_W + GAP, y: b.y + TITLE })
    expect(b.y).toBe(top(1))
    expect(r.get('c')!.y).toBe(top(2))
    // the frame around them grows sideways to hold it
    const g = r.get('g')!
    expect(g.x + g.w).toBe(r.get('t')!.x + r.get('t')!.w + PAD)
    expect(overlapping(d, r)).toEqual([])
  })

  test('two on one card stack downward', () => {
    const d = canvas([thread('t', 'b'), thread('u', 'b')], [card('t1', 't'), card('u1', 'u')])
    const r = lay(d, ['g', 't', 'u']).rects
    const t = r.get('t')!
    const u = r.get('u')!
    expect(u.x).toBe(t.x)
    expect(u.y - TITLE).toBe(t.y + t.h + GAP)
    expect(overlapping(d, r)).toEqual([])
  })

  test('one on the next card that the first would meet moves down past it', () => {
    // t on a holds two cards, taller than a and the gap: u on b goes below it
    const d = canvas([thread('t', 'a'), thread('u', 'b')], [card('t1', 't'), card('t2', 't'), card('u1', 'u')])
    const r = lay(d, ['g', 't', 'u']).rects
    expect(r.get('t')!.y).toBe(top(0) + TITLE)
    expect(r.get('u')!.y - TITLE).toBe(r.get('t')!.y + r.get('t')!.h + GAP)
    expect(overlapping(d, r)).toEqual([])
  })

  test('while collapsed stands beside a collapsed frame\'s first card when it is about it, else under the deck', () => {
    const d = canvas([thread('t', 'a'), thread('u', 'b')], [card('t1', 't'), card('u1', 'u')])
    const r = lay(d, ['t', 'u']).rects
    const a = r.get('a')!
    expect(r.get('t')).toMatchObject({ x: a.x + CARD_W + GAP, y: a.y + TITLE })
    expect(r.has('b')).toBe(false)
    expect(r.get('u')!.x).toBe(ROOT_X + PAD)
    expect(r.get('u')!.y).toBeGreaterThan(a.y + a.h)
    expect(overlapping(d, r)).toEqual([])
  })
})

describe("a thread's frame the analyst moved", () => {
  test('stays where they put it', () => {
    const pos: Pos = { x: 30, y: 900 }
    const d = canvas([thread('t', 'b', { pos })], [card('t1', 't')])
    const r = lay(d, ['g', 't']).rects
    expect(r.get('t')).toMatchObject({ x: ROOT_X + pos.x, y: ROOT_Y + pos.y })
  })

  test('into the column stays at its place there', () => {
    const d = canvas([thread('t', 'a', { order: 2 })], [card('t1', 't')])
    const r = lay(d, ['g', 't']).rects
    expect(r.get('t')).toMatchObject({ x: ROOT_X + PAD, y: top(2) + TITLE })
    expect(r.get('c')!.y).toBeGreaterThan(r.get('t')!.y + r.get('t')!.h)
  })
})

describe("a thread's frame about a loose card", () => {
  // main's single cards stand loose, outside every frame: a thread on one of them keeps its frame beside the card, at
  // the root, as a thread's frame inside a frame does
  const loose = (threads: Group[], cells: Cell[]): CanvasResponse => ({
    groups: [{ ...group('l'), kind: 'loose' }, group('q'), ...threads],
    cells: [card('q1', 'q'), card('a', 'l'), card('b', 'l'), ...cells],
  })
  const on = (id: string, anchor: string) => thread(id, anchor, { parent: 'l' })

  test('stands right of the card, its title level with the card, and the cards below stay in their column', () => {
    const d = loose([on('t', 'a')], [card('t1', 't'), card('t2', 't')])
    const r = lay(d, ['q', 't']).rects
    const a = r.get('a')!
    expect(a.x).toBe(ROOT_X)
    expect(r.get('t')).toMatchObject({ x: a.x + CARD_W + GAP, y: a.y + TITLE })
    expect(r.get('b')!).toMatchObject({ x: ROOT_X, y: a.y + H + GAP })
    expect(overlapping(d, r)).toEqual([])
  })

  test('two that would overlap stack downward', () => {
    const d = loose([on('t', 'a'), on('u', 'b')], [card('t1', 't'), card('t2', 't'), card('u1', 'u')])
    const r = lay(d, ['q', 't', 'u']).rects
    expect(r.get('u')!.x).toBe(r.get('t')!.x)
    expect(r.get('u')!.y - TITLE).toBe(r.get('t')!.y + r.get('t')!.h + GAP)
    expect(overlapping(d, r)).toEqual([])
  })
})

describe('what a thread made, with no frame of its own', () => {
  // no thread gets a group: the card its fork adds stands loose, credited to the thread's chat, and so does a sequence
  // of its cards, in a frame named by the question. What no one has placed stands beside the card the thread is about,
  // as a thread's frame did. The canvas route names each thread's anchor with the cards (`threads`), so the board needs
  // nothing else to put them there
  const by = (id: string, notebook: string, chat: string, extra: Partial<Cell> = {}) => ({ ...card(id, notebook), created_by: `chat:${chat}`, ...extra }) as Cell
  const threads = { th: 'card:a', th2: 'card:q1', th3: 'report:report#p3', th4: 'card:q2' }
  const loose = (cells: Cell[], groups: Group[] = []): CanvasResponse => ({
    groups: [{ ...group('l'), kind: 'loose' }, group('q'), ...groups],
    cells: [card('q1', 'q'), card('a', 'l'), card('b', 'l'), ...cells],
    threads,
  })
  const layAbout = (d: CanvasResponse, open: string[]) => layoutBoard(boardOf(d), new Set(open), heights)

  test("a thread's loose card stands right of the loose card it is about, level with it, and the column stays together", () => {
    const d = loose([by('t1', 'l', 'th')])
    const r = layAbout(d, ['q']).rects
    const a = r.get('a')!
    expect(r.get('t1')).toMatchObject({ x: a.x + CARD_W + GAP, y: a.y })
    expect(r.get('b')!).toMatchObject({ x: ROOT_X, y: a.y + H + GAP })
    expect(overlapping(d, r)).toEqual([])
    // without the thread's anchor it is one more card of the column
    const plain = layoutBoard(boardOf({ ...d, threads: {} }), new Set(['q']), heights).rects
    expect(plain.get('t1')!.x).toBe(ROOT_X)
  })

  test('a move or a delete drawn before the route answers keeps what the thread made beside the card', () => {
    const d = loose([by('t1', 'l', 'th'), card('c', 'q')])
    for (const shown of [moveLocal(d, ['b'], 'q', undefined, null), removeLocal(d, ['c'], [])]) {
      const r = layAbout(shown, ['q']).rects
      const a = r.get('a')!
      expect(r.get('t1')).toMatchObject({ x: a.x + CARD_W + GAP, y: a.y })
    }
  })

  test('a thread on something other than a card, or one the route does not name, leaves its card in the column', () => {
    const d = loose([by('t1', 'l', 'th3'), by('t2', 'l', 'gone')])
    const r = layAbout(d, ['q']).rects
    expect([r.get('t1')!.x, r.get('t2')!.x]).toEqual([ROOT_X, ROOT_X])
    expect(overlapping(d, r)).toEqual([])
  })

  test('about a card a collapsed frame folds away, it stands right of that frame, level with its top, until the frame opens', () => {
    const d = loose([card('q2', 'q'), by('t1', 'l', 'th4')])
    const shut = layAbout(d, []).rects
    const q = shut.get('q')!
    expect(shut.has('q2')).toBe(false)
    expect(shut.get('t1')).toMatchObject({ x: q.x + q.w + GAP, y: q.y })
    expect(overlapping(d, shut)).toEqual([])
    const open = layAbout(d, ['q']).rects
    expect(open.get('t1')).toMatchObject({ x: open.get('q')!.x + open.get('q')!.w + GAP, y: open.get('q2')!.y })
    expect(overlapping(d, open)).toEqual([])
  })

  test('two about one card stack downward', () => {
    const d = loose([by('t1', 'l', 'th'), by('t2', 'l', 'th')])
    const r = layAbout(d, ['q']).rects
    expect(r.get('t2')!.x).toBe(r.get('t1')!.x)
    expect(r.get('t2')!.y).toBe(r.get('t1')!.y + r.get('t1')!.h + GAP)
    expect(overlapping(d, r)).toEqual([])
  })

  test("about a card in a frame, it stands right of the frame, level with the card", () => {
    const d = loose([by('t1', 'l', 'th2')])
    const r = layAbout(d, ['q']).rects
    const q = r.get('q')!
    expect(r.get('t1')).toMatchObject({ x: q.x + q.w + GAP, y: r.get('q1')!.y })
    expect(overlapping(d, r)).toEqual([])
  })

  test("a frame of the thread's cards stands beside the card, its title level with the card's top", () => {
    const d = loose([by('s1', 's', 'th'), by('s2', 's', 'th')], [group('s')])
    const r = layAbout(d, ['q', 's']).rects
    const a = r.get('a')!
    expect(r.get('s')).toMatchObject({ x: a.x + CARD_W + GAP, y: a.y + TITLE })
    expect(overlapping(d, r)).toEqual([])
    // a frame that holds a card of anyone else's stays in the column
    const mixed = loose([by('s1', 's', 'th'), card('s2', 's')], [group('s')])
    expect(layAbout(mixed, ['q', 's']).rects.get('s')!.x).toBe(ROOT_X)
  })

  test('what the analyst placed stays where they put it', () => {
    const pos: Pos = { x: 900, y: 40 }
    const d = loose([by('t1', 'l', 'th', { pos } as Partial<Cell>)])
    expect(layAbout(d, ['q']).rects.get('t1')).toMatchObject(pos)
  })
})
