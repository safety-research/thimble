// The Claims graph in cells (shell/claimgraph.js): the layout keeps each cluster an island that fills the area, no two
// claims touch and a cluster's name touches none; at rest no line is drawn; the hovered claim shows a card of what it
// means (at most five lines) and its links, a revision dashed and faint; a claim whose denominator was not stated has a
// faint ? beside it; a replay shows the claims made so far, the newest bold.
//   node --test lean/shell/test/claimgraph.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyTurn, emptyStore, viewOf } from '../../verbs/claims/claims.js'
import { cardLines, compose, layout, line, neighbours } from '../claimgraph.js'

function store() {
  const s = emptyStore('s1')
  const text = Array.from({ length: 18 }, (_, i) => `Fact number ${i + 1} holds for wiki ${'abc'[i % 3]}.`).join(' ')
  applyTurn(s, { places: [{ row: 'r1', by: 'claude', turn: 1, text }], turn: 1, out: { claims: Array.from({ length: 18 }, (_, i) => ({ claim: `Fact ${i + 1} about wiki ${'abc'[i % 3]}`, quote: `Fact number ${i + 1} holds`, kind: 'finding', cluster: `wiki ${'abc'[i % 3]}` })) } })
  applyTurn(s, { places: [{ row: 'r2', by: 'claude', turn: 2, text: 'No: fact number 2 is wrong, it is 3.' }], turn: 2, out: { claims: [{ claim: 'Fact 2 is wrong; it is 3', quote: 'fact number 2 is wrong', kind: 'finding', revises: 'c2', precisely: 'Wiki b holds 3 of the facts, not 2, counted over all its pages', based_on: 'q2 · wiki b, all pages · 3 rows', judgment: "'wrong' is a reading: the first count used one page", unstated: 'All of June, or only after June 18?' }] } })
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

test('at rest no line is drawn; the hovered claim shows its card and its links, a revision dashed and faint; the rest fades', () => {
  const v = viewOf(store())
  const groups = v.groups.filter(g => g.id)
  const lay = layout(v.flat, groups, { w: 120, h: 30 })
  const base = { claims: v.flat, clusters: groups, lay, visible: null, colorOf: c => `#00000${groups.findIndex(g => g.id === c.cluster)}`, amber: '#e0a43a', cite: '#4f46e5' }
  const rest = compose({ ...base, focus: null })
  const t = draw(rest)
  assert.doesNotMatch(t, /[─│╱╲╌╎]/)
  assert.equal((t.match(/[●○◉]/g) || []).length, 19)
  assert.equal((t.match(/○/g) || []).length, 1)
  for (const name of ['wiki a', 'wiki b', 'wiki c']) assert.ok(t.includes(name))
  assert.ok(rest.flat().filter(r => r.node).every(r => !r.style.faint))
  // the claim whose window was not stated has a faint ? beside it
  const p19 = lay.pos.get('c19')
  assert.equal(rest[p19.y].map(r => r.s).join('')[p19.x + 1], '?')
  // the hover on the correction: its card, a faint dashed amber line to the claim it revised, the rest faded
  const near = neighbours(v.flat, 'c19')
  assert.equal(near.get('c2'), 'revised')
  const f = compose({ ...base, focus: 'c19' })
  const ft = draw(f)
  for (const words of ['Fact 2 is wrong; it is 3', 'Precisely   Wiki b holds 3 of the facts, not 2', 'Based on    q2 · wiki b, all pages · 3 rows', "Judgment    'wrong' is a reading", 'Not stated  All of June, or only after June 18?']) assert.ok(ft.includes(words), words)
  assert.ok(f.card && f.card.h === 5)
  assert.ok(f.flat().some(r => r.style && r.style.color === '#e0a43a' && r.style.faint && /[╌╎╱╲]/.test(r.s)))
  // the card never covers its own claim, and Based on reads as a cite
  const pf = lay.pos.get('c19')
  assert.ok(!(pf.y >= f.card.y && pf.y < f.card.y + f.card.h && pf.x >= f.card.x - 1 && pf.x <= f.card.x + f.card.w))
  assert.ok(f.flat().some(r => r.style && r.style.color === '#4f46e5' && r.s.includes('q2 · wiki b')))
  const nodes = f.flat().filter(r => r.node)
  assert.equal(nodes.find(r => r.node === 'c19').style.faint, false)
  assert.ok(nodes.filter(r => r.style.faint).length >= 12)
  // lines are cells of glyphs between two claims, their ends left out
  assert.deepEqual(line({ x: 0, y: 0 }, { x: 4, y: 0 }).map(p => p.ch).join(''), '───')
  assert.deepEqual(line({ x: 0, y: 0 }, { x: 0, y: 3 }).map(p => p.ch).join(''), '││')
})

test('a card is at most five lines: the claim and Precisely wrap to two while there is room; a sparkline draws beside Based on', () => {
  const text = (lines) => lines.map(l => l.map(r => r.s).join(''))
  const long = { text: 'June 18 had the most saves of any day in the wiki, by far, and most were by agents', precisely: 'June 18 had 6,543 saves, the most of the 92 days from May 1 to July 31, counted from revisions.jsonl', based_on: 'q1 · revisions.jsonl, May–July · 6,543 rows', sources: [{ ref: 'q1@n', values: [1, 2, 9, 3] }] }
  const a = text(cardLines(long, 60))
  assert.equal(a.length, 5)
  assert.ok(a[0].startsWith('June 18 had the most saves'))
  assert.ok(a[2].startsWith('Precisely'))
  assert.ok(a[3].startsWith('            '))
  assert.match(a[4], /^Based on {4}q1 · revisions\.jsonl.*[▁▂▃▄▅▆▇]{4}$/)
  // with a judgment and what was not stated, the claim and Precisely take one line each
  const b = text(cardLines({ ...long, judgment: "'by far' is a reading: no test", unstated: 'Of all days, or of weekdays?' }, 60))
  assert.equal(b.length, 5)
  assert.deepEqual(b.map(l => l.slice(0, 11).trim()), ['June 18 had', 'Precisely', 'Based on', 'Judgment', 'Not stated'])
  assert.ok(b.every(l => l.length <= 60))
  // a claim with none of it (an older store): its words, and its sources as Based on
  assert.deepEqual(text(cardLines({ text: 'Bots made 4% of edits', sources: [{ ref: 'q5#bot=yes@share', label: '4%' }] }, 60)), ['Bots made 4% of edits', 'Based on    q5 · bot=yes · share'])
})

test('a replay shows the claims made so far, the newest bold, and no revision before it is made', () => {
  const v = viewOf(store())
  const groups = v.groups.filter(g => g.id)
  const lay = layout(v.flat, groups, { w: 120, h: 34 })
  const order = v.flat.map(c => c.id).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
  const visible = new Set(order.slice(0, 18))
  const rows = compose({ claims: v.flat, clusters: groups, lay, visible, newest: new Set(['c18']), focus: null, colorOf: () => '#000000', amber: '#e0a43a' })
  const t = draw(rows)
  assert.equal((t.match(/[●○◉]/g) || []).length, 18)
  assert.ok(!t.includes('○'))
  assert.equal(rows.flat().find(r => r.node === 'c18').style.bold, true)
  assert.equal(rows.flat().find(r => r.node === 'c17').style.bold, false)
  // a cluster's name shows once a claim of it is made
  const first = compose({ claims: v.flat, clusters: groups, lay, visible: new Set(['c1']), focus: null, colorOf: () => '#000000', amber: '#e0a43a' })
  assert.ok(draw(first).includes('wiki a'))
  assert.ok(!draw(first).includes('wiki b'))
})
