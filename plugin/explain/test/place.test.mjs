// Where the explainers and heads-ups stand on a message's words (explain/place.mjs): a term on its words, in a
// citation's words, across a citation; a look's explainers go to the newest message that holds them, each term once per
// conversation. Made-up data only.
//   node --test plugin/explain/test
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'

import { citeLinks, filePlaces, findInLink, findRead, findTerm, glossesOf, headsOf, mergeLook } from '../place.mjs'

const at = (text, p) => (p ? text.slice(p.start, p.end) : null)

test('a term stands on its words outside links and code, then in a citation\'s words, then across a citation', () => {
  const text = 'The `retry budget` ends [after five tries](#), and the network ranges vary.'
  assert.equal(at(text, findTerm(text, 'retry budget')), '`retry budget`')
  assert.equal(findTerm(text, 'five tries'), null)
  assert.equal(at(text, findInLink(text, 'five tries')), 'five tries')
  assert.equal(at(text, findTerm(text, 'Network Ranges')), 'network ranges')
  const across = 'So [5](#) of the 13 files in `src/notes` mention citations.'
  assert.equal(at(across, findRead(across, '5 of the 13 files in src/notes mention citations')), 'of the 13 files in `src/notes` mention citations')
})

test("the look's explainers: a term the text holds, once, none already explained; one heads-up with bullets", () => {
  const text = 'The p95 latency rose, and the SuspenseBoundary held the page.'
  const gs = glossesOf([{ term: '`p95`', body: 'b' }, { term: 'p95', body: 'again' }, { term: 'SuspenseBoundary', body: 'w' }, { term: 'not here', body: 'x' }], text, ['suspenseboundary'])
  assert.deepEqual(gs, [{ id: 'g1', term: 'p95', title: 'p95', body: 'b', here: '' }])
  assert.equal(headsOf({ term: 'p95 latency', title: 't', bullets: [] }, text), null)
  assert.deepEqual(headsOf({ term: 'p95 latency rose', title: 'Only one day', bullets: ['[The log ends on Mar 14](logs/a.log).'] }, text),
    { id: 'h1', kind: 'heads', term: 'p95 latency rose', title: 'Only one day', bullets: ['[The log ends on Mar 14](logs/a.log).'] })
  // the heads-up only informs: an older look's offer or todo (a call to action) is not kept
  assert.deepEqual(headsOf({ term: 'p95 latency rose', title: 'Only one day', bullets: ['b'], todo: 'Count again.', offer: 'Count the latency per hour' }, text),
    { id: 'h1', kind: 'heads', term: 'p95 latency rose', title: 'Only one day', bullets: ['b'] })
})

test("an explainer's links to a file's lines become citations, each with its place; a citation, a web address and code stay as they are", () => {
  const got = citeLinks('A [x](#) and [ticket 4](t/a.jsonl#L88) and `[c](d.py#L1)`, [web](https://example.test) and [f](f.py:3-5).')
  assert.equal(got.text, 'A [x](#) and [ticket 4](#) and `[c](d.py#L1)`, [web](https://example.test) and [f](#).')
  assert.deepEqual(got.places, [null, { path: 't/a.jsonl', from: 88, to: 88 }, { path: 'f.py', from: 3, to: 5 }])
  assert.deepEqual(filePlaces('[a](b.py#L2-L4) [c](#) [d](e/f.txt)'), [{ path: 'b.py', from: 2, to: 4 }, { path: 'e/f.txt', from: null, to: null }])
})

test('a look places each explainer in the newest message that holds it, adds to what the message had, and names what it placed', () => {
  const msgs = [
    { row: 'r1', text: 'First the retry budget, then the p95.', part: null },
    { row: 'r2', text: 'The p95 rose.', part: { items: { g1: { id: 'g1', term: 'flaky' } }, order: ['g1'] } },
  ]
  const out = { glosses: [{ term: 'retry budget', body: 'b' }, { term: 'p95', body: 'q' }, { term: 'p95', body: 'dup' }], heads: { term: 'p95 rose', title: 'One day', bullets: ['x'] } }
  const r = mergeLook(msgs, out, { glossed: ['flaky'] })
  assert.deepEqual(Object.keys(r.parts).sort(), ['r1', 'r2'])
  assert.deepEqual(r.parts.r1.order, ['g1'])
  assert.equal(r.parts.r1.items.g1.term, 'retry budget')
  assert.deepEqual(r.parts.r2.order, ['g1', 'h1', 'g2'])
  assert.equal(r.parts.r2.items.g2.term, 'p95')
  assert.deepEqual(r.placed, ['retry budget', 'p95'])
  assert.deepEqual(r.heads, ['One day'])
  // terms already explained are never explained again
  assert.deepEqual(mergeLook(msgs, { glosses: [{ term: 'p95' }], heads: null }, { glossed: ['P95'] }).placed, [])
})

