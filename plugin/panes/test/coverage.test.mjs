// The coverage pane's words (panes/coverage.js): each file in its own unit, never which rows, `none` when untouched.
//   node --test plugin/panes/test
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { amounts, fileWords, groupLine, itemId, sentence, sizeOf, topShares } from '../coverage.js'

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

test('the top has two shares of the files, as the bar counts them: read into Claude\'s context, and searched or computed over', () => {
  assert.deepEqual(topShares({ files: 996, seen_files: 4, touched_files: 13 }), [["read into Claude's context", 4 / 996, 4, 996], ['searched or computed over', 13 / 996, 13, 996]])
  assert.deepEqual(topShares({ files: 0 }).map(r => r[1]), [0, 0])
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

test('a folder of a few files lists them all; a large one is a tree of its top folders, each opening one level on Enter, its untouched files on one line', async () => {
  const { listItems } = await import('../coverage.js')
  const file = (path, o = {}) => ({ path, folder: path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : './', type: path.split('.').pop(), unit: 'lines', units: 3, status: 'not read', ...o })
  // four files: no group to open
  const few = listItems({ files: [file('a.jsonl', { status: 'seen' }), file('b.csv'), file('c.md'), file('d.png')], folder: [] }, 'folder', [], 20)
  assert.deepEqual(few.map(x => x.kind), ['file', 'file', 'file', 'file'])
  // 400 files in 40 run folders under runs/, and 5 under tools/; Claude read one and searched one, both in runs/
  const files = [file('runs/r01/x.jsonl', { status: 'seen', touched: true, read: 0.5, counted: 0.5 }), file('runs/r02/y.jsonl', { status: 'searched', touched: true }), file('notes.md', { status: 'seen', touched: true, read: 1, counted: 1 })]
  const rest = { path: [], unit: [], units: [] }
  const push = p => { rest.path.push(p); rest.unit.push('lines'); rest.units.push(3) }
  for (let r = 0; r < 40; r++) for (let i = 0; i < 10; i++) if (!((r === 1 && i === 0) || (r === 2 && i === 0))) push(`runs/r${String(r).padStart(2, '0')}/f${i}.txt`)
  for (let i = 0; i < 5; i++) push(`tools/t${i}.py`)
  push('LICENSE')
  const data = { files, rest }
  // the top: its folders, those touched first, then its files touched, then one line for the rest of its files
  const top = listItems(data, 'folder', [], 20)
  assert.deepEqual(top.map(x => x.id), [itemId('g', 'runs/'), itemId('g', 'tools/'), itemId('f', 'notes.md'), 'rest'])
  assert.equal(top[0].g.files, 400)
  assert.equal(top[0].g.touched, 2)
  assert.equal(top[1].g.files, 5)
  assert.equal(top[3].files, 1)
  // ↵ on runs/ opens it one level: its 40 folders, the two touched first, named by their own folder
  const runs = listItems(data, 'folder', ['runs/'], 20)
  assert.deepEqual(runs.slice(1, 3).map(x => [x.g.key, x.g.name, x.depth]), [['runs/r01/', 'r01/', 1], ['runs/r02/', 'r02/', 1]])
  assert.equal(runs.filter(x => x.kind === 'group' && x.depth === 1).length, 40)
  // ↵ on r01/ opens its touched file and one line for its 9 untouched files, which opens to them
  const r01 = listItems(data, 'folder', ['runs/', 'runs/r01/'], 20)
  const at = r01.findIndex(x => x.id === itemId('g', 'runs/r01/'))
  assert.deepEqual(r01.slice(at + 1, at + 3).map(x => [x.kind, x.depth]), [['file', 2], ['rest', 2]])
  assert.equal(r01[at + 2].files, 9)
  const all = listItems(data, 'folder', ['runs/', 'runs/r01/', 'rest:runs/r01/'], 20)
  assert.equal(all.filter(x => x.kind === 'file' && x.depth === 3).length, 9)
  // a search went over the whole of y.jsonl: r02/ is searched over in part, though none of it was read
  const r02 = runs.find(x => x.id === itemId('g', 'runs/r02/')).g
  assert.equal(r02.read, 0)
  assert.ok(r02.counted > 0)
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
    for (const s of ['0.03%', '100%', '0.1%', '<0.01%', 'read', 'searched', "read into Claude's context", 'searched or computed over']) assert.ok(text.includes(s), `${s} at ${w}: ${text}`)
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

test('a folder\'s subject leaves out a size its files do not share; an open file is the part a question is about', async () => {
  await import('../../draw/kit.js')
  const coverage = (await import('../coverage.js')).default
  const DK = globalThis.DrawKit
  // a folder of a Makefile and a log: no one unit, so no size, and no empty field in its words
  const groups = Array.from({ length: 30 }, (_, r) => ({ folder: `runs/r${String(r).padStart(2, '0')}/`, files: 2, touched: r === 0 ? 1 : 0, units: [{ unit: 'lines', units: 40 }, { unit: 'records', units: 9 }] }))
  const files = groups.map(g => ({ path: `${g.folder}Makefile`, type: 'txt', unit: 'lines', units: 40, status: 'not read', touched: false }))
  const cov = { session: 's', total: { files: 60, touched_files: 1 }, files, untouched: { path: groups.map(g => `${g.folder}events.jsonl`), unit: groups.map(() => 'records'), units: groups.map(() => 9) }, groups, types: [] }
  const data = coverage.data({ coverage: { cov } }, {}, { w: 100, h: 40 })
  const run = state => DK.run(coverage.program, data, { w: 100, h: 40, mode: 'pane', state })
  const top = run({})
  const label = top.regions.find(r => r.id === top.selected).meta.label
  assert.match(label, /^runs\/: 60 files; Claude read/)
  // ↵ on a file nothing touched opens it with no line to walk: the file itself is selected, named by its path
  const few = coverage.data({ coverage: { cov: { session: 's', total: { files: 1, touched_files: 0 }, files: [], untouched: { path: ['passengers.csv'], unit: ['rows'], units: [891] }, groups: [], types: [] } } }, {}, { w: 100, h: 40 })
  const opened = DK.run(coverage.program, few, { w: 100, h: 40, mode: 'pane', state: {}, event: { type: 'key', key: 'return' } })
  const d = DK.run(coverage.program, few, { w: 100, h: 40, mode: 'pane', state: opened.state })
  assert.equal(d.state?.file ?? opened.state.file, 'passengers.csv')
  assert.equal(d.regions.find(r => r.id === d.selected)?.meta.label, 'passengers.csv: none')
})

test("a CSV's file view counts its rows, not its header line", async () => {
  await import('../../draw/kit.js')
  const coverage = (await import('../coverage.js')).default
  const DK = globalThis.DrawKit
  const f = { path: 'passengers.csv', type: 'csv', unit: 'rows', units: 891, rows: 891, lines: 892, seen_units: 2, status: 'seen', touched: true, ranges: [[2, 3]], read_share: 0.002, counted_share: 1 }
  const cov = { session: 's', total: { files: 1, touched_files: 1, seen_files: 1, units: [{ unit: 'rows', units: 891, seen: 2 }] }, files: [f], untouched: { path: [], unit: [], units: [] }, groups: [], types: [] }
  const data = coverage.data({ coverage: { cov } }, {}, { w: 100, h: 40 })
  const { gridText, renderTerm } = await import('../../draw/term.js')
  const text = gridText(renderTerm(DK.run(coverage.program, data, { w: 100, h: 40, mode: 'pane', state: { file: 'passengers.csv' } }), { w: 100 }))
  assert.match(text, /file · 891 rows/)
  assert.doesNotMatch(text, /892 rows/)
})
