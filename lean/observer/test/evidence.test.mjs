// The observer's pure parts: what it reads of an object's lineage, how it reads the fork's answer, and the hint row as
// it ranks it (shell/object.js rankRow). `node --test lean/observer/test/*.test.mjs`
import assert from 'node:assert/strict'
import test from 'node:test'

import { bareNumbers, digest, hintsFor, isRepeat, parseAnswer, pickHints, rowCount, rowsIn } from '../evidence.js'
import { rankRow } from '../../shell/object.js'

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
  assert.equal(rowsIn('forge.db#prs/1-12'), 12)
  assert.equal(rowsIn('orders.csv#row=2-300,410-522'), 412)
  assert.equal(rowCount(['a.jsonl#L1-3', 'b.jsonl#L7']), 4)
  assert.equal(rowCount(['a.jsonl']), null)
})

test('numbers in the words that cite nothing are named; cited ones, years and dates are not', () => {
  assert.deepEqual(bareNumbers('West had [412 refunds](q3#region=West@n) in March 2026, about 31% of all, on 2026-03-14, and 9 regions had none; 1,203 rows.'), ['31%', '1,203'])
})

test('the digest says how many rows stand behind each cited value, how sure the lineage is, what was not read, and the verbs', () => {
  const d = digest(OBJECT, { verbs: VERBS, isNew: true, drawn: 'Refunds by region\nWest ▆▆▆▆ 412\n\n12 regions' })
  assert.match(d, /Object 02-orders-by-region v2 "Refunds by region" \(saved since the last look\)/)
  assert.match(d, /"412 refunds" = 412 \(q3#region=West@n\): rests on 412 rows of orders.csv/)
  assert.match(d, /numbers in its words that cite nothing: 31%/)
  assert.match(d, /query q3 "refunds per region": orders.csv \(18,204 rows read\); rows found by key, but their number does not equal the count column/)
  assert.match(d, /not read returns.csv, notes.txt/)
  assert.match(d, /Claude declared: read: ten refund rows by hand/)
  assert.match(d, /t trace: where it came from · where these numbers come from/)
  assert.match(d, /its hint row now: explore, trace \(Claude named explore\)/)
  assert.match(d, /records it quotes or cites in its data: 1, each found in its row/)
  assert.match(d, /as the person sees it under the reply:\n    Refunds by region\n    West ▆▆▆▆ 412\n    12 regions/)
})

test("the fork's answer is read leniently, and its hints keep only verbs that exist, at most three", () => {
  const a = parseAnswer('Here: {"notes": [{"note": "412 counts all months.", "rests_on": "groupby"}, {"note": " "}], "line": {"line": "x", "decision": "send it"}, "settled": true, "hints": {"orders-by-region": [{"verb": "trace", "phrase": "trace the 412 to its rows"}, {"verb": "stress"}, {"verb": "t"}, "explore", {"verb": "squeeze"}, {"verb": "x"}]}}')
  assert.equal(a.notes.length, 1)
  assert.equal(a.line.title, 'x')
  assert.equal(a.settled, true)
  const list = pickHints(hintsFor(a.hints, '02-orders-by-region'), VERBS)
  assert.deepEqual(list, [{ verb: 'trace', phrase: 'trace the 412 to its rows' }, { verb: 'explore' }, { verb: 'squeeze' }])
  assert.equal(parseAnswer('no json'), null)
  assert.deepEqual(pickHints([{ verb: 'map' }], VERBS), [])
})

test('a repeat is the same line in other spacing or case', () => {
  assert.equal(isRepeat('Before you send: 3 of 9 never re-ran.', ['before you send 3 of 9 never re-ran']), true)
  assert.equal(isRepeat('Before you send: 4 of 9 never re-ran.', ['before you send 3 of 9 never re-ran']), false)
})

test("the hint row as the observer ranked it: its verbs first, in its order, with its words; none of its own, the rule's", () => {
  const row = rankRow(VERBS, { verbs: [{ verb: 'trace', phrase: 'trace the 412' }, { verb: 'squeeze' }] })
  assert.deepEqual(row.map(v => [v.name, v.picked, v.hint ?? null]), [['trace', true, 'trace the 412'], ['squeeze', true, null], ['explore', false, null]])
  assert.equal(rankRow(VERBS, null), VERBS)
  assert.equal(rankRow(VERBS, { verbs: [{ verb: 'map' }] }), VERBS)
})
