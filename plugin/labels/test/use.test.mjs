// The pure parts of the label rows and of the ask before a large label run (labels/use.mjs): which labels a row names,
// the ask's choices and what Claude hears after the person's choice. All data is made up.
//   node --test plugin/labels/test/use.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import { definition } from '../ledger.mjs'
import { answerChoice, answerNote, askChoices, askContext, askInput, askOf, howMade, rowValues, sampleOffered, usedNames } from '../use.mjs'

test('a row names each label a turn used once, in order, and not those another row shows', () => {
  const uses = [{ name: 'spam' }, { name: 'tone' }, { name: 'spam' }, { name: 'lang' }]
  assert.deepEqual(usedNames(uses), ['spam', 'tone', 'lang'])
  assert.deepEqual(usedNames(uses, ['tone']), ['spam', 'lang'])
})

test('a row names the values its records have, then the records with no value, and says how the label was made as the pane does', () => {
  // every record of a prompt label got no value (the model refused them): the row says so, and names no value
  assert.deepEqual(rowValues({ values: ['yes', 'no'], counts: {}, waiting: 0, failed: 40 }), [{ v: '-', name: 'no value' }])
  // the reads still run
  assert.deepEqual(rowValues({ values: ['yes', 'no'], counts: { yes: 3 }, waiting: 37, failed: 0 }), [{ v: 'yes', name: 'yes' }, { v: '-', name: 'not labeled yet' }])
  // a value no record has is left out; a value outside the list that records have is named after the list's
  assert.deepEqual(rowValues({ values: ['yes', 'no'], counts: { no: 12, maybe: 1 } }).map(x => x.name), ['no', 'maybe'])
  // a label read with no counts names its values
  assert.deepEqual(rowValues({ values: ['a', 'b'] }).map(x => x.name), ['a', 'b'])
  // one set of words for how a label was made, in the row and in the pane's definition
  for (const kind of ['prompt', 'set', 'regex', 'code']) {
    const pane = definition({ name: 'x', kind, rule: 'r', values: ['yes', 'no'], records: 2 }, 60)[0].map(r => r.s).join('')
    assert.equal(pane, `definition · ${howMade(kind)}`)
  }
  assert.equal(howMade('prompt'), 'read by Claude')
  assert.equal(howMade('set'), 'values Claude gave')
})

test('an ask is one question for the question tool: run all, a sample or cancel, each with its cost, one for the rest no sample; the answer picks the choice, and Claude hears how to label the rest', () => {
  const ev = { kind: 'label_ask', name: 'spam', root: '/made-up/data/', ask: 'a1', units: 420, calls: 9, sample: 300, text: 'Read 420 records with Claude', meta: '9 model calls', t: 1 }
  const a = askOf(ev)
  // the choices, each with what it costs
  {
    assert.equal(a.root, '/made-up/data')
    assert.equal(sampleOffered(a), true)
    assert.deepEqual(askChoices(a).map(c => `${c.label}: ${c.cost}`), ['Run all: 9 model calls, about 20 s', 'Run on a sample of 300: 7 model calls, about 10 s', 'Cancel: reads none'])
    const rest = askOf({ ...ev, ask: 'a2', units: 120, sample: 0, rest: true })
    assert.deepEqual(askChoices(rest).map(c => c.label), ['Run the rest', 'Cancel'])
    assert.equal(askOf({ ...ev, name: '../x' }), null)
    assert.equal(askOf({ ...ev, ask: undefined }), null)
  }
  // the question tool's input, which Claude reads after the command, and the person's answer in its result
  {
    const input = askInput(a)
    assert.deepEqual(input.questions[0].options.map(o => o.label), ['Run all', 'Run on a sample of 300', 'Cancel'])
    assert.equal(input.questions[0].question, 'Read 420 records with Claude for the label spam?')
    assert.ok(askContext(a).includes(JSON.stringify(input)))
    assert.match(askContext(a), /AskUserQuestion/)
    const q = input.questions[0].question
    assert.equal(answerChoice(a, input, { answers: { [q]: 'Run on a sample of 300' } }), 'sample')
    assert.equal(answerChoice(a, input, { answers: { [q]: 'cancel' } }), 'cancel')
    // the question in Claude's own words, its choices as given
    const reworded = { questions: [{ ...input.questions[0], question: 'Label all 420 messages?' }] }
    assert.equal(answerChoice(a, reworded, { answers: { 'Label all 420 messages?': 'Run all' } }), 'all')
    // an answer in the person's own words, or no answer, is no choice
    assert.equal(answerChoice(a, input, { answers: { [q]: 'only the first 50' } }), null)
    assert.equal(answerChoice(a, input, { answers: {} }), null)
    assert.equal(answerChoice(a, { questions: [{ question: 'Which file?', options: [{ label: 'a' }, { label: 'b' }] }] }, { answers: { 'Which file?': 'a' } }), null)
  }
  // Claude hears the choice, and after a sample how to label the rest
  {
    const b = askOf({ name: 'spam', root: '/d', ask: 'a1', units: 420, sample: 300 })
    assert.match(answerNote(b, 'cancel', {}), /chose not to run the label spam: the model reads none of its 420 records/)
    assert.match(answerNote(b, 'all', {}), /run the label spam on all 420 records/)
    const s = answerNote(b, 'sample', { reads: 300, of: 420 })
    assert.match(s, /random sample of 300 of the label spam's 420 records/)
    assert.match(s, /The other 120 records stay without a value/)
    assert.match(s, /without --limit: the analyst is then asked again/)
  }
})

