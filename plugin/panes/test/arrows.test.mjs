// ← and → in the side panel's panes (panes/coverage.js, panes/labels.js, claims/graph.js): each program takes them
// where they mean something, and the host turns a move of the ring along the selected part's row into them
// (shell/detail.tsx rowWay).
//   node --test plugin/panes/test
import '../../test-home.mjs'
import '../../draw/kit.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import coverage from '../coverage.js'
import labels from '../labels.js'
import claims from '../../claims/graph.js'
import { applyTurn, emptyStore } from '../../claims/store.js'

const DK = globalThis.DrawKit
/** The program's state after `key`, from `state`. */
const after = (pane, data, state, key) => {
  const d = DK.run(pane.program, data, { w: 100, h: 40, mode: 'pane', state, event: { type: 'key', key } })
  assert.equal(d.error, undefined, d.error && d.error.message)
  return { ...state, ...(d.state || {}), selected: d.selected }
}

test('Coverage: → opens the group or the file selected, ← closes the group, goes up to it from a file in it, and back from a file', () => {
  const file = (path, o = {}) => ({ path, type: 'txt', unit: 'lines', units: 3, status: 'not read', touched: false, ...o })
  const files = [file('runs/r01/x.txt', { status: 'seen', touched: true, seen_units: 1, ranges: [[1, 1]] })]
  const rest = { path: [], unit: [], units: [] }
  for (let r = 0; r < 30; r++) for (let i = 0; i < 4; i++) if (r || i) { rest.path.push(`runs/r${String(r).padStart(2, '0')}/f${i}.txt`); rest.unit.push('lines'); rest.units.push(3) }
  const groups = Array.from({ length: 30 }, (_, r) => ({ folder: `runs/r${String(r).padStart(2, '0')}/`, files: 4, touched: r === 1 ? 1 : 0 }))
  const cov = { session: 's', total: { files: 120, touched_files: 1, seen_files: 1 }, files, untouched: rest, groups, types: [] }
  const data = coverage.data({ coverage: { cov } }, {}, { w: 100, h: 40 })
  let st = { at: 'g:runs/r01/' }
  st = after(coverage, data, st, 'right')
  assert.deepEqual(st.open, ['runs/r01/'])
  // → again on an open group does nothing; ↓ to its file, then ← goes up to the group, and ← again closes it
  assert.deepEqual(after(coverage, data, st, 'right').open, ['runs/r01/'])
  st = { ...st, at: 'f:runs/r01/x.txt' }
  st = after(coverage, data, st, 'left')
  assert.equal(st.at, 'g:runs/r01/')
  st = after(coverage, data, st, 'left')
  assert.deepEqual(st.open, [])
  // → on a file opens its lines; ← goes back to the list, on the file
  const few = coverage.data({ coverage: { cov: { ...cov, untouched: { path: ['b.txt'], unit: ['lines'], units: [3] }, files: [file('a.txt', { status: 'seen', touched: true })], groups: [] } } }, {}, { w: 100, h: 40 })
  st = after(coverage, few, { at: 'f:a.txt' }, 'right')
  assert.equal(st.file, 'a.txt')
  st = after(coverage, few, st, 'left')
  assert.equal(st.file, null)
  assert.equal(st.at, 'f:a.txt')
})

test('Labels: → opens the label selected, as ↵ does; ← goes back to the list', () => {
  const lab = name => ({ name, values: ['yes', 'no'], counts: { yes: 3, no: 2 }, records: 5, kind: 'regex', rule: 'x', in: 'a.jsonl' })
  const data = labels.data({ labels: { list: [lab('kind'), lab('mood')] } }, {}, { w: 100, h: 40 })
  let st = after(labels, data, { at: 'lb-1' }, 'right')
  assert.equal(st.open, 'mood')
  assert.equal(st.from, 'list')
  st = after(labels, data, st, 'left')
  assert.equal(st.open, null)
  // the ring starts on the label selected, never on the input bar
  assert.equal(labels.ringStart, 'part')
})

test('Claims: ← → go to the cluster before or after, on its first claim', () => {
  const store = emptyStore('s')
  const said = [['Kestrel made 41% of edits', 'who edited'], ['Wren made 22%', 'who edited'], ['June 18 had 6,543 saves', 'the burst'], ['The burst was one bot', 'the burst']]
  applyTurn(store, { places: [{ row: 'r1', by: 'claude', turn: 1, text: said.map(s => s[0]).join('. ') }], turn: 1, out: { claims: said.map(([quote, cluster]) => ({ quote, cluster })) } })
  const data = claims.data({ claims: store, threads: [] })
  const first = data.claims[0]
  const other = data.claims.find(c => String(c.cluster) !== String(first.cluster))
  let st = after(claims, data, { claim: first.id }, 'right')
  assert.equal(st.claim, other.id)
  st = after(claims, data, st, 'left')
  assert.equal(st.claim, first.id)
})
