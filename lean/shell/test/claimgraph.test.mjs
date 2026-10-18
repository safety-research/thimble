// The Claims graph in cells (shell/claimgraph.js): the layout keeps each cluster an island that fills the area, no two
// claims touch and a cluster's name touches none; at rest no line is drawn; the ring's claim shows its text and its
// links, a revision dashed; a search lights its matches with their labels, the words found marked.
//   node --test lean/shell/test/claimgraph.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyTurn, emptyStore, viewOf } from '../../verbs/claims/claims.js'
import { compose, layout, line, neighbours } from '../claimgraph.js'

function store() {
  const s = emptyStore('s1')
  const text = Array.from({ length: 18 }, (_, i) => `Fact number ${i + 1} holds for wiki ${'abc'[i % 3]}.`).join(' ')
  applyTurn(s, { places: [{ row: 'r1', by: 'claude', turn: 1, text }], turn: 1, out: { claims: Array.from({ length: 18 }, (_, i) => ({ claim: `Fact ${i + 1} about wiki ${'abc'[i % 3]}`, quote: `Fact number ${i + 1} holds`, kind: 'finding', cluster: `wiki ${'abc'[i % 3]}` })) } })
  applyTurn(s, { places: [{ row: 'r2', by: 'claude', turn: 2, text: 'No: fact number 2 is wrong, it is 3.' }], turn: 2, out: { claims: [{ claim: 'Fact 2 is wrong; it is 3', quote: 'fact number 2 is wrong', kind: 'finding', revises: 'c2' }] } })
  return s
}
const draw = (rows) => rows.map(r => r.map(x => x.s).join('')).join('\n')

test('the layout: each cluster an island, no two claims touching, every claim inside, each name clear of the claims', () => {
  const v = viewOf(store())
  const groups = v.groups.filter(g => g.id)
  const lay = layout(v.flat, groups, { w: 100, h: 30 })
  const ps = v.flat.map(c => lay.pos.get(c.id))
  for (const p of ps) assert.ok(p.x >= 1 && p.x <= 98 && p.y >= 0 && p.y <= 29, JSON.stringify(p))
  for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
    const a = ps[i], b = ps[j]
    assert.ok(!(a.y === b.y && Math.abs(a.x - b.x) < 4) && !(Math.abs(a.y - b.y) === 1 && Math.abs(a.x - b.x) < 2), `${JSON.stringify(a)} touches ${JSON.stringify(b)}`)
  }
  assert.equal(lay.names.length, 3)
  for (const n of lay.names) assert.ok(!ps.some(p => p.y === n.y && p.x >= n.x - 1 && p.x <= n.x + n.name.length), n.name)
  // islands: a claim is nearer its own cluster's centre than another's
  const centre = id => { const m = v.flat.filter(c => c.cluster === id).map(c => lay.pos.get(c.id)); return [m.reduce((s, p) => s + p.x, 0) / m.length, m.reduce((s, p) => s + p.y, 0) / m.length] }
  const cs = Object.fromEntries(groups.map(g => [g.id, centre(g.id)]))
  const d = (p, c) => Math.hypot(p.x - c[0], (p.y - c[1]) * 2)
  const near = v.flat.filter(c => { const p = lay.pos.get(c.id); return groups.every(g => g.id === c.cluster || d(p, cs[c.cluster]) <= d(p, cs[g.id])) }).length
  assert.ok(near >= v.flat.length - 1, `${near} of ${v.flat.length} nearest their own cluster`)
  // the same input lays out the same
  assert.deepEqual([...layout(v.flat, groups, { w: 100, h: 30 }).pos], [...lay.pos])
})

test('at rest no line is drawn; the ring\'s claim shows its text and its links, a revision dashed in amber; the rest fades', () => {
  const v = viewOf(store())
  const groups = v.groups.filter(g => g.id)
  const lay = layout(v.flat, groups, { w: 100, h: 30 })
  const base = { claims: v.flat, clusters: groups, lay, visible: null, selected: null, matches: null, colorOf: c => `#00000${groups.findIndex(g => g.id === c.cluster)}`, amber: '#e0a43a' }
  const rest = compose({ ...base, focus: null })
  const t = draw(rest)
  assert.doesNotMatch(t, /[─│╱╲╌╎]/)
  assert.equal((t.match(/[●○◉]/g) || []).length, 19)
  assert.equal((t.match(/○/g) || []).length, 1)
  for (const name of ['wiki a', 'wiki b', 'wiki c']) assert.ok(t.includes(name))
  assert.ok(rest.flat().filter(r => r.node).every(r => !r.style.faint))
  // the ring on the correction: its text, a dashed amber line to the claim it revised, the rest faded
  const near = neighbours(v.flat, 'c19')
  assert.equal(near.get('c2'), 'revised')
  const f = compose({ ...base, focus: 'c19' })
  const ft = draw(f)
  assert.ok(ft.includes('Fact 2 is wrong; it is 3'))
  assert.ok(f.flat().some(r => r.style && r.style.color === '#e0a43a'))
  const nodes = f.flat().filter(r => r.node)
  assert.equal(nodes.find(r => r.node === 'c2').style.faint, false)
  assert.ok(nodes.filter(r => r.style.faint).length >= 15)
  // lines are cells of glyphs between two claims, their ends left out
  assert.deepEqual(line({ x: 0, y: 0 }, { x: 4, y: 0 }).map(p => p.ch).join(''), '───')
  assert.deepEqual(line({ x: 0, y: 0 }, { x: 0, y: 3 }).map(p => p.ch).join(''), '││')
})

test('a search lights its matches with their labels, the words found marked; time shows the claims made by then', () => {
  const v = viewOf(store())
  const groups = v.groups.filter(g => g.id)
  const lay = layout(v.flat, groups, { w: 120, h: 34 })
  const matches = new Set(['c1', 'c19'])
  const rows = compose({ claims: v.flat, clusters: groups, lay, visible: null, focus: null, selected: null, matches, query: 'wrong', colorOf: () => '#000000', amber: '#e0a43a' })
  const t = draw(rows)
  assert.ok(t.includes('Fact 1 about wiki a'))
  assert.ok(t.includes('Fact 2 is wrong; it is 3'))
  assert.ok(rows.flat().some(r => r.style && r.style.mark && r.s.includes('wrong')))
  assert.ok(rows.flat().filter(r => r.node && !matches.has(r.node)).every(r => r.style.faint))
  // at turn 1 the correction is not made yet: 18 claims, none hollow
  const visible = new Set(v.flat.filter(c => c.turn === 1).map(c => c.id))
  const t1 = draw(compose({ claims: v.flat, clusters: groups, lay, visible, focus: null, selected: null, matches: null, colorOf: () => '#000000', amber: '#e0a43a' }))
  assert.equal((t1.match(/[●○◉]/g) || []).length, 18)
  assert.ok(!t1.includes('○'))
})
