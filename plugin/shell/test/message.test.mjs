// The message layer's pure parts: the record and its marks (shell/message.js), the tray's stack (shell/tray.js) and the
// tray's cards (shell/cards.js), drawn through the drawing contract. node --test plugin/shell/test/message.test.mjs
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { citeCard, citeWords, drawnCard, drawsHyperlinks, explainerCard, fileLink, linksIn, placeOf, sourceCard } from '../cards.js'
import { askedRow, engagedText, openedRow } from '../engaged.js'
import { anchorTerm, blocks, findInLink, findTerm, glossesOf, headsOf, inline, lineOf, linkMarks, marksIn, newRecord, plainWords, placeMarks, recordFor, remark, runsText, seriesRef, shownOf, sparkChars, stemOf, tableOf, verbsOf, withObserver, wrapRuns } from '../message.js'
import { back, base, open, order, push, step, top } from '../tray.js'
import { citeRef } from '../object.js'
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
  const verbs = verbsOf({ v: { note: '2 views ready', proposals: ['steps per run', 'the common path', 'a third'] }, s: { lit: false }, c: { note: 'not a row verb now' }, a: { note: 'not a row verb now' }, x: { note: 'not a row verb' } })
  assert.deepEqual(Object.keys(verbs), ['v'])
  assert.deepEqual(verbs.v.proposals, ['steps per run', 'the common path'])
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
  assert.deepEqual(seriesRef('r4@n'), { query: 'r4', col: 'n' })
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

const draw = (part, w = 90, h = 9) => { const d = runProgram(part, { w, h }); assert.equal(d.error, undefined, JSON.stringify(d.error)); return renderTerm(d, { w }) }

// One rule for every citation: its card opens on the most readable form of what it points to; the rows behind it, its
// code, or a record as the file holds it are sections a key away in the same panel, never shown first.
const sectionText = (card, id) => card.sections.find(x => x.id === id).parts.map(p => gridText(draw(p, 90, 20))).join('\n')

test("a number from a query opens as the query's output table, its row and cell marked, and no lines about where it comes from; the rows and the code are sections", () => {
  const query = { id: 'q3', about: 'notes per day', keys: ['day'], code: 'df = load("notes.jsonl")\ntally(df, "day")\n', lineage: 'exact', inputs: [{ path: 'notes.jsonl', rows_read: 9120 }], table: [['06-16', 1546], ['06-17', 870], ['06-18', 132], ['06-19', 322], ['06-20', 558], ['06-21', 500], ['06-22', 5], ['06-23', 7], ['06-24', 9]].map(([day, n]) => ({ day, n })) }
  const resolved = { count: 132, rows: ['notes.jsonl#L1-132'], chain: [{ step: 'query', id: 'q3', about: 'notes per day' }], records: [{ ref: 'notes.jsonl#L40', text: 'user: bot-7, label: note', words: 'the totals do not match', meta: 'bot-7 · note' }] }
  const card = sourceCard({ ref: 'q3#day=06-18@n', label: '132 notes', query, resolved })
  const g = draw(card.parts[0])
  const text = gridText(g)
  assert.match(text, /notes per day/)
  assert.match(text, /day +n/, 'the table has its header')
  assert.match(text, /▌ +06-18 +132/, 'the cited row is marked')
  assert.match(text, / {2}06-17 +870/)
  // where the value comes from is the code section's: no "rows behind it", no "rows 1–9 of 9" on the card
  assert.doesNotMatch(text, /behind it|rows \d+–\d+ of/)
  assert.doesNotMatch(text, /tally|notes\.jsonl#L40/, 'neither the code nor the rows show first')
  assert.ok(g.h <= 9)
  // the cited cell is lit: the accent, in bold
  const cell = g.rows.flatMap(r => r).filter(c => c.tone === 'accent' && c.b).map(c => c.ch).join('')
  assert.equal(cell, '132')
  assert.equal(card.right, 'cite · notes.jsonl')
  assert.deepEqual(card.sections.map(x => [x.id, x.key, x.words]), [['rows', 'r', 'rows'], ['code', 'c', 'code']])
  // the rows behind the cell as words, with who and where
  const rows = sectionText(card, 'rows')
  assert.match(rows, /132 rows of notes\.jsonl behind this value · 1 spread across them/)
  assert.match(rows, /notes\.jsonl#L40 {2}the totals do not match {2}bot-7 · note/)
  // the query's code, its lines numbered, then where the value comes from
  const code = sectionText(card, 'code')
  assert.match(code, /q3 · notes per day/)
  assert.match(code, /1 {2}df = load\("notes\.jsonl"\)\n2 {2}tally\(df, "day"\)/)
  assert.match(code, /reads notes\.jsonl \(9,120 rows\)/)
  assert.match(code, /ref q3#day=06-18@n ← 132 source rows · lineage exact/)
})

test('a query whose output is one value opens as the value and one line on what it counts', () => {
  const query = { id: 'q5', about: 'saves in all', keys: [], table: [{ value: 14591 }], code: 'len(load("edits.jsonl"))' }
  const card = sourceCard({ ref: 'q5#row=1@value', label: '14,591 saves', query, resolved: { count: 14591, rows: ['edits.jsonl#L1-14591'], records: [], chain: [{ step: 'query', id: 'q5', value: 14591 }] } })
  const text = gridText(draw(card.parts[0]))
  assert.match(text, /^14,591\nq5 · saves in all$/)
  assert.deepEqual(card.sections.map(x => x.key), ['r', 'c'])
})

test('a sparkline opens as its series, a small table when it is short and a plot when it is long', () => {
  const short = { id: 'q3', about: 'notes per day', keys: ['day'], table: [{ day: '06-16', n: 4 }, { day: '06-17', n: 9 }] }
  const card = sourceCard({ ref: 'q3@n', label: 'sparkline', query: short, resolved: { count: 13, rows: ['notes.jsonl#L1-13'], records: [] } })
  assert.match(gridText(draw(card.parts[0])), /notes per day\n06-16 ▆+ +4\n06-17 ▆+ +9$/)
  const long = { ...short, table: Array.from({ length: 30 }, (_, i) => ({ day: `d${i}`, n: i * i })) }
  const plot = gridText(draw(sourceCard({ ref: 'q3@n', label: 'sparkline', query: long, resolved: { count: 9, rows: [], records: [] } }).parts[0]))
  assert.match(plot, /^notes per day · 30 values of n\n/)
  assert.match(plot, /d0 +d14 +d29/)
  assert.deepEqual(card.sections.map(x => x.id), ['rows', 'code'])
})

test('a quote opens the cited span of its file: the rows around it, the quoted words marked in the field that holds them; the record as the file holds it is a section', () => {
  const span = {
    path: 'notes.jsonl', file: '/data/notes.jsonl', kind: 'jsonl', unit: 'line', cited: 1, raw: '{\n "user": "watcher",\n "summary": "PRECISION ALERT: totals off"\n}',
    rows: [
      { ref: 'notes.jsonl#L4409', n: 4409, hot: false, text: 'an earlier note', meta: 'bot-7' },
      { ref: 'notes.jsonl#L4410', n: 4410, hot: true, text: 'PRECISION ALERT: totals off', at: [0, 15], field: 'summary', meta: 'watcher · ALERT' },
      { ref: 'notes.jsonl#L4411', n: 4411, hot: false, text: 'a later note' },
    ],
  }
  const card = sourceCard({ ref: 'notes.jsonl#L4410', label: '"PRECISION ALERT"', resolved: { count: 1, rows: ['notes.jsonl#L4410'], records: [], span } })
  const g = draw(card.parts[0])
  assert.equal(gridText(g), [
    '4409   an earlier note  bot-7',
    '4410 ▌ summary: PRECISION ALERT: totals off',
    '       watcher · ALERT',
    '4411   a later note',
  ].join('\n'))
  // the quoted words, and only they, are lit
  assert.equal(g.rows.flatMap(r => r).filter(c => c.tone === 'accent' && c.b).map(c => c.ch).join(''), 'PRECISION ALERT')
  assert.deepEqual(card.sections.map(x => [x.id, x.key, x.words]), [['raw', 'c', 'raw']])
  // the field the citation quotes is marked, and stays in view however long the record is
  assert.match(sectionText(card, 'raw'), /notes\.jsonl:4410, as the file holds it\n \{\n  "user": "watcher",\n▌ "summary": "PRECISION ALERT: totals off"\n \}/)
  const long = { ...span, raw: ['{', ...Array.from({ length: 30 }, (_, i) => ` "f${i}": ${i},`), ' "summary": "PRECISION ALERT: totals off"', '}'].join('\n') }
  const far = sectionText(sourceCard({ ref: 'notes.jsonl#L4410', label: '"PRECISION ALERT"', resolved: { count: 1, rows: [], records: [], span: long } }), 'raw')
  assert.match(far, /"f7": 7,\n… 22 lines\n▌ "summary": "PRECISION ALERT: totals off"\n \}$/)
})

test('a line of a code file opens its lines with the cited one marked, and needs no section; a row the kernel has no span for reads as words', () => {
  const lines = [12, 13, 14, 15, 16].map(n => ({ n, text: n === 14 ? '@pytest.fixture(scope="module")' : `line ${n}` }))
  const card = sourceCard({ ref: 'tests/conftest.py#L14', label: 'conftest.py:14', lines, resolved: { count: 1, rows: ['tests/conftest.py#L14'], records: [] } })
  const code = gridText(draw(card.parts[0]))
  assert.match(code, /13 {3}line 13\n14 ▌ @pytest\.fixture\(scope="module"\)\n15 {3}line 15/)
  assert.deepEqual(card.sections, [])
  // the kernel's words for a row (thimble resolve --json): its words and who, never field: value
  const words = gridText(draw(sourceCard({ ref: 'notes.jsonl', label: '"ALERT"', resolved: { count: 1, rows: ['notes.jsonl#L4410'], records: [{ ref: 'notes.jsonl#L4410', text: 'user: watcher, title: ALERT, text: the totals do not match the source', words: 'the totals do not match the source', meta: 'watcher · ALERT' }] } }).parts[0]))
  assert.match(words, /notes\.jsonl#L4410 {2}the totals do not match the source {2}watcher · ALERT/)
  assert.doesNotMatch(words, /user: watcher/)
  const bad = gridText(draw(sourceCard({ ref: 'q9#row=1@n', label: 'x', resolved: { error: 'no query q9' } }).parts[0]))
  assert.match(bad, /q9#row=1@n does not resolve: no query q9/)
})

test('a value of a card opens the card itself, its part that holds the value marked, with the value; the rows behind it are a section', () => {
  const object = { id: '03-saves', title: 'Saves per day', program: "return k.stack(data.days.map(d => k.region('day-' + d.day, { ref: d._ref }, k.text(d.day + ' ' + d.n))))", data: { days: [{ day: '06-17', n: 870, _ref: 'q1#day=06-17' }, { day: '06-18', n: 132, _ref: 'q1#day=06-18' }] } }
  const resolved = { count: 132, rows: ['notes.jsonl#L1-132'], records: [], chain: [{ step: 'object', id: '03-saves', title: 'Saves per day', at: '/days/1/n', value: 132, marks: ['obj:03-saves#/days/1/n', 'obj:03-saves#/days/1', 'q1#day=06-18'] }] }
  const card = sourceCard({ ref: 'obj:saves#/days/1/n', label: '132', resolved, object })
  assert.equal(card.parts[0].program, object.program)
  assert.equal(card.parts[0].id, '03-saves')
  assert.deepEqual(card.mark, ['obj:03-saves#/days/1/n', 'obj:03-saves#/days/1', 'q1#day=06-18'])
  assert.match(gridText(draw(card.parts[1])), /^value 132 at \/days\/1\/n$/)
  assert.equal(card.right, 'cite · Saves per day')
  assert.deepEqual(card.sections.map(x => x.id), ['rows', 'code'])
})

test('a citation of a file links to it as Claude Code links a file in a reply: the absolute path as a file: URL, the line its fragment', () => {
  assert.deepEqual(fileLink('revisions.jsonl#L4410', '/data/wiki'), { href: 'file:///data/wiki/revisions.jsonl#L4410', label: 'revisions.jsonl:4410', path: '/data/wiki/revisions.jsonl' })
  assert.equal(fileLink('runs/a b.jsonl#L3-L5', '/d').href, 'file:///d/runs/a%20b.jsonl#L3')
  assert.equal(fileLink('runs/a b.jsonl#L3-L5', '/d').label, 'runs/a b.jsonl:3-5')
  assert.equal(fileLink('/abs/notes.md#L2', null).href, 'file:///abs/notes.md#L2')
  assert.equal(placeOf('runs.csv#row=3'), 'runs.csv row 3')
  assert.equal(placeOf('a.jsonl#L44.b1'), 'a.jsonl:44')
  for (const ref of ['q1#day=2026-06-18@n', 'q3@n', 'obj:x#/a/1', 'https://example.org/x']) assert.equal(fileLink(ref, '/d'), null, ref)
})

test('a card is drawn with its sections at once; a section that fails says so in its place, and a part that fails stops the card in one line', async () => {
  const spec = { title: 't', right: 'cite', parts: [{ program: 'a' }], sections: [{ id: 'rows', key: 'r', words: 'rows', parts: [{ program: 'b' }] }, { id: 'code', key: 'c', words: 'code', parts: [{ program: 'bad' }] }], mark: ['q1'], links: [] }
  const draw1 = async p => { if (p.program === 'bad') throw new Error('no node'); return { root: { t: 'text' }, id: p.program } }
  const got = await drawnCard(spec, draw1)
  assert.deepEqual(got.drawings.map(d => d.id), ['a'])
  assert.deepEqual(got.sections.map(s => [s.id, s.key, s.words, s.drawings.length, s.problem || '']), [['rows', 'r', 'rows', 1, ''], ['code', 'c', 'code', 0, 'the card could not be drawn: no node']])
  assert.deepEqual(got.mark, ['q1'])
  const failed = await drawnCard({ ...spec, parts: [{ program: 'bad' }] }, draw1)
  assert.equal(failed.problem, 'the card could not be drawn: no node')
})

test("a gloss's explainer card: what it is, its drawing, where it mattered, each citation a nested mark as a citation looks in the answer", () => {
  const gloss = { term: 'fixture scope', body: 'How long pytest keeps one fixture object. Every test inside that span gets the **same** object.', here: 'In r17, [conftest.py:14](tests/conftest.py#L14) set "module"; the cart turned up at [step 1,812](runs/r17.jsonl#L1812).', program: "return k.beside(k.text('**module** {dim:one cart per file}'), k.text('**default** {dim:a cart per test}'), { gap: 4 })" }
  const card = explainerCard({ gloss })
  assert.deepEqual(card.links.map(l => l.ref), ['tests/conftest.py#L14', 'runs/r17.jsonl#L1812'])
  assert.equal(card.parts.length, 3)
  const text = card.parts.map(p => gridText(draw(p))).join('\n')
  assert.match(text, /gets the same\s+object/)
  assert.match(text, /module one cart per file {4}default a cart per test/)
  assert.match(text, /conftest\.py:14 set "module"; the cart turned up at step 1,812\./)
  // no digits: the words are the citation, in the cite tone and underlined, as in the answer
  assert.doesNotMatch(text, /[²³⁴]/)
  assert.ok(draw(card.parts[2]).regions.length === 2)
  assert.deepEqual([...new Set(draw(card.parts[2]).rows.flat().filter(c => c.ref).map(c => c.tone))], ['cite'])
  // the nested marks are parts of the drawing a press reaches
  const here = draw(card.parts[2])
  assert.deepEqual(here.regions.map(r => r.id).sort(), ['n1', 'n2'])
  assert.deepEqual(linksIn('[a](q1#row=1@n) and [b](https://x.org) and [a again](q1#row=1@n)').map(l => l.ref), ['q1#row=1@n'])
})

test('a citation whose key holds spaces and brackets is one mark, and its card opens the row behind the value it shows', () => {
  // Claude copied the key's words into the ref: still one link, nothing of it spills into the prose
  const text = 'Clean wins took a median of [110](q11#outcome=won (clean ep)@median) calls; all runs [4 failed](q11).'
  const marks = linkMarks(text)
  assert.deepEqual(marks.map(m => [m.ref, m.label]), [['q11#outcome=won (clean ep)@median', '110'], ['q11', '4 failed']])
  assert.equal(text.slice(marks[0].end), ' calls; all runs [4 failed](q11).')
  assert.deepEqual(linkMarks('a median of [110](r11#outcome=won (clean ep)@median) calls').map(m => m.ref), ['r11#outcome=won (clean ep)@median'])
  // the kernel narrowed the whole-query cite to the row holding its value: the card's hot row is that row
  const query = { id: 'q11', about: 'runs by outcome', keys: ['outcome'], table: [{ outcome: 'won (clean ep)', n: 3, median: 110 }, { outcome: 'failed/adversarial', n: 4, median: 165 }, { outcome: 'contested', n: 1, median: 190 }] }
  const resolved = { ref: 'q11#outcome=failed/adversarial@n', narrowed: 'q11#outcome=failed/adversarial@n', wrote: 'q11', count: 4, rows: ['runs.jsonl#L6-9'], records: [], chain: [] }
  const card = sourceCard({ ref: 'q11', label: '4 failed', resolved, query })
  const { rows, hotCol } = card.parts[0].data
  assert.deepEqual(rows.filter(r => r.hot).map(r => [r.cells[0], r.cells[hotCol]]), [['failed/adversarial', '4']])
  // a key written as its slug finds its row in the card too
  const slugged = sourceCard({ ref: 'q11#outcome=won-clean-ep@median', label: '110', resolved: { count: 3, rows: [], records: [], chain: [] }, query })
  const s2 = slugged.parts[0].data
  assert.deepEqual(s2.rows.filter(r => r.hot).map(r => [r.cells[0], r.cells[s2.hotCol]]), [['won (clean ep)', '110']])
})

test('a term is found again in a rewrite that says it in another form: its words, their forms in a row, then its longest word', () => {
  for (const [w, stem] of [['claimed', 'claim'], ['claiming', 'claim'], ['claimer', 'claim'], ['claims', 'claim'], ['approval', 'approv'], ['approved', 'approv'], ['stopped', 'stop'], ['process', 'process'], ['analysis', 'analysis']]) assert.equal(stemOf(w), stem, w)
  const t = 'PRs the claiming agent also approved; self-approved merges, [346](q19#n). The module-scoped fixtures leaked.'
  const show = x => x && [t.slice(x.start, x.end), x.how]
  assert.deepEqual(show(anchorTerm(t, 'claimed')), ['claiming', 'form'])
  assert.deepEqual(show(anchorTerm(t, 'self-approval')), ['self-approved', 'form'])
  assert.deepEqual(show(anchorTerm(t, 'fixture scope')), ['fixtures', 'word'])
  assert.deepEqual(show(anchorTerm(t, 'approved')), ['approved', 'term'])
  // never in a link, and a small word alone never carries a term
  assert.equal(anchorTerm('see [the merges](q19#n)', 'merge'), null)
  assert.equal(anchorTerm('of the runs', 'of vs on'), null)
})

test('an explain stands on its term in the text: in a citation\'s words it is drawn inside the citation, and a rewrite that left the term out shows none until the original is back', () => {
  const text = 'All 481 merges had their approval from [the claimer](q19#n). Emergent runs self-approved most.'
  const rec = withObserver(newRecord({ row: 'r1', session: 's1', text }), { verbs: {}, glosses: { g1: { term: 'claimer' }, g2: { term: 'Emergent vs managed' }, g3: { term: 'never said' } } })
  // claimer stands only in a citation's words: its explain is drawn there, inside the citation; the others have no words
  const gl = rec.marks.filter(m => m.kind === 'gloss')
  assert.deepEqual(gl.map(m => [m.gloss, text.slice(m.start, m.end)]), [['g1', 'claimer']])
  const runs = inline(text, 0, text.length, rec.marks)
  assert.deepEqual(runs.filter(r => r.mark !== undefined).map(r => [r.s, rec.marks[r.mark].kind, r.within === undefined ? null : rec.marks[r.within].kind]), [['the ', 'cite', null], ['claimer', 'gloss', 'cite']])
  // nothing is drawn after the text: every mark lies in it
  assert.ok(rec.marks.every(m => m.end <= text.length && m.start < m.end))
  const short = 'Every flagged merge was approved by its claimer.'
  const next = remark({ ...rec, shown: short })
  assert.deepEqual(next.marks.map(m => [m.gloss, short.slice(m.start, m.end)]), [['g1', 'claimer']])
  // a term the original holds that the rewrite left out entirely: no mark while the rewrite shows, the gloss kept
  const orig = 'The runs split. **Emergent vs managed:** emergent runs self-approved most.'
  const r2 = withObserver(newRecord({ row: 'r2', session: 's1', text: orig }), { verbs: {}, glosses: { g2: { term: 'Emergent vs managed' } } })
  assert.equal(orig.slice(r2.marks[0].start, r2.marks[0].end), 'Emergent vs managed')
  const s2 = 'The runs split in two.'
  const n2 = remark({ ...r2, shown: s2 })
  assert.deepEqual(n2.marks, [])
  assert.deepEqual(Object.keys(n2.glosses), ['g2'])
  // restored to the original, it stands on its words again
  const back = remark({ ...n2, shown: null })
  assert.equal(orig.slice(back.marks[0].start, back.marks[0].end), 'Emergent vs managed')
  // a record an earlier version kept with the explain after the text: read again, it stands inside the citation
  const kept = { ...rec, marks: [...linkMarks(text), { kind: 'gloss', start: text.length, end: text.length, gloss: 'g1', loose: true, inLink: true }] }
  const again = recordFor(kept, { row: 'r1', session: 's1', text })
  assert.deepEqual(again.marks.filter(m => m.kind === 'gloss').map(m => text.slice(m.start, m.end)), ['claimer'])
  assert.equal(recordFor(rec, { row: 'r1', session: 's1', text }), rec)
})

test('a model call that gave no answer is said as what happened, never as its code alone', async () => {
  const { modelWhy } = await import('../why.js')
  assert.equal(modelWhy({ isAnswered: true, text: 'x' }), '')
  assert.equal(modelWhy({ isAnswered: false, reason: 'api-error', status: null, error: 'unknown' }), 'no reply came from the API. Check the connection, or sign in again with /login')
  // a failed sign-in says its fix: trying again cannot help until the person signs in
  assert.equal(modelWhy({ isAnswered: false, reason: 'api-error', status: 401, error: 'authentication_failed' }), 'the sign-in failed or expired. Sign in again with /login')
  assert.equal(modelWhy({ isAnswered: false, reason: 'api-error', status: null, error: 'authentication_failed' }), 'the sign-in failed or expired. Sign in again with /login')
  assert.equal(modelWhy({ isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded' }), 'the API is overloaded')
  assert.equal(modelWhy({ isAnswered: false, reason: 'api-error', status: 418, error: 'unknown' }), 'the API answered with an error (HTTP 418)')
  assert.equal(modelWhy({ isAnswered: false, reason: 'empty-reply' }), 'the model answered with no text')
  assert.match(modelWhy({ isAnswered: false, reason: 'aborted' }), /stopped before an answer came/)
  assert.equal(modelWhy(null), 'no answer came back')
})

test('a citation of code is a mark in the forms Claude writes it: a line ref, a line as editors write it, a whole file, and a code span that names a line', () => {
  assert.equal(citeRef('server/auth.py#L88-94'), 'server/auth.py#L88-94')
  assert.equal(citeRef('server/auth.py:88'), 'server/auth.py#L88')
  assert.equal(citeRef('server/auth.py:88-94'), 'server/auth.py#L88-94')
  assert.equal(citeRef('README.md'), 'README.md')
  for (const t of ['docs/', 'foo', 'v0.8.0', 'https://example.com/a.md', 'a b.md']) assert.equal(citeRef(t), null, t)
  // a code span takes only a file's line: a path alone or a name in backticks stays code
  assert.equal(citeRef('README.md', { loose: true }), null)
  const text = [
    'The rule is at `app/shell.ts:1484`, and [the hook that draws it](app/shell.ts:2282) calls',
    '[`barEl()`](app/shell.ts#L1419-1490), as [the readme](README.md) says; `README.md` and `barEl()` stay code.',
    '',
    '```ts',
    'see `app/x.ts:3` and [z](r2#n)',
    '```',
  ].join('\n')
  const marks = linkMarks(text)
  assert.deepEqual(marks.map(m => [m.ref, m.label]), [
    ['app/shell.ts#L1484', 'app/shell.ts:1484'], ['app/shell.ts#L2282', 'the hook that draws it'],
    ['app/shell.ts#L1419-1490', 'barEl()'], ['README.md', 'the readme'],
  ])
  assert.equal(at(text, marks[0]), '`app/shell.ts:1484`')
  // the card words cite the same forms
  assert.deepEqual(linksIn('Hidden by [the check](app/shell.ts:1484).').map(l => l.ref), ['app/shell.ts#L1484'])
})

test('an explain finds its term written with backticks, or in part as code, and one that stands only in a citation is drawn inside it', () => {
  const text = 'The `AbovePrompt` hook calls `barEl()`, and [the narrow-bar rule in fitBar](app/host.js#L219) drops the counts.'
  assert.equal(at(text, findTerm(text, '`barEl()`')), '`barEl()`')
  assert.equal(at(text, findTerm(text, 'AbovePrompt hook')), '`AbovePrompt` hook')
  assert.equal(findTerm(text, 'Above'), null)
  assert.equal(findTerm(text, 'fitBar'), null)
  assert.equal(at(text, findInLink(text, 'fitBar')), 'fitBar')
  assert.equal(findInLink(text, 'barEl()'), null)
  const g = glossesOf([{ term: '`barEl()`', body: 'b' }, { term: 'fitBar', body: 'f' }, { term: 'nowhere', body: 'n' }], text)
  assert.deepEqual(Object.values(g).map(x => x.term), ['barEl()', 'fitBar'])
  const rec = withObserver(newRecord({ row: 'r1', session: 's1', text }), { verbs: {}, glosses: g })
  const runs = inline(text, 0, text.length, rec.marks)
  assert.deepEqual(runs.filter(r => r.mark !== undefined).map(r => [r.s, rec.marks[r.mark].kind]), [['barEl()', 'gloss'], ['the narrow-bar rule in ', 'cite'], ['fitBar', 'gloss']])
  // ] steps through them in reading order: the citation, then the explain inside it
  assert.deepEqual(rec.marks.map(m => m.kind), ['gloss', 'cite', 'gloss'])
  // the line wraps between the citation's words and the explain, never inside either
  const lines = wrapRuns(runs, 40)
  assert.ok(lines.every(l => l.filter(r => r.mark !== undefined).every(r => runs.some(x => x.mark === r.mark && x.s.includes(r.s)))))
})

test('a citation whose words name nothing shows the place it opens; a whole file opens at its top, with no line about rows', async () => {
  assert.equal(citeWords('here', 'plugin/hooks/path.ts#L9-13'), 'plugin/hooks/path.ts:9-13')
  assert.equal(citeWords('↗', 'plugin/hooks/path.ts'), 'plugin/hooks/path.ts')
  assert.equal(citeWords('the hook', 'plugin/hooks/path.ts'), 'the hook')
  assert.deepEqual(linkMarks('see [here](app/x.ts#L9) and [the hook](app/x.ts#L2)').map(m => m.label), ['app/x.ts:9', 'the hook'])
  const file = 'line one\nline two\nline three'
  const card = await citeCard({ ref: 'notes/prompt.md', label: 'the prompt', root: '/r', room: 9 }, { resolve: async () => ({ why: 'notes/prompt.md names a whole file, not rows of it' }), read: async p => (p === '/r/notes/prompt.md' ? file : '') })
  const text = gridText(draw(card.parts[0]))
  assert.match(text, /1 +line one\n2 +line two\n3 +line three/)
  assert.doesNotMatch(JSON.stringify(card), /whole file|rows of it|behind/)
  assert.equal(card.file.label, 'notes/prompt.md')
})

test('a heads-up is placed on its words and opens a card of its title, its points with citations, and what to do', () => {
  const text = 'Refunds fell 40% in March, after the new policy.'
  const h = headsOf({ term: 'fell 40% in March', title: 'March is half a month', bullets: ['[refunds.csv](refunds.csv) ends on Mar 14.', 'Per day they fell [12%](r4#month=03@per_day).'], todo: 'Quote the per-day drop.' }, text)
  assert.deepEqual(Object.keys(h), ['h1'])
  assert.equal(h.h1.kind, 'heads')
  assert.deepEqual(h.h1.refs, ['refunds.csv', 'r4#month=03@per_day'])
  assert.deepEqual(headsOf({ term: 'not in the text', bullets: ['x'] }, text), {})
  assert.deepEqual(headsOf({ term: 'fell 40% in March', bullets: [] }, text), {})
  const rec = withObserver(newRecord({ row: 'r1', session: 's1', text }), { verbs: {}, glosses: h })
  assert.equal(at(text, rec.marks.find(m => m.kind === 'gloss')), 'fell 40% in March')
  const card = explainerCard({ gloss: h.h1 })
  assert.equal(card.right, 'heads up')
  const drawn = gridText(draw(card.parts[0]))
  assert.match(drawn, /March is half a month\n• refunds\.csv ends on Mar 14\.\n• Per day they fell 12%\.\n→ Quote the per-day drop\./)
  assert.deepEqual(card.links.map(l => l.ref), ['refunds.csv', 'r4#month=03@per_day'])
})

test('a link is drawn as a hyperlink only where Claude Code surely draws one, so its address never shows beside its words', () => {
  assert.equal(drawsHyperlinks({}), false)
  assert.equal(drawsHyperlinks({ TERM: 'xterm-256color' }), false)
  assert.equal(drawsHyperlinks({ TERM_PROGRAM: 'tmux', TERM_PROGRAM_VERSION: '3.4' }), true)
  assert.equal(drawsHyperlinks({ TERM_PROGRAM: 'tmux', TERM_PROGRAM_VERSION: '3.3a' }), false)
  assert.equal(drawsHyperlinks({ TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.5.0' }), true)
  assert.equal(drawsHyperlinks({ TERM_PROGRAM: 'vscode', TERM_PROGRAM_VERSION: '1.71.0' }), false)
  assert.equal(drawsHyperlinks({ FORCE_HYPERLINK: '1' }), true)
  assert.equal(drawsHyperlinks({ FORCE_HYPERLINK: '0', TERM_PROGRAM: 'ghostty' }), false)
  assert.equal(drawsHyperlinks({ WT_SESSION: 'x', TMUX: '/tmp/s,1,0', TERM_PROGRAM: 'tmux', TERM_PROGRAM_VERSION: '3.2' }), false)
  assert.equal(drawsHyperlinks({ VTE_VERSION: '7200' }), true)
  assert.equal(drawsHyperlinks({ VTE_VERSION: '0.50.0' }), false)
})

test('what the person engaged with, in one short row for Claude that says what it is for: an explainer, an important detail, a citation, a question to a side thread', () => {
  const message = 'The page stays blank until `hydrate()` runs, as [app/main.ts](app/main.ts#L18) shows.'
  const g = openedRow({ row: 'r1', i: 1, kind: 'gloss', label: 'hydrate()', gloss: { term: 'hydrate()' } }, message)
  assert.equal(g.text, 'opened the explainer of "hydrate()" in your message that begins "The page stays blank until hydrate() runs, as app/main.ts…"')
  const h = openedRow({ row: 'r1', i: 2, kind: 'gloss', label: 'blank', gloss: { kind: 'heads', term: 'stays blank', title: 'Only on a cold load' } }, message)
  assert.match(h.text, /^opened the important detail "Only on a cold load" on "stays blank" in your message/)
  const c = openedRow({ row: 'r1', i: 0, kind: 'cite', ref: 'app/main.ts#L18', label: 'app/main.ts' }, message)
  assert.match(c.text, /^opened the citation "app\/main.ts" \(app\/main.ts#L18\) in your message/)
  // a citation inside a card names no message
  assert.equal(openedRow({ kind: 'cite', ref: 'q2#n', label: '2,994' }).text, 'opened the citation "2,994" (q2#n)')
  // the same open twice is one key
  assert.equal(openedRow({ row: 'r1', i: 1, kind: 'gloss', label: 'hydrate()', gloss: { term: 'hydrate()' } }, 'other words').key, g.key)
  const a = askedRow({ text: 'why does it wait on the session?', scope: { row: 'r1', mark: { kind: 'gloss', term: 'hydrate()' } } })
  assert.equal(a.text, 'asked a side thread about "hydrate()", which a side agent answers there: "why does it wait on the session?"')
  // the row: what it is for, then each thing, so Claude reads it as context with the analyst's prompt
  assert.equal(engagedText([g.text, a.text]), [
    'What the analyst did on screen since your last reply. It shows what they know and what they care about; none of it asks anything of you.',
    '- They opened the explainer of "hydrate()" in your message that begins "The page stays blank until hydrate() runs, as app/main.ts…".',
    '- They asked a side thread about "hydrate()", which a side agent answers there: "why does it wait on the session?".',
  ].join('\n'))
  assert.match(askedRow({ text: 'which week?', scope: { object: 'saves', region: 'bar-3', label: 'week 3' }, card: { id: 'saves', title: 'Saves per week' } }).text, /about the card "Saves per week" \(week 3\)/)
  assert.equal(openedRow(null), null)
  assert.equal(askedRow({ text: '  ' }), null)
})

test('a citation\'s words keep what a code span holds: underscores and stars inside it, and an underscore inside a word', () => {
  const text = 'It [reads `src/add_csv_export.py` first](src/add_csv_export.py#L12), then **writes** _once_ to snake_case_name.'
  const marks = linkMarks(text)
  assert.equal(marks[0].label, 'reads src/add_csv_export.py first')
  assert.deepEqual(inline(text, 0, text.length, marks).filter(r => r.mark !== undefined).map(r => r.s), ['reads src/add_csv_export.py first'])
  // an explain inside those words keeps them too
  const rec = withObserver(newRecord({ row: 'r1', session: 's1', text }), { verbs: {}, glosses: { g1: { term: 'add_csv_export.py' } } })
  assert.deepEqual(inline(text, 0, text.length, rec.marks).filter(r => r.mark !== undefined).map(r => r.s), ['reads src/', 'add_csv_export.py', ' first'])
  assert.equal(plainWords('**bold** and _it_ and `a_b*c` and a_b and "*"'), 'bold and it and a_b*c and a_b and "*"')
  assert.equal(lineOf('# The `add_csv` step\n> reads [the file](a.py#L2)'), 'The add_csv step reads the file')
  assert.equal(citeWords('`snake_case`', 'a.py#L3'), 'snake_case')
})
