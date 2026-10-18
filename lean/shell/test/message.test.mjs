// The message layer's pure parts: the record and its marks (shell/message.js), the tray's stack (shell/tray.js) and the
// tray's cards (shell/cards.js), drawn through the drawing contract. node --test lean/shell/test/message.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { explainerCard, linksIn, sourceCard } from '../cards.js'
import { blocks, findTerm, glossesOf, inline, linkMarks, newRecord, placeMarks, recordFor, remark, runsText, seriesRef, shownOf, sparkChars, tableOf, verbsOf, withObserver, wrapRuns } from '../message.js'
import { back, base, open, order, push, step, top } from '../tray.js'
import { runProgram } from '../../draw/sandbox-node.mjs'
import { gridText, renderTerm } from '../../draw/term.js'

const TEXT = 'Mostly notes. Of 9,120 saves, [2,310 notes](q2#label=note@n) [~](q3@n) went to other bots, from [880 senders](q4#row=1@n). I read only **1 of 3 files**, so the `fixture scope` and `rebase loop` are guesses.'
const at = (text, m) => text.slice(m.start, m.end)

test('the record holds the cites and sparks Claude wrote, as offsets into its markdown', () => {
  const rec = newRecord({ row: 'r1', session: 's1', text: TEXT })
  assert.equal(rec.v, 1)
  assert.equal(rec.shown, null)
  assert.deepEqual(rec.marks.map(m => m.kind), ['cite', 'spark', 'cite'])
  assert.equal(at(TEXT, rec.marks[0]), '[2,310 notes](q2#label=note@n)')
  assert.equal(rec.marks[0].label, '2,310 notes')
  assert.equal(rec.marks[1].ref, 'q3@n')
  assert.equal(at(TEXT, rec.marks[2]), '[880 senders](q4#row=1@n)')
  assert.deepEqual(rec.verbs, {})
  assert.deepEqual(rec.glosses, {})
})

test('links inside code, and links to the web, are not marks', () => {
  const t = 'See `[a](q1#row=1@n)` and [docs](https://example.org/x) and\n```\n[b](q2)\n```\nand [c](q3#row=2@n).'
  const marks = linkMarks(t)
  assert.equal(marks.length, 1)
  assert.equal(marks[0].label, 'c')
})

test('a gloss is placed where its term first stands outside links; one written as code takes the whole code span', () => {
  const marks = placeMarks(TEXT, { g1: { term: '1 of 3 files' }, g2: { term: 'fixture scope' }, g3: { term: 'no such words' }, g4: { term: 'notes' } })
  const g = marks.filter(m => m.kind === 'gloss')
  assert.deepEqual(g.map(m => m.gloss), ['g4', 'g1', 'g2'])
  // "notes" first stands in "Mostly notes", not inside the link "[2,310 notes](...)"
  assert.equal(g[0].start, TEXT.indexOf('notes'))
  assert.equal(at(TEXT, g[1]), '1 of 3 files')
  assert.equal(at(TEXT, g[2]), '`fixture scope`')
  // marks are in text order and never overlap
  for (let i = 1; i < marks.length; i++) assert.ok(marks[i].start >= marks[i - 1].end)
  assert.equal(findTerm('abc rebase loops', 'rebase loop'), null)
})

test('after the text changes (a squeeze), every mark is placed again on the new text, and sparks keep their values', () => {
  let rec = newRecord({ row: 'r1', session: 's1', text: TEXT })
  rec.marks[1].values = [3, 9, 4]
  rec = withObserver(rec, { verbs: {}, glosses: { g1: { term: 'rebase loop' } } })
  assert.equal(at(TEXT, rec.marks.find(m => m.kind === 'gloss')), '`rebase loop`')
  const squeezed = { ...rec, shown: 'Mostly notes: [2,310](q2#label=note@n) [~](q3@n). A `rebase loop` is a guess.' }
  const next = remark(squeezed)
  const s = shownOf(next)
  assert.equal(s, squeezed.shown)
  assert.deepEqual(next.marks.map(m => [m.kind, at(s, m)]), [['cite', '[2,310](q2#label=note@n)'], ['spark', '[~](q3@n)'], ['gloss', '`rebase loop`']])
  assert.deepEqual(next.marks[1].values, [3, 9, 4])
  // the same words keep the record; other words make a new one that keeps the glosses and verbs
  assert.equal(recordFor(next, { row: 'r1', session: 's1', text: TEXT }), next)
  const other = recordFor(next, { row: 'r1', session: 's1', text: 'A `rebase loop` happened.' })
  assert.equal(other.marks.length, 1)
  assert.equal(other.marks[0].kind, 'gloss')
})

test("the observer's verbs and glosses, as the record keeps them: lit only when given, glosses only for terms in the text", () => {
  const verbs = verbsOf({ v: { note: '2 views ready', proposals: ['steps per run', 'the common path', 'a third'] }, s: { lit: false }, a: { note: 'map 16 runs', minutes: 3, tokens: 60000 }, x: { note: 'not a row verb' } })
  assert.deepEqual(Object.keys(verbs), ['v', 'a'])
  assert.deepEqual(verbs.v.proposals, ['steps per run', 'the common path'])
  assert.deepEqual(verbs.a.offer, { what: 'map 16 runs', minutes: 3, tokens: 60000 })
  const chips = verbsOf({ s: { note: '41 lines', chips: [{ name: 'Length', levels: ['one line', 'short', 'full'], level: 2 }, { name: 'bad', levels: ['one'] }] } })
  assert.deepEqual(chips.s.chips, [{ id: 'length', name: 'Length', levels: ['one line', 'short', 'full'], level: 2 }])
  const g = glossesOf([{ term: 'rebase loop', body: 'An agent rebases again and again.', here: 'Run 7 did it [41 times](q4#run=7@n).', refs: ['q4#run=7@n', 'not a ref'] }, { term: 'absent term' }, { term: 'fixture scope' }], TEXT, ['Fixture  Scope'])
  assert.deepEqual(Object.values(g).map(x => x.term), ['rebase loop'])
  assert.deepEqual(g.g1.refs, ['q4#run=7@n'])
})

test('blocks and inline runs: a mark is one run, bold and code keep their style, and a mark never breaks across lines', () => {
  const t = `${TEXT}\n\n- an item with [a quote](notes.jsonl#L44)\n- plain\n\n| wiki | saves |\n|---|---|\n| alpha | [1,203](q5#wiki=alpha@n) |`
  const bs = blocks(t)
  assert.deepEqual(bs.map(b => b.type), ['para', 'item', 'item', 'table'])
  const marks = placeMarks(t, { g1: { term: '1 of 3 files' } })
  const runs = inline(t, bs[0].from, bs[0].to, marks)
  assert.ok(runs.some(r => r.mark !== undefined && r.s === '1 of 3 files' && r.b))
  assert.ok(runs.some(r => r.code && r.s === 'fixture scope'))
  for (const w of [20, 33, 47]) {
    const lines = wrapRuns(runs, w)
    for (const l of lines) assert.ok([...runsText(l)].length <= w, `${runsText(l)} fits ${w}`)
    const kept = lines.flat().filter(r => r.mark !== undefined).map(r => r.s)
    assert.deepEqual(kept, ['2,310 notes', sparkChars([]), '880 senders', '1 of 3 files'])
  }
  const rows = tableOf(t, bs[3], marks)
  assert.equal(runsText(rows[1][1]), '1,203')
  assert.equal(rows[1][1][0].mark, marks.findIndex(m => m.ref === 'q5#wiki=alpha@n'))
})

test('a sparkline reads its series from 0, never touches the row above, and bins a long series', () => {
  assert.equal(sparkChars([0, 5, 10]), '▁▄▇')
  assert.equal(sparkChars([1546, 870, 132, 322, 558, 500, 5]).length, 7)
  assert.equal(sparkChars(Array.from({ length: 100 }, (_, i) => i)).length, 24)
  assert.deepEqual(seriesRef('q4@n'), { query: 'q4', col: 'n' })
  assert.deepEqual(seriesRef('q4#n'), { query: 'q4', col: 'n' })
  assert.equal(seriesRef('q4#day=2026-06-18@n'), null)
})

test('the tray is a stack: a nested card goes over the one under it, back returns, and back from the first closes', () => {
  const list = order([{ row: 'a', marks: [1, 2] }, { row: 'b', marks: [] }, { row: 'c', marks: [1, 2, 3] }])
  assert.deepEqual(list.map(p => `${p.row}${p.i}`), ['a0', 'a1', 'c0', 'c1', 'c2'])
  // from none: the first mark of the latest message with marks, or the last mark going back
  assert.deepEqual(step(list, null, 1), { row: 'c', i: 0 })
  assert.deepEqual(step(list, null, -1), { row: 'c', i: 2 })
  assert.deepEqual(step(list, { row: 'c', i: 2 }, 1), { row: 'a', i: 0 })
  assert.deepEqual(step(list, { row: 'c', i: 0 }, -1), { row: 'a', i: 1 })
  let t = open({ row: 'c', i: 1 })
  t = push(t, { ref: 'tests/conftest.py#L14', label: 'conftest.py:14', kind: 'cite' })
  t = push(t, { ref: 'tests/conftest.py#L14', label: 'conftest.py:14', kind: 'cite' })
  assert.equal(t.stack.length, 2)
  t = push(t, { ref: 'runs/r17.jsonl#L1812', label: 'step 1,812', kind: 'cite' })
  assert.equal(top(t).label, 'step 1,812')
  assert.deepEqual(base(t), { row: 'c', i: 1 })
  t = back(t)
  assert.equal(top(t).label, 'conftest.py:14')
  t = back(t)
  assert.deepEqual(top(t), { row: 'c', i: 1 })
  assert.equal(back(t), null)
})

const draw = (part, w = 90) => { const d = runProgram(part, { w, h: 9 }); assert.equal(d.error, undefined, JSON.stringify(d.error)); return renderTerm(d, { w }) }

test("a query value's source card: bars of the output around the cited row, its rows, and one from line", () => {
  const query = { id: 'q3', about: 'notes per day', keys: ['day'], inputs: [{ path: 'notes.jsonl' }], table: [['06-16', 1546], ['06-17', 870], ['06-18', 132], ['06-19', 322], ['06-20', 558], ['06-21', 500], ['06-22', 5], ['06-23', 7], ['06-24', 9]].map(([day, n]) => ({ day, n })) }
  const card = sourceCard({ ref: 'q3#day=06-18@n', label: '132 notes', query, resolved: { count: 132, rows: ['notes.jsonl#L1-132'], records: [{ ref: 'notes.jsonl#L40', text: 'user: bot-7, label: note' }] } })
  const g = draw(card.parts[0])
  const text = gridText(g)
  assert.match(text, /06-18 ▆+ +132/)
  assert.match(text, /6 of 9 rows of q3/)
  assert.match(text, /notes\.jsonl#L40 {2}user: bot-7/)
  assert.match(text, /from notes\.jsonl · notes per day · 132 source rows/)
  assert.ok(g.h <= 9)
  assert.equal(card.right, 'cite · notes.jsonl')
})

test('a code citation opens its hunk with the cited line lit; a row citation opens the row', () => {
  const lines = [12, 13, 14, 15, 16].map(n => ({ n, text: n === 14 ? '@pytest.fixture(scope="module")' : `line ${n}` }))
  const code = gridText(draw(sourceCard({ ref: 'tests/conftest.py#L14', label: 'conftest.py:14', lines, resolved: { count: 1, rows: ['tests/conftest.py#L14'], records: [] } }).parts[0]))
  assert.match(code, /14 ▌ @pytest\.fixture\(scope="module"\)/)
  assert.match(code, /tests\/conftest\.py {2}line 14/)
  const row = gridText(draw(sourceCard({ ref: 'notes.jsonl#L4410', label: '"ALERT"', resolved: { count: 1, rows: ['notes.jsonl#L4410'], records: [{ ref: 'notes.jsonl#L4410', text: 'user: watcher, title: ALERT, text: the totals do not match the source' }] } }).parts[0]))
  assert.match(row, /notes\.jsonl#L4410 {2}user: watcher, title: ALERT/)
  // with the kernel's words for it (lean resolve --json): the row reads as its words and who, never as field: value
  const words = gridText(draw(sourceCard({ ref: 'notes.jsonl#L4410', label: '"ALERT"', resolved: { count: 1, rows: ['notes.jsonl#L4410'], records: [{ ref: 'notes.jsonl#L4410', text: 'user: watcher, title: ALERT, text: the totals do not match the source', words: 'the totals do not match the source', meta: 'watcher · ALERT' }] } }).parts[0]))
  assert.match(words, /notes\.jsonl#L4410 {2}the totals do not match the source {2}watcher · ALERT/)
  assert.doesNotMatch(words, /user: watcher/)
  const bad = gridText(draw(sourceCard({ ref: 'q9#row=1@n', label: 'x', resolved: { error: 'no query q9' } }).parts[0]))
  assert.match(bad, /q9#row=1@n does not resolve: no query q9/)
})

test("a gloss's explainer card: what it is, its drawing, where it mattered, each citation a nested mark with its digit", () => {
  const gloss = { term: 'fixture scope', body: 'How long pytest keeps one fixture object. Every test inside that span gets the **same** object.', here: 'In r17, [conftest.py:14](tests/conftest.py#L14) set "module"; the cart turned up at [step 1,812](runs/r17.jsonl#L1812).', program: "return k.beside(k.text('**module** {dim:one cart per file}'), k.text('**default** {dim:a cart per test}'), { gap: 4 })" }
  const card = explainerCard({ gloss })
  assert.deepEqual(card.links.map(l => l.ref), ['tests/conftest.py#L14', 'runs/r17.jsonl#L1812'])
  assert.equal(card.parts.length, 3)
  const text = card.parts.map(p => gridText(draw(p))).join('\n')
  assert.match(text, /gets the same\s+object/)
  assert.match(text, /module one cart per file {4}default a cart per test/)
  assert.match(text, /conftest\.py:14² set "module"; the cart turned up at step 1,812³/)
  // the nested marks are parts of the drawing a press reaches
  const here = draw(card.parts[2])
  assert.deepEqual(here.regions.map(r => r.id).sort(), ['n1', 'n2'])
  assert.deepEqual(linksIn('[a](q1#row=1@n) and [b](https://x.org) and [a again](q1#row=1@n)').map(l => l.ref), ['q1#row=1@n'])
})
