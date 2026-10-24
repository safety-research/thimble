// The marks of a reply (message.js): which links are marks, their numbers and sentences, a check's rewrite in place,
// and a feature's span on them. node --test plugin/marks/test/message.test.mjs
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { inline, marksIn, rewritesIn, runsText, sentenceOf, withCorrections, withRewrites } from '../message.js'

const words = text => marksIn(text).map(m => m.words)

test('a mark is a link to # on the words of a claim; a link to anything else is no mark', () => {
  const text = 'Of the [410](#) requests, [352](#) were approved ([85.9%](#)). See [the docs](https://example.com) and [a file](data.csv).'
  assert.deepEqual(words(text), ['410', '352', '85.9%'])
  const m = marksIn(text)[0]
  assert.equal(text.slice(m.start, m.end), '[410](#)')
})

test('bold, code spans and brackets inside the words are formatting of one mark', () => {
  assert.deepEqual(words('It ran [**three** times](#), and [`retry()` was called](#), and [the [x] flag](#) was set.'), ['**three** times', '`retry()` was called', 'the [x] flag'])
})

test('a link inside code is no mark: in a fence, or in a code span', () => {
  const text = 'Before `[1](#)`.\n\n```\n[2](#)\n```\n\nAfter [3](#).'
  assert.deepEqual(words(text), ['3'])
})

test('a sentence runs from the stop or line break before the mark to the next one, each mark in it as [words]', () => {
  const text = 'First line.\n- agent-07 merged [12 of 40](#) pull requests on [June 3](#). Then it stopped.'
  const ms = marksIn(text)
  assert.equal(sentenceOf(text, ms[0]), '- agent-07 merged [12 of 40] pull requests on [June 3].')
  assert.equal(sentenceOf(text, ms[1]), sentenceOf(text, ms[0]))
  // a bold sentence ends at its period, and its bold does not show
  const bold = '**[26](#) pull requests were merged.** Four agents tie with [3 merges each](#).'
  const bm = marksIn(bold)
  assert.equal(sentenceOf(bold, bm[0]), '[26] pull requests were merged.')
  assert.equal(sentenceOf(bold, bm[1]), 'Four agents tie with [3 merges each].')
  // a `__` inside a name is part of it; around words it is bold
  const named = 'Late: __annotation-platform__underspecified__ at [87%](#).'
  assert.equal(sentenceOf(named, marksIn(named)[0]), 'Late: annotation-platform__underspecified at [87%].')
})

test("a stop inside a mark's words (a quote of two sentences) ends no sentence: the next mark's sentence holds the quote whole", () => {
  const t = 'A typical post: ["R2 done at 03:28. Please post R3 here."](#) Later runs asked to [fast-forward their clocks](#) and report back. Then [12 pages](#) went.'
  const ms = marksIn(t)
  const both = 'A typical post: ["R2 done at 03:28. Please post R3 here."] Later runs asked to [fast-forward their clocks] and report back.'
  assert.equal(sentenceOf(t, ms[0]), both)
  assert.equal(sentenceOf(t, ms[1]), both)
  assert.equal(sentenceOf(t, ms[2]), 'Then [12 pages] went.')
  // a rewrite of the second mark's sentence written for one mark cannot stand where the sentence holds two: the reply
  // stays as written, never cut inside the quote
  const items = [{ status: 'verified' }, { status: 'corrected', shown: 'clock.wait', rewrite: 'Later runs asked: [clock.wait] the answer.' }, { status: 'verified' }]
  assert.equal(rewritesIn(t, items).text, t)
})

test("a sentence a check rewrote stands in place of the reply's, its citations marks again; the rest of the text stays", () => {
  const text = 'First line.\n- On line 29, agent-07 wrote [“yes, that was me”](#) and closed [#118](#). Then it stopped.'
  const out = withRewrites(text, [{ status: 'corrected', rewrite: '- On line 27, agent-07 wrote [“yes, that was me”] and closed [#118].' }])
  assert.equal(out, 'First line.\n- On line 27, agent-07 wrote [“yes, that was me”](#) and closed [#118](#). Then it stopped.')
  assert.equal(marksIn(out).length, 2)
  // a sentence that would not hold the same marks leaves the text as it was
  assert.equal(withRewrites(text, [{ status: 'corrected', rewrite: '- agent-07 wrote [“yes, that was me”].' }]), text)
})

test("a rewrite in a sentence with a link stands whole: the link keeps its target, and the cited words are never glued into the old sentence", () => {
  const text = 'Nightly runs.\nThe nightly run nightly-007 passed [with 0 errors](#) (see [the log](runs/n7.log)). Then [3](#) more ran.'
  const ms = marksIn(text)
  assert.equal(sentenceOf(text, ms[0]), 'The nightly run nightly-007 passed [with 0 errors] (see [the log](runs/n7.log)).')
  const fixed = { status: 'corrected', shown: 'failed with 2 errors', rewrite: 'The nightly run nightly-007 [failed with 2 errors] (see [the log]).' }
  const got = rewritesIn(text, [fixed, { status: 'verified', shown: '3' }])
  assert.equal(got.text, 'Nightly runs.\nThe nightly run nightly-007 [failed with 2 errors](#) (see [the log](runs/n7.log)). Then [3](#) more ran.')
  assert.deepEqual([...got.placed], [0])
  // the link written whole stays as written
  assert.equal(withRewrites(text, [{ ...fixed, rewrite: 'The nightly run nightly-007 [failed with 2 errors] (see [the log](runs/n7.log)).' }]), got.text)
  // brackets that are neither a mark nor a link (in code) stay as written, and the sentence still stands
  const code = 'Run `x[0]` passed [with 0 errors](#).'
  assert.equal(withRewrites(code, [{ status: 'corrected', rewrite: 'Run `x[0]` [failed with 2 errors].' }]), 'Run `x[0]` [failed with 2 errors](#).')
  // a rewrite that cannot hold the sentence's marks leaves that sentence, and only that one, as it was
  const two = 'A [1](#) here. B [2](#) there.'
  const one = rewritesIn(two, [{ status: 'corrected', rewrite: 'A [1] [x] here.' }, { status: 'corrected', rewrite: 'B [two] there.' }])
  assert.equal(one.text, 'A [1](#) here. B [two](#) there.')
  assert.deepEqual([...one.placed], [1])
})

test('a correction\'s words stand in place of its mark\'s words, so features place their words on what is shown; a narrowing or a rewrite does not', () => {
  const text = 'Of the runs, [12 of 40](#) failed, [all](#) on [Tuesday at noon](#).'
  const items = [
    { status: 'corrected', shown: '11 of 40' },
    { status: 'verified', shown: 'all' },
    { status: 'corrected', shown: 'noon', narrowed: true },
  ]
  assert.equal(withCorrections(text, items), 'Of the runs, [11 of 40](#) failed, [all](#) on [Tuesday at noon](#).')
  assert.equal(withCorrections(text, [{ status: 'corrected', shown: '11 of 40', rewrite: 'Of the runs, [11 of 40] failed.' }]), text)
  // words that would not hold as a mark's (an unbalanced bracket) leave the mark's words
  assert.equal(withCorrections(text, [{ status: 'corrected', shown: '11 of [40' }]), text)
})

test("a feature's span lies on plain words or inside one mark's words, and its runs carry its index", () => {
  const text = 'The page waits on `hydrate()` until [the query ends](#), then hydrate runs.'
  const marks = marksIn(text)
  const at = (w, from = 0) => text.indexOf(w, from)
  const spans = [
    { start: at('hydrate runs'), end: at('hydrate runs') + 'hydrate'.length },
    { start: at('query'), end: at('query') + 'query'.length },
  ]
  const runs = inline(text, 0, text.length, marks, spans)
  assert.equal(runsText(runs), 'The page waits on hydrate() until the query ends, then hydrate runs.')
  const outside = runs.find(r => r.span === 0)
  assert.equal(outside.s, 'hydrate')
  assert.equal(outside.mark, undefined)
  const inside = runs.find(r => r.span === 1)
  assert.deepEqual([inside.s, inside.mark], ['query', 0])
  // the words of the mark around the span stay the mark's
  assert.equal(runs.filter(r => r.mark === 0).map(r => r.s).join(''), 'the query ends')
})
