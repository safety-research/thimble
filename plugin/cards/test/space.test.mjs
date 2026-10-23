// The blank rows the runner puts between a card's parts (cards/space.js), on made-up trees as the runner makes them.
//   node --test plugin/cards/test/space.test.mjs
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { layoutLines } from '../layout.js'
import { spaced } from '../space.js'

const T = (c, p = {}) => ({ t: 'Text', p, c: Array.isArray(c) ? c : [c] })
const B = (c, p = {}) => ({ t: 'Box', p, c })
const lines = t => layoutLines(t, 80).lines

/** A dense card: a takeaway, a legend, a chart of rows with a selection, its axis, and the selected row's detail. */
function dense(sel) {
  const names = ['ada', 'bram', 'cleo', 'dov', 'eli', 'fay', 'gus', 'hal']
  return B([
    T([T('Fay ran longest', { bold: true }), ' at 41 minutes, twice the median of the eight agents.']),
    T([T('█ tests  '), T('░ idle')]),
    ...names.map((n, i) => T([T((i === sel ? '▸ ' : '  ') + n.padEnd(6), { bold: true }), '█'.repeat(i + 2)])),
    T('        0    10    20 min'),
    T([T(names[sel], { bold: true }), ' ran 3 times']),
    T('  run 1 failed'),
    T('  run 2 passed'),
  ], { flexDirection: 'column' })
}

test('a dense card gets a blank row under its takeaway, around its legend and above its detail', () => {
  const out = lines(spaced(dense(2), 80))
  assert.deepEqual(out.slice(0, 5), ['Fay ran longest at 41 minutes, twice the median of the eight agents.', '', '█ tests  ░ idle', '', '  ada   ██'])
  assert.deepEqual(out.slice(-6), ['  hal   █████████', '        0    10    20 min', '', 'cleo ran 3 times', '  run 1 failed', '  run 2 passed'])
  assert.equal(out.length - lines(dense(2)).length, 3)
})

/** A score of lanes as the wiki card in a recording drew it: a ▼ note on its own row above the first lane, and the selected lane
 *  bold, with no ▸ (`whole`: the whole row bold, not only its name). */
function lanes(sel, whole = false) {
  const names = ['Welcome', 'MainPage', 'Sandbox', 'RecentChanges', 'HelpDesk', 'Archive']
  return B([
    T('Edits per page, May 24 to Jul 2, one mark per 12-hour bucket'),
    T(' '),
    T('                  May 24        Jun 1        Jun 9'),
    T('                                         ▼ peak 2,299 edits'),
    ...names.map((n, i) => T([T(n.padEnd(18), { bold: i === sel }), T('──·──•──●──'), T(String(100 * (6 - i)).padStart(6))], i === sel && whole ? { bold: true } : {})),
    T(' '),
    T([T(names[sel], { bold: true }), ' · busiest day Jun 18']),
    T('  top editors  ada 314'),
    T(' '),
    T('Welcome got the most edits, and most of them came on one day.'),
  ], { flexDirection: 'column' })
}

const rowOf = (out, name) => out.findIndex(l => l.startsWith(name + ' '))

test('the places of the blank rows are kept from the first drawing, so a row that reads as a heading in one state moves nothing', () => {
  const plan = new Map()
  const first = lines(spaced(lanes(0, true), 80, plan))
  // drawn alone, each state puts its blank row above the selected lane (bold through, it reads as a heading)
  assert.notEqual(rowOf(lines(spaced(lanes(2, true), 80)), 'MainPage'), rowOf(first, 'MainPage'))
  for (const sel of [1, 2, 5, 0]) {
    const out = lines(spaced(lanes(sel, true), 80, plan))
    assert.equal(out.length, first.length)
    for (const n of ['Welcome', 'MainPage', 'Sandbox', 'Archive']) assert.equal(rowOf(out, n), rowOf(first, n), `${n}, selection ${sel}`)
  }
  // another width, or a view that draws more parts, gets places of its own
  assert.equal(plan.size, 1)
  spaced(lanes(1, true), 60, plan)
  assert.equal(plan.size, 2)
})

