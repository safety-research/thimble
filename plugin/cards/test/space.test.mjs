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

test('the rows stay where they are when the selection moves', () => {
  for (const sel of [0, 1, 5, 7]) assert.equal(lines(spaced(dense(sel), 80)).length, lines(spaced(dense(2), 80)).length)
})

test('a small card, a column the view spaced itself, and a table header stay as they are', () => {
  const small = B([T('Fay ran longest of the eight agents, at 41 minutes.'), T('ada 3'), T('bram 5')], { flexDirection: 'column' })
  assert.equal(spaced(small, 80), small)
  const gap = { ...dense(1), p: { flexDirection: 'column', gap: 1 } }
  assert.equal(spaced(gap, 80), gap)
  const margin = dense(1)
  margin.c[3] = { ...margin.c[3], p: { marginTop: 1 } }
  assert.equal(spaced(margin, 80), margin)
  const table = B([T('agent   run  tests  failed', { bold: true }), ...Array.from({ length: 14 }, (_, i) => T(`a${i}        1     10       0`))], { flexDirection: 'column' })
  assert.equal(spaced(table, 80), table)
})

test('a card never grows by more than four rows', () => {
  const parts = Array.from({ length: 8 }, (_, i) => [T([T(`Part ${i}`, { bold: true }), ' of the run']), T('  a line'), T('  another line')]).flat()
  const t = B([T('The eight parts of the run took about as long as each other.'), ...parts], { flexDirection: 'column' })
  assert.equal(lines(spaced(t, 80)).length - lines(t).length, 4)
})
