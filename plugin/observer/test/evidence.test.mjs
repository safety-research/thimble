// The observer's pure parts: what it reads of an object's lineage, and how it reads the pass's answer.
// `node --test plugin/observer/test/*.test.mjs`
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'

import { bareNumbers, digest, fewInputs, isRepeat, parseAnswer, rowCount, rowsIn, slim } from '../evidence.js'

const OBJECT = {
  id: '02-orders-by-region', version: 2, session: 's-1', title: 'Refunds by region', question: 'Which region had the most refunds in March?',
  text: 'West had [412 refunds](q3#region=West@n) in March, about 31% of all, and 9 regions had none.',
  hints: ['explore'],
  lineage: {
    queries: { q3: { id: 'q3', about: 'refunds per region', inputs: [{ path: 'orders.csv', rows_read: 18204 }], uses: [], kept: [], lineage: 'superset' } },
    bindings: [{ at: '/regions', ref: 'q3', query: 'q3', lineage: 'superset' }],
    cites: [
      { in: 'text', ref: 'q3#region=West@n', label: '412 refunds', value: 412, rows: ['orders.csv#row=2-300,410-522'] },
      { in: '/examples/one', ref: 'orders.csv#row=17', rows: ['orders.csv#row=17'], quote: 'refund: damaged' },
    ],
    rows: { 'orders.csv': { count: 412, rowsets: ['orders.csv#row=2-300,410-522'] } },
    coverage: { files: { 'orders.csv': 'computed' }, not_read: ['returns.csv', 'notes.txt'] },
    declared: { read: 'ten refund rows by hand' },
    problems: [],
  },
}
const VERBS = [
  { key: 's', name: 'squeeze', line: 'shorter', phrase: null, picked: false },
  { key: 'x', name: 'explore', line: 'a view to explore', phrase: 'explore 12 regions', picked: true },
  { key: 't', name: 'trace', line: 'where it came from', phrase: 'where these numbers come from', picked: true },
]

test('row sets count their rows, and a whole file counts as unknown', () => {
  assert.equal(rowsIn('revisions.jsonl#L4-9,12,40-41'), 9)
  assert.equal(rowsIn('a.jsonl#L4-L9'), 6)
  assert.equal(rowsIn('run.jsonl#L12.b1'), 1)
  assert.equal(rowsIn('run.jsonl#L12.b0-1,14-15.b0'), 4) // a block set: each part's lines times its blocks
  assert.equal(rowsIn('forge.db#prs/1-12'), 12)
  assert.equal(rowsIn('orders.csv#row=2-300,410-522'), 412)
  assert.equal(rowCount(['a.jsonl#L1-3', 'b.jsonl#L7']), 4)
  assert.equal(rowCount(['a.jsonl']), null)
})

test('a file only counted or searched is not read: the digest says so, from a snapshot of now and of before', () => {
  const at = cov => digest({ ...OBJECT, lineage: { ...OBJECT.lineage, coverage: cov } }, {})
  // now: not_read holds every file not read, and files says how each was touched
  const now = at({ files: { 'orders.csv': 'computed', 'a.py': 'read', 'b.py': 'named', 'c.py': 'searched' }, not_read: ['b.py', 'c.py', 'd.py'] })
  assert.match(now, /the session had: computed orders.csv; read a.py; not read b.py \(only named or counted\), c.py \(searched\), d.py$/m)
  // before: not_read held only the untouched files
  assert.match(at({ files: { 'orders.csv': 'computed', 'b.py': 'named' }, not_read: ['d.py'] }), /not read d.py, b.py \(only named or counted\)$/m)
  // many: counted by how
  const many = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`s${i}.py`, i < 8 ? 'named' : 'searched']))
  assert.match(at({ files: many, not_read: Object.keys(many), not_read_count: 12 }), /not read 12 files \(8 only named or counted, 1 searched\), as s0.py, s1.py, s2.py, s3.py$/m)
  assert.equal(slim({ id: 'x', lineage: { coverage: { files: {}, not_read: ['a'], total: { not_read_files: 40 } } } }).lineage.coverage.not_read_count, 40)
})

test('numbers in the words that cite nothing are named; cited ones, years and dates are not', () => {
  assert.deepEqual(bareNumbers('West had [412 refunds](q3#region=West@n) in March 2026, about 31% of all, on 2026-03-14, and 9 regions had none; 1,203 rows.'), ['31%', '1,203'])
})

test('the digest says how many rows stand behind each cited value, how sure the lineage is, what was not read, and the verbs', () => {
  const d = digest(OBJECT, { verbs: VERBS, isNew: true, drawn: 'Refunds by region\nWest ▆▆▆▆ 412\n\n12 regions' })
  assert.match(d, /Card 02-orders-by-region v2 "Refunds by region" \(saved since the last look\)/)
  assert.match(d, /"412 refunds" = 412 \(q3#region=West@n\): rests on 412 rows of orders.csv/)
  assert.match(d, /numbers in its words that cite nothing: 31%/)
  assert.match(d, /query q3 "refunds per region": orders.csv \(18,204 rows read\); rows found by key, but their number does not equal the count column/)
  assert.match(d, /not read returns.csv, notes.txt/)
  assert.match(d, /Claude declared: read: ten refund rows by hand/)
  assert.match(d, /t trace: where it came from · where these numbers come from/)
  assert.match(d, /its hint row now: explore, trace \(Claude named explore\)/)
  assert.match(d, /records it quotes or cites in its data: 1, each found in its row/)
  assert.match(d, /as the analyst sees it under the reply:\n    Refunds by region\n    West ▆▆▆▆ 412\n    12 regions/)
})

test("the pass's answer is read leniently: its notes, and nothing of the parts no lens gives", () => {
  const a = parseAnswer('Here: {"notes": [{"note": "412 counts all months.", "rests_on": "groupby"}, {"note": " "}], "line": {"line": "x", "decision": "send it"}, "settled": true, "hints": {"orders-by-region": [{"verb": "trace", "phrase": "trace the 412 to its rows"}, {"verb": "stress"}, {"verb": "t"}, "explore", {"verb": "squeeze"}, {"verb": "x"}]}}')
  assert.equal(a.notes.length, 1)
  assert.equal('line' in a, false)
  assert.equal('hints' in a, false)
  assert.equal(parseAnswer('no json'), null)
})

test('a repeat is the same line in other spacing or case', () => {
  assert.equal(isRepeat('Before you send: 3 of 9 never re-ran.', ['before you send 3 of 9 never re-ran']), true)
  assert.equal(isRepeat('Before you send: 4 of 9 never re-ran.', ['before you send 3 of 9 never re-ran']), false)
})

test('a slimmed object keeps what the digest reads and drops its data, program and row sets; many inputs read as patterns', () => {
  const big = { ...OBJECT, program: 'x'.repeat(1000), data: { rows: Array.from({ length: 1000 }, (_, i) => ({ n: i, _rows: [`a.jsonl#L${i}`] })) } }
  const s = slim(big)
  assert.equal(s.data, undefined)
  assert.equal(s.program, undefined)
  assert.equal(s.lineage.cites[0].rows, undefined)
  assert.equal(s.lineage.cites[0].rows_n, 412)
  assert.equal(digest(s, { verbs: VERBS }), digest(OBJECT, { verbs: VERBS }))
  const inputs = Array.from({ length: 96 }, (_, i) => ({ path: `runs/sweep${1 + (i % 2)}-opus/agents/agent-${String(i).padStart(2, '0')}.jsonl`, rows_read: 10 }))
  assert.deepEqual(fewInputs(inputs), [{ path: 'runs/sweep*-opus/agents/agent-*.jsonl (96 files)', rows_read: 960 }])
})
