// A squeeze's rewrite (squeeze/chips.mjs): the model's reply read, the rewrite held to the original's numbers, the
// request, a catch-up's original, the cards each version shows, and what Claude hears. Made-up data only.
// node --test plugin/squeeze/test/chips.test.mjs
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { MEANS, applyRewrite, cardListsAt, cardNotes, cardsAfter, catchUpText, changedCitations, checkRewrite, chipsOf, endsOf, fromVersions, mapLinks, placedCards, request, restore, settledNote, shownKey, termsOf } from '../chips.mjs'

// a made-up report, as a long reply takes it
const TEXT = [
  '**Fixed `test_checkout_total`.** It failed in about [1 run in 9](#) because the `cart` fixture in tests/conftest.py had `scope="module"`.',
  '',
  'The coupon test left a coupon on the shared cart.',
  '',
  '- The fix is one line.',
  '- The test then [passed 200 times in a row](#).',
].join('\n')

test('a rewrite is held to the original: its citations stay as written, and a number it never states is named', () => {
  const out = checkRewrite(TEXT, 'Fixed in [2 tries](#); it failed [1 run in 9](#), 12% of runs.')
  assert.equal(out.text, 'Fixed in [2 tries](#); it failed [1 run in 9](#), 12% of runs.')
  assert.equal(out.problems.length, 1)
  assert.match(out.problems[0], /this version states "12", which the original answer does not/)
  assert.deepEqual(checkRewrite(TEXT, 'It failed about [1 in 9](#); now it [passed 200 times](#).').problems, [])
  // a link's words count, its target does not
  assert.equal(mapLinks('a [b (c)](#) d', (all, words) => words), 'a b (c) d')
})

test('the request carries only the definition of each level picked, and Length always', () => {
  const words = { words: 40, data: false, keep: 0 }
  const rec = { text: TEXT, squeeze: { at: { length: 3, interpret: 0, 'x-boss': 3 }, own: [{ id: 'x-boss', words: 'for my boss' }], scale: 4 } }
  const tail = request(rec, { system: 'S' }).prompt[1].text
  assert.match(tail, /- Length: much longer\. About two and a half times the original/)
  assert.match(tail, /- Interpretation: facts only\. State what was found/)
  assert.match(tail, /"for my boss": fully\. Write the whole text as these words ask\./)
  // no other level of any chip is defined, and the input (the original) stays in the cached head
  for (const [chip, at] of [['length', 3], ['interpret', 0]]) {
    MEANS[chip].forEach((m, i) => { if (i !== at && m(words)) assert.ok(!tail.includes(m(words).split('.')[0]), `${chip} level ${i} is not in the request`) })
  }
  assert.ok(!tail.includes(MEANS.own[1]()) && !tail.includes(MEANS.own[2]()))
  assert.ok(!tail.includes('<original>'))
  // a chip left where the original is, other than Length, is not named
  const one = request({ text: TEXT, squeeze: { at: { length: 0 }, scale: 4 } }, { system: 'S' }).prompt[1].text
  assert.match(one, /- Length: short\./)
  assert.ok(!one.includes('Interpretation'))
  // a record of scale 3 (one line first, Background's four levels) reads on the scales now, its Background level kept
  const old = chipsOf({ text: TEXT, squeeze: { at: { length: 4, familiarity: 0 }, scale: 3, versions: { 'length=4': 'x' } } })
  assert.deepEqual(old.map(c => `${c.id}=${c.levels[c.level]}`), ['length=much longer', 'interpret=as written', 'familiarity=new'])
})

test('older records still read after the scale went to 5 (levelsAt)', () => {
  const read = squeeze => chipsOf({ text: TEXT, squeeze }).map(c => `${c.id}=${c.levels[c.level]}`)
  // scale 4, no Background chip: its levels read as they were, and Background stands at the original's
  const four = { at: { length: 0, interpret: 2 }, scale: 4, versions: { 'length=0&interpret=2': 'Short, read.' } }
  assert.deepEqual(read(four), ['length=short', 'interpret=with context', 'familiarity=working'])
  // its versions come back with no call
  assert.equal(fromVersions({ text: TEXT, squeeze: four }, { length: 0, interpret: 2 }).shown, 'Short, read.')
  // scale 2, when Background had five levels: its level reads as the original's, and the versions it wrote go
  assert.deepEqual(read({ at: { familiarity: 4 }, scale: 2, versions: { 'familiarity=4': 'x' } }), ['length=as written', 'interpret=as written', 'familiarity=working'])
  assert.equal(fromVersions({ text: TEXT, squeeze: { at: {}, scale: 2, versions: { 'familiarity=0': 'x' } } }, { familiarity: 0 }), null)
  // scale 3 kept Background's four levels: a version of it alone comes back
  assert.equal(fromVersions({ text: TEXT, squeeze: { at: {}, scale: 3, versions: { 'familiarity=0': 'New.' } } }, { familiarity: 0 }).shown, 'New.')
})

test('each version keeps its cards: an edit takes its card\'s place, an add goes last, a drop leaves one out; 0 brings the original\'s back', () => {
  const row = 'row-a'
  const orig = { [row]: [{ id: 'c0a1b2c3d4', copy: 'orig' }, { id: 'c9e8d7c6b5', copy: 'orig' }] }
  const done = [
    { op: 'edit', id: 'c0a1b2c3d4', copy: 's1', v: 2, title: 'Runs by day' },
    { op: 'drop', id: 'c9e8d7c6b5', title: 'Sources' },
    { op: 'add', id: 'c55556666', copy: 's2', v: 1, title: 'Runs by hour' },
  ]
  const cards = cardsAfter(orig, row, done)
  assert.deepEqual(cards.rows[row], [{ id: 'c0a1b2c3d4', copy: 's1' }, { id: 'c55556666', copy: 's2' }])
  const rec = applyRewrite({ row, text: TEXT, shown: null, squeeze: {} }, { text: 'Short.', at: { length: 0 }, cards, origCards: orig })
  assert.equal(rec.shown, 'Short.')
  assert.deepEqual(cardListsAt(rec)[row], cards.rows[row])
  assert.deepEqual(cardNotes(rec), { marks: { c0a1b2c3d4: 'edited', c55556666: 'added' }, left: ['Sources'] })
  const back = restore(rec)
  assert.equal(back.shown, null)
  assert.deepEqual(cardListsAt(back)[row], orig[row])
  assert.deepEqual(cardNotes(back), { marks: {}, left: [] })
  // a level seen before comes back with no call, and with its cards
  const again = fromVersions(back, { length: 0 })
  assert.equal(again.shown, 'Short.')
  assert.deepEqual(cardListsAt(again)[row], cards.rows[row])
  assert.equal(fromVersions(back, { length: 3 }), null)
})

test('Claude hears the version the person settled on once, the original only after a version, and a catch-up names its replies', () => {
  const rec = applyRewrite({ row: 'r1', text: 'The long answer about [12 runs](#).', at: '2026-01-05T14:05:00Z', shown: null, squeeze: {} }, { text: 'Short: [12 runs](#).', at: { length: 0 } })
  const note = settledNote(rec, 'orig')
  assert.match(note, /now reads, for the analyst, as:\n\nShort: \[12 runs\]\(#\)\./)
  assert.match(note, /Length: short/)
  assert.equal(settledNote(rec, shownKey(rec)), '')
  assert.equal(settledNote(restore(rec), 'orig'), '')
  assert.match(settledNote(restore(rec), shownKey(rec)), /reads again, for the analyst, as you wrote it/)
  const cu = { row: 'r3', text: catchUpText(['First reply.', 'Second reply.']), shown: 'Both, short.', squeeze: { at: { length: 0 }, scale: 4 }, catchup: { host: 'r3', rows: ['r2', 'r3'], replies: 2, question: 'q' } }
  assert.match(settledNote(cu, 'orig'), /caught up on your 2 replies since their last prompt\. Below those messages \("First reply\."; "Second reply\."\), which still show/)
  assert.match(settledNote({ ...cu, catchup: { ...cu.catchup, dismissed: true } }, shownKey(cu)), /closed the catch-up of your 2 replies/)
  // the terms of a message's explainers, not its heads-ups
  assert.deepEqual(termsOf({ items: { a: { id: 'a', term: 'hydrate' }, b: { id: 'b', term: 'the cache', kind: 'heads' } }, order: ['a', 'b'] }), ['hydrate'])
})

test('a cited number the rewrite changed is named, though the original states it elsewhere', () => {
  const orig = 'The job ran [26 times](#) in March. It ran 23 times in April.'
  // 23 is in the original, so the plain number check finds nothing; the citation still changed
  const out = checkRewrite(orig, 'The job ran [23 times](#) in March.')
  assert.deepEqual(out.problems, ['this version says "23 times" where the original answer says "26 times"'])
  assert.deepEqual(changedCitations(orig, 'It ran [26 times](#), then [23](#) more.'), [{ words: '23', was: null }])
  // a cited value kept, or rounded as a rewrite may round it, is no change
  assert.deepEqual(checkRewrite('Errors fell to [0.369](#) of runs.', 'Errors fell to [37%](#) of runs.').problems, [])
  assert.deepEqual(checkRewrite(orig, 'It ran [26 times](#).').problems, [])
  // a citation that keeps the original's value and adds one the original states beside it changed nothing
  const saves = 'Of the 13,704 saves, [13,339 fell in one week, June 16–22](#).'
  assert.deepEqual(checkRewrite(saves, '[13,339 of 13,704 saves fell in June 16–22](#).').problems, [])
})

test('each chip names its two ends', () => {
  const chips = chipsOf({ text: 'x', squeeze: {} })
  assert.deepEqual(chips.map(endsOf), [['shorter', 'longer'], ['facts', 'with context'], ['new', 'expert']])
  // a chip of the person's own runs from as written to fully
  assert.deepEqual(endsOf({ levels: ['as written', 'a little', 'more', 'fully'] }), ['as written', 'fully'])
})

test('a version places each card where it puts the card\'s line; a line it leaves out leaves the card out', () => {
  const orig = ['Sales rose in March.', '', '[Sales by week](card:c0a1b2c3d4)', '', 'Most of it came from one shop.', '', 'Returns stayed flat.'].join('\n')
  // kept, or moved: the text as written, the card drawn where its line is
  const kept = 'Sales rose.\n\n[Sales by week](card:c0a1b2c3d4)\n\nOne shop did it.'
  assert.deepEqual(placedCards(kept, orig), { text: kept, left: [], removed: [] })
  const moved = 'Sales rose.\n\nOne shop did it.\n\n[Sales by week](card:c0a1b2c3d4)'
  assert.deepEqual(placedCards(moved, orig), { text: moved, left: [], removed: [] })
  // left out: nothing puts it back; the card is left out of this version
  const short = 'Sales rose in March, most of it in one shop.'
  assert.deepEqual(placedCards(short, orig), { text: short, left: ['c0a1b2c3d4'], removed: [] })
  // dropped: its line goes
  assert.deepEqual(placedCards(kept, orig, ['c0a1b2c3d4']), { text: 'Sales rose.\n\nOne shop did it.', left: [], removed: ['c0a1b2c3d4'] })
})
