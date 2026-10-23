// The pure parts of the label rows and of the ask before a large label run (labels/use.mjs): which labels a row names,
// the ask's choices and what Claude hears after the person's choice. All data is made up.
//   node --test plugin/labels/test/use.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import { answerNote, askChoices, askOf, sampleOffered, usedNames } from '../use.mjs'

test('a row names each label a turn used once, in order, and not those another row shows', () => {
  const uses = [{ name: 'spam' }, { name: 'tone' }, { name: 'spam' }, { name: 'lang' }]
  assert.deepEqual(usedNames(uses), ['spam', 'tone', 'lang'])
  assert.deepEqual(usedNames(uses, ['tone']), ['spam', 'lang'])
})

test('an ask offers 1 run all, 2 a sample and 0 cancel, one for the rest no sample; Claude hears the choice, and after a sample how to label the rest, never a key to press', () => {
  // an ask offers 1 run all, 2 a sample and 0 cancel; an ask for the rest offers no sample
  {
    const ev = { kind: 'label_ask', name: 'spam', root: '/made-up/data/', ask: 'a1', units: 420, sample: 300, text: 'Read 420 records with Claude', meta: '9 model calls', t: 1 }
    const a = askOf(ev)
    assert.equal(a.root, '/made-up/data')
    assert.equal(sampleOffered(a), true)
    assert.deepEqual(askChoices(a).map(c => `${c.key} ${c.words}`), ['1 run all', '2 run on a sample of 300', '0 cancel'])
    const rest = askOf({ ...ev, ask: 'a2', units: 120, sample: 0, rest: true })
    assert.deepEqual(askChoices(rest).map(c => `${c.key} ${c.words}`), ['1 run the rest', '0 cancel'])
    assert.equal(askOf({ ...ev, name: '../x' }), null)
    assert.equal(askOf({ ...ev, ask: undefined }), null)
  }
  // Claude hears the choice, and after a sample how to label the rest, never a key to press
  {
    const a = askOf({ name: 'spam', root: '/d', ask: 'a1', units: 420, sample: 300 })
    assert.match(answerNote(a, 'cancel', {}), /chose not to run the label spam: the model reads none of its 420 records/)
    assert.match(answerNote(a, 'all', {}), /run the label spam on all 420 records/)
    const s = answerNote(a, 'sample', { reads: 300, of: 420 })
    assert.match(s, /random sample of 300 of the label spam's 420 records/)
    assert.match(s, /the other 120 records stay without a value/)
    assert.match(s, /without --limit: the terminal then asks the analyst again/)
  }
})

