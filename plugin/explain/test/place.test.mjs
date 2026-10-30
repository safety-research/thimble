// Where the explainers and heads-ups stand on a message's words (explain/place.mjs): a term on its words, in a
// citation's words, across a citation; a look's explainers go to the newest message that holds them, each term once per
// conversation. Made-up data only.
//   node --test plugin/explain/test
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'

import { citeLinks, filePlaces, findInLink, findRead, findTerm, glossesOf, headsOf, markHolding, mergeLook, placeGlosses } from '../place.mjs'

const at = (text, p) => (p ? text.slice(p.start, p.end) : null)

test('a term stands on its words outside links and code, then in a citation\'s words, then across a citation', () => {
  const text = 'The `retry budget` ends [after five tries](#), and the network ranges vary.'
  assert.equal(at(text, findTerm(text, 'retry budget')), '`retry budget`')
  assert.equal(findTerm(text, 'five tries'), null)
  assert.equal(at(text, findInLink(text, 'five tries')), 'five tries')
  assert.equal(at(text, findTerm(text, 'Network Ranges')), 'network ranges')
  const across = 'So [5](#) of the 13 files in `src/notes` mention citations.'
  // across a citation, the mark covers the citation whole: the person sees both, and a press on its words opens the citation
  assert.equal(at(across, findRead(across, '5 of the 13 files in src/notes mention citations')), '[5](#) of the 13 files in `src/notes` mention citations')
  const by = 'Answers were shared by [1,212 accounts](#) in June.'
  assert.equal(at(by, findRead(by, 'by 1,212 accounts')), 'by [1,212 accounts](#)')
  assert.equal(at(by, findRead(by, 'shared by 1,212')), 'shared by [1,212 accounts](#)')
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
  // r2 says p95 only inside the heads-up's words, which the heads-up keeps: its explainer is not added
  assert.deepEqual(r.parts.r2.order, ['g1', 'h1'])
  assert.deepEqual(r.placed, ['retry budget'])
  assert.deepEqual(r.heads, ['One day'])
  // terms already explained are never explained again
  assert.deepEqual(mergeLook(msgs, { glosses: [{ term: 'p95' }], heads: null }, { glossed: ['P95'] }).placed, [])
})


test('words the analyst asked about over or across explainers are one mark, which covers the explainers it overlaps; a heads-up keeps its words; words inside a mark are that mark', () => {
  const text = 'Requests go through [third-party relays](#) before the heads gateway.'
  const look = { g1: { id: 'g1', term: 'relays' }, h1: { id: 'h1', kind: 'heads', term: 'heads gateway' } }
  assert.deepEqual(placeGlosses(text, { items: look, order: ['g1', 'h1'] }).map(p => at(text, p)), ['relays', 'heads gateway'])
  // asked over the explainer's words: the wider mark stands, the explainer under it draws nothing
  const wide = { ...look, a1: { id: 'a1', term: 'third-party relays', asked: true } }
  const placed = placeGlosses(text, { items: wide, order: ['g1', 'h1', 'a1'] })
  assert.deepEqual(placed.map(p => [p.id, at(text, p)]), [['a1', 'third-party relays'], ['h1', 'heads gateway']])
  // across a heads-up's words: the heads-up keeps them, and what is left of the asked words beside it is no mark, so
  // that asked mark draws nothing and the older one stands
  const across = { ...wide, a2: { id: 'a2', term: 'relays before the heads', asked: true } }
  assert.deepEqual(placeGlosses(text, { items: across, order: ['g1', 'h1', 'a1', 'a2'] }).map(p => [p.id, at(text, p)]), [['a1', 'third-party relays'], ['h1', 'heads gateway']])
  // across an asked mark and a citation (as any mark, over the whole of the citation it touches), the newest asked
  // wins over an older one
  const over = { ...across, a3: { id: 'a3', term: 'go through third-party', asked: true } }
  assert.deepEqual(placeGlosses(text, { items: over, order: ['g1', 'h1', 'a1', 'a2', 'a3'] }).map(p => [p.id, at(text, p)]), [['a3', 'go through [third-party relays](#)'], ['h1', 'heads gateway']])
  // words inside a mark, or on it, are that mark; words over it, across it or outside every mark are none
  assert.equal(markHolding(text, placed, 'third-party')?.id, 'a1')
  assert.equal(markHolding(text, placed, 'third-party relays')?.id, 'a1')
  assert.equal(markHolding(text, placed, 'gateway')?.id, 'h1')
  assert.equal(markHolding(text, placed, 'the heads gateway'), null)
  assert.equal(markHolding(text, placed, 'relays before'), null)
  assert.equal(markHolding(text, placed, 'Requests go'), null)
})

test('an explainer and a heads-up never share words: the one already there keeps them, and a new one of the other kind yields', () => {
  const text = 'Uploads fail when the retry budget runs out: 41 of the 44 failures came 30 seconds after a network drop.'
  const heads = { term: '30 seconds after a network drop', title: 'One office', bullets: ['x'] }
  const look = glosses => mergeLook([{ row: 'r1', text, part: null }], { glosses, heads }, { glossed: [] })
  const drawn = (t, part) => placeGlosses(t, part).map(p => [p.id, at(t, p)])
  // a look's heads-up comes before its explainers: one inside its words, or across them, is not added nor named placed
  const r = look([{ term: 'network drop', body: 'b' }, { term: 'retry budget', body: 'c' }, { term: 'failures came 30 seconds', body: 'd' }])
  assert.deepEqual(r.parts.r1.order, ['h1', 'g2'])
  assert.deepEqual(r.placed, ['retry budget'])
  assert.deepEqual(drawn(text, r.parts.r1), [['g2', 'retry budget'], ['h1', '30 seconds after a network drop']])
  // its term said again outside the heads-up's words: it stands there
  const again = `${text} A network drop ends each try.`
  const r2 = mergeLook([{ row: 'r1', text: again, part: null }], { glosses: [{ term: 'network drop', body: 'b' }], heads }, { glossed: [] })
  assert.deepEqual(drawn(again, r2.parts.r1), [['h1', '30 seconds after a network drop'], ['g1', 'network drop']])
  // a later look's heads-up on words an explainer already stands on is not added; on other words it is
  const had = { items: { g1: { id: 'g1', term: 'network drop' } }, order: ['g1'] }
  assert.deepEqual(mergeLook([{ row: 'r1', text, part: had }], { glosses: [], heads }, { glossed: ['network drop'] }), { parts: {}, placed: [], heads: [] })
  const beside = mergeLook([{ row: 'r1', text, part: had }], { glosses: [], heads: { term: 'retry budget runs out', title: 't', bullets: ['y'] } }, { glossed: [] })
  assert.deepEqual(drawn(text, beside.parts.r1), [['h1', 'retry budget runs out'], ['g1', 'network drop']])
  // an explainer the analyst asked for over a heads-up's words, or across them, is kept, and drawn only on free words
  const asked = { items: { h1: { id: 'h1', kind: 'heads', term: heads.term }, a1: { id: 'a1', term: 'came 30 seconds', asked: true }, a2: { id: 'a2', term: 'network drop', asked: true } }, order: ['h1', 'a1', 'a2'] }
  assert.deepEqual(drawn(text, asked), [['h1', '30 seconds after a network drop']])
  assert.deepEqual(drawn(again, asked), [['h1', '30 seconds after a network drop'], ['a2', 'network drop']])
})

test("an explainer never stands on what is left of its words beside a mark it keeps apart from, wherever its term is said: it stands where the term is said apart from them, or not at all", () => {
  const drawn = (t, part) => placeGlosses(t, part).map(p => [p.id, at(t, p)])
  // the term's first place is under an explainer the analyst asked for, its second runs into the heads-up's words
  const text = 'We saw the drop in signal at noon; 41 failures came 30 seconds after a drop in signal.'
  const part = { items: { h1: { id: 'h1', kind: 'heads', term: '30 seconds after a drop' }, a1: { id: 'a1', term: 'the drop in signal', asked: true } }, order: ['h1', 'a1'] }
  const g1 = { id: 'g1', term: 'drop in signal' }
  assert.deepEqual(drawn(text, { items: { ...part.items, g1 }, order: [...part.order, 'g1'] }), [['a1', 'the drop in signal'], ['h1', '30 seconds after a drop']])
  // so a look that gives it adds nothing there
  assert.deepEqual(mergeLook([{ row: 'r1', text, part }], { glosses: [{ term: 'drop in signal', body: 'b' }], heads: null }, { glossed: [] }), { parts: {}, placed: [], heads: [] })
  // the term said again, across a citation: the explainer stands there, not on what is left beside the heads-up
  const again = 'Uploads failed 30 seconds after a drop in signal; a [drop](#) in signal ends each try.'
  const heads = { items: { h1: { id: 'h1', kind: 'heads', term: '30 seconds after a drop' }, g1 }, order: ['h1', 'g1'] }
  assert.deepEqual(drawn(again, heads), [['h1', '30 seconds after a drop'], ['g1', '[drop](#) in signal']])
})

test('only a mark the analyst sees holds words: a look adds an explainer on the words of a heads-up their switch hides, and a heads-up on those of a hidden explainer', () => {
  const text = 'Uploads fail when the retry budget runs out: 41 of the 44 failures came 30 seconds after a network drop.'
  const h1 = { id: 'h1', kind: 'heads', term: '30 seconds after a network drop', title: 'One office', bullets: ['x'] }
  const g1 = { id: 'g1', term: 'network drop', title: 'network drop', body: 'b', here: '' }
  const isHeads = g => g.kind === 'heads'
  const drawn = (part, shown) => placeGlosses(text, { items: part.items, order: part.order.filter(id => shown(part.items[id])) }).map(p => [p.id, at(text, p)])
  // the explainer of a look, on the words of an older heads-up: not added while the heads-up shows
  const onHeads = [{ row: 'r1', text, part: { items: { h1 }, order: ['h1'] } }]
  const gloss = { glosses: [{ term: 'network drop', body: 'b' }], heads: null }
  assert.deepEqual(mergeLook(onHeads, gloss, { glossed: [] }, () => true).placed, [])
  // Heads-ups off: the analyst sees no heads-up there, so the explainer is added and stands on its words
  const headsOff = g => !isHeads(g)
  const r = mergeLook(onHeads, gloss, { glossed: [] }, headsOff)
  assert.deepEqual(r.placed, ['network drop'])
  assert.deepEqual(drawn(r.parts.r1, headsOff), [['g1', 'network drop']])
  // the heads-up of a look (h), on the words of an older explainer: not added while the explainer shows
  const onGloss = [{ row: 'r1', text, part: { items: { g1 }, order: ['g1'] } }]
  const tip = { glosses: [], heads: { term: h1.term, title: h1.title, bullets: h1.bullets } }
  assert.deepEqual(mergeLook(onGloss, tip, { glossed: ['network drop'] }, () => true).heads, [])
  // Explainers off: it is added and stands on its words
  const glossOff = g => isHeads(g)
  const h = mergeLook(onGloss, tip, { glossed: ['network drop'] }, glossOff)
  assert.deepEqual(h.heads, ['One office'])
  assert.deepEqual(drawn(h.parts.r1, glossOff), [['h1', '30 seconds after a network drop']])
})
