// A squeeze's rewrite (squeeze/chips.mjs): the rewrite is held to the original's citations and numbers; a simpler
// version's request names one message to make simpler, at Length short and Background learning; Simplify's words on
// citing come only while Claude cites its claims, and in manual and off the request names the analyst's citations; the
// choices under it stop at each end and never land on the original; a record kept before very short was added keeps
// its levels. Made-up data only.
// node --test plugin/squeeze/test/chips.test.mjs
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { ASKED_HEAD, CATCHUP_HEAD, CHOICES, CITING, SCALE, SIMPLIFY_AT, SIMPLIFY_HEAD, checkRewrite, chipsOf, choiceAt, fromVersions, isSimplify, mapLinks, request, settledNote, squeezeText, upgradeSqueeze } from '../chips.mjs'

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

test("a simpler version's request names one message to make simpler, at Length short and Background learning; Claude hears it stands below the message", () => {
  const rec = { id: 'r1#cu', row: 'r1', text: TEXT, at: '2026-01-01T00:00:00Z', shown: null, squeeze: { at: { ...SIMPLIFY_AT } }, catchup: { host: 'r1', rows: ['r1'], replies: 1, question: 'why did it fail?', prompt: null, kind: 'simplify' } }
  assert.deepEqual({ ...SIMPLIFY_AT }, { length: 1, familiarity: 1 })
  assert.equal(isSimplify(rec), true)
  assert.equal(isSimplify({ ...rec, catchup: { ...rec.catchup, kind: undefined } }), false)
  const req = request(rec, { system: 'squeeze', question: 'why did it fail?' })
  const head = req.prompt[0].text
  assert.match(head, /Write one simpler message of it/)
  assert.ok(head.includes(SIMPLIFY_HEAD))
  assert.ok(!head.includes(CATCHUP_HEAD))
  const tail = req.prompt[1].text
  assert.match(tail, /- Length: short\./)
  assert.match(tail, /- Background: learning\./)
  // the levels' names, as the chips show them
  assert.deepEqual(chipsOf(rec).map(c => c.levels[c.level]), ['short', 'learning'])
  const note = settledNote({ ...rec, shown: 'The cart fixture was shared, so a coupon leaked.' })
  assert.match(note, /^Below your message \("Fixed test_checkout_total\. It failed in about 1 run…"\), which still shows as you wrote it/)
  assert.match(note, /Length: short, Background: learning/)
  assert.match(settledNote({ ...rec, shown: 'x', catchup: { ...rec.catchup, dismissed: true } }, 'cu:x:1'), /closed the simpler version/)
})

test("Simplify's words on citing come only while Claude cites; in manual and off, the request names the analyst's citations instead, and no level asks for a citation of Claude's own", () => {
  const system = readFileSync(new URL('../../prompts/squeeze.md', import.meta.url), 'utf8')
  const card = { id: 'c1a2b3c4d5', title: 'Runs by night', columns: ['night', 'runs'], sample: '{"night":1,"runs":3}', drawn: 'Runs by night', view: 'function view() {}' }
  const rec = { id: 'r1#s', row: 'r1', text: TEXT.replace('[passed 200 times in a row](#)', 'passed 200 times in a row'), shown: null, squeeze: { at: { length: 3, familiarity: 1 } }, catchup: { host: 'r1', rows: ['r1'], replies: 1, kind: 'simplify' } }
  // squeeze.md has the principle on citations that CITING names, and it is the one line that shows a citation
  assert.equal(system.split('\n').filter(l => l.startsWith(CITING)).length, 1)
  assert.doesNotMatch(squeezeText(system, false), /\]\(#\)/)
  // while Claude cites (auto + verify, auto): the principle, and each new number cited
  const auto = request(rec, { system, cards: [card] })
  assert.ok(auto.system[0].text.includes(system.split('\n').find(l => l.startsWith(CITING))))
  assert.match(auto.system[0].text, /a card or a card's rows, and cite each new number\.\*\*/)
  assert.match(auto.prompt[1].text, /Add detail from the cards and their rows where it helps, each new number cited\./)
  // in manual and off: no principle on citations, and no new number cited
  const manual = request(rec, { system, cards: [card], cites: false })
  assert.doesNotMatch(manual.system[0].text.split('## Your reply')[0], /citation/)
  assert.doesNotMatch(manual.system[0].text, /cite each new number|\{\{/)
  assert.match(manual.system[0].text, /a card or a card's rows\.\*\*/)
  assert.match(manual.prompt[1].text, /Add detail from the cards and their rows where it helps\./)
  assert.doesNotMatch(manual.prompt[1].text, /cited/)
  assert.doesNotMatch(manual.prompt[0].text, /Words the analyst cited/)
  // the words the analyst cited with c are named, as the original writes them
  const asked = request({ ...rec, text: rec.text.replace('about 1 run in 9', 'about [1 run in 9](#)') }, { system, cards: [card], cites: false, asked: ['1 run in 9'] })
  assert.ok(asked.prompt[0].text.includes(`${ASKED_HEAD}\n- [1 run in 9](#)`))
})

const choice = words => CHOICES.find(c => c.words === words)

test('the choices move one chip one level, stop at its end, and step past the original, which a simpler version never shows', () => {
  const rec = { id: 'r1#s', row: 'r1', text: TEXT, shown: 'x', squeeze: { at: { ...SIMPLIFY_AT } }, catchup: { host: 'r1', rows: ['r1'], replies: 1, kind: 'simplify' } }
  assert.deepEqual(CHOICES.map(c => `${c.key} ${c.words}`), ['1 shorter', '2 longer', '3 explain more', '4 assume more'])
  assert.deepEqual(choiceAt(rec, { length: 1, familiarity: 1 }, choice('shorter')), { length: 0, familiarity: 1 })
  assert.equal(choiceAt(rec, { length: 0, familiarity: 1 }, choice('shorter')), null)
  assert.equal(choiceAt(rec, { length: 4, familiarity: 1 }, choice('longer')), null)
  assert.equal(choiceAt(rec, { length: 1, familiarity: 0 }, choice('explain more')), null)
  // as written at learning, then assume more: working would be the original, so it goes on to expert
  assert.deepEqual(choiceAt(rec, { length: 2, familiarity: 1 }, choice('assume more')), { length: 2, familiarity: 3 })
  assert.equal(choiceAt(rec, { length: 2, familiarity: 3 }, choice('assume more')), null)
  // very short asks for one or two sentences
  assert.match(request({ ...rec, squeeze: { at: { length: 0 } } }).prompt[1].text, /- Length: very short\. One or two sentences/)
})

test('a record kept at scale 5 reads with Length one level higher: its levels, its versions and its cards keep what they were written at', () => {
  const old = { at: { length: 0, familiarity: 1 }, scale: 5, versions: { 'length=0&familiarity=1': 'short', 'familiarity=1': 'as written', 'length=2': 'longer' }, cards: { 'length=0&familiarity=1': { rows: {}, did: [] } }, made: [{ key: 'length=0&familiarity=1', ms: 1 }] }
  const up = upgradeSqueeze(old)
  assert.equal(up.scale, SCALE)
  assert.deepEqual(up.at, { length: 1, familiarity: 1 })
  assert.deepEqual(up.versions, { 'length=1&familiarity=1': 'short', 'familiarity=1': 'as written', 'length=3': 'longer' })
  assert.deepEqual(Object.keys(up.cards), ['length=1&familiarity=1'])
  assert.equal(up.made[0].key, 'length=1&familiarity=1')
  // read again, it stays as it is
  assert.deepEqual(upgradeSqueeze(up), up)
  const rec = { text: TEXT, shown: 'short', squeeze: up }
  assert.deepEqual(chipsOf(rec).map(c => c.levels[c.level]), ['short', 'learning'])
  assert.equal(fromVersions(rec, { length: 3 }).shown, 'longer')
})
