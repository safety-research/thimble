// The coverage pane's words (panes/coverage.js): each file in its own unit, never which rows, `none` when untouched.
//   node --test plugin/panes/test
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { amounts, fileWords, groupLine, sentence, sizeOf } from '../coverage.js'

const MIXED = [{ unit: 'records', units: 14591, seen: 3 }, { unit: 'pages', units: 12, seen: 2 }, { unit: 'file', units: 2, seen: 1 }]

test('the sentence says each unit apart, and one unit as before', () => {
  assert.equal(sentence({ files: 6, seen_files: 3, units: MIXED }, 's'), "Claude read from 3 of the folder's 6 files: 3 of 14,591 records (0.02%), 2 of 12 pages (17%) and 1 of 2 other files.")
  assert.equal(sentence({ files: 4, seen_files: 3, units: [{ unit: 'records', units: 42205, seen: 7 }] }, 's'), "Claude read 7 of the folder's 42,205 records (0.01%), from 3 of its 4 files.")
  assert.equal(sentence({ files: 3, seen_files: 1, units: [{ unit: 'file', units: 3, seen: 1 }] }, 's'), "Claude saw 1 of the folder's 3 files.")
})

test('a group and a file say how much in their unit, never which rows', () => {
  assert.equal(groupLine({ files: 4, seenFiles: 1, units: [{ unit: 'records', units: 14591, seen: 3 }] }), 'Claude read 3 of 14,591 records (0.02%), from 1 of 4 files.')
  assert.equal(groupLine({ files: 3, seenFiles: 2, units: [{ unit: 'file', units: 3, seen: 2 }] }), 'Claude saw 2 of 3 files.')
  assert.equal(sizeOf([{ unit: 'pages', units: 12 }]), '12 pages')
  assert.equal(amounts(MIXED, 'seen'), '3 of 14,591 records (0.02%), 2 of 12 pages (17%) and 1 of 2 other files')
  // the kernel's words when it gives them; else the amount alone
  assert.equal(fileWords({ said: 'seen', status: 'seen' }), 'seen')
  assert.equal(fileWords({ status: 'seen', unit: 'records', units: 14591, seen_units: 3, ranges: [[8256, 8256]] }), 'read 3 of 14,591 records (0.02%)')
  assert.equal(fileWords({ status: 'not read' }), 'none')
})
