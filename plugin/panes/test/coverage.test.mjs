// The coverage pane's words (panes/coverage.js): each file in its own unit, never which rows, `none` when untouched.
//   node --test plugin/panes/test
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { amounts, barCells, fileWords, groupLine, sentence, sizeOf, typeMix } from '../coverage.js'

const MIXED = [{ unit: 'records', units: 14591, seen: 3 }, { unit: 'pages', units: 12, seen: 2 }, { unit: 'file', units: 2, seen: 1 }]

test('the sentence leads with the files touched, as the bar does, then what was read of each unit', () => {
  assert.equal(sentence({ files: 6, touched_files: 4, seen_files: 3, units: MIXED }, 's'), "Claude touched 4 of the folder's 6 files and read 3 of 14,591 records (0.02%), 2 of 12 pages (17%) and 1 of 2 other files.")
  assert.equal(sentence({ files: 4, touched_files: 3, seen_files: 3, units: [{ unit: 'records', units: 42205, seen: 7 }] }, 's'), "Claude touched 3 of the folder's 4 files and read 7 of 42,205 records (0.01%).")
  assert.equal(sentence({ files: 3, touched_files: 1, seen_files: 1, units: [{ unit: 'file', units: 3, seen: 1 }] }, 's'), "Claude touched 1 of the folder's 3 files.")
  // a unit none of whose parts was read is left to the list under it
  assert.equal(sentence({ files: 5, touched_files: 2, seen_files: 2, units: [{ unit: 'records', units: 9, seen: 2 }, { unit: 'lines', units: 50, seen: 0 }, { unit: 'file', units: 2, seen: 1 }] }, 's'), "Claude touched 2 of the folder's 5 files and read 2 of 9 records (22%) and 1 of 2 other files.")
  // a count over every record touches the file though none of it was read; 0 touched means no file was looked at
  assert.equal(sentence({ files: 7, touched_files: 1, seen_files: 0, units: [{ unit: 'rows', units: 891, seen: 0 }] }, 's'), "Claude touched 1 of the folder's 7 files and read none of their lines into its context.")
  assert.equal(sentence({ files: 7, touched_files: 0, seen_files: 0, units: [{ unit: 'rows', units: 891, seen: 0 }] }, 's'), "Claude touched 0 of the folder's 7 files.")
})

test("the bar's strip fills by the share of files touched: an image weighs as much as a log of 14,591 records", () => {
  // a log with 3 of its 14,591 records read, and 2 images, one seen: 2 of 3 files touched
  const types = [{ type: 'jsonl', files: 1, seen_files: 1, touched: 1, rows: 14591, seen_rows: 3 }, { type: 'image', files: 2, seen_files: 1, touched: 1, rows: 2, seen_rows: 1 }]
  const cells = barCells(typeMix(types), 6)
  assert.deepEqual(cells.map(c => [c.tone, c.seen, c.n]), [['c1', true, 2], ['c2', true, 2], ['c2', false, 2]])
  // touched files first, so the strip fills from the left: 3 of 7 files touched is 3 of 8 cells; the csv was only
  // counted over, with no line read, and lights as much as the jsonl Claude read
  const seven = [{ type: 'jsonl', files: 1, seen_files: 1, touched: 1, rows: 2400 }, { type: 'csv', files: 1, seen_files: 0, touched: 1, rows: 240 }, { type: 'image', files: 5, seen_files: 0, touched: 1, rows: 5 }]
  assert.deepEqual(barCells(typeMix(seven), 8).map(c => [c.tone, c.seen, c.n]), [['c1', true, 1], ['c2', true, 1], ['c3', true, 1], ['c3', false, 5]])
  // a full count and nothing read: the strip is lit, not empty
  const counted = [{ type: 'csv', files: 1, seen_files: 0, touched: 1, rows: 891 }]
  assert.deepEqual(barCells(typeMix(counted), 4).map(c => [c.seen, c.n]), [[true, 4]])
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
