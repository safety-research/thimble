// A squeeze's rewrite (squeeze/chips.mjs): the model's reply read, the rewrite held to the original's numbers, the
// request, a catch-up's original, the cards each version shows, and what Claude hears. Made-up data only.
// node --test plugin/squeeze/test/chips.test.mjs
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { MEANS, applyRewrite, cardListsAt, cardNotes, cardsAfter, cardsBlock, catchUpText, checkRewrite, chipsOf, fromVersions, levelWords, mapLinks, readReply, request, restore, revealCut, settledNote, shownKey, stepAt, termsOf } from '../chips.mjs'

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
  assert.match(out.problems[0], /"12" is not in the original/)
  assert.deepEqual(checkRewrite(TEXT, 'It failed about [1 in 9](#); now it [passed 200 times](#).').problems, [])
  // a link's words count, its target does not
  assert.equal(mapLinks('a [b (c)](#) d', (all, words) => words), 'a b (c) d')
})

test('readReply takes the text from its tags, or the whole reply when it gave none, and the card changes after it', () => {
  const none = { cards: [], cardProblems: [] }
  assert.deepEqual(readReply('<text>\nA.\n</text>'), { text: 'A.', ...none })
  assert.deepEqual(readReply('A plain reply.'), { text: 'A plain reply.', ...none })
  assert.deepEqual(readReply('```markdown\nB.\n```'), { text: 'B.', ...none })
  const reply = [
    '<text>\nShort.\n</text>',
    '<card edit="c0a1b2c3d4">\n<title>Saves each day</title>\n</card>',
    '<card add="saves-by-hour" rows="c0a1b2c3d4">\n<title>Saves by hour</title>\n<view>\n```js\nfunction view(props, s) { return s.Text({ children: String(props.rows.length) }) }\n```\n</view>\n</card>',
    '<card drop="c9e8d7c6b5"/>',
    '<card add="broken">\n<title>No rows</title>\n<view>function view() {}</view>\n</card>',
    '<card edit="c11112222">\n</card>',
  ].join('\n')
  const got = readReply(reply)
  assert.equal(got.text, 'Short.')
  assert.deepEqual(got.cards, [
    { op: 'edit', id: 'c0a1b2c3d4', title: 'Saves each day' },
    { op: 'add', id: 'saves-by-hour', rows: 'c0a1b2c3d4', title: 'Saves by hour', view: 'function view(props, s) { return s.Text({ children: String(props.rows.length) }) }' },
    { op: 'drop', id: 'c9e8d7c6b5' },
  ])
  assert.equal(got.cardProblems.length, 1)
  assert.match(got.cardProblems[0], /the new card broken came without the card whose rows it draws/)
  // a reply with no text tags: the card blocks are no part of the text
  assert.equal(readReply('Plain.\n<card drop="c9e8d7c6b5"/>').text, 'Plain.')
})

test('the request shows each card with its columns, first rows, drawing and view, and sends the card guide with them', () => {
  const cards = [{ id: 'c0a1b2c3d4', title: 'Runs by day', columns: ['day', 'n'], sample: '{"day":"Mon","n":4}', drawn: 'Mon ████ 4', view: 'function view() {}' }]
  const block = cardsBlock(cards)
  for (const w of ['<card id="c0a1b2c3d4">', '<columns>day, n</columns>', '{"day":"Mon","n":4}', 'Mon ████ 4', 'function view() {}']) assert.ok(block.includes(w), w)
  const req = request({ text: TEXT, squeeze: { at: { length: 2 }, scale: 4 } }, { system: 'S', toolkit: 'GUIDE', cards })
  assert.equal(req.system.length, 2)
  assert.equal(req.system[1].text, 'GUIDE')
  assert.ok(req.prompt[0].text.includes('<card id="c0a1b2c3d4">'))
  assert.match(req.prompt[1].text, /Add detail from the cards and their rows/)
  assert.match(req.prompt[1].text, /then a block for each card it changes/)
  // no cards: no guide, no block
  const plain = request({ text: TEXT, squeeze: { at: { length: 0 }, scale: 4 } }, { system: 'S', toolkit: 'GUIDE' })
  assert.equal(plain.system.length, 1)
  assert.ok(!plain.prompt[0].text.includes('<card'))
})

test('a link with brackets in its words stays one link through the check, and the text writing in never stops inside it', () => {
  const orig = 'Of the boys, [21 (age 0-12)](#) of 37 stayed; of the girls, 19 of 32.'
  const text = 'Boys: [21 (age 0-12)](#) of 37. Girls: [19 (age 0-12)](#) of 32.'
  const out = checkRewrite(orig, text)
  assert.equal(out.text, text)
  assert.deepEqual(out.problems, [])
  const links = ['[21', '[19'].map(w => [text.indexOf(w), text.indexOf('](#)', text.indexOf(w)) + 4])
  for (let n = 4; n < text.length; n += 3) {
    const end = revealCut(text, n).length
    assert.ok(!links.some(([a, b]) => end > a && end < b), `cut at ${end} falls inside a link`)
  }
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

test('Background is back: new · learning · working · expert, the original at working, each level its own definition', () => {
  const chips = chipsOf({ text: TEXT })
  assert.deepEqual(chips.map(c => c.name), ['Length', 'Interpretation', 'Background'])
  const bg = chips[2]
  assert.deepEqual(bg.levels, ['new', 'learning', 'working', 'expert'])
  assert.equal(bg.level, 2)
  assert.equal(levelWords(bg), 'as written')
  assert.equal(MEANS.familiarity[2](), '')
  const at = n => request({ text: TEXT, squeeze: { at: { familiarity: n }, scale: 5 } }, { system: 'S' }).prompt[1].text
  assert.match(at(0), /- Background: new\. Write for a reader new to the field\./)
  assert.match(at(1), /- Background: learning\. Write for a reader learning the field\./)
  assert.match(at(3), /- Background: expert\. Write for an expert in the field\./)
  assert.ok(!at(2).includes('Background'))
  // Interpretation's expert reading no longer brings the background with it
  assert.ok(!MEANS.interpret[2]().includes('background'))
  // a step on it is one key, and a version is kept by it
  assert.deepEqual(stepAt({ text: TEXT }, 'familiarity', 1), { familiarity: 3 })
  const rec = applyRewrite({ text: TEXT, shown: null, squeeze: {} }, { text: 'For a newcomer.', at: { familiarity: 0 } })
  assert.equal(rec.squeeze.scale, 5)
  assert.deepEqual(Object.keys(rec.squeeze.versions), ['familiarity=0'])
})

test('older records still read after the scale went to 5 (levelsAt)', () => {
  const read = squeeze => chipsOf({ text: TEXT, squeeze }).map(c => `${c.id}=${c.levels[c.level]}`)
  // scale 4, no Background chip: its levels read as they were, and Background stands at the original's
  const four = { at: { length: 0, interpret: 2 }, scale: 4, versions: { 'length=0&interpret=2': 'Short, read.' } }
  assert.deepEqual(read(four), ['length=short', 'interpret=expert reading', 'familiarity=working'])
  // its versions come back with no call
  assert.equal(fromVersions({ text: TEXT, squeeze: four }, { length: 0, interpret: 2 }).shown, 'Short, read.')
  // scale 2, when Background had five levels: its level reads as the original's, and the versions it wrote go
  assert.deepEqual(read({ at: { familiarity: 4 }, scale: 2, versions: { 'familiarity=4': 'x' } }), ['length=as written', 'interpret=as written', 'familiarity=working'])
  assert.equal(fromVersions({ text: TEXT, squeeze: { at: {}, scale: 2, versions: { 'familiarity=0': 'x' } } }, { familiarity: 0 }), null)
  // scale 3 kept Background's four levels: a version of it alone comes back
  assert.equal(fromVersions({ text: TEXT, squeeze: { at: {}, scale: 3, versions: { 'familiarity=0': 'New.' } } }, { familiarity: 0 }).shown, 'New.')
})

test('Interpretation starts at the original, as written, in its middle, and adds nothing to the request there', () => {
  const [, interp] = chipsOf({ text: TEXT })
  assert.deepEqual(interp.levels, ['facts only', 'as written', 'expert reading'])
  assert.equal(interp.level, 1)
  assert.equal(levelWords(interp), 'as written')
  assert.equal(MEANS.interpret[1](), '')
  // a record from before, where an observer placed the original on the chip, starts at as written too
  const old = chipsOf({ text: TEXT, verbs: { s: { lit: false, at: { interpretation: 'facts only' } } } })[1]
  assert.equal(old.level0, 1)
  assert.equal(levelWords(old), 'as written')
  // a step either way is named with its own definition; the middle is not named
  const down = request({ text: TEXT, squeeze: { at: { interpret: 0 }, scale: 4 } }, { system: 'S' }).prompt[1].text
  assert.match(down, /- Interpretation: facts only\. State what was found/)
  const up = request({ text: TEXT, squeeze: { at: { interpret: 2 }, scale: 4 } }, { system: 'S' }).prompt[1].text
  assert.match(up, /- Interpretation: expert reading\. Lead with Claude's reading/)
  const mid = request({ text: TEXT, squeeze: { at: { interpret: 1 }, scale: 4 } }, { system: 'S' }).prompt[1].text
  assert.ok(!mid.includes('Interpretation'))
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
  assert.match(settledNote(cu, 'orig'), /caught up on your 2 replies since their last prompt\. In place of those messages \("First reply\."; "Second reply\."\)/)
  assert.match(settledNote({ ...cu, catchup: { ...cu.catchup, dismissed: true } }, shownKey(cu)), /went back to reading your 2 replies/)
  // the terms of a message's explainers, not its heads-ups
  assert.deepEqual(termsOf({ items: { a: { id: 'a', term: 'hydrate' }, b: { id: 'b', term: 'the cache', kind: 'heads' } }, order: ['a', 'b'] }), ['hydrate'])
})
