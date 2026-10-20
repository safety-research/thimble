// A squeeze's rewrite (squeeze/chips.mjs): the model's reply read, and the rewrite held to the original's citations and
// numbers. node --test squeeze/test
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { checkRewrite, readReply, revealCut } from '../chips.mjs'

// a made-up report, as a long reply takes it
const TEXT = [
  '**Fixed `test_checkout_total`.** It failed in about [1 run in 9](q2#test=checkout@fail_rate) because the `cart` fixture in [tests/conftest.py:14](tests/conftest.py#L14) had `scope="module"`.',
  '',
  'The coupon test left a coupon on the shared cart. Failures by day [~](q5@n).',
  '',
  '- The fix is one line.',
  '- The test then [passed 200 times in a row](q3#test=checkout@passes).',
].join('\n')

test('a rewrite is held to the original: a ref it never cited is kept for the healing pass, and a number it never states is named', () => {
  const out = checkRewrite(TEXT, 'Fixed in [2 tries](q9#x@n); it failed [1 run in 9](q2#test=checkout@fail_rate), 12% of runs.')
  assert.equal(out.text, 'Fixed in [2 tries](q9#x@n); it failed [1 run in 9](q2#test=checkout@fail_rate), 12% of runs.')
  assert.equal(out.problems.length, 1)
  assert.match(out.problems[0], /"12" is not in the original/)
  assert.deepEqual(checkRewrite(TEXT, 'It failed about [1 in 9](q2#test=checkout@fail_rate); now it [passed 200 times](q3#test=checkout@passes).').problems, [])
})

test('a cited ref whose words now state another number keeps its link, for the healing pass to re-point or mark', () => {
  // the original cites 13,403 there; the healing pass finds 14,591 in its place's row, or marks the citation ×
  const orig = 'Most saves came on [6,543](q1#day=18@n) days, [13,403 of 14,591](q10#wiki=dse@n) on one wiki.'
  const total = checkRewrite(orig, 'Of [14,591 edits](q10#wiki=dse@n), most came on one day.')
  assert.equal(total.text, 'Of [14,591 edits](q10#wiki=dse@n), most came on one day.')
  assert.deepEqual(total.problems, [])
  const moved = checkRewrite(TEXT, 'The fix held [200 times](tests/conftest.py#L14); it [passed 200 times](q3#test=checkout@passes).')
  assert.equal(moved.text, 'The fix held [200 times](tests/conftest.py#L14); it [passed 200 times](q3#test=checkout@passes).')
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

test('a ref with brackets in a key value stays one link through the check, a new one too, and nothing of it is left as words', () => {
  const orig = 'Of the boys, [21](r4#age=child%20(0-12)&group=a@kept) of 37 stayed; of the girls, 19 of 32.'
  const text = 'Boys: [21](r4#age=child%20(0-12)&group=a@kept) of 37. Girls: [19](r4#age=child%20(0-12)&group=b@kept) of 32.'
  const out = checkRewrite(orig, text)
  assert.equal(out.text, text)
  assert.deepEqual(out.problems, [])
  // the text writing in never stops inside such a link
  const links = ['[21](', '[19]('].map(w => [text.indexOf(w), text.indexOf('@kept)', text.indexOf(w)) + 6])
  for (let n = 8; n < text.length; n += 5) {
    const end = revealCut(text, n).length
    assert.ok(!links.some(([a, b]) => end > a && end < b), `cut at ${end} falls inside a link`)
  }
})

