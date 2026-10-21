// The coverage pane's words (panes/coverage.js): each file in its own unit, never which rows, `none` when untouched.
//   node --test plugin/panes/test
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { amounts, barCells, fileWords, groupLine, itemId, sentence, sizeOf, typeMix } from '../coverage.js'

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

test('a folder of a few files lists them all; a large one lists the touched groups first and the rest on one line, each opening on Enter', async () => {
  const { listItems } = await import('../coverage.js')
  const file = (path, o = {}) => ({ path, folder: path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : './', type: path.split('.').pop(), status: 'not read', ...o })
  // four files: no group to open
  const few = listItems({ files: [file('a.jsonl', { status: 'seen' }), file('b.csv'), file('c.md'), file('d.png')], folder: [] }, 'folder', [], 20)
  assert.deepEqual(few.map(x => x.kind), ['file', 'file', 'file', 'file'])
  // 400 files in 40 folders, Claude touched two of them: those first, the other 38 folders on one line
  const files = [file('runs/r01/x.jsonl', { status: 'seen' }), file('runs/r02/y.jsonl', { status: 'computed' })]
  const rest = { path: [], unit: [], units: [] }
  for (let r = 0; r < 40; r++) for (let i = 0; i < 10; i++) if (!((r === 1 && i === 0) || (r === 2 && i === 0))) { rest.path.push(`runs/r${String(r).padStart(2, '0')}/f${i}.txt`); rest.unit.push('lines'); rest.units.push(3) }
  const folder = Array.from({ length: 40 }, (_, r) => ({ key: `runs/r${String(r).padStart(2, '0')}/`, files: 10, touched: r === 1 || r === 2 ? 1 : 0 }))
    .sort((a, b) => b.touched - a.touched)
  const data = { files, rest, folder }
  const top = listItems(data, 'folder', [], 20)
  assert.deepEqual(top.map(x => x.id), [itemId('g', 'runs/r01/'), itemId('g', 'runs/r02/'), 'rest'])
  assert.equal(top[2].files, 380)
  assert.equal(top[2].groups, 38)
  // Enter on a group opens its files under it; on the line of the others, their folders
  const open = listItems(data, 'folder', ['runs/r01/', 'rest'], 20)
  assert.deepEqual(open.slice(0, 3).map(x => x.id), [itemId('g', 'runs/r01/'), itemId('f', 'runs/r01/x.jsonl'), itemId('f', 'runs/r01/f1.txt')])
  assert.equal(open.filter(x => x.kind === 'file').length, 10)
  assert.equal(open.filter(x => x.kind === 'group' && x.depth === 1).length, 38)
})

test("each row has two measures in its own unit: read into Claude's context, and counted or computed over (read is part of it)", async () => {
  const { default: pane, program } = await import('../coverage.js')
  await import('../../draw/kit.js')
  const { gridText, renderTerm } = await import('../../draw/term.js')
  const cov = { session: 's', total: { files: 2, touched_files: 1, seen_files: 1, units: [{ unit: 'records', units: 40, seen: 8 }, { unit: 'rows', units: 30, seen: 0 }] },
    files: [{ path: 'events.jsonl', type: 'jsonl', unit: 'records', units: 40, seen_units: 8, status: 'seen', touched: true, read_share: 0.2, counted_share: 1 }],
    untouched: { path: ['runs.csv'], unit: ['rows'], units: [30] }, groups: [], types: [] }
  const data = pane.data({ coverage: { cov } }, {}, { w: 100, h: 30 })
  const text = gridText(renderTerm(globalThis.DrawKit.run(program, data, { w: 100, h: 30, mode: 'pane' }), { w: 100 }))
  assert.match(text, /events\.jsonl +40 records +\S+ +20% +\S+ +100%/)
  assert.match(text, /runs\.csv +30 rows +\S+ +0% +\S+ +0%/)
})

test('in a narrow pane no number is cut: the bars narrow and go, then the size says its number alone; a row presses on its name, not its bars', async () => {
  const { default: pane, program } = await import('../coverage.js')
  await import('../../draw/kit.js')
  const { gridText, renderTerm } = await import('../../draw/term.js')
  const file = (path, units, read, counted) => ({ path, type: 'jsonl', unit: 'records', units, lines: units, seen_units: 1, status: 'seen', touched: true, read_share: read, counted_share: counted })
  const cov = { session: 's', total: { files: 3, touched_files: 3, seen_files: 3, units: [{ unit: 'records', units: 937635, seen: 3 }] },
    files: [file('events.jsonl', 19931, 0.0003, 1), file('notes/revisions.jsonl', 14591, 0.001, 1), file('big.jsonl', 900000, 0.000001, 0.00001)],
    untouched: { path: [], unit: [], units: [] }, groups: [], types: [] }
  for (const w of [100, 57, 48, 40]) {
    const data = pane.data({ coverage: { cov } }, {}, { w, h: 30 })
    const grid = renderTerm(globalThis.DrawKit.run(program, data, { w, h: 30, mode: 'pane' }), { w })
    const text = gridText(grid)
    // every number whole, and no word of the header or the legend cut
    for (const s of ['0.03%', '100%', '0.1%', '<0.01%', 'read', 'counted', "read into Claude's context"]) assert.ok(text.includes(s), `${s} at ${w}: ${text}`)
    assert.doesNotMatch(text, /\d…|co…|…\d/, `at ${w}`)
    if (w >= 100) assert.match(text, /19,931 records/)
    else if (w >= 48) assert.match(text, /19,931 /)
    // the row's press holds its name and stops before its bars
    const row = grid.regions.find(r => r.id === 'f:events.jsonl')
    const y = row.rects[0].y
    const line = grid.rows[y].map(c => c.ch).join('')
    const end = Math.max(...row.rects.map(q => q.x + q.w))
    assert.ok(line.slice(0, end).includes('events.jsonl'), line)
    assert.ok(!/[▆▇█]/.test(line.slice(0, end)), `the press holds a bar at ${w}: ${line}`)
  }
})
