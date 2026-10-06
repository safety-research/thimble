// The home panel (hooks/home.ts, /thimble-home): what it lists of a session, in its two layouts, and what a
// click on it does. `claude plugin test mods/thimble-cc-mod`.
import { expect, test } from 'claude-code/testing'

import { lineWidth } from '../hooks/draw'
import { groupCards, homeLayout, homeReduce, homeSections, plainLines } from '../hooks/home'
import type { HomeAct, HomeData, HomeUi } from '../hooks/home'
import { SESSION } from './home-fixture'

const W = 95
const UI: HomeUi = { layout: 'stacked', folded: [], more: [], pick: '' }

function data(): HomeData {
  const byId = new Map(SESSION.cards.map(c => [c.id, c]))
  const groups = SESSION.groups.map(g => ({ ...g, cards: g.cards.flatMap(id => (byId.has(id) ? [byId.get(id)!] : [])) }))
  return { ...SESSION, cardGroups: groupCards(groups, [...SESSION.cards].sort((a, b) => a.created - b.created)) }
}

const text = (ui: Partial<HomeUi> = {}) => plainLines(homeLayout(data(), { ...UI, ...ui }, W).lines)

test('a card stands under the first question that made it; a report or thread reusing it does not list it again', () => {
  const groups = groupCards(
    [
      { head: 'later', from: 'report', cards: [{ id: 'a', kind: 'bar', question: 'A?' }, { id: 'c', kind: 'line', question: 'C?' }], at: 3 },
      { head: 'first', from: 'answer', cards: [{ id: 'a', kind: 'bar', question: 'A?' }], at: 1 },
      { head: 'reuses', from: 'thread', cards: [{ id: 'a', kind: 'bar', question: 'A?' }], at: 2 },
    ],
    [{ id: 'a', kind: 'bar', question: 'A?' }, { id: 'b', kind: 'table', question: 'B?' }, { id: 'c', kind: 'line', question: 'C?' }],
  )
  // newest first, the thread that only reused a card left out, the card no question names last
  expect(groups.map(g => [g.head, g.cards.map(c => c.id).join('')])).toEqual([['later', 'c'], ['first', 'a'], ['cards no answer shows', 'b']])
})

test('the stacked layout: every section under its heading with its count, the first items, and "… N more"', () => {
  const lines = text()
  // the title row: Home and what the panel holds, the layouts against the right edge; then the rule
  expect(lines[0]).toMatch(/^Home {2}2 views · 1 report · 2 threads · 9 cards · 1 label · 4 files +stacked {2}index$/)
  expect(lines[1]).toMatch(/^─+$/)
  // a heading: its name and its count, no marker; what is new after it
  for (const h of ['Views  2', 'Reports  1', 'Side threads  2  1 new', 'Cards  9', 'Labels  1', 'Files  4']) expect(lines.some(l => l.startsWith(h))).toBe(true)
  expect(lines.some(l => /^[▾▸]/.test(l))).toBe(false)
  // an item: its state at A0, its name at A2; a view's state words at the right, without the word its glyph says
  expect(lines.some(l => /^! Wiki Pages +1 problem left, 7 fixed$/.test(l))).toBe(true)
  // a thread with a new answer: its name bold, no count on its row
  const lay = homeLayout(data(), UI, W)
  const relent = lay.lines.find(l => l.map(x => x.s).join('').includes('"Is AgentRelent one agent'))!
  expect(relent.some(x => x.b && x.s.includes('AgentRelent'))).toBe(true)
  expect(lay.lines.filter(l => l.some(x => x.b)).map(l => plainLines([l])[0])).toEqual(['Side threads  2  1 new', relent.map(x => x.s).join('').trimEnd()])
  // a label's legend: each value's ● and its count; a file's records against the right edge under the column name
  expect(lines.some(l => /● test page 29 {2}● links or data 20 {2}● prose 11/.test(l))).toBe(true)
  expect(lines.some(l => /^Files {2}4 +records$/.test(l))).toBe(true)
  expect(lines.some(l => /^● revisions\.jsonl +14,591$/.test(l))).toBe(true)
  // the cards by the question asked, where it was asked in the category column; three questions, then the rest
  expect(lines.some(l => /^ {2}Which wikis did the agents write to/.test(l))).toBe(false)
  expect(lines.some(l => /^ {2}… 3 more$/.test(l))).toBe(true)
  const whole = text({ more: ['cards'] })
  expect(whole.some(l => /^ {2}Which wikis did the agents write to.* main +1 card$/.test(l))).toBe(true)
  // a question's cards at A4, their kind as a word in the category column, no glyph
  expect(whole.some(l => /^ {4}Which wikis did the agents write to.* table$/.test(l))).toBe(true)
  // a folded section keeps its heading alone
  const folded = text({ folded: ['files'] })
  expect(folded.at(-1)).toMatch(/^Files {2}4/)
})

test('the index: every section in two columns, a line an item; the section picked drawn whole under them', () => {
  const lines = text({ layout: 'index' })
  // the second column at A0 + ⌈T/2⌉
  const col = Math.ceil(W / 2)
  expect(lines[2]).toMatch(/^Views {2}2 +Cards {2}9$/)
  expect(lines[2]!.indexOf('Cards')).toBe(col)
  // the glyph says the view is built (with problems left); no word repeats it
  expect(lines.some(l => /^! Wiki Pages(?! +built)/.test(l))).toBe(true)
  expect(lines.filter(l => /^─+$/.test(l)).length).toBe(1)
  const picked = text({ layout: 'index', pick: 'cards' })
  const head = picked.findIndex((l, i) => i > 3 && /^Cards {2}9/.test(l))
  expect(head).toBeGreaterThan(3)
  expect(picked[head - 1]).toBe('')
  // whole: no "more" under the section picked
  expect(picked.slice(head).some(l => /… \d+ more/.test(l))).toBe(false)
})

test('every line fits the panel, in both layouts and at a narrow panel', () => {
  for (const w of [W, 60]) {
    for (const ui of [UI, { ...UI, more: ['cards', 'files'] }, { ...UI, layout: 'index' as const }, { ...UI, layout: 'index' as const, pick: 'labels' }]) {
      const lay = homeLayout(data(), ui, w)
      for (const l of lay.lines) expect(lineWidth(l)).toBeLessThanOrEqual(w)
      for (const h of lay.hits) expect(h.x1).toBeLessThanOrEqual(w)
    }
  }
})

test('no line says how to use the panel', () => {
  for (const ui of [UI, { ...UI, layout: 'index' as const, pick: 'threads' }]) {
    for (const l of plainLines(homeLayout(data(), ui, W).lines)) expect(l).not.toMatch(/\b(click|press|select|type|tap|choose|hover)\b/i)
  }
})

test('a click on an item opens it; one on a heading folds it or, in the index, opens it under the grid', () => {
  const at = (ui: HomeUi, re: RegExp): HomeAct | undefined => {
    const lay = homeLayout(data(), ui, W)
    const y = plainLines(lay.lines).findIndex(l => re.test(l))
    return lay.hits.find(h => h.y === y)?.act
  }
  expect(at(UI, /Wiki Pages/)).toEqual({ op: 'open', open: { kind: 'view', slug: 'wiki-pages', built: true } })
  expect(at(UI, /Usernames Over Time/)).toEqual({ op: 'open', open: { kind: 'view', slug: 'usernames-over-time', built: false } })
  expect(at(UI, /^ {4}What did the maintainer/)).toMatchObject({ op: 'open', open: { kind: 'card' } })
  expect(at(UI, /^● pages\.jsonl/)).toEqual({ op: 'open', open: { kind: 'file', path: 'pages.jsonl' } })
  expect(at(UI, /^● page kind/)).toEqual({ op: 'open', open: { kind: 'label', name: 'page kind' } })
  const fold = at(UI, /^Labels/)!
  expect(fold).toEqual({ op: 'fold', sec: 'labels' })
  expect(homeReduce(UI, fold).folded).toEqual(['labels'])
  expect(homeReduce(homeReduce(UI, fold), fold).folded).toEqual([])
  const pick = at({ ...UI, layout: 'index' }, /^Views/)!
  expect(pick).toEqual({ op: 'pick', sec: 'views' })
  expect(homeReduce({ ...UI, layout: 'index' }, pick).pick).toBe('views')
  // the layouts in the header
  const lay = homeLayout(data(), UI, W)
  expect(lay.hits.filter(h => h.y === 0).map(h => h.act)).toEqual([{ op: 'layout', layout: 'stacked' }, { op: 'layout', layout: 'index' }])
  // the layout shown on the selection background, the other plain
  expect(lay.lines[0]!.filter(x => x.bg).map(x => x.s)).toEqual(['stacked'])
})

test('an empty folder: every section named, with nothing under it but "none"', () => {
  const empty: HomeData = { views: [], reports: [], threads: [], cardGroups: [], labels: [], files: [], coverage: '' }
  expect(homeSections(empty).map(s => s.count)).toEqual([0, 0, 0, 0, 0, 0])
  const lines = plainLines(homeLayout(empty, UI, W).lines)
  expect(lines.filter(l => l === '  none').length).toBe(6)
})

test('the stacked layout shows every thread with new answers, however many, before "… N more"', () => {
  const t = (i: number, unread: number) => ({ id: `t${i}`, title: `"question ${i}?"`, about: 'about the last answer', words: 'answered · 1 question', tone: 'ok', unread, earlier: false, at: i })
  const threads = [t(1, 1), t(2, 0), t(3, 1), t(4, 1), t(5, 0), t(6, 1)]
  const lines = plainLines(homeLayout({ ...data(), threads }, UI, W).lines)
  const at = lines.findIndex(l => l.startsWith('Side threads  6'))
  expect(lines[at]).toBe('Side threads  6  4 new')
  const rows = lines.slice(at + 1).filter(l => /^● /.test(l))
  expect(rows.slice(0, 4).map(l => /"question (\d)\?"/.exec(l)?.[1])).toEqual(['6', '4', '3', '1'])
  expect(lines.slice(at + 1).find(l => /… \d+ more/.test(l))?.trim()).toBe('… 2 more')
})
