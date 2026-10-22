// The marks of a reply (message.js): which links are marks, their numbers and sentences, and how a block with marks
// is laid out. node --test plugin/marks/test/message.test.mjs
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { blocks, inline, marksIn, plainSentence, runsText, sentenceOf, tableOf, withoutMarks, wrapRuns } from '../message.js'

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
  // a bold sentence ends at its period, and its bold does not show
  const bold = '**[26](#) pull requests were merged.** Four agents tie with [3 merges each](#).'
  const bm = marksIn(bold)
  assert.equal(sentenceOf(bold, bm[0]), '[26] pull requests were merged.')
  assert.equal(sentenceOf(bold, bm[1]), 'Four agents tie with [3 merges each].')
  // a `__` inside a name is part of it; around words it is bold
  const named = 'Late: __annotation-platform__underspecified__ at [87%](#).'
  assert.equal(sentenceOf(named, marksIn(named)[0]), 'Late: annotation-platform__underspecified at [87%].')
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

test('a mark breaks at its spaces where the line ends, its glyph with its last word; its _ are letters', () => {
  const text = 'The pipeline ran [nine of the ten steps](#) today.'
  const runs = inline(text, 0, text.length, marksIn(text))
  runs.splice(runs.findIndex(r => r.mark === 0 && r.s.endsWith('steps')) + 1, 0, { s: ' ×', mark: 0, tag: 'x' })
  assert.deepEqual(wrapRuns(runs, 24).map(runsText), ['The pipeline ran nine of', 'the ten steps × today.'])
  const quote = 'It reads ["covers the same _bin_edges/_adjust_bin_edges in __init__.py"](#).'
  assert.equal(runsText(inline(quote, 0, quote.length, marksIn(quote))), 'It reads "covers the same _bin_edges/_adjust_bin_edges in __init__.py".')
})

test('a sentence as read keeps the brackets inside a mark\'s words', () => {
  assert.equal(plainSentence('agent-28 wrote [agent-28: "assignment [219] is moot"] at [14:02].'), 'agent-28 wrote agent-28: "assignment [219] is moot" at 14:02.')
})

test('a table splits its cells at | outside code and marks, each cell its runs', () => {
  const text = '| run | result |\n|---|---|\n| [a|b](#) | `x|y` passed |'
  const b = blocks(text)[0]
  assert.equal(b.type, 'table')
  const rows = tableOf(text, b, marksIn(text))
  assert.deepEqual(rows.map(r => r.map(runsText)), [['run', 'result'], ['a|b', 'x|y passed']])
  assert.equal(rows[1][0][0].mark, 0)
  // a bracket that opens no link is a letter of its cell
  const named = '| agent | last |\n|---|---|\n| [Temporary] Leader | [13:27](#) |'
  assert.deepEqual(tableOf(named, blocks(named)[0], marksIn(named)).map(r => r.map(runsText)), [['agent', 'last'], ['[Temporary] Leader', '13:27']])
})

test('a quote inside a list item is a quote of its own, and an indented line after it goes on under the item', () => {
  const text = '1. agent-a removed [42](#) of its lines, including:\n   > = HEADING =\n   > a line\n\n   agent-b put its own list there.'
  const bs = blocks(text)
  assert.deepEqual(bs.map(b => [b.type, b.indent]), [['item', 0], ['quote', 3], ['quote', 3], ['para', 3]])
  assert.deepEqual(bs.slice(1).map(b => text.slice(b.from, b.to)), ['= HEADING =', 'a line', 'agent-b put its own list there.'])
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
