// The squeeze chips' pure parts (squeeze/chips.mjs): chip state with its levels, every chip in one request, the
// reply read and held to the original, the marks placed again after a
// rewrite, the text cut as it writes itself in, and the original restored. node --test squeeze/test
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { newRecord, remark, verbsOf, withObserver } from '../../shell/message.js'
import { ARRIVE, CATCHUP_HEAD, CHIPS, answerText, applyRewrite, atOf, cardListsAt, drawnOf, cardNotesFor, cardSpec, cardsAfter, cardsBlock, cardsDid, cardsKnown, queryIdsOf, toolkitOf, withLater, catchUpStands, catchUpText, checkRewrite, chipsOf, dropOrphanHeads, fromVersions, glyph, isCatchUp, isHeading, isLong, isOriginal, keepCorrections, keyOf, levelWords, mustKeep, ownWords, readReply, setWords, settledNote, shownKey, withOwn, rebaseAt, request, restore, revealCut, revealStep, rowsOf, stepAt, termsOf, unplacedMoves } from '../chips.mjs'

// a made-up report, as a long reply takes it
const TEXT = [
  '**Fixed `test_checkout_total`.** It failed in about [1 run in 9](q2#test=checkout@fail_rate) because the `cart` fixture in [tests/conftest.py:14](tests/conftest.py#L14) had `scope="module"`.',
  '',
  'The coupon test left a coupon on the shared cart. Failures by day [~](q5@n).',
  '',
  '- The fix is one line.',
  '- The test then [passed 200 times in a row](q3#test=checkout@passes).',
].join('\n')
const PROMPT = readFileSync(fileURLToPath(new URL('../../prompts/squeeze.md', import.meta.url)), 'utf8')

function record() {
  const rec = newRecord({ row: 'r1', session: 's1', text: TEXT })
  rec.marks.find(m => m.kind === 'spark').values = [3, 1, 4, 1, 5]
  return withObserver(rec, { verbs: {}, glosses: { g1: { term: 'fixture' }, g2: { term: 'coupon test' } } })
}

test('every message has the same chips: Length (5, the original in the middle), Interpretation (3), Background (4); the observer only says where the original stands', () => {
  const rec = record()
  const chips = chipsOf(rec)
  assert.deepEqual(chips.map(c => c.name), ['Length', 'Interpretation', 'Background'])
  assert.deepEqual(chips.map(c => c.levels), [['one line', 'short', 'as written', 'longer', 'much longer'], ['facts only', 'some meaning', 'full meaning'], ['new', 'learning', 'working', 'expert']])
  assert.deepEqual(chips.map(c => c.levels[c.level]), ['as written', 'some meaning', 'working'])
  assert.deepEqual(chips.map(c => c.known), [true, false, false])
  assert.ok(isOriginal(chips))
  assert.equal(keyOf(chips), '')
  // the observer's levels, by the chips' names now, by index, or by older names; a proposed new dimension is ignored
  const seen = withObserver(rec, { verbs: { s: { at: { interpretation: 'facts only', background: 3 }, chips: [{ name: 'Story', levels: ['hidden', 'full'] }] } }, glosses: rec.glosses })
  const c2 = chipsOf(seen)
  assert.deepEqual(c2.map(c => c.name), ['Length', 'Interpretation', 'Background'])
  assert.deepEqual(c2.map(c => c.levels[c.level]), ['as written', 'facts only', 'expert'])
  assert.ok(c2.every(c => c.known))
  assert.equal(CHIPS.length, 3)
  const older = withObserver(rec, { verbs: { s: { at: { interpret: 'report', familiarity: 'fluent' } } }, glosses: rec.glosses })
  assert.deepEqual(chipsOf(older).map(c => c.levels[c.level]), ['as written', 'facts only', 'expert'])
  const oldest = withObserver(rec, { verbs: { s: { at: { interpret: 'both', familiarity: 'new to the field' } } }, glosses: rec.glosses })
  assert.deepEqual(chipsOf(oldest).map(c => c.levels[c.level]), ['as written', 'some meaning', 'new'])
  // the observer's s may carry only where the answer stands: the record keeps it, unlit
  const kept = verbsOf({ s: { at: { interpretation: 'Full meaning', background: 'learning' } } })
  assert.deepEqual(kept.s, { lit: false, note: '', at: { interpretation: 'full meaning', background: 'learning' }, chips: [] })
  assert.deepEqual(chipsOf({ ...rec, verbs: kept }).map(c => c.levels[c.level]), ['as written', 'full meaning', 'learning'])
})

test('a chip steps one level at a time and stops at its ends; its dots show one ● at its place', () => {
  const rec = record()
  // the original stands in the middle of Length: a step shorter or longer
  assert.deepEqual(stepAt(rec, 'length', -1), { length: 1 })
  assert.deepEqual(stepAt(rec, 'length', 1), { length: 3 })
  assert.equal(stepAt({ ...rec, squeeze: { at: { length: 4 }, scale: 3 } }, 'length', 1), null)
  const at = { length: 0 }
  assert.equal(stepAt({ ...rec, squeeze: { at } }, 'length', -1), null)
  assert.deepEqual(stepAt(rec, 'familiarity', 1), { familiarity: 3 })
  const [len, interp, fam] = chipsOf(rec)
  assert.equal(glyph(len, 1), '○●○○○')
  assert.equal(glyph(len, 2), '○○●○○')
  assert.equal(glyph(len, 4), '○○○○●')
  // the level in words: `as written` where the original stands, with its name on a chip the observer placed
  assert.equal(levelWords(len), 'as written')
  assert.equal(levelWords({ ...len, level: 3 }), 'longer')
  assert.equal(levelWords(interp), 'as written')
  assert.equal(levelWords({ ...interp, known: true }), 'some meaning, as written')
  assert.equal(glyph(interp, 0), '●○○')
  assert.equal(glyph(interp, 2), '○○●')
  assert.equal(glyph(fam, 0), '●○○○')
  assert.equal(glyph(fam, 3), '○○○●')
  // the version's key names only the levels that differ from the original
  assert.equal(keyOf(chipsOf({ ...rec, squeeze: { at: { length: ARRIVE, interpret: 1 } } })), 'length=1')
})

test("a step made before the observer placed the original counts again from the level it gives; Length and placed chips are left as they are", () => {
  const rec = record()
  const placed = withObserver(rec, { verbs: { s: { at: { interpretation: 'full meaning', background: 'learning' } } }, glosses: {} })
  // one step toward facts only from the middle moves Interpretation before anyone said where the original is
  assert.deepEqual(unplacedMoves(rec, { length: 1, interpret: 0 }), ['interpret'])
  assert.deepEqual(unplacedMoves(rec, { length: 1 }), [])
  assert.deepEqual(unplacedMoves(placed, { interpret: 0 }), [])
  // the original stands at full meaning: one step toward facts only is some meaning; Length stays as set
  assert.deepEqual(rebaseAt(rec, placed, { length: 1, interpret: 0 }), { length: 1, interpret: 1 })
  // one step up from working (to expert), the original at learning: working
  assert.deepEqual(rebaseAt(rec, placed, { familiarity: 3 }), { familiarity: 2 })
  // a step that lands on the original's level, or past an end, is the original on that chip
  assert.deepEqual(rebaseAt(rec, placed, { familiarity: 1 }), { familiarity: 0 })
  const atReport = withObserver(rec, { verbs: { s: { at: { interpretation: 'facts only' } } }, glosses: {} })
  assert.deepEqual(rebaseAt(rec, atReport, { length: 2, interpret: 0 }), { length: 2 })
  // nothing to count again when the observer has said nothing, or had placed the chip already
  assert.deepEqual(rebaseAt(rec, rec, { interpret: 0 }), { interpret: 0 })
  assert.deepEqual(rebaseAt(placed, placed, { interpret: 1 }), { interpret: 1 })
  // the arrival's version stays the same version whatever level the observer gives: its other chips are as the original
  assert.equal(keyOf(chipsOf({ ...placed, squeeze: { at: { length: ARRIVE } } })), keyOf(chipsOf({ ...rec, squeeze: { at: { length: ARRIVE } } })))
})

test('a rewrite is held to the original: a ref it never cited loses its link, and a number it never states is named', () => {
  const out = checkRewrite(TEXT, 'Fixed in [2 tries](q9#x@n); it failed [1 run in 9](q2#test=checkout@fail_rate), 12% of runs.')
  assert.equal(out.text, 'Fixed in 2 tries; it failed [1 run in 9](q2#test=checkout@fail_rate), 12% of runs.')
  assert.equal(out.problems.length, 2)
  assert.match(out.problems[0], /q9#x@n is not in the original/)
  assert.match(out.problems[1], /"12" is not in the original/)
  assert.deepEqual(checkRewrite(TEXT, 'It failed about [1 in 9](q2#test=checkout@fail_rate); now it [passed 200 times](q3#test=checkout@passes).').problems, [])
  // a kept ref whose words state another number of the text: the words stay, the link goes
  const moved = checkRewrite(TEXT, 'The fix held [200 times](tests/conftest.py#L14); it [passed 200 times](q3#test=checkout@passes).')
  assert.equal(moved.text, 'The fix held 200 times; it [passed 200 times](q3#test=checkout@passes).')
  assert.match(moved.problems[0], /"200 times" was linked to the source of "tests\/conftest.py:14"/)
  // the cited value with a date or a total beside it is kept; a total alone in place of the value is not
  const orig = 'Most saves came on [6,543](q1#day=18@n) days, [13,403 of 14,591](q10#wiki=dse@n) on one wiki.'
  assert.deepEqual(checkRewrite(orig, 'Peak: [6,543 on Jun 18](q1#day=18@n); [13,403 saves](q10#wiki=dse@n).').problems, [])
  const total = checkRewrite(orig, 'Of [14,591 edits](q10#wiki=dse@n), most came on one day.')
  assert.equal(total.text, 'Of 14,591 edits, most came on one day.')
  assert.match(total.problems[0], /"14,591 edits" was linked to the source of "13,403 of 14,591"/)
})

test('after a rewrite the marks are placed again on the new text: citations, a sparkline with its values, each gloss on its term or a word of it', () => {
  const rec = record()
  const short = '**Fixed:** a shared `cart` fixture leaked a coupon, about [1 run in 9](q2#test=checkout@fail_rate) [~](q5@n); now it [passed 200 times](q3#test=checkout@passes).'
  const next = applyRewrite(rec, { text: short, at: { length: 0 }, made: { ms: 900, model: 'sonnet' } }, remark)
  assert.equal(next.shown, short)
  const at = m => short.slice(m.start, m.end)
  assert.deepEqual(next.marks.filter(m => m.kind !== 'gloss').map(at), ['[1 run in 9](q2#test=checkout@fail_rate)', '[~](q5@n)', '[passed 200 times](q3#test=checkout@passes)'])
  assert.deepEqual(next.marks.find(m => m.kind === 'spark').values, [3, 1, 4, 1, 5])
  // `fixture` stayed as it was; of `coupon test` only "coupon" stayed, and the explain stands on it
  assert.deepEqual(next.marks.filter(m => m.kind === 'gloss').map(m => [m.gloss, at(m), m.anchor ?? 'term']), [['g1', 'fixture', 'term'], ['g2', 'coupon', 'word']])
  assert.equal(next.squeeze.versions['length=0'], short)
  assert.equal(next.squeeze.made[0].ms, 900)
  // the original's marks are kept, so a later version that brings the sparkline back still has its values
  const again = applyRewrite(next, { text: 'Failures [~](q5@n), [1 run in 9](q2#test=checkout@fail_rate).', at: { length: 1 } }, remark)
  assert.deepEqual(again.marks.find(m => m.kind === 'spark').values, [3, 1, 4, 1, 5])
  // what the bar says of it: the levels set, never a count of lines
  assert.equal(setWords(again), 'short')
  // what Claude reads once the person settles on it: the version whole, with the message's first words and time
  const told = settledNote({ ...again, at: '2026-06-18T14:05:00' })
  assert.match(told, /^Your message from 14:05 \("Fixed test_checkout_total\. It failed in about 1 run…"\) now reads, for the analyst, as:\n\nFailures \[~\]\(q5@n\), \[1 run in 9\]\(q2#test=checkout@fail_rate\)\.\n\n\(The squeeze chips wrote this version of yours \(Length: short\)\. What you wrote is unchanged, and the analyst can go back to it\.\)$/)
  // told once: the same version again says nothing; back at the original, Claude hears so
  assert.equal(settledNote(again, shownKey(again)), '')
  assert.match(settledNote(restore(again, remark), shownKey(again)), /reads again, for the analyst, as you wrote it\.$/)
  assert.equal(settledNote(restore(again, remark)), '')
})

test('a level seen before comes back with no call, and the original comes back with its own marks', () => {
  const rec = record()
  const a = applyRewrite(rec, { text: 'Short: [1 run in 9](q2#test=checkout@fail_rate).', at: { length: 1 } }, remark)
  const b = applyRewrite(a, { text: 'One line.', at: { length: 0 } }, remark)
  const back = fromVersions(b, { length: 1 }, remark)
  assert.equal(back.shown, 'Short: [1 run in 9](q2#test=checkout@fail_rate).')
  assert.equal(fromVersions(b, { length: 3 }, remark), null)
  const orig = restore(b, remark)
  assert.equal(orig.shown, null)
  assert.deepEqual(orig.squeeze.at, {})
  assert.deepEqual(orig.marks.map(m => `${m.kind} ${m.start}`), rec.marks.map(m => `${m.kind} ${m.start}`))
  assert.deepEqual(orig.marks.find(m => m.kind === 'spark').values, [3, 1, 4, 1, 5])
  assert.ok(isOriginal(chipsOf(orig)))
  // the versions written stay, so a level seen before still comes back after the original
  assert.equal(fromVersions(orig, { length: 0 }, remark).shown, 'One line.')
})

test('a message taller than half the screen arrives squeezed; the rows count as drawn', () => {
  assert.equal(rowsOf('a\n\nb', 100), 3)
  assert.equal(rowsOf('word '.repeat(50).trim(), 100), 3)
  assert.equal(rowsOf('[a long label](q1#x@n)', 10), 1)
  const long = Array.from({ length: 40 }, (_, i) => `Line ${i} of a long answer.`).join('\n')
  assert.ok(isLong(long, { cols: 100, room: 26 }))
  assert.ok(!isLong(TEXT, { cols: 100, room: 26 }))
  assert.ok(!isLong(long, { cols: 100, room: 60 }))
})

test('readReply takes the text from its tags, or the whole reply when it gave none, and the card changes after it', () => {
  const none = { cards: [], cardProblems: [] }
  assert.deepEqual(readReply('<text>\nA.\n</text>'), { text: 'A.', ...none })
  assert.deepEqual(readReply('A plain reply.'), { text: 'A plain reply.', ...none })
  assert.deepEqual(readReply('```markdown\nB.\n```'), { text: 'B.', ...none })
  const reply = [
    '<text>\nShort.\n</text>',
    '<card edit="01-saves">\n<title>Saves each day</title>\n<takeaway>June 18 had the most\n saves.</takeaway>\n</card>',
    '<card add="saves-by-hour">\n<title>Saves by hour</title>\n<takeaway>Most came at noon.</takeaway>\n<data>{"hours": "r2"}</data>\n<program>\nreturn k.bars(data.hours.map(h => ({ id: `h${h.hour}`, label: h.hour, value: h.n })))\n</program>\n</card>',
    '<card drop="02-old"/>',
    '<card add="broken">\n<title>No data</title>\n<program>return 1</program>\n</card>',
    '<card edit="03-x">\n<data>[1, 2]</data>\n</card>',
  ].join('\n')
  const got = readReply(reply)
  assert.equal(got.text, 'Short.')
  assert.deepEqual(got.cards, [
    { op: 'edit', id: '01-saves', title: 'Saves each day', takeaway: 'June 18 had the most saves.' },
    { op: 'add', id: 'saves-by-hour', title: 'Saves by hour', takeaway: 'Most came at noon.', program: 'return k.bars(data.hours.map(h => ({ id: `h${h.hour}`, label: h.hour, value: h.n })))', data: { hours: 'r2' } },
    { op: 'drop', id: '02-old' },
  ])
  assert.equal(got.cardProblems.length, 2)
  assert.match(got.cardProblems[0], /the new card broken came without its data/)
  assert.match(got.cardProblems[1], /card 03-x gave data that is no JSON object/)
  // a reply with no text tags: the card blocks are no part of the text
  assert.equal(readReply('Plain.\n<card drop="02-old"/>').text, 'Plain.')
})

test("a squeeze's cards: the request shows the original's cards and the outputs they draw on; each version keeps the cards it drew, the original comes back with its own, and a card made since is kept", () => {
  const cards = [{ id: '01-saves', title: 'Saves per day', text: 'June 18 had [6,543](q1#day=2026-06-18@n).', data: { days: 'q1' }, program: 'return k.bars([])' }]
  const outputs = [{ id: 'q1', about: 'saves per day', text: '   day      n\n0  06-18  6543' }]
  const block = cardsBlock(cards, outputs)
  assert.match(block, /^The cards drawn under the original, in order:\n<card id="01-saves">\n<title>Saves per day<\/title>/)
  assert.match(block, /<data>\{"days":"q1"\}<\/data>\n<program>\nreturn k.bars\(\[\]\)\n<\/program>/)
  assert.match(block, /<output id="q1" about="saves per day">\n   day      n\n0  06-18  6543\n<\/output>/)
  assert.equal(cardsBlock([], []), '')
  assert.deepEqual(queryIdsOf(['See [6,543](q1#day=1@n) and [~](r4@n), and [x](r4#a=1).'], ['q1#/days', 'r2']), ['q1', 'r2', 'r4'])
  // the request: the block after the original, and the toolkit as a second cached system block
  const rec = { ...record(), squeeze: { at: { length: 4 }, scale: 3 } }
  const req = request(rec, { system: 'P', toolkit: 'TOOLKIT', cards, outputs })
  assert.deepEqual(req.system.map(x => x.text), ['P', 'TOOLKIT'])
  assert.match(req.prompt[0].text, /<\/original>\n\nThe cards drawn under the original/)
  assert.deepEqual(request(rec, { system: 'P', toolkit: 'TOOLKIT' }).system.map(x => x.text), ['P'])
  assert.equal(toolkitOf('# G\n\n## What\n\nx\n\n## The toolkit\n\nk.bars\n\n## Worked programs\n\ny'), '## The toolkit\n\nk.bars')
  // an edit lays its parts over the original's spec; an add is its own
  assert.deepEqual(cardSpec({ op: 'edit', id: '01-saves', takeaway: 'Plainer.', data: { hours: 'q2' } }, { title: 'T', text: 'Old.', data: { days: 'q1' }, program: 'P' }), { title: 'T', text: 'Plainer.', data: { days: 'q1', hours: 'q2' }, program: 'P' })
  assert.deepEqual(cardSpec({ op: 'add', id: 'x', title: 'X', program: 'P2', data: { a: 'q2' } }, { title: 'T' }), { title: 'X', program: 'P2', data: { a: 'q2' } })
  // the versions: one edits a card and adds one, one leaves a card out; the original has its own
  const A = { id: '01-saves', v: 1, root: '/d' }, B = { id: '02-hours', v: 1, root: '/d' }
  const orig = { r1: [A, B] }
  const longer = cardsAfter(orig, 'r1', [{ op: 'edit', id: '01-saves', ref: { id: '01-saves', v: 2, root: '/d' }, title: 'Saves per day' }, { op: 'add', id: '03-new', ref: { id: '03-new', v: 1, root: '/d' }, title: 'New' }])
  assert.deepEqual(longer.rows.r1.map(x => `${x.id}@${x.v}`), ['01-saves@2', '02-hours@1', '03-new@1'])
  assert.deepEqual(longer.did.map(d => d.did), ['edited', 'added'])
  const shorter = cardsAfter(orig, 'r1', [{ op: 'drop', id: '02-hours', title: 'Hours' }])
  assert.deepEqual(shorter.rows.r1.map(x => x.id), ['01-saves'])
  const remark = r => r
  let r = applyRewrite({ ...record(), squeeze: {} }, { text: 'Longer.', at: { length: 3 }, cards: longer, origCards: orig }, remark)
  r = applyRewrite(r, { text: 'Short.', at: { length: 1 }, cards: shorter, origCards: orig }, remark)
  r = applyRewrite(r, { text: 'Facts.', at: { interpret: 0 }, cards: null, origCards: orig }, remark)
  assert.deepEqual(cardListsAt(r).r1.map(x => x.id), ['01-saves', '02-hours'])
  assert.deepEqual(cardsDid(r), [])
  const back = fromVersions(r, { length: 3 }, remark)
  assert.deepEqual(cardListsAt(back).r1.map(x => `${x.id}@${x.v}`), ['01-saves@2', '02-hours@1', '03-new@1'])
  assert.deepEqual(cardNotesFor(back, 'r1'), { marks: { '01-saves': 'edited', '03-new': 'added' }, left: [] })
  assert.deepEqual(cardNotesFor(fromVersions(r, { length: 1 }, remark), 'r1'), { marks: {}, left: ['Hours'] })
  const orig2 = restore(back, remark)
  assert.deepEqual(cardListsAt(orig2).r1.map(x => `${x.id}@${x.v}`), ['01-saves@1', '02-hours@1'])
  // a card v made under the answer since: kept after the cards the squeeze answers for
  const C = { id: '04-later', v: 1, root: '/d' }
  assert.deepEqual(withLater([A, B, C], longer.rows.r1, cardsKnown(back)).map(x => x.id), ['01-saves', '02-hours', '03-new', '04-later'])
  // Claude hears what the version did to the cards, and that they came back
  assert.match(settledNote(back), /Its cards changed with it: "Saves per day" \(01-saves\) edited, now version 2; "New" \(03-new\) added\./)
  assert.match(settledNote(orig2, shownKey(back)), /as you wrote it, with its cards as they were\.$/)
  // a rewrite is held to the whole answer it was shown: a value a card draws, or a ref its takeaway cites, is no addition
  const drawnCard = { title: 'Saves per day', text: 'June 18 had [6,543](q1#day=2026-06-18@n).', drawn: drawnOf({ data: { days: [{ day: '06-17', n: 4210, _ref: 'q1#day=06-17', _rows: ['x#row=1'] }] } }) }
  assert.equal(drawnCard.drawn, '{"days":[{"day":"06-17","n":4210}]}')
  const longerText = 'June 17 had 4,210 saves and June 18 had [6,543](q1#day=2026-06-18@n).'
  assert.deepEqual(checkRewrite('Most saves came on June 18.', longerText).problems.length, 2)
  assert.deepEqual(checkRewrite(answerText('Most saves came on June 18.', [drawnCard]), longerText).problems, [])
  // a value the answer states, rounded or as a percent, is no addition; a value it never states is
  assert.deepEqual(checkRewrite('Its rate was 0.369 and its mean 36.94 steps.', 'About 37% of them, with 36.9 steps on average.').problems, [])
  assert.deepEqual(checkRewrite('Its rate was 0.369.', 'About 39% of them.').problems, ['"39" is not in the original'])
  // a record no rewrite touched the cards of: nothing to place
  assert.equal(cardListsAt(applyRewrite({ ...record(), squeeze: {} }, { text: 'S.', at: { length: 1 } }, remark)), null)
})

test('the new text writes itself in from the top: each cut ends a word and never splits a link, code, bold or a table row', () => {
  const t = '**Status:** fixed. The [cart fixture](q1#x@n) is `scope="module"`, shared.\n\n| run | steps |\n|---|---|\n| r17 | 2,143 |'
  assert.equal(revealCut(t, 0), '**Status:**')
  assert.equal(revealCut(t, 3), '**Status:**')
  assert.equal(revealCut(t, 14), '**Status:** fixed.')
  assert.equal(revealCut(t, 26), '**Status:** fixed. The [cart fixture](q1#x@n)')
  assert.equal(revealCut(t, 52), '**Status:** fixed. The [cart fixture](q1#x@n) is `scope="module"`,')
  assert.ok(revealCut(t, 80).endsWith('| run | steps |'))
  assert.equal(revealCut(t, 1000), t)
  // every cut is a prefix of the text, and they grow
  let last = ''
  for (let n = 0; n <= t.length; n += 7) {
    const c = revealCut(t, n)
    assert.ok(t.startsWith(c))
    assert.ok(c.length >= last.length)
    last = c
  }
  // the pace: about 400 characters a second, never more than about 2.5 s for the whole
  assert.equal(revealStep(300, 50), 20)
  assert.equal(revealStep(5000, 50), 100)
})

test('the rewrite names the terms of the message\'s explain marks, to keep in their words', () => {
  const rec = record()
  const req = request({ ...rec, squeeze: { at: { length: 0 } } }, { system: PROMPT, question: '', terms: termsOf(rec), model: 'sonnet', effort: 'low', maxTokens: 4000 })
  assert.match(req.prompt[1].text, /Terms the analyst can open an explainer of\. Where your text keeps what a term names, use the term in these words:\n- fixture\n- coupon test/)
})

test('the corrections of its own earlier answer are found in the original: a list under a lead, a paragraph, a sentence; an offer is not one', () => {
  const list = 'The answer.\n\nTwo corrections to my last answer:\n- **AgentRelent:** 316, not 317.\n- **The split:** 5,242, not 5,181.\n\nCaveats: rough.'
  assert.deepEqual(mustKeep(list), ['**AgentRelent:** 316, not 317.', '**The split:** 5,242, not 5,181.'])
  const para = 'The answer.\n\n**I also need to correct something I told you.** I said it was many agents. It may be one process.'
  assert.deepEqual(mustKeep(para), ['**I also need to correct something I told you.** I said it was many agents. It may be one process.'])
  assert.deepEqual(mustKeep('June 18 was the peak. Earlier I said 21:25; the last save was at 22:10.'), ['Earlier I said 21:25; the last save was at 22:10.'])
  assert.deepEqual(mustKeep('I can check whether the answers were actually wrong, if you want.'), [])
  assert.deepEqual(mustKeep('June 18 had 6,543 saves, most of them on one page.'), [])
})

test('a rewrite that leaves a correction out gets it back after it; one that kept it in other words is left as it is', () => {
  const keep = ['**AgentRelent:** 316, not 317.', '**The split:** 5,242, not 5,181.']
  const r = keepCorrections('The peak was June 18 (316 edits, not 317).', keep)
  assert.deepEqual(r.back, ['**The split:** 5,242, not 5,181.'])
  assert.ok(r.text.endsWith('\n\n**The split:** 5,242, not 5,181.'))
  assert.deepEqual(keepCorrections('Peak June 18; earlier I said 317 and 5,181, it is 316 and 5,242.', keep).back, [])
})

// a correction section whose second item is a heading over a list of its own, as Claude writes one
const NESTED = [
  'First, two corrections to my last answer:',
  '- **The 70% leaves out round 1.** Reading is 70% of calls only in rounds 2 and 3; in round 1 building takes [55%](q4#row=3@build).',
  '- **The numbers I did not cite before:**',
  '  - Mid-run, Tern spends [37%](q4#row=24@test) of calls testing.',
  '  - 81 of the 86 idle helpers are in round 1 ([13](q2#run=r1-a@idle) + [68](q2#run=r1-b@idle)).',
  '',
  'Helper-44 then ran for 6 hours, from 07:30 to 13:30, and made 2 merges.',
].join('\n')

test('a correction that heads a list keeps the list: its sub-items are part of it, in the request as in the original', () => {
  const keep = mustKeep(NESTED)
  assert.equal(keep.length, 2)
  assert.equal(keep[1], '**The numbers I did not cite before:**\n  - Mid-run, Tern spends [37%](q4#row=24@test) of calls testing.\n  - 81 of the 86 idle helpers are in round 1 ([13](q2#run=r1-a@idle) + [68](q2#run=r1-b@idle)).')
  const tail = request({ text: NESTED, squeeze: { at: { length: 1 } } }, { system: 'S', keep }).prompt[1].text
  // the sub-items stand under their heading, one level in
  assert.match(tail, /\n- \*\*The numbers I did not cite before:\*\*\n {2}- Mid-run, Tern spends \[37%\]\(q4#row=24@test\) of calls testing\.\n {2}- 81 of the 86 idle helpers/)
})

test('a sub-item the rewrite left out comes back under its heading; a heading never comes back alone; a number said elsewhere in the original is not the correction\'s', () => {
  const keep = mustKeep(NESTED)
  // the rewrite keeps the 70% correction and the 37%, and drops the idle helpers; "13" of 13:30 is no sign they stayed
  const rewrite = 'Round 1 differs: building takes [55%](q4#row=3@build) there, and Tern tests [37%](q4#row=24@test) of calls. Helper-44 ran 6 hours, to 13:30.'
  const r = keepCorrections(rewrite, keep, NESTED)
  assert.deepEqual(r.back, ['**The numbers I did not cite before:**\n- 81 of the 86 idle helpers are in round 1 ([13](q2#run=r1-a@idle) + [68](q2#run=r1-b@idle)).'])
  assert.ok(r.text.endsWith('\n\n**The numbers I did not cite before:**\n- 81 of the 86 idle helpers are in round 1 ([13](q2#run=r1-a@idle) + [68](q2#run=r1-b@idle)).'))
  // without the original, the 13 of 13:30 would pass for the [13] of the idle helpers
  assert.deepEqual(keepCorrections(rewrite, keep).back, [])
  // every sub-item kept: nothing comes back, not even the heading
  assert.deepEqual(keepCorrections(`${rewrite} 81 of 86 idle helpers are round 1.`, keep, NESTED).back, [])
})

test('a rewrite that ends on a heading with nothing under it loses the heading; a bold sentence at the end stays', () => {
  assert.deepEqual(dropOrphanHeads('Helper-44 made 2 merges.\n\n**The numbers I did not cite before:**'), { text: 'Helper-44 made 2 merges.', dropped: ['**The numbers I did not cite before:**'] })
  assert.deepEqual(dropOrphanHeads('Two things.\n\n## Caveats\n\n- **Next:**').dropped, ['## Caveats', '- **Next:**'])
  assert.equal(dropOrphanHeads('Helper-44 made 2 merges.\n\n**Fix it before you send it.**').text, 'Helper-44 made 2 merges.\n\n**Fix it before you send it.**')
  assert.equal(dropOrphanHeads('**Only a heading:**').text, '**Only a heading:**')
  assert.ok(isHeading('- **Caveats**') && isHeading('Two corrections to my last answer:') && !isHeading('**It is 316.**') && !isHeading('It ran to 13:30.'))
})

test('the request names the corrections and does not count them in a level\'s length', () => {
  const q = request({ text: 'A. Earlier I said 3; it is 4.', squeeze: { at: { length: 0 } } }, { system: 'S', keep: ['Earlier I said 3; it is 4.'] })
  const tail = q.prompt[1].text
  assert.match(tail, /one line, one sentence with its main point, then each correction listed below in a few words/)
  assert.match(tail, /Corrections in the original\. Each stays at every level, in as few words as it needs, next to what it corrects:\n- Earlier I said 3; it is 4\./)
  assert.doesNotMatch(request({ text: 'A.', squeeze: { at: { length: 0 } } }, { system: 'S' }).prompt[1].text, /Corrections in the original/)
})

test('the request names the terms of the explain marks, to keep in their words; none when the message has no explain marks', () => {
  assert.deepEqual(termsOf(record()), ['fixture', 'coupon test'])
  assert.deepEqual(termsOf({ glosses: { a: { term: '  rebase\n loop ' }, b: { term: 'rebase loop' }, c: {} } }), ['rebase loop'])
  const q = request(record(), { system: 'S', terms: termsOf(record()) })
  assert.match(q.prompt[1].text, /Terms the analyst can open an explainer of\. Where your text keeps what a term names, use the term in these words:\n- fixture\n- coupon test\n/)
  assert.doesNotMatch(request(record(), { system: 'S' }).prompt[1].text, /Terms the person can open/)
})

test('a catch-up is several messages written as one: its original is them in order, its request names them so, and the note tells Claude what the person read', () => {
  const first = 'I will start the reader first.'
  const second = 'The empty label has [741 IPs](q4#label=@ips) for [899 revisions](q4#label=@n).'
  const third = 'The reader is back: 3,104 lines.\n\nI also need to correct something I told you: I wrote that it starts at the first write; it does not.'
  const text = catchUpText([first, `${second}\n`, '', third])
  assert.equal(text, `${first}\n\n---\n\n${second}\n\n---\n\n${third}`)
  const cu = { text, shown: null, marks: [], glosses: {}, verbs: {}, objects: [], catchup: { host: 'r3', rows: ['r1', 'r2', 'r3'], replies: 2, question: 'What does labels.jsonl say about the empty label?', prompt: 'p1' }, squeeze: { at: { length: ARRIVE } } }
  assert.ok(isCatchUp(cu) && catchUpStands(cu))
  assert.ok(!catchUpStands({ ...cu, catchup: { ...cu.catchup, dismissed: true } }))
  assert.ok(!isCatchUp(record()))
  const keep = mustKeep(text)
  assert.deepEqual(keep, ['I also need to correct something I told you: I wrote that it starts at the first write; it does not.'])
  const req = request(cu, { system: 'P', question: cu.catchup.question, keep })
  const head = req.prompt[0].text
  // one header line differs from a single message's request; the rest is the same request
  assert.equal(head, `The analyst asked: What does labels.jsonl say about the empty label?\n\n${CATCHUP_HEAD}\n<original>\n${text}\n</original>`)
  assert.equal(CATCHUP_HEAD, "Claude's messages since the analyst's last prompt, in the order it wrote them, as written (the original). Write them as one message:")
  assert.match(req.prompt[1].text, /- Length: short, about a quarter of the original, about \d+ words/)
  assert.match(req.prompt[1].text, /Corrections in the original\. Each stays at every level/)
  assert.equal(request(record(), { system: 'P' }).prompt[0].text.split('\n')[2], "Claude's message, as written (the original):")
  // nothing for Claude until a version shows; then the version, as the person reads it, and the messages it stands in for
  assert.equal(settledNote(cu), '')
  const shown = applyRewrite(cu, { text: 'The empty label: [741 IPs](q4#label=@ips). The reader counted 3,104 lines; it does not start at the first write.', at: { length: ARRIVE } }, remark)
  assert.match(settledNote(shown), /^The analyst caught up on your 2 replies since their last prompt\. In place of those messages \("[^"]+"; "[^"]+"; "[^"]+"\), they now read one message that the squeeze chips wrote of them \(Length: short\):\n\nThe empty label: \[741 IPs\]\(q4#label=@ips\)\. The reader counted 3,104 lines; it does not start at the first write\.\n\n\(What you wrote is unchanged, and the analyst can go back to it\.\)$/)
  assert.equal(settledNote({ ...shown, catchup: { ...shown.catchup, dismissed: true } }, shownKey(shown)), 'The analyst went back to reading your 2 replies since their last prompt as you wrote them.')
  // its citations are placed on the version, as any message's
  assert.deepEqual(shown.marks.filter(m => m.kind === 'cite').map(m => m.ref), ['q4#label=@ips'])
})

test('longer and much longer ask for more words of the same content; a record from before the scale reads full as the original and medium as short', () => {
  const rec = record()
  const words = request({ ...rec, squeeze: { at: { length: 3 }, scale: 3 } }, { system: PROMPT }).prompt[1].text
  assert.match(words, /- Length: longer, about one and a half times the original, about \d+ words \(levels one line · short · as written · longer · much longer; the original is at "as written", \d+ words\)/)
  assert.match(request({ ...rec, squeeze: { at: { length: 4 }, scale: 3 } }, { system: PROMPT }).prompt[1].text, /- Length: much longer, about two and a half times the original, about \d+ words \(/)
  // a record squeezed before the scale (its versions kept, no scale): full was the original, medium reads as short
  const before = { ...rec, shown: 'Medium.', squeeze: { at: { length: 2 }, versions: { 'length=2': 'Medium.', 'length=1': 'Short.' } } }
  assert.deepEqual(atOf(before), { length: 1 })
  assert.equal(chipsOf(before)[0].levels[chipsOf(before)[0].level], 'short')
  assert.deepEqual(atOf({ ...before, squeeze: { ...before.squeeze, at: { length: 3, interpret: 0 } } }), { interpret: 0 })
  // a version written before keeps short's text and drops medium's, which no level names now
  const kept = applyRewrite(before, { text: 'One line.', at: { length: 0 } }, remark)
  assert.deepEqual(Object.keys(kept.squeeze.versions).sort(), ['length=0', 'length=1'])
  assert.equal(kept.squeeze.scale, 3)
  // a new record's levels are read as set
  assert.deepEqual(atOf({ ...rec, squeeze: { at: { length: 3 } } }), { length: 3 })
})

test('a chip the person typed: its words, as written · a little · more · fully, the original at as written; the request quotes the words', () => {
  const rec = record()
  assert.equal(ownWords('+  for my manager. '), 'for my manager')
  assert.equal(ownWords('  '), '')
  const added = withOwn(rec, 'for my manager')
  assert.equal(added.id, 'x-for-my-manager')
  const r2 = { ...rec, squeeze: added.squeeze }
  const c = chipsOf(r2).at(-1)
  assert.deepEqual([c.name, c.levels, c.level, c.level0], ['for my manager', ['as written', 'a little', 'more', 'fully'], 0, 0])
  assert.equal(levelWords(c), 'as written')
  // the same words again keep the one chip; a fourth goes in place of the oldest
  assert.equal(withOwn(r2, 'For my manager').id, 'x-for-my-manager')
  let r3 = r2
  for (const w of ['more skeptical', 'as a timeline', 'engineer → manager']) r3 = { ...r3, squeeze: withOwn(r3, w).squeeze }
  assert.deepEqual(chipsOf(r3).slice(3).map(x => x.name), ['more skeptical', 'as a timeline', 'engineer → manager'])
  // a step moves it like any chip; the request names it with its words and level
  const at = stepAt(r2, 'x-for-my-manager', 1)
  assert.deepEqual(at, { 'x-for-my-manager': 1 })
  const full = { ...r2, squeeze: { ...r2.squeeze, at: { 'x-for-my-manager': 3 }, scale: 3 } }
  assert.equal(keyOf(chipsOf(full)), 'x-for-my-manager=3')
  assert.match(request(full, { system: PROMPT }).prompt[1].text, /- A chip the analyst typed, "for my manager": fully \(levels as written · a little · more · fully; the original is at "as written"\)/)
  assert.equal(setWords(full), 'fully')
  assert.match(PROMPT, /A chip the analyst typed/)
})
