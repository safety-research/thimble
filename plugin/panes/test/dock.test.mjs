// Coverage and the label viewer (panes/coverage.js, panes/labels.js): the panes the bar's counts open in the side
// panel, each a thread (a question under it is about the part selected and carries its refs). Coverage
// keeps apart the files touched and the files seen, and the rows seen (in Claude's context) from those only computed
// over; it shows the folder's rows by file type in those shades, its files grouped by wildcard pattern or by type, a
// group's files with what happened to each, and a file's seen lines; the label viewer lists the labels with their values'
// bars, and opens one label: what made it, its definition, its values (a filter each), its records in their values'
// colors, stepped through and checked with the number keys. node --test plugin/panes/test
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import '../../draw/kit.js'
import { gridText, renderTerm } from '../../draw/term.js'
import PANES from '../index.js'
import { barCells, mixCells, typeMix } from '../coverage.js'
import { toneBeside, tonesIn } from '../labels.js'
import { actionsOf, backOf, barText, keyEvent, nextState, takes } from '../host.js'

const DK = globalThis.DrawKit
const SIZE = { w: 96, h: 30 }
/** One turn of a program: the event answered, the state kept, the drawing after it (with what the host gave). */
function turn(pane, data, state, event, got = {}) {
  const d = DK.run(pane.program, data, { ...SIZE, mode: 'pane', state, event, got })
  assert.equal(d.error, undefined, JSON.stringify(d.error))
  const next = nextState(state, d)
  const after = DK.run(pane.program, data, { ...SIZE, mode: 'pane', state: next, got })
  return { d, state: next, after, text: gridText(renderTerm(after, { w: SIZE.w })) }
}

// ---------------------------------------------------------------- coverage
const file = (path, type, pattern, status, o = {}) => ({ path, type, pattern, rows: 300, lines: 300, status, share: 0, seen_lines: 0, ranges: [], hit_lines: [], hits: 0, by: [], searched_by: [], queries: [], labels: [], computed: 0, model: 0, shown: 0, ...o })
const FILES = [
  file('runs/r1.jsonl', 'jsonl', 'runs/*.jsonl', 'seen', { share: 0.2, seen_lines: 60, ranges: [[1, 40], [100, 119]] }),
  file('runs/r2.jsonl', 'jsonl', 'runs/*.jsonl', 'searched', { searched: true, searched_by: ['grep'] }),
  file('runs/r3.jsonl', 'jsonl', 'runs/*.jsonl', 'named', { by: ['wc'] }),
  file('runs/r4.jsonl', 'jsonl', 'runs/*.jsonl', 'computed', { computed: 300, queries: ['q1'] }),
  file('src/app.py', 'py', 'src/app.py', 'not read'),
]
const COV = {
  session: 's-1', files: FILES,
  total: { files: 5, rows: 1500, seen_rows: 60, seen_share: 0.04, seen_files: 1, touched_files: 4, computed_rows: 300, model_rows: 0 },
  patterns: [{ pattern: 'runs/*.jsonl', files: 4, rows: 1200, seen_rows: 60, computed_rows: 300, model_rows: 0, touched: 4, seen_files: 1, by_status: { seen: 1, searched: 1, named: 1, computed: 1 } }, { pattern: 'src/app.py', files: 1, rows: 300, seen_rows: 0, touched: 0, seen_files: 0, by_status: { 'not read': 1 } }],
  types: [{ type: 'jsonl', files: 4, rows: 1200, seen_rows: 60, computed_rows: 300, model_rows: 0, touched: 4, seen_files: 1, by_status: { seen: 1, searched: 1, named: 1, computed: 1 } }, { type: 'py', files: 1, rows: 300, seen_rows: 0, touched: 0, seen_files: 0, by_status: { 'not read': 1 } }],
}
const covData = (cov = COV) => PANES.coverage.data({ coverage: { cov } }, {}, SIZE)

test('coverage: files touched and files seen apart; the rows seen, apart from those only computed over; the type bar in shades of seen, computed over and untouched; the groups are wildcard patterns, the * lit', () => {
  const { after, text } = turn(PANES.coverage, covData(), {}, null)
  assert.match(text, /^▎ Coverage\n▎ what this session read of the folder · 5 files · 1,500 rows · seen 60 rows \(4%\)/)
  assert.match(text, /files  4 of 5 touched · 1 seen \(some of their lines in Claude's context\)/)
  assert.match(text, /rows   300 computed over, none seen/)
  assert.match(text, /█ seen  ▓ read by a label's model  ▒ computed over  ░ untouched/)
  assert.match(text, /■ jsonl 80% · 5% seen   ■ py 20%/)
  // the bar: each type's cells in its shades, seen first, then computed over, then untouched (pale)
  const bar = text.split('\n').find(l => /^[█▓▒░]+$/.test(l.trim()) && l.trim().length > 20).trim()
  assert.match(bar, /^█+▒+░+$/)
  assert.equal(bar.length, SIZE.w)
  assert.equal(bar.match(/▒/g).length, Math.round(SIZE.w * 0.8 * 300 / 1200))
  // by pattern: its files, those touched, those seen
  assert.match(text, /▸ runs\/\*\.jsonl\s+4\s+4\s+1/)
  const star = after.root.kids.flatMap(k => k.kids || []).flatMap(k => k.kid?.runs || []).find(r => r.s === '*')
  assert.equal(star.tone, 'accent')
  // no key of its own; at the top esc is the panel's (back to what it showed, or close)
  assert.equal(barText([after]), '')
  assert.equal(takes(after, keyEvent('esc')), false)
  // the group selected carries its pattern, and the pane's thread says what the pane shows, in the kernel's words
  assert.equal(after.regions.find(r => r.id === 'g-0').meta.ref, 'runs/*.jsonl')
  const about = PANES.coverage.thread({}, {}, covData()).about
  assert.match(about, /what this session did with the folder's files, by `thimble coverage`: 60 of 1,500 rows seen \(4%\), from 1 of 5 source files; 4 files touched; 300 rows computed over and not seen/)
})

test('coverage: by type and by pattern are presses; a press on a group opens its files with what happened to each, a file its seen lines, which the host reads; esc goes back, and the way back names where', () => {
  assert.equal(takes(turn(PANES.coverage, covData(), {}, null).after, keyEvent('g')), false)
  let { state, text } = turn(PANES.coverage, covData(), {}, { type: 'press', region: 'by-type' })
  assert.equal(state.by, 'type')
  assert.match(text, /type\s+files touched\s+seen[^\n]*\n\s+jsonl\s+4/)
  ;({ state, text } = turn(PANES.coverage, covData(), state, { type: 'press', region: 'by-pattern' }))
  assert.match(text, /pattern\s+files touched\s+seen[^\n]*\n\s+runs\/\*\.jsonl/)
  // a press on a group opens it: each file by its name (the pattern in the subject names its folder)
  ;({ state, text } = turn(PANES.coverage, covData(), state, { type: 'press', region: 'g-0' }))
  assert.equal(state.group, 'runs/*.jsonl')
  assert.match(text, /^▎ runs\/\*\.jsonl\n▎ files of the folder · 4 files · 1,200 rows · seen 60 rows \(5%\)/)
  assert.match(text, /1 seen · 1 searched · 1 only computed over · 1 only counted/)
  assert.match(text, /seen      r1\.jsonl\s+300  seen 60 of 300 rows \(20%\): rows 1–40, 100–119/)
  assert.match(text, /searched  r2\.jsonl\s+300  searched by grep; which lines it showed is not known/)
  assert.match(text, /computed  r4\.jsonl\s+300  computed over all 300 rows \(q1\); none of them seen/)
  assert.match(text, /counted   r3\.jsonl\s+300  only named, listed or counted \(wc\); none of its lines seen/)
  // esc goes back to every group, which the way back names
  assert.equal(backOf(turn(PANES.coverage, covData(), state, null).after), 'Coverage')
  // the ring on a file selects it; a press (↵ with the ring on it) opens it
  ;({ state } = turn(PANES.coverage, covData(), state, { type: 'focus', region: 'f-0' }))
  const opened = turn(PANES.coverage, covData(), state, { type: 'press', region: 'f-0' })
  assert.equal(opened.state.file, 'runs/r1.jsonl')
  assert.match(opened.text, /▸ seen  rows 1–40  \(40\)/)
  assert.equal(backOf(opened.after), 'runs/*.jsonl')
  const want = opened.after.wants[0]
  assert.deepEqual(want.request, { lines: 'runs/r1.jsonl', from: 1, to: want.request.to })
  const lines = Array.from({ length: want.request.to }, (_, i) => `{"n": ${i + 1}}`)
  const shown = turn(PANES.coverage, covData(), opened.state, null, { [want.key]: { lines } })
  assert.match(shown.text, / 1 ▌\{"n": 1\}/)
  // the ring on the next seen range selects it, and its ref is what a question carries; a press opens its lines as a
  // citation over the pane
  const next = turn(PANES.coverage, covData(), opened.state, { type: 'focus', region: 'rg-1' })
  assert.equal(next.state.at, 'rg-1')
  assert.equal(next.after.regions.find(r => r.id === 'rg-1').meta.ref, 'runs/r1.jsonl#L100-119')
  assert.deepEqual(turn(PANES.coverage, covData(), next.state, { type: 'press', region: 'rg-1' }).d.effects, [{ mark: { kind: 'cite', ref: 'runs/r1.jsonl#L100-119', label: 'runs/r1.jsonl lines 100–119' }, do: 'open' }])
  // esc: back to the group, back to the groups; at the top it is the panel's
  let back = turn(PANES.coverage, covData(), opened.state, keyEvent('esc'))
  assert.equal(back.state.file, null)
  back = turn(PANES.coverage, covData(), back.state, keyEvent('esc'))
  assert.equal(back.state.group, null)
  assert.equal(takes(back.after, keyEvent('esc')), false)
})

test('coverage: a file only computed over, counted or untouched says why no line of it was seen; the pane says when it is still reading', () => {
  const counted = turn(PANES.coverage, covData(), { group: 'runs/*.jsonl', file: 'runs/r3.jsonl' }, null)
  assert.match(counted.text, /No line of it entered Claude's context: it was only named, listed or counted \(wc\)\./)
  assert.equal(counted.after.wants, undefined)
  const computed = turn(PANES.coverage, covData(), { group: 'runs/*.jsonl', file: 'runs/r4.jsonl' }, null)
  assert.match(computed.text, /Computed over: q1 went over its rows, and none of them entered a context/)
  assert.match(turn(PANES.coverage, PANES.coverage.data({ coverage: {} }, {}, SIZE), {}, null).text, /reading what this session saw/)
})

test("the type bar's cells: each type's by its rows, its seen, model-read, computed and untouched parts in order; the small bar in thimble's bar is seen against the rest; past six types, other", () => {
  const mix = typeMix([{ type: 'py', rows: 900, seen_rows: 9, computed_rows: 450 }, { type: 'md', rows: 100, model_rows: 50 }])
  assert.deepEqual(mixCells(mix, 20).map(c => `${c.tone} ${c.part} ${c.n}`), ['c1 seen 1', 'c1 computed 8', 'c1 untouched 9', 'c2 model 1', 'c2 untouched 1'])
  assert.deepEqual(barCells(mix, 8), [{ tone: 'c1', seen: true, n: 1 }, { tone: 'c1', seen: false, n: 6 }, { tone: 'c2', seen: false, n: 1 }])
  const many = typeMix(Array.from({ length: 9 }, (_, i) => ({ type: `t${i}`, rows: 100 - i, seen_rows: 0 })))
  assert.deepEqual(many.map(t => t.type), ['t0', 't1', 't2', 't3', 't4', 'other'])
  assert.equal(many.at(-1).rows, 95 + 94 + 93 + 92)
})

// ---------------------------------------------------------------- labels
const LABELS = [
  { name: 'apology', kind: 'prompt', rule: 'Does the agent apologize for something it did?', values: ['yes', 'no'], in: 'chat/*.jsonl', version: 2, records: 6, waiting: 1, failed: 0, checked: 1, agree: 0, disagree: 1, counts: { yes: 2, no: 3 } },
  { name: 'fails', kind: 'regex', rule: '(?i)fail|error', values: ['fail', 'pass'], in: 'runs/*.log', version: 1, records: 40, waiting: 0, failed: 0, checked: 0, counts: { fail: 10, pass: 30 } },
]
const RECS = [
  { ref: 'chat/room.jsonl#L1', i: 0, value: 'yes', by: 'model', confidence: 0.92, reason: 'says sorry for the build', words: "I'm sorry, I broke the build.", text: "I'm sorry, I broke the build." },
  { ref: 'chat/room.jsonl#L2', i: 1, value: 'no', by: 'analyst', checked: true, was: 'yes', words: 'Merged the fix.', text: 'Merged the fix.' },
  { ref: 'chat/room.jsonl#L3', i: 2, value: null, waiting: true, by: null, words: 'Running the tests now.', text: 'Running the tests now.' },
]
const labData = () => PANES.labels.data({ labels: { list: LABELS, checks: 3 } }, {}, SIZE)
const page = d => Object.fromEntries((d.wants || []).map(w => [w.key, { total: 6, records: RECS }]))

test('labels: the list shows each label with a bar of its values in their colors and a legend; a press opens one; no key of its own', () => {
  const { after, text } = turn(PANES.labels, labData(), {}, null)
  assert.match(text, /▎ Labels\n▎ 2 labels in this folder/)
  assert.match(text, /● apology\s+█+░*\s+6 records/)
  assert.match(text, /● yes 2   ● no 3   ░ not labeled yet 1/)
  assert.match(text, /● fails\s+█+\s+40 records/)
  // the bar's cells in the values' tones: the first value the accent, as the label card colors it
  const bar = after.root.kids.flatMap(k => k.kid?.kids || []).flatMap(k => k.runs || []).filter(r => /^[█░]+$/.test(r.s)).map(r => r.tone).slice(0, 3)
  assert.deepEqual(bar, ['accent', 'c3', 'unseen'])
  // no key of its own: the ring walks the labels, a press opens one, esc is the panel's
  assert.equal(barText([after]), '')
  assert.equal(takes(after, keyEvent('esc')), false)
  const opened = turn(PANES.labels, labData(), {}, { type: 'press', region: 'lb-1' })
  assert.equal(opened.state.open, 'fails')
  assert.equal(opened.state.from, 'list')
  // opened from the list, esc goes back to it, and the way back names it
  assert.equal(backOf(opened.after), 'labels')
  assert.equal(turn(PANES.labels, labData(), opened.state, keyEvent('esc')).state.open, null)
})

test('labels: one label opens on its values over its records and the records, says how far it is in plain words; how it was made is an action', () => {
  let { after, state } = turn(PANES.labels, labData(), {}, { type: 'press', region: 'lb-0' })
  assert.equal(state.open, 'apology')
  // the records are a page the host reads, at the label's generation of checks
  assert.deepEqual(after.wants[0].request, { records: 'apology', value: '*', at: 0, n: 20, gen: 3 })
  const got = page(after)
  let t = turn(PANES.labels, labData(), state, null, got)
  const lines = t.text.split('\n')
  // the subject: the label, and how far it is, in plain words with its counts
  assert.match(lines[0], /^▎ ● apology/)
  assert.match(lines[1], /^▎ label over chat\/\*\.jsonl · labeled 5 of 6 records · 1 waiting for the model · you checked 1/)
  // then its values, each a bar and a count, before anything else
  assert.match(lines[3], /^● yes\s+█+\s+2\s+33%/)
  assert.match(lines[4], /^● no\s+█+\s+3\s+50%/)
  assert.match(lines[5], /^░ not labeled yet\s+█+\s+1/)
  // then its records in their colors, and the one selected whole, with the values to check it
  assert.match(t.text, /records · all 6\s+1 of 6/)
  assert.match(t.text, /room\.jsonl:1\s+● yes\s+model 0\.92\s+I'm sorry, I broke the build\./)
  assert.match(t.text, /room\.jsonl:2\s+● no\s+you \(was yes\)/)
  assert.match(t.text, /room\.jsonl:3\s+● not yet/)
  assert.match(t.text, /chat\/room\.jsonl#L1 · ● yes · the model, 92% sure/)
  assert.match(t.text, /why: says sorry for the build/)
  assert.match(t.text, /your check:\s+● yes\s+● no/)
  // how it was made is an action above the input bar, in words; its definition is not shown up front
  assert.deepEqual(actionsOf(t.after), [{ event: 'act:def', words: 'Definition', on: false }])
  assert.doesNotMatch(t.text, /Does the agent apologize/)
  assert.doesNotMatch(t.text, /made by/)
  // no key of its own but esc, back to the list
  assert.equal(barText([t.after]), 'esc labels')
  assert.equal(takes(t.after, keyEvent('f')) || takes(t.after, keyEvent(']')) || takes(t.after, keyEvent('1')), false)
  // a record carries its ref; a press on it opens its row as a citation over the pane
  assert.equal(t.after.regions.find(r => r.id === 'rec-0').meta.ref, 'chat/room.jsonl#L1')
  assert.deepEqual(turn(PANES.labels, labData(), state, { type: 'press', region: 'rec-0' }, got).d.effects, [{ mark: { kind: 'cite', ref: 'chat/room.jsonl#L1', label: 'apology = yes: room.jsonl:1' }, do: 'open' }])
  assert.match(PANES.labels.thread({}, state, labData()).about, /^the label apology, made by a model, reading each record against the definition, over chat\/\*\.jsonl: 6 records \(yes 2, no 3, 1 waiting for the model\); the analyst checked 1/)
  // a press on a value of the check row: the analyst says the record is no; the host keeps the check, and the next
  // record is selected
  const checked = turn(PANES.labels, labData(), state, { type: 'press', region: 'chk-1' }, got)
  assert.deepEqual(checked.d.effects, [{ label: 'apology', ref: 'chat/room.jsonl#L1', value: 'no', do: 'check' }])
  assert.equal(checked.state.rec, 1)
  // a press on a value filters the records to it; again, or `show all`, shows every record
  ;({ state } = turn(PANES.labels, labData(), state, { type: 'press', region: 'val-0' }, got))
  assert.equal(state.filter, 'yes')
  t = turn(PANES.labels, labData(), state, null)
  assert.equal(t.after.wants[0].request.value, 'yes')
  assert.match(turn(PANES.labels, labData(), state, null, page(t.after)).text, /records · yes 2 · show all/)
  assert.equal(turn(PANES.labels, labData(), state, { type: 'press', region: 'filter-all' }).state.filter, null)
  assert.equal(turn(PANES.labels, labData(), state, { type: 'press', region: 'filter-all' }).state.at, null)
  assert.equal(turn(PANES.labels, labData(), state, { type: 'press', region: 'val-0' }).state.filter, null)
  assert.equal(turn(PANES.labels, labData(), state, { type: 'press', region: 'filter-none' }).state.filter, '-')
  // Definition opens how it was made, in the `side:opened` region the panel draws above the actions; esc closes it
  const def = turn(PANES.labels, labData(), state, { type: 'act:def' }, got)
  assert.match(def.text, /made by a model, reading each record against the definition\nover chat\/\*\.jsonl\n▎ Does the agent apologize for something it did\?/)
  assert.ok(renderTerm(def.after, { w: SIZE.w }).regions.some(r => r.id === 'side:opened'))
  assert.deepEqual(actionsOf(def.after), [{ event: 'act:def:on', words: 'Definition', on: true }])
  assert.equal(turn(PANES.labels, labData(), def.state, keyEvent('esc'), got).state.def, false)
  // where Claude made the label: the host scrolls the conversation to its card
  const withCard = () => PANES.labels.data({ labels: { list: [{ ...LABELS[0], card: '07-label-apology' }, LABELS[1]], checks: 3 } }, {}, SIZE)
  assert.deepEqual(actionsOf(turn(PANES.labels, withCard(), state, null, got).after).map(a => a.words), ['Definition', 'Where Claude made it'])
  assert.deepEqual(turn(PANES.labels, withCard(), state, { type: 'act:made' }, got).d.effects, [{ card: '07-label-apology', do: 'reveal' }])
  // opened from beside a card (not from the list), esc is the panel's: back to what it showed, or close
  assert.equal(takes(turn(PANES.labels, labData(), { open: 'apology' }, null).after, keyEvent('esc')), false)
})

test('labels: a rule label says it was a rule, its pattern under Definition; one label alone opens on itself; no labels yet says how one comes', () => {
  const t = turn(PANES.labels, labData(), { open: 'fails', def: true }, null)
  assert.match(t.text, /made by a rule: text that matches the pattern is fail, the rest pass/)
  assert.match(t.text, /▎ \(\?i\)fail\|error/)
  assert.match(t.text, /label over runs\/\*\.log · 40 records, all labeled/)
  const one = turn(PANES.labels, PANES.labels.data({ labels: { list: [LABELS[1]] } }, {}, SIZE), {}, null)
  assert.match(one.text, /▎ ● fails/)
  const none = turn(PANES.labels, PANES.labels.data({ labels: { list: [] } }, {}, SIZE), {}, null)
  assert.match(none.text, /No labels here yet/)
})

test("a label beside a chart says its values in the chart's colors: where a value first stands as a word in a color, not on a fill; plain for one the chart leaves plain", () => {
  const cell = (ch, tone, bg) => ({ ch, ...(tone ? { tone } : {}), ...(bg ? { bg } : {}) })
  const row = (parts) => parts.flatMap(([text, tone, bg]) => [...text].map(ch => cell(ch, tone, bg)))
  const grid = { rows: [
    row([['Edits by ', 'ink'], ['agent', 'c3'], [' · ', 'dim'], ['person', 'c5'], [' · unclear', 'ink']]),
    row([['agent 13,355', 'paper', 'c3'], [' agents', 'c4']]),
  ] }
  const tones = tonesIn(grid, ['agent', 'person', 'unclear'])
  assert.deepEqual(tones, { agent: 'c3', person: 'c5' })
  const l = { name: 'editor_kind', values: ['agent', 'person', 'unclear'], tones }
  assert.deepEqual(['agent', 'person', 'unclear'].map(v => toneBeside(l, v)), ['c3', 'c5', 'ink'])
  // a legend's mark in the value's color, before its name in plain words, gives the value that color
  const legend = { rows: [row([['by who: ', 'ink'], ['■', 'c2'], [' agent  ', 'ink'], ['■', 'dim'], [' unclear  ', 'ink'], ['■', 'c4'], [' person', 'ink']])] }
  assert.deepEqual(tonesIn(legend, ['agent', 'person', 'unclear']), { agent: 'c2', person: 'c4' })
  // a value only on a fill, or inside a longer word, is not the chart's color for it: the label's own colors then
  const none = tonesIn({ rows: [row([['agent 3', 'paper', 'c3'], [' agents', 'c4']])] }, ['agent', 'person'])
  assert.deepEqual(none, {})
  assert.deepEqual(['agent', 'person'].map(v => toneBeside({ values: ['agent', 'person'], tones: none }, v)), ['accent', 'c3'])
})
