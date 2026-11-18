// Where the keys c and e act on words selected in an answer (marks/asked.mjs), which the terminal and the workbench
// share: words that stand more than once act where the selection lies, when the mode knows it (the workbench's rankOf),
// else at their first place in the row (the terminal, whose selection gives the row and the words).
//   node --test plugin/marks/test
import assert from 'node:assert/strict'
import test from 'node:test'

import { citeAt, pickedPlace, placeOf, rankOf } from '../asked.mjs'

// Claude's words: the phrase twice in one answer, once in bold and once in a chip the page draws as its value
const RAW = 'The retry budget is five tries. Uploads fail after the **retry budget** runs out, see [[retry budget|card:abc123#tries/1]].'
// the same answer as the page draws it, without the chip
const DRAWN = 'The retry budget is five tries. Uploads fail after the retry budget runs out, see .'
const SECOND = RAW.indexOf('retry budget', 10)

test('the place a selection names: its rank among the places of the words as drawn, then that place in the text', () => {
  const at = DRAWN.lastIndexOf('retry budget')
  assert.equal(rankOf(DRAWN, 'retry budget', at), 1)
  // a selection may start on the space before the words
  assert.equal(rankOf(DRAWN, 'retry budget', at - 1), 1)
  assert.equal(rankOf(DRAWN, 'retry budget', 0), 0)
  assert.equal(rankOf(DRAWN, 'retry budget', DRAWN.length), undefined)
  assert.deepEqual(placeOf(RAW, 'retry budget', '×', 1), { start: SECOND, end: SECOND + 12 })
  // no place named: the first, as the terminal's keys take it; a place the text does not hold (the chip's words are
  // no place the page counts): the first too
  assert.deepEqual(placeOf(RAW, 'retry budget'), { start: 4, end: 16 })
  assert.deepEqual(placeOf(RAW, 'retry budget', '×', 2), { start: 4, end: 16 })
})

test('c cites the words at the place named, with the sentence that holds them there', () => {
  assert.deepEqual(citeAt(RAW, [], 'retry budget', '×', 1), {
    start: SECOND, end: SECOND + 12, words: 'retry budget',
    sentence: 'Uploads fail after the [retry budget] runs out, see [[retry budget|card:abc123#tries/1]].',
  })
  assert.equal(citeAt(RAW, [], 'retry budget').sentence, 'The [retry budget] is five tries.')
  // a citation at the second place, asked about before: the same words there open it, and at the first make another
  const asked = { n: 1, words: 'retry budget', start: SECOND, end: SECOND + 12, asked: true, status: 'verified', shown: 'retry budget' }
  assert.deepEqual(citeAt(RAW, [asked], 'retry budget', '×', 1), { n: 1 })
  assert.equal(citeAt(RAW, [asked], 'retry budget', '×', 0).start, 4)
})

test('e takes the place named, in the answer as it draws and in the text Claude wrote', () => {
  const asked = { n: 1, words: 'five tries', start: 20, end: 30, asked: true, status: 'checking', shown: 'five tries' }
  const got = pickedPlace(RAW, [asked], 'retry budget', '×', 1)
  // the citation asked about before is written into the answer as it draws, before the words
  assert.equal(got.shown.slice(got.at.start, got.at.end), 'retry budget')
  assert.ok(got.at.start > SECOND)
  assert.deepEqual(got.written, { start: SECOND, end: SECOND + 12 })
  assert.equal(pickedPlace(RAW, [], 'not in it'), null)
})
