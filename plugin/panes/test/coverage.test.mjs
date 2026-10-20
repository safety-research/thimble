// The coverage pane's words (panes/coverage.js): each file in its own unit, never which rows, `none` when untouched.
//   node --test plugin/panes/test
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { amounts, barCells, fileWords, groupLine, sentence, sizeOf, typeMix } from '../coverage.js'

const MIXED = [{ unit: 'records', units: 14591, seen: 3 }, { unit: 'pages', units: 12, seen: 2 }, { unit: 'file', units: 2, seen: 1 }]

test('the sentence leads with the share of files read, as the bar does, then each unit apart', () => {
  assert.equal(sentence({ files: 6, seen_files: 3, units: MIXED }, 's'), "Claude read 3 of the folder's 6 files (50%): 3 of 14,591 records (0.02%), 2 of 12 pages (17%) and 1 of 2 other files.")
  assert.equal(sentence({ files: 4, seen_files: 3, units: [{ unit: 'records', units: 42205, seen: 7 }] }, 's'), "Claude read 3 of the folder's 4 files (75%): 7 of 42,205 records (0.01%).")
  assert.equal(sentence({ files: 3, seen_files: 1, units: [{ unit: 'file', units: 3, seen: 1 }] }, 's'), "Claude read 1 of the folder's 3 files (33%).")
  // a unit none of whose parts was read is left to the list under it
  assert.equal(sentence({ files: 5, seen_files: 2, units: [{ unit: 'records', units: 9, seen: 2 }, { unit: 'lines', units: 50, seen: 0 }, { unit: 'file', units: 2, seen: 1 }] }, 's'), "Claude read 2 of the folder's 5 files (40%): 2 of 9 records (22%) and 1 of 2 other files.")
})

test("the bar's strip fills by the share of files read: an image weighs as much as a log of 14,591 records", () => {
  // a log with 3 of its 14,591 records read, and 2 images, one seen: 2 of 3 files read
  const types = [{ type: 'jsonl', files: 1, seen_files: 1, rows: 14591, seen_rows: 3 }, { type: 'image', files: 2, seen_files: 1, rows: 2, seen_rows: 1 }]
  const cells = barCells(typeMix(types), 6)
  assert.deepEqual(cells.map(c => [c.tone, c.seen, c.n]), [['c1', true, 2], ['c2', true, 2], ['c2', false, 2]])
  // read files first, so the strip fills from the left: 3 of 7 files read is 3 of 8 cells
  const seven = [{ type: 'jsonl', files: 1, seen_files: 1, rows: 2400 }, { type: 'csv', files: 1, seen_files: 0, rows: 240 }, { type: 'image', files: 5, seen_files: 2, rows: 5 }]
  assert.deepEqual(barCells(typeMix(seven), 8).map(c => [c.tone, c.seen, c.n]), [['c1', true, 1], ['c3', true, 2], ['c2', false, 1], ['c3', false, 4]])
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
