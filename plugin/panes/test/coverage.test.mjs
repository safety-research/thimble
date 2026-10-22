// The coverage pane (panes/coverage-view.mjs) as text: the overview's one bar and its key, one line per row, a folder
// opened one level, a file picked with its detail in its own unit, and the edge cases (nothing touched, everything
// read, too many rows, a narrow pane, files without lines). Made-up data only.
//   node --test plugin/panes/test/
//   COVERAGE_RENDER=1 node --test plugin/panes/test/   (also prints each state)
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { coverageView, pressView, stepView, textOf } from '../coverage-view.mjs'
import { textWidth } from '../../core/text.js'

const show = (title, v) => { if (process.env.COVERAGE_RENDER) console.log(`\n=== ${title}\n${textOf(v)}\n${'─'.repeat(20)}`) }

/** A made-up folder of 996 files: 16 trial folders of 57 or 56 files under trials/, each with one log a script went
 *  over (one of them also read by a label's model); a README Claude read; 91 notes, one PDF searched and one image
 *  measured. */
export const TRIALS = Array.from({ length: 16 }, (_, i) => `trial${(i % 3) + 1}-${['maple', 'birch', 'cedar', 'alder'][i % 4]}-${i < 8 ? 'guided' : 'open'}_${i % 2 ? 'tasks' : 'tasks_notes'}-${String(i).padStart(2, '0')}`)
function folderCov() {
  const groups = []
  const files = []
  const untouched = { path: [], unit: [], units: [], by: [] }
  TRIALS.forEach((t, i) => {
    const n = i < 8 ? 57 : 56
    groups.push({ folder: `trials/${t}/`, files: 3, touched: 1, seen_files: 0 })
    groups.push({ folder: `trials/${t}/agents/`, files: n - 7, touched: 0, seen_files: 0 })
    groups.push({ folder: `trials/${t}/prompts/`, files: 4, touched: 0, seen_files: 0 })
    files.push({ path: `trials/${t}/board.jsonl`, unit: 'records', units: 1617, seen: false, seen_units: 0, model_units: i === 4 ? 53 : 0, searched_units: 0,
      computed_units: i === 4 ? 1564 : 1617, computed_over_units: 1617, model_read_units: i === 4 ? 53 : 0, model: i === 4 ? 53 : 0,
      model_labels: i === 4 ? ['post_kind'] : [], labels: i === 4 ? ['post_kind'] : [], computed_by: ['python3', 'wc'], searched: false, status: 'computed' })
    for (const f of ['config.yaml', 'README.md', 'run.log']) { untouched.path.push(`trials/${t}/${f}`); untouched.unit.push('lines'); untouched.units.push(40); untouched.by.push('') }
    for (let k = 0; k < 4; k++) { untouched.path.push(`trials/${t}/prompts/p${k}.md`); untouched.unit.push('lines'); untouched.units.push(20); untouched.by.push('') }
  })
  groups.push({ folder: './', files: 1, touched: 1, seen_files: 1 })
  files.push({ path: 'README.md', unit: 'lines', units: 120, seen: true, seen_units: 120, model_units: 0, searched_units: 0, computed_units: 0, status: 'seen' })
  groups.push({ folder: 'notes/', files: 91, touched: 2, seen_files: 0 })
  files.push({ path: 'notes/protocol.pdf', unit: 'pages', units: 12, seen: false, seen_units: 0, model_units: 0, searched_units: 3, computed_units: 0, searched: true, searched_by: ['grep'], computed_by: [], status: 'searched' })
  files.push({ path: 'notes/board-layout.png', unit: 'file', units: 1, kind: 'image', seen: false, seen_units: 0, model_units: 0, searched_units: 0, computed_units: 1, computed_over_units: 1, computed_by: ['python3'], status: 'computed' })
  untouched.path.push('notes/interviews.csv'); untouched.unit.push('rows'); untouched.units.push(300); untouched.by.push('ls')
  return { root: '/made-up/data', total: { files: 996, touched_files: 19, seen_files: 1 }, groups, files, untouched }
}

const DIMS = { W: 66, H: 40 }
const fits = (v, W) => { for (const l of textOf(v).split('\n')) assert.ok(textWidth(l) <= W, `wider than ${W}: ${l}`) }

test('step 1, opened: one bar and its key, then one line per row with a small bar and the files touched', () => {
  const cov = folderCov()
  const v = coverageView(cov, null, DIMS)
  show('1 · opens', v)
  const t = textOf(v).split('\n')
  assert.match(t[0], /^Coverage +19\/996 files touched · 1\.9%$/)
  assert.match(t[1], /^█▓+░+$/)
  assert.equal(textWidth(t[1]), 66)
  assert.match(t[2], /█ read into Claude's context 1$/)
  assert.match(t[3], /▓ computed over or searched, not in its context 18 {3}░ untouched$/)
  assert.match(t[5], /touched$/)
  // the top folder Claude touched opens at first: each of its 16 folders on one line
  assert.match(t[6], /^▾ trials\/ +▓░+ {2}16\/904/)
  assert.equal(t.filter(l => l.startsWith('  ▸ trial')).length, 16)
  assert.ok(t.some(l => /^ {2}README\.md +█{12} {2}1\/1/.test(l)))
  assert.ok(t.some(l => /^▸ notes\/ .* 2\/91/.test(l)))
  assert.ok(!t.some(l => /rows \d/.test(l)))
  fits(v, 66)
})

test('step 2, a folder opened: ↵ shows what is directly in it, and ↵ again collapses it', () => {
  const cov = folderCov()
  const key = `dir:trials/${TRIALS[5]}/`
  let view = pressView(cov, null, key, DIMS)
  const v = coverageView(cov, view, DIMS)
  show('2 · a folder opened', v)
  const t = textOf(v)
  assert.match(t, new RegExp(`▾ ${TRIALS[5]}/`))
  assert.match(t, / {4}▸ agents\/ .* 0\/50/)
  assert.match(t, / {4}▸ prompts\/ .* 0\/4/)
  assert.match(t, / {6}board\.jsonl .*1\/1/)
  assert.match(t, / {6}config\.yaml .*0\/1/)
  // one level: the prompts folder's files do not show
  assert.doesNotMatch(t, /p0\.md/)
  fits(v, 66)
  view = pressView(cov, view, key, DIMS)
  assert.doesNotMatch(textOf(coverageView(cov, view, DIMS)), /board\.jsonl/)
})

test('step 3, a file picked: its detail in its own unit, the tree scrolled to keep it in view', () => {
  const cov = folderCov()
  // the pane as Claude Code gives it, with the thread's input under it
  const DIMS3 = { W: 66, H: 40, under: 5 }
  let view = pressView(cov, null, `dir:trials/${TRIALS[4]}/`, DIMS3)
  for (let i = 0; i < 4; i++) view = stepView(cov, view, 1, DIMS3)
  view = { ...view, sel: `file:trials/${TRIALS[4]}/board.jsonl` }
  for (let i = 0; i < 3; i++) view = stepView(cov, view, 1, DIMS3)
  for (let i = 0; i < 3; i++) view = stepView(cov, view, -1, DIMS3)
  const v = coverageView(cov, view, DIMS3)
  show('3 · a file picked', v)
  const t = textOf(v).split('\n')
  const sel = v.lines.find(l => l.sel)
  assert.match(sel.runs.map(r => r.s).join(''), /board\.jsonl/)
  assert.ok(t.some(l => /^ +rows \d+–\d+ of 25$/.test(l)))
  const d = t.slice(t.findIndex(l => /^─+$/.test(l)) + 1)
  // the folder cut in its middle, so the line keeps the name and the size
  assert.match(d[0], /^board\.jsonl  trials\/trial….*-04\/ · 1,617 records$/)
  assert.match(d[1], /^▓{24}$/)
  assert.match(d[2], /^█ in Claude's context +0\/1,617 records +0%$/)
  assert.match(d[3], /^▓ computed over +1,617\/1,617 +100% {2}python3, wc$/)
  assert.match(d[4], /^▓ read by a label's model +53\/1,617 +3\.3% {2}post_kind$/)
  // the thread's input under the pane keeps 5 rows; the rule and the keys 2
  assert.ok(t.length <= 40 - 5 - 2)
  fits(v, 66)
})

test('edge: too many rows scroll with the selection; the head stays and the line says which rows show', () => {
  const groups = Array.from({ length: 214 }, (_, i) => ({ folder: `days/2026-06-${String((i % 30) + 1).padStart(2, '0')}-run-${String(i * 7 + 11).padStart(3, '0')}/`, files: 19, touched: i % 3 ? 2 : 3, seen_files: i === 44 ? 1 : 0 }))
  const cov = { total: { files: 4066, touched_files: 42, seen_files: 3 }, groups, files: [], untouched: { path: [] } }
  let view = null
  for (let i = 0; i < 50; i++) view = stepView(cov, view, 1, DIMS)
  const v = coverageView(cov, view, DIMS)
  show('edge · too many rows', v)
  const t = textOf(v).split('\n')
  assert.match(t[0], /^Coverage/)
  assert.match(t.at(-1), /rows \d+–50 of 215$/)
  assert.ok(t.length <= 38)
  fits(v, 66)
})

test('edge: files without lines: a PDF counts its pages, an image is read or not as a whole', () => {
  const cov = folderCov()
  const view = pressView(cov, { open: ['notes/'] }, 'file:notes/protocol.pdf', DIMS)
  const pdf = textOf(coverageView(cov, view, DIMS))
  show('edge · a PDF picked', coverageView(cov, view, DIMS))
  assert.match(pdf, /protocol\.pdf {2}notes\/ · 12 pages/)
  assert.match(pdf, /█ in Claude's context +0\/12 pages +0%/)
  assert.match(pdf, /▓ searched +12\/12 +100% {2}grep/)
  const img = coverageView(cov, { ...view, sel: 'file:notes/board-layout.png' }, DIMS)
  show('edge · an image picked', img)
  assert.match(textOf(img), /board-layout\.png {2}notes\/ · image\n▓ computed over, not in Claude's context {2}python3$/)
})

test('edge: nothing touched yet: an empty bar and the top folders, dim, with their files', () => {
  const cov = { total: { files: 996, touched_files: 0, seen_files: 0 }, groups: [{ folder: 'trials/', files: 904 }, { folder: './', files: 1 }, { folder: 'notes/', files: 91 }], files: [], untouched: { path: ['README.md'], unit: ['lines'], units: [3], by: [''] } }
  const v = coverageView(cov, null, DIMS)
  show('edge · nothing touched yet', v)
  const t = textOf(v).split('\n')
  assert.match(t[0], /^Coverage +nothing touched yet$/)
  assert.equal(t[1], '░'.repeat(66))
  assert.match(t[3], /^▸ trials\/ +904 files$/)
  assert.match(t.join('\n'), /▸ notes\/ +91 files/)
  assert.match(t.join('\n'), / {2}README\.md +1 file/)
  assert.ok(v.lines.slice(3).every(l => l.runs.every(r => r.tone === 'dim')))
})

test('edge: everything read: the bar is full and the rows say all', () => {
  const names = ['interview-01.md', 'interview-02.md', 'interview-03.md', 'summary.md', 'codes.csv', 'README.md']
  const cov = { total: { files: 6, touched_files: 6, seen_files: 6 }, groups: [{ folder: 'notes/', files: 6, touched: 6, seen_files: 6 }],
    files: names.map(n => ({ path: `notes/${n}`, unit: 'lines', units: 10, seen: true, seen_units: 10 })), untouched: { path: [] } }
  const v = coverageView(cov, null, DIMS)
  show('edge · everything read', v)
  const t = textOf(v)
  assert.match(t, /^Coverage +6\/6 files touched · 100%\n█{66}\n/)
  assert.match(t, /▾ notes\/ +█{12} {2}all 6/)
  assert.equal(t.match(/█{12} {2}read/g).length, 6)
})

test('edge: a narrow pane (44 columns): no bars in the rows; the top bar and the counts stay', () => {
  const cov = folderCov()
  const v = coverageView(cov, null, { W: 44, H: 40 })
  show('edge · narrow', v)
  const t = textOf(v).split('\n')
  assert.match(t[0], /^Coverage +19\/996 touched · 1\.9%$/)
  assert.equal(textWidth(t[1]), 44)
  assert.match(t[2], /█ in context 1 {2}▓ computed 18 {2}░ untouched/)
  assert.match(t[4], /^▾ trials\/ +16\/904$/)
  assert.ok(!t.slice(4).some(l => /[█▓░]/.test(l)))
  fits(v, 44)
})
