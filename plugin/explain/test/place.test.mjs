// Where the explainers and heads-ups stand on a message's words (explain/place.mjs): a term on its words, in a
// citation's words, across a citation; a heads-up first, so an explainer inside its words stands where its term is said
// again; a squeezed text finds a term in another form; a look's explainers go to the newest message that holds them,
// each term once per conversation. Made-up data only.
//   node --test plugin/explain/test
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'

import { anchorTerm, filePlaces, findInLink, findRead, findTerm, glossesOf, headsOf, linksOf, markColors, mergeLook, placeGlosses, themeOf } from '../place.mjs'

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

test('links are the citations and every other link, never one inside code', () => {
  const text = 'See [the log](logs/a.log#L3-9), [41 of 44](#) and `[not](#)`.'
  assert.deepEqual(linksOf(text).map(l => l.words), ['the log', '41 of 44'])
  assert.deepEqual(filePlaces(text), [{ path: 'logs/a.log', from: 3, to: 9 }])
  assert.deepEqual(filePlaces('[a](src/x.py:12) [b](https://example.com/x) [c](notes.md)'), [{ path: 'src/x.py', from: 12, to: 12 }, { path: 'notes.md', from: null, to: null }])
})

test('a heads-up whose words hold an explainer\'s term keeps them, and the explainer stands where its term is said again', () => {
  const text = 'Each surge came from more than a hundred different network ranges. Later, the network ranges are the better clue.'
  const part = {
    items: {
      g1: { id: 'g1', term: 'network ranges', body: 'An address cut to its first two numbers.' },
      h1: { id: 'h1', kind: 'heads', term: 'more than a hundred different network ranges', title: 'Most ranges may be one provider', bullets: ['Addresses that start with 20. made most edits.'] },
    },
    order: ['g1', 'h1'],
  }
  const places = placeGlosses(text, part)
  const of = id => places.find(p => p.id === id)
  assert.equal(at(text, of('h1')), 'more than a hundred different network ranges')
  assert.equal(at(text, of('g1')), 'network ranges')
  assert.ok(of('g1').start > of('h1').end)
})

test('in a squeezed text a term is found again in another form, never on a citation', () => {
  assert.deepEqual(anchorTerm('The claimer claimed it.', 'claiming').how, 'form')
  const squeezed = 'Two [claimers](#) were self-approved.'
  assert.equal(at(squeezed, anchorTerm(squeezed, 'self-approval')), 'self-approved')
  assert.equal(placeGlosses('Uploads give up after the budget.', { items: { g1: { id: 'g1', term: 'retry budget' } }, order: ['g1'] }, true).length, 1)
  assert.equal(placeGlosses('Uploads give up after the budget.', { items: { g1: { id: 'g1', term: 'retry budget' } }, order: ['g1'] }, false).length, 0)
})

test("the look's explainers: a term the text holds, once, none already explained; one heads-up with bullets", () => {
  const text = 'The p95 latency rose, and the SuspenseBoundary held the page.'
  const gs = glossesOf([{ term: '`p95`', body: 'b' }, { term: 'p95', body: 'again' }, { term: 'SuspenseBoundary', body: 'w' }, { term: 'not here', body: 'x' }], text, ['suspenseboundary'])
  assert.deepEqual(gs, [{ id: 'g1', term: 'p95', title: 'p95', body: 'b', here: '' }])
  assert.equal(headsOf({ term: 'p95 latency', title: 't', bullets: [] }, text), null)
  assert.deepEqual(headsOf({ term: 'p95 latency rose', title: 'Only one day', bullets: ['[The log ends on Mar 14](logs/a.log).'], todo: 'Count again.' }, text),
    { id: 'h1', kind: 'heads', term: 'p95 latency rose', title: 'Only one day', bullets: ['[The log ends on Mar 14](logs/a.log).'], todo: 'Count again.' })
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

test("0.10's colors: teal and orange pens, the light palette only for a light theme", () => {
  assert.equal(markColors('dark').glossBg, '#9fe0d5')
  assert.equal(markColors('light').glossBg, '#c4eee6')
  assert.equal(markColors('light').headsBg, '#ffe0b8')
  assert.equal(themeOf('light-daltonized'), 'light')
  assert.equal(themeOf('auto'), 'dark')
})
