// The home panel (hooks/home.ts, /thimble-home): what it lists of a session, in its one column, and what a click or a
// key on it does. `claude plugin test mods/thimble-cc-mod`.
import { expect, test } from 'claude-code/testing'

import { lineWidth } from '../hooks/draw'
import { HOME_UI_EMPTY, groupCards, homeLayout, homePick, homeReduce, homeSections, plainLines } from '../hooks/home'
import type { HomeAct, HomeData, HomeUi } from '../hooks/home'
import { SESSION } from './home-fixture'

const W = 95
const UI: HomeUi = HOME_UI_EMPTY

function data(): HomeData {
  const byId = new Map(SESSION.cards.map(c => [c.id, c]))
  const groups = SESSION.groups.map(g => ({ ...g, cards: g.cards.flatMap(id => (byId.has(id) ? [byId.get(id)!] : [])) }))
  return { ...SESSION, cardGroups: groupCards(groups, [...SESSION.cards].sort((a, b) => a.created - b.created)), root: 'collusion-wiki' }
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

test('one column: the title Home alone, sections under bold headings with their counts, the key hints last', () => {
  const lay = homeLayout(data(), UI, W)
  const lines = plainLines(lay.lines)
  // the title is Home alone, in the accent and bold; then the rule
  expect(lines[0]).toBe('Home')
  expect(lay.lines[0]!.find(x => x.s === 'Home')).toMatchObject({ fg: 'suggestion', b: true })
  expect(lines[1]).toMatch(/^─+$/)
  // a heading: its name bold, its count dim in parentheses, what is new in green after it
  for (const h of ['Views (2)', 'Reports (1)', 'Threads (2)  1 new', 'Cards (9)', 'Labels (1)', 'Files (4)']) expect(lines.some(l => l.startsWith(h))).toBe(true)
  const head = lay.lines.find(l => l.some(x => x.s === 'Threads'))!
  expect(head.find(x => x.s === 'Threads')!.b).toBe(true)
  expect(head.find(x => x.s === '1 new')!.fg).toBe('success')
  // bold only on the title and the headings: never on an item, even a new one
  expect(lay.lines.filter(l => l.some(x => x.b)).length).toBe(7)
  // an item: its state at A0, its name at A2, its metadata dim against the right edge, without the word its glyph says
  expect(lines.some(l => /^! Wiki Pages +pages\.jsonl · 1 problem left, 7 fixed$/.test(l))).toBe(true)
  // a thread with a new answer: its name regular, `new` in green at the right
  const relent = lay.lines.find(l => l.map(x => x.s).join('').includes('"Is AgentRelent one agent'))!
  expect(relent.some(x => x.b)).toBe(false)
  expect(relent.at(-1)).toMatchObject({ s: 'new', fg: 'success' })
  // a label's legend: each value's ● and its count
  expect(lines.some(l => /● test page 29 {2}● links or data 20 {2}● prose 11/.test(l))).toBe(true)
  // the key hints, dim and italic, the last row
  expect(lines.at(-1)).toBe('↑↓ to choose · Enter to open · Space to fold · x to close')
  expect(lay.lines.at(-1)!.at(-1)).toMatchObject({ i: true })
})

test('card groups say what they hold, the newest open and the others folded, their cards at A2 with their kind at R', () => {
  const lines = text()
  const at = lines.findIndex(l => l.startsWith('Cards (9)'))
  const groups = lines.slice(at + 1).filter(l => /^[▾▸] /.test(l))
  // the newest group is open, the others folded; a group's card count dim at R
  expect(groups[0]).toMatch(/^▾ in the report "Agents filled the dse wiki.* \d+ cards$/)
  expect(groups.slice(1).filter(l => !/collusion-wiki/.test(l)).every(l => l.startsWith('▸ '))).toBe(true)
  expect(groups.some(l => /^▸ in the thread "Is AgentRelent one agent/.test(l))).toBe(true)
  expect(groups.some(l => /^▸ answer to "Use the label tool: a prompt label named 'page kind'.* 2 cards$/.test(l))).toBe(true)
  // the open group's cards at A2, their kind at R
  const open = lines.indexOf(groups[0]!)
  expect(lines[open + 1]).toMatch(/^ {2}\S.* +(bar|line|table|timeline|example|diagram|label)$/)
  // a group is never "… 1 more": it shows whole, or folds
  expect(lines.some(l => /… 1 more/.test(l))).toBe(false)
})

test('the files by folder: a folder row with its file count, records and share read; the first folder open', () => {
  const lines = text()
  expect(lines.some(l => /^Files \(4\) +records +read$/.test(l))).toBe(true)
  expect(lines.some(l => /^▾ collusion-wiki\/ +4 files +\S+ +\S+$/.test(l))).toBe(true)
  // its files' glyphs at A2 and their names at A4, records and share against R
  expect(lines.some(l => /^ {2}● revisions\.jsonl +14,591 +\S+$/.test(l))).toBe(true)
  // folded, only the folder shows
  const folded = text({ folded: ['files:collusion-wiki/'] })
  expect(folded.some(l => /^▸ collusion-wiki\//.test(l))).toBe(true)
  expect(folded.some(l => /● revisions\.jsonl/.test(l))).toBe(false)
})

test('every line fits the panel and its margin, at a wide and a narrow panel', () => {
  for (const w of [W, 60]) {
    for (const ui of [UI, { ...UI, more: ['cards', 'files'] }, { ...UI, unfolded: ['cards:answer:When did the writing happen? Show revisions per day by wiki, and which usernames wrote the most on dse.'] }]) {
      const lay = homeLayout(data(), ui, w)
      for (const l of lay.lines) expect(lineWidth(l)).toBeLessThanOrEqual(w + 2)
      for (const h of lay.hits) expect(h.x1).toBeLessThanOrEqual(w + 2)
    }
  }
})

test('no line but the key hints says how to use the panel', () => {
  for (const l of text().slice(0, -1)) expect(l).not.toMatch(/\b(click|press|select|type|tap|choose|hover)\b/i)
})

test("a click on an item opens it; on a heading its section's panel; on a group or folder it folds", () => {
  const at = (ui: HomeUi, re: RegExp): HomeAct | undefined => {
    const lay = homeLayout(data(), ui, W)
    const y = plainLines(lay.lines).findIndex(l => re.test(l))
    return lay.hits.find(h => h.y === y)?.act
  }
  expect(at(UI, /Wiki Pages/)).toEqual({ op: 'open', open: { kind: 'view', slug: 'wiki-pages', built: true } })
  expect(at(UI, /Usernames Over Time/)).toEqual({ op: 'open', open: { kind: 'view', slug: 'usernames-over-time', built: false } })
  const label = at(UI, /^▸ answer to "Use the label tool/)!
  expect(at(homeReduce(UI, label), /^ {2}How many of 60 sampled/)).toMatchObject({ op: 'open', open: { kind: 'card' } })
  expect(at(UI, /^ {2}● pages\.jsonl/)).toEqual({ op: 'open', open: { kind: 'file', path: 'pages.jsonl' } })
  expect(at(UI, /^● page kind/)).toEqual({ op: 'open', open: { kind: 'label', name: 'page kind' } })
  expect(at(UI, /^Labels/)).toEqual({ op: 'open', open: { kind: 'pane', view: 'labels', title: 'Labels' } })
  expect(at(UI, /^Threads/)).toEqual({ op: 'open', open: { kind: 'pane', view: 'threads', title: 'Threads' } })
  const fold = at(UI, /^▾ in the report/)!
  expect(fold).toMatchObject({ op: 'fold', open: true })
  const folded = homeReduce(UI, fold)
  expect(plainLines(homeLayout(data(), folded, W).lines).some(l => /^▸ in the report/.test(l))).toBe(true)
  const unfold = at(folded, /^▸ in the report/)!
  expect(homeReduce(folded, unfold)).toEqual({ ...UI, folded: [], unfolded: [(unfold as { key: string }).key] })
})

test('the keys choose a row: `❯` and the accent on it, up and down through the rows a click opens', () => {
  const lay = homeLayout(data(), UI, W)
  // the first row is chosen at first
  const first = lay.lines.findIndex(l => l[0]?.s === '❯ ')
  expect(plainLines([lay.lines[first]!])[0]).toMatch(/Usernames Over Time|Wiki Pages/)
  expect(lay.lines[first]![0]!.fg).toBe('suggestion')
  const next = homePick(lay, UI, 'down')
  expect(next).not.toBe(lay.picks[0]!.key)
  expect(homePick(lay, { ...UI, pick: next }, 'up')).toBe(lay.picks[0]!.key)
  const chosen = homeLayout(data(), { ...UI, pick: next }, W)
  expect(chosen.lines.filter(l => l[0]?.s === '❯ ').length).toBe(1)
})

test('an empty folder: every section named, with nothing under it but "none"', () => {
  const empty: HomeData = { views: [], reports: [], threads: [], cardGroups: [], labels: [], files: [], coverage: '' }
  expect(homeSections(empty).map(s => s.count)).toEqual([0, 0, 0, 0, 0, 0])
  const lines = plainLines(homeLayout(empty, UI, W).lines)
  expect(lines.filter(l => l === '  none').length).toBe(6)
})

test('the threads with new answers come first; a section shows its first five, then "… N more"', () => {
  const t = (i: number, unread: number) => ({ id: `t${i}`, title: `"question ${i}?"`, about: 'about the last answer', words: 'answered · 1 question', tone: 'ok', unread, earlier: false, at: i })
  const threads = [t(1, 1), t(2, 0), t(3, 1), t(4, 1), t(5, 0), t(6, 1), t(7, 0), t(8, 0)]
  const lines = plainLines(homeLayout({ ...data(), threads }, UI, W).lines)
  const at = lines.findIndex(l => l.startsWith('Threads (8)'))
  expect(lines[at]).toBe('Threads (8)  4 new')
  const rows = lines.slice(at + 1).filter(l => /^● /.test(l))
  expect(rows.slice(0, 4).map(l => /"question (\d)\?"/.exec(l)?.[1])).toEqual(['6', '4', '3', '1'])
  expect(lines.slice(at + 1).find(l => /… \d+ more/.test(l))?.trim()).toBe('… 3 more')
  const whole = plainLines(homeLayout({ ...data(), threads }, { ...UI, more: ['threads'] }, W).lines)
  expect(whole.slice(at + 1).filter(l => /^● "question/.test(l)).length).toBe(8)
})
