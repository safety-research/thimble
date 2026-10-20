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
import { barText, keyEvent, nextState, takes } from '../host.js'

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
  assert.match(text, /Coverage of this session · 5 files · 1,500 rows/)
  assert.match(text, /seen 60 rows \(4%\)/)
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
  // at the top esc is the panel's (back to what it showed, or close)
  assert.equal(barText([after]), '[ ] step · t by type')
  assert.equal(takes(after, keyEvent('esc')), false)
  // the group selected carries its pattern, and the pane's thread says what the pane shows, in the kernel's words
  assert.equal(after.regions.find(r => r.id === 'g-0').meta.ref, 'runs/*.jsonl')
  const about = PANES.coverage.thread({}, {}, covData()).about
  assert.match(about, /what this session did with the folder's files, by `thimble coverage`: 60 of 1,500 rows seen \(4%\), from 1 of 5 source files; 4 files touched; 300 rows computed over and not seen/)
})

test('coverage: t groups by type; a group opens its files with what happened to each; a file opens its seen lines, which the host reads; esc goes back', () => {
  let { state, text } = turn(PANES.coverage, covData(), {}, keyEvent('t'))
  assert.match(text, /▸ jsonl\s+4/)
  ;({ state, text } = turn(PANES.coverage, covData(), state, keyEvent('t')))
  assert.match(text, /▸ runs\/\*\.jsonl/)
  // a press on the selected group opens it: each file by its name (the pattern in the header names its folder)
  ;({ state, text } = turn(PANES.coverage, covData(), state, { type: 'press', region: 'g-0' }))
  assert.equal(state.group, 'runs/*.jsonl')
  assert.match(text, /1 seen · 1 searched · 1 only computed over · 1 only counted/)
  assert.match(text, /seen      r1\.jsonl\s+300  seen 60 of 300 rows \(20%\): rows 1–40, 100–119/)
  assert.match(text, /searched  r2\.jsonl\s+300  searched by grep; which lines it showed is not known/)
  assert.match(text, /computed  r4\.jsonl\s+300  computed over all 300 rows \(q1\); none of them seen/)
  assert.match(text, /counted   r3\.jsonl\s+300  only named, listed or counted \(wc\); none of its lines seen/)
  // the ring on a file selects it; ↵ (a press on it) opens it
  ;({ state } = turn(PANES.coverage, covData(), state, { type: 'focus', region: 'f-0' }))
  const opened = turn(PANES.coverage, covData(), state, { type: 'press', region: 'f-0' })
  assert.equal(opened.state.file, 'runs/r1.jsonl')
  assert.match(opened.text, /▸ seen  rows 1–40  \(40\)/)
  const want = opened.after.wants[0]
  assert.deepEqual(want.request, { lines: 'runs/r1.jsonl', from: 1, to: want.request.to })
  const lines = Array.from({ length: want.request.to }, (_, i) => `{"n": ${i + 1}}`)
  const shown = turn(PANES.coverage, covData(), opened.state, null, { [want.key]: { lines } })
  assert.match(shown.text, / 1 ▌\{"n": 1\}/)
  // ] steps to the next seen range; ↵ opens its lines as a citation over the pane, and a question carries them
  const next = turn(PANES.coverage, covData(), opened.state, keyEvent(']'))
  assert.equal(next.state.at, 'rg-1')
  assert.equal(next.after.regions.find(r => r.id === 'rg-1').meta.ref, 'runs/r1.jsonl#L100-119')
  assert.deepEqual(turn(PANES.coverage, covData(), next.state, keyEvent('return')).d.effects, [{ mark: { kind: 'cite', ref: 'runs/r1.jsonl#L100-119', label: 'runs/r1.jsonl lines 100–119' }, do: 'open' }])
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

test('labels: the list shows each label with its kind and scope, a bar of its values in their colors and a legend; a number opens one', () => {
  const { after, text, state } = turn(PANES.labels, labData(), {}, null)
  assert.match(text, /Labels · 2 in this folder/)
  assert.match(text, /▸● apology\s+prompt · chat\/\*\.jsonl/)
  assert.match(text, /● yes 2   ● no 3   ░ waiting for the model 1/)
  assert.match(text, /● fails\s+regex · runs\/\*\.log/)
  // the bar's cells in the values' tones: the first value the accent, as the label card colors it
  const bar = after.root.kids[2].kid.runs.filter(r => /^[█░]+$/.test(r.s)).map(r => r.tone)
  assert.deepEqual(bar, ['accent', 'c3', 'unseen'])
  assert.equal(barText([after]), '[ ] step · 1 2 open a label')
  assert.equal(takes(after, keyEvent('esc')), false)
  assert.equal(turn(PANES.labels, labData(), state, keyEvent('2')).state.open, 'fails')
})

test('labels: one label says what made it and its definition, its values with bars, and its records in color; the number keys check the record shown and step on; f filters', () => {
  let { after, state } = turn(PANES.labels, labData(), {}, keyEvent('1'))
  assert.equal(state.open, 'apology')
  // the records are a page the host reads, at the label's generation of checks
  assert.deepEqual(after.wants[0].request, { records: 'apology', value: '*', at: 0, n: 20, gen: 3 })
  const got = page(after)
  let t = turn(PANES.labels, labData(), state, null, got)
  assert.match(t.text, /made by\s+a model, reading each record against the definition · 1 wait for it/)
  assert.match(t.text, /definition Does the agent apologize for something it did\?/)
  assert.match(t.text, /values\s+● yes\s+█+\s+2\s+33%/)
  assert.match(t.text, /no value yet/)
  assert.match(t.text, /checks\s+1 checked: 0 agree, 1 changed/)
  assert.match(t.text, /▸ room\.jsonl:1\s+● yes\s+model 0\.92\s+I'm sorry, I broke the build\./)
  assert.match(t.text, /room\.jsonl:2\s+● no\s+you \(was yes\)/)
  assert.match(t.text, /room\.jsonl:3\s+● waiting/)
  assert.match(t.text, /chat\/room\.jsonl#L1 · ● yes · the model, 92% sure/)
  assert.match(t.text, /why: says sorry for the build/)
  assert.equal(barText([t.after]), '[ ] record · 1 yes · 2 no · f filter · esc back')
  // a question under it carries the record selected; ↵ on it (a press) opens its row as a citation over the pane
  assert.equal(t.after.regions.find(r => r.id === 'rec-0').meta.ref, 'chat/room.jsonl#L1')
  assert.deepEqual(turn(PANES.labels, labData(), state, { type: 'press', region: 'rec-0' }, got).d.effects, [{ mark: { kind: 'cite', ref: 'chat/room.jsonl#L1', label: 'apology = yes: room.jsonl:1' }, do: 'open' }])
  assert.match(PANES.labels.thread({}, state, labData()).about, /^the label apology, made by a model, reading each record against the definition, over chat\/\*\.jsonl: 6 records \(yes 2, no 3, 1 waiting for the model\); the analyst checked 1/)
  // 2: the analyst says the record is no; the host keeps the check, and the next record is selected
  const checked = turn(PANES.labels, labData(), state, keyEvent('2'), got)
  assert.deepEqual(checked.d.effects, [{ label: 'apology', ref: 'chat/room.jsonl#L1', value: 'no', do: 'check' }])
  assert.equal(checked.state.rec, 1)
  // f: the records of yes, then of no, then of those with no value yet, then all again
  ;({ state } = turn(PANES.labels, labData(), state, keyEvent('f'), got))
  assert.equal(state.filter, 'yes')
  t = turn(PANES.labels, labData(), state, null)
  assert.equal(t.after.wants[0].request.value, 'yes')
  assert.match(turn(PANES.labels, labData(), state, null, page(t.after)).text, /filter: yes \(2\)/)
  ;({ state } = turn(PANES.labels, labData(), state, keyEvent('f')))
  ;({ state } = turn(PANES.labels, labData(), state, keyEvent('f')))
  assert.equal(state.filter, '-')
  ;({ state } = turn(PANES.labels, labData(), state, keyEvent('f')))
  assert.equal(state.filter, null)
  // a press on a value filters to it, a press again takes the filter off; esc goes back to the list
  ;({ state } = turn(PANES.labels, labData(), state, { type: 'press', region: 'val-1' }))
  assert.equal(state.filter, 'no')
  ;({ state } = turn(PANES.labels, labData(), state, { type: 'press', region: 'val-1' }))
  assert.equal(state.filter, null)
  assert.equal(turn(PANES.labels, labData(), state, keyEvent('esc')).state.open, null)
})

test('labels: a rule label says it was a rule, its pattern in its own color; no labels yet says how one comes', () => {
  const t = turn(PANES.labels, labData(), { open: 'fails' }, null)
  assert.match(t.text, /made by\s+a rule: a record whose text matches the pattern is fail, the rest pass/)
  assert.match(t.text, /pattern\s+\(\?i\)fail\|error/)
  const none = turn(PANES.labels, PANES.labels.data({ labels: { list: [] } }, {}, SIZE), {}, null)
  assert.match(none.text, /No labels here yet/)
})
