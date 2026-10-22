// The marks of a reply (message.js): which links are marks, their numbers and sentences, and how a block with marks
// is laid out. node --test plugin/marks/test/message.test.mjs
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { blocks, inline, marksIn, runsText, sentenceOf, tableOf, withoutMarks, wrapRuns } from '../message.js'

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

test('withoutMarks keeps the words and drops the link', () => {
  assert.equal(withoutMarks('[352](#) of the [410](#) requests, [docs](https://x.y)'), '352 of the 410 requests, [docs](https://x.y)')
})

test('a sentence runs from the stop or line break before the mark to the next one, each mark in it as [words]', () => {
  const text = 'First line.\n- agent-07 merged [12 of 40](#) pull requests on [June 3](#). Then it stopped.'
  const ms = marksIn(text)
  assert.equal(sentenceOf(text, ms[0]), '- agent-07 merged [12 of 40] pull requests on [June 3].')
  assert.equal(sentenceOf(text, ms[1]), sentenceOf(text, ms[0]))
})

test('a block with marks lays out as runs, each mark one group of runs with its own bold and code', () => {
  const text = 'It ran [**3** times](#) after `fix()`.'
  const runs = inline(text, 0, text.length, marksIn(text))
  assert.equal(runsText(runs), 'It ran 3 times after fix().')
  assert.deepEqual(runs.filter(r => r.mark === 0).map(r => [r.s, !!r.b]), [['3', true], [' times', false]])
  assert.ok(runs.some(r => r.code && r.s === 'fix()'))
})

test('a mark and the stop after it stay on one line; a mark wider than the line breaks at its spaces', () => {
  const text = 'aaaa bbbb cccc [dddd](#).'
  const lines = wrapRuns(inline(text, 0, text.length, marksIn(text)), 16)
  assert.deepEqual(lines.map(runsText), ['aaaa bbbb cccc', 'dddd.'])
  const long = '[one two three four five six](#)'
  assert.deepEqual(wrapRuns(inline(long, 0, long.length, marksIn(long)), 10).map(runsText), ['one two', 'three four', 'five six'])
})

test('a table splits its cells at | outside code and marks, each cell its runs', () => {
  const text = '| run | result |\n|---|---|\n| [a|b](#) | `x|y` passed |'
  const b = blocks(text)[0]
  assert.equal(b.type, 'table')
  const rows = tableOf(text, b, marksIn(text))
  assert.deepEqual(rows.map(r => r.map(runsText)), [['run', 'result'], ['a|b', 'x|y passed']])
  assert.equal(rows[1][0][0].mark, 0)
})
