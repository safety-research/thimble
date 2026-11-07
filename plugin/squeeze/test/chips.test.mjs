// A squeeze's rewrite (squeeze/chips.mjs): the rewrite is held to the original's citations and numbers; a simpler
// version's request names one message to make simpler, at Length short and Background learning. Made-up data only.
// node --test plugin/squeeze/test/chips.test.mjs
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { CATCHUP_HEAD, SIMPLIFY_AT, SIMPLIFY_HEAD, checkRewrite, chipsOf, isSimplify, mapLinks, request, settledNote } from '../chips.mjs'

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
  assert.deepEqual({ ...SIMPLIFY_AT }, { length: 0, familiarity: 1 })
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
