// Coverage and the label viewer (panes/coverage.js, panes/labels.js): the side panes the bar's counts open. Coverage
// shows the folder's rows by file type with the read part lit, its files grouped by wildcard pattern or by type, a
// group's files with what reached Claude, and a file's read lines; the label viewer lists the labels with their values'
// bars, and opens one label: what made it, its definition, its values (a filter each), its records in their values'
// colors, stepped through and checked with the number keys. node --test plugin/panes/test
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import '../../draw/kit.js'
import { gridText, renderTerm } from '../../draw/term.js'
import PANES from '../index.js'
import { mixCells, typeMix } from '../coverage.js'
import { barText, keyEvent, nextState } from '../host.js'

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
const file = (path, type, pattern, status, o = {}) => ({ path, type, pattern, rows: 300, lines: 300, status, share: 0, read_lines: 0, ranges: [], hit_lines: [], hits: 0, by: [], searched_by: [], queries: [], computed: 0, shown: 0, ...o })
const FILES = [
  file('runs/r1.jsonl', 'jsonl', 'runs/*.jsonl', 'read', { share: 0.2, read_lines: 60, ranges: [[1, 40], [100, 119]] }),
  file('runs/r2.jsonl', 'jsonl', 'runs/*.jsonl', 'searched', { hit_lines: [5, 9], hits: 2 }),
  file('runs/r3.jsonl', 'jsonl', 'runs/*.jsonl', 'named', { by: ['wc'] }),
  file('runs/r4.jsonl', 'jsonl', 'runs/*.jsonl', 'not read'),
  file('src/app.py', 'py', 'src/app.py', 'not read'),
]
const COV = {
  session: 's-1', files: FILES,
  total: { files: 5, rows: 1500, read_rows: 60, read_share: 0.04 },
  patterns: [{ pattern: 'runs/*.jsonl', files: 4, rows: 1200, read_rows: 60, by_status: { read: 1, searched: 1, named: 1, 'not read': 1 } }, { pattern: 'src/app.py', files: 1, rows: 300, read_rows: 0, by_status: { 'not read': 1 } }],
  types: [{ type: 'jsonl', files: 4, rows: 1200, read_rows: 60, by_status: { read: 1, searched: 1, named: 1, 'not read': 1 } }, { type: 'py', files: 1, rows: 300, read_rows: 0, by_status: { 'not read': 1 } }],
}
const covData = (cov = COV) => PANES.coverage.data({ coverage: { cov } }, {}, SIZE)

test('coverage: the type bar shows the share of rows of each file type, its read part lit; the groups are wildcard patterns, the * lit', () => {
  const { after, text } = turn(PANES.coverage, covData(), {}, null)
  assert.match(text, /Coverage of this session · 5 files · 1,500 rows/)
  assert.match(text, /read 60 rows \(4%\)/)
  assert.match(text, /■ jsonl 80% · 5% read   ■ py 20%/)
  // the bar: each type's cells, the read part bright and the rest pale, as tones
  const bar = after.root.kids[2].runs.map(r => [r.tone, r.s.length])
  assert.deepEqual(bar.map(([t]) => t), ['c1', 'c1-faint', 'c2-faint'])
  assert.equal(bar.reduce((s, [, n]) => s + n, 0), SIZE.w)
  // by pattern, the group read first, its files counted by what reached Claude
  assert.match(text, /▸ runs\/\*\.jsonl\s+4\s+1\s+1\s+1\s+1/)
  const star = after.root.kids.flatMap(k => k.kids || []).flatMap(k => k.kid?.runs || []).find(r => r.s === '*')
  assert.equal(star.tone, 'accent')
  assert.equal(barText([after]), '[ ] step · t by type · esc close')
})

test('coverage: t groups by type; a group opens its files with what reached each; a file opens its read lines, which the host reads; esc goes back, then closes', () => {
  let { state, text } = turn(PANES.coverage, covData(), {}, keyEvent('t'))
  assert.match(text, /▸ jsonl\s+4/)
  ;({ state, text } = turn(PANES.coverage, covData(), state, keyEvent('t')))
  assert.match(text, /▸ runs\/\*\.jsonl/)
  // a press on the selected group opens it
  ;({ state, text } = turn(PANES.coverage, covData(), state, { type: 'press', region: 'g-0' }))
  assert.equal(state.group, 'runs/*.jsonl')
  // each file by its name: the pattern in the header names its folder
  assert.match(text, /read      r1\.jsonl\s+300  read 60 of 300 rows \(20%\): rows 1–40, 100–119/)
  assert.match(text, /searched  r2\.jsonl\s+300  searched: only the 2 matching lines shown/)
  assert.match(text, /counted   r3\.jsonl\s+300  only named, listed or counted \(wc\)/)
  assert.match(text, /untouched r4\.jsonl/)
  // the ring on a file selects it; ↵ (a press on it) opens it
  ;({ state } = turn(PANES.coverage, covData(), state, { type: 'focus', region: 'f-0' }))
  const opened = turn(PANES.coverage, covData(), state, { type: 'press', region: 'f-0' })
  assert.equal(opened.state.file, 'runs/r1.jsonl')
  assert.match(opened.text, /▸ read  rows 1–40  \(40\)/)
  const want = opened.after.wants[0]
  assert.deepEqual(want.request, { lines: 'runs/r1.jsonl', from: 1, to: want.request.to })
  // the lines the host read: read ones marked, the rest dim
  const lines = Array.from({ length: want.request.to }, (_, i) => `{"n": ${i + 1}}`)
  const shown = turn(PANES.coverage, covData(), opened.state, null, { [want.key]: { lines } })
  assert.match(shown.text, / 1 ▌\{"n": 1\}/)
  // ] steps to the next read range
  const next = turn(PANES.coverage, covData(), opened.state, keyEvent(']'))
  assert.equal(next.state.at, 'rg-1')
  assert.equal(next.after.wants[0].request.from, 98)
  // esc: back to the group, back to the groups, then the host closes the pane
  let back = turn(PANES.coverage, covData(), opened.state, keyEvent('esc'))
  assert.equal(back.state.file, null)
  back = turn(PANES.coverage, covData(), back.state, keyEvent('esc'))
  assert.equal(back.state.group, null)
  assert.deepEqual(turn(PANES.coverage, covData(), back.state, keyEvent('esc')).d.effects, [{ do: 'close' }])
})

test('coverage: a file only counted or untouched says why no line of it is shown; the pane says when it is still reading', () => {
  const counted = turn(PANES.coverage, covData(), { group: 'runs/*.jsonl', file: 'runs/r3.jsonl' }, null)
  assert.match(counted.text, /No line of it reached Claude: it was only named, listed or counted \(wc\)\./)
  assert.equal(counted.after.wants, undefined)
  assert.match(turn(PANES.coverage, PANES.coverage.data({ coverage: {} }, {}, SIZE), {}, null).text, /reading what this session read/)
})

test('the small type bar: cells by rows, the read part of a type at least one cell, the rest of more than six types as other', () => {
  const mix = typeMix([{ type: 'py', rows: 900, read_rows: 9 }, { type: 'md', rows: 100, read_rows: 0 }])
  assert.deepEqual(mixCells(mix, 8), [{ tone: 'c1', read: true, n: 1 }, { tone: 'c1', read: false, n: 6 }, { tone: 'c2', read: false, n: 1 }])
  const many = typeMix(Array.from({ length: 9 }, (_, i) => ({ type: `t${i}`, rows: 100 - i, read_rows: 0 })))
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
  assert.equal(barText([after]), '[ ] step · 1 2 open a label · esc close')
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
