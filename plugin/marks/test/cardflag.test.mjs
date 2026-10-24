// A card that still shows a figure its answer's check corrected (marks/cardflag.mjs). Made-up data only.
// node --test plugin/marks/test/cardflag.test.mjs
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'

import { changedFigures, staleFigures, treeWords } from '../cardflag.mjs'

const TREE = { t: 'Box', p: {}, c: [
  { t: 'Text', p: { bold: true }, c: ['Pages deleted per day'] },
  { t: 'Box', p: {}, c: [{ t: 'Text', p: {}, c: ['admin-a  '] }, { t: 'Text', p: { color: 'blue' }, c: ['5,217'] }] },
  { t: 'Box', p: {}, c: [{ t: 'Text', p: {}, c: ['admin-b  '] }, { t: 'Text', p: {}, c: [312] }] },
] }

test("a card's words: each Box a line, numbers as drawn", () => {
  assert.equal(treeWords(TREE), '\nPages deleted per day\nadmin-a  5,217\nadmin-b  312\n')
})

test('a corrected citation whose old figure the card still shows is found; one the card does not show is not', () => {
  assert.deepEqual(changedFigures('5,217 pages', '5,144 pages'), ['5217'])
  // a single digit is too common to tell
  assert.deepEqual(changedFigures('3 runs', '4 runs'), [])
  const items = [
    { n: 1, status: 'corrected', words: '5,217 pages', shown: '5,144 pages' },
    { n: 2, status: 'corrected', words: '640 edits', shown: '612 edits' },
    { n: 3, status: 'verified', words: '312', shown: '312' },
    { n: 4, status: 'corrected', narrowed: true, words: 'admin-b deleted 312', shown: '312' },
  ]
  assert.deepEqual(staleFigures(treeWords(TREE), items), [{ n: 1, was: '5,217 pages', now: '5,144 pages', figure: '5217' }])
})
