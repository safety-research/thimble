// Claims as pure functions (claims/store.js, graph.js, lens.mjs, estimate.mjs): the lens's claims parsed, each placed
// by its words with the citations near it, a restatement counted (×N), a correction linked both ways, clusters named,
// renamed and split, the folder's map merged and merged again, the graph's edges and layout, the pane drawn on the
// card runtime (the graph, the claim selected, where it came from), and the folder's estimate.
//   node --test plugin/claims/test/
import '../../test-home.mjs'
import '../../draw/kit.js'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { gridText, renderTerm } from '../../draw/term.js'
import { keysOf } from '../../panes/host.js'
import { parseAnswer } from '../../observer/evidence.js'
import { ROOT, textOf } from '../../prompts/node.mjs'
import { composeSystem, composeTurn, sectionsOf } from '../../observer/compose.mjs'
import pane, { layout, messageRows } from '../graph.js'
import lens from '../lens.mjs'
import { cost, estimate, looksLikeTranscript, runsOf } from '../estimate.mjs'
import { applyTurn, clusterFor, edgesOf, emptyStore, findQuote, grownClusters, isFolderCard, likeness, locate, mergeFolder, noteFor, noteGap, parseClaims, plainOf, promptLines, readStore, sentenceAt, shortRef, sourcesNear, viewOf } from '../store.js'

const DK = globalThis.DrawKit

// a made-up wiki: the analyst's question and two of Claude's messages in turn 1
const Q1 = 'was there any bias in the edits? who drove it?'
const A1 = 'Yes. **The tilt is one editor.** Kestrel made [41%](q4#user=Kestrel@share) of June\'s edits, and [212 of them](q7#user=Kestrel@n) were reverts.\n\n- June 18 had [6,543 saves](q1#day=2026-06-18@n), the busiest day.\n- Bots made [4%](q5#bot=yes@share) of edits.'
const PLACES1 = [{ row: 'u1', by: 'person', turn: 1, text: Q1 }, { row: 'r1', by: 'claude', turn: 1, text: 'Let me count the edits per user.' }, { row: 'r2', by: 'claude', turn: 1, text: A1 }]
const OUT1 = { claims: [
  { quote: 'The tilt is one editor', claim: 'The tilt in the edits is one editor', cluster: 'testing for bias' },
  { quote: "Kestrel made 41% of June's edits", cluster: 'finding who edited' },
  { quote: 'June 18 had 6,543 saves', cluster: 'the June 18 burst' },
  { quote: 'Bots made 4% of edits', cluster: 'ruling out bots' },
] }

function turn1() {
  const store = emptyStore('s1')
  const res = applyTurn(store, { places: PLACES1, out: OUT1, turn: 1, at: '2026-10-18T10:00:00Z' })
  return { store, res }
}

// ------------------------------------------------------------------------------------------------ the lens's claims

test("the lens's claims are read as given: a quote names a claim that gives no words of its own; a same, a correction, who said it", () => {
  const got = parseClaims([
    { quote: 'June 18 had 6,543 saves', cluster: 'k1' },
    { same: 'c2', quote: 'the edits were biased', by: 'analyst' },
    { claim: 'A correction', quote: 'it is two editors', revises: 'c1', by: 'Person' },
    { claim: 'no quote' },
    'not an object',
  ])
  assert.deepEqual(got.map(x => [x.text, x.by, x.same, x.revises]), [
    ['June 18 had 6,543 saves', 'claude', null, null],
    ['', 'person', 'c2', null],
    ['A correction', 'person', null, 'c1'],
  ])
  // one kind: a statement, with no parts beside its words
  assert.deepEqual(Object.keys(got[0]).sort(), ['at', 'by', 'cluster', 'links', 'quote', 'revises', 'same', 'text'])
  // the links a claim names to others: supports, contradicts or same topic, in the words it gives
  assert.deepEqual(parseClaims([{ quote: 'q', links: [{ to: 'c1', how: 'Supports' }, { to: '#2', how: 'contradiction' }, { to: 'c3', how: 'same topic' }, { to: 'c4', how: 'causes' }, { how: 'supports' }] }])[0].links,
    [{ to: 'c1', how: 'supports' }, { to: '#2', how: 'contradicts' }, { to: 'c3', how: 'same topic' }])
  const a = parseAnswer('{"notes": [], "claims": [{"claim": "x", "quote": "y"}], "clusters": [{"id": "k1", "name": "z"}]}')
  assert.deepEqual(lens.read(a), { claims: [{ claim: 'x', quote: 'y' }], clusters: [{ id: 'k1', name: 'z' }] })
})

test("the lens's text composes: its principles in the system prompt, its digest of the claims so far in the message, and no rule of code's", () => {
  const t = textOf('lens-claims', ROOT, {}).text
  const s = sectionsOf(t)
  assert.match(s.body, /^## The claims of this turn/)
  assert.ok(s.digest.includes('{{CLAIMS}}'))
  const { store } = turn1()
  const st = { store, grown: [] }
  const sys = composeSystem('F {{LENSES}} {{SKELETON}}', [{ lens, text: t }])
  assert.match(sys.text, /"claims": \[\]\}$/)
  const turn = composeTurn('T {{DIGEST}}{{RULES}}', {}, [{ lens, text: t }], st)
  assert.match(turn.text, /- c2 · k2 · Kestrel made 41% of June's edits/)
  // whether a turn holds claims is the lens's own judgment: code adds no rule for it
  assert.deepEqual(lens.when({ store }), [])
  assert.deepEqual(Object.keys(s.when), [])
})

// ------------------------------------------------------------------------------------------------ where it was said

test('a quote is found in the words as read, and its sources are the citations in its sentence', () => {
  assert.equal(plainOf('**Yes.** see [41%](q4#a@b) and `code`').plain, 'Yes. see 41% and code')
  const hit = findQuote(A1, 'Kestrel made 41% of June’s edits')
  assert.equal(A1.slice(hit.start, hit.end), "Kestrel made [41%](q4#user=Kestrel@share) of June's edits")
  assert.equal(findQuote(A1, 'nothing like this is said anywhere'), null)
  const text = 'One. Two has [3.5 s](q1#a@b) here. Three.'
  const s = sentenceAt(text, 6, 9)
  assert.equal(text.slice(s.start, s.end), 'Two has [3.5 s](q1#a@b) here.')
  // the citations in the claim's own words; with none there, those of its sentence
  assert.deepEqual(sourcesNear(A1, hit.start, hit.end), [{ ref: 'q4#user=Kestrel@share', label: '41%' }])
  const tilt = findQuote(A1, 'The tilt is one editor')
  assert.deepEqual(sourcesNear(A1, tilt.start, tilt.end), [])
  const both = findQuote(A1, "Kestrel made 41% of June's edits, and 212 of them were reverts")
  assert.deepEqual(sourcesNear(A1, both.start, both.end).map(x => x.label), ['41%', '212 of them'])
  const s2 = 'Most runs failed: [31 of 40](q2#ended=fail@n).'
  const most = findQuote(s2, 'Most runs failed')
  assert.deepEqual(sourcesNear(s2, most.start, most.end).map(x => x.label), ['31 of 40'])
  assert.equal(shortRef('runs/r1/agents/a.jsonl#L12-L14'), 'a.jsonl:12-14')
  assert.equal(locate('any bias in the edits', PLACES1, 'person').place.row, 'u1')
  assert.equal(locate('Bots made 4% of edits', PLACES1).place.sentence, 'Bots made 4% of edits.')
})

// ------------------------------------------------------------------------------------------------ a turn

test('a turn adds its claims with where each was said, its sources and a cluster; c lights only for a correction', () => {
  const { store, res } = turn1()
  assert.deepEqual(res.added, ['c1', 'c2', 'c3', 'c4'])
  assert.deepEqual(store.clusters.map(c => c.name), ['testing for bias', 'finding who edited', 'the June 18 burst', 'ruling out bots'])
  const c2 = store.claims[1]
  assert.equal(c2.text, "Kestrel made 41% of June's edits")
  assert.deepEqual(c2.said.map(p => [p.row, p.by, p.turn]), [['r2', 'claude', 1]])
  assert.deepEqual(c2.sources.map(s => s.label), ['41%'])
  assert.equal(noteFor(res), '')
  assert.ok(!('kind' in c2) && !('precisely' in c2))
  assert.equal(noteFor({ added: ['c1', 'c2'] }), '')
  assert.equal(noteFor({ added: ['c5'], revised: ['c1'] }), '1 corrected')
  const r = applyTurn(store, { places: PLACES1, out: { claims: [{ claim: 'Made up', quote: 'words nobody wrote down' }] }, turn: 1 })
  assert.deepEqual(r.added, [])
  assert.match(r.dropped[0].why, /are not in this turn's messages/)
})

test('a claim said again adds its place (×N); a correction is linked both ways, also one of the same turn (#N)', () => {
  const { store } = turn1()
  const A2 = 'Fix one thing: it is two editors, not one. June 18 was the busiest day, with [6,543 saves](q1#day=2026-06-18@n).'
  const res = applyTurn(store, { places: [{ row: 'u2', by: 'person', turn: 2, text: "I'll say the tilt is one editor." }, { row: 'r3', by: 'claude', turn: 2, text: A2 }], turn: 2, out: { claims: [
    { same: 'c1', quote: 'the tilt is one editor', by: 'analyst' },
    { quote: 'it is two editors, not one', claim: 'The tilt is two editors, not one', revises: 'c1' },
    { same: 'c3', quote: 'June 18 was the busiest day' },
  ] } })
  assert.deepEqual(res.added, ['c5'])
  assert.deepEqual(res.restated, ['c1', 'c3'])
  const [c1, , c3] = store.claims
  assert.equal(c1.revised_by, 'c5')
  assert.equal(store.claims[4].revises, 'c1')
  assert.equal(store.claims[4].cluster, c1.cluster)
  assert.deepEqual(c1.said.map(p => p.by), ['claude', 'person'])
  assert.equal(viewOf(store).flat.find(c => c.id === 'c3').n, 2)
  assert.equal(c3.said.length, 2)
  assert.equal(noteFor(res), '1 corrected')
  assert.match(promptLines(store).claims, /- c1 · k1 · The tilt in the edits is one editor \(corrected by c5, ×2\)/)
  const same = applyTurn(store, { places: [{ row: 'u4', by: 'person', turn: 4, text: 'bots drove it' }, { row: 'r6', by: 'claude', turn: 4, text: 'Bots made only [4%](q5#bot=yes@share) of the edits.' }], turn: 4, out: { claims: [
    { quote: 'bots drove it', claim: 'Bots drove the bias', by: 'analyst', cluster: 'k4' },
    { quote: 'Bots made only 4% of the edits', cluster: 'k4', revises: '#1' },
  ] } })
  assert.deepEqual(same.revised, ['c6'])
  // said again in the same turn (#N): one claim, said twice
  const twice = applyTurn(store, { places: [{ row: 'r7', by: 'claude', turn: 5, text: 'Wren made [22%](q9#user=Wren@share) of the edits. In short, Wren made a fifth of them.' }], turn: 5, out: { claims: [
    { quote: 'Wren made 22% of the edits', cluster: 'k2' },
    { same: '#1', quote: 'Wren made a fifth of them' },
  ] } })
  assert.equal(twice.added.length, 1)
  assert.equal(store.claims.find(c => c.id === twice.added[0]).said.length, 2)
  assert.ok(likeness("Kestrel made 41% of June's edits", 'Kestrel made 41% of the edits in June') >= 0.8)
})

test('clusters: named by id or by name, a new name makes one; a grown one is offered to rename or split', () => {
  const { store } = turn1()
  assert.equal(clusterFor(store, 'Finding Who Edited'), 'k2')
  assert.equal(clusterFor(store, 'new: checking the reverts', 2), 'k5')
  assert.equal(clusterFor(store, ''), null)
  const many = Array.from({ length: 6 }, (_, i) => ({ claim: `Kestrel reverted page ${i + 1} twice in June`, quote: `page ${i + 1} reverted twice`, cluster: 'k2' }))
  const text = Array.from({ length: 6 }, (_, i) => `On page ${i + 1} reverted twice.`).join(' ')
  applyTurn(store, { places: [{ row: 'r5', by: 'claude', turn: 2, text }], out: { claims: many }, turn: 2 })
  const grown = grownClusters(store)
  assert.deepEqual(grown, [{ id: 'k2', name: 'finding who edited', from: 1, to: 7 }])
  const res = applyTurn(store, { places: [], out: { claims: [], clusters: [{ id: 'k2', name: "Kestrel's edits" }, { split: 'k2', name: 'the reverts', claims: ['c5', 'c6', 'c7', 'c8', 'c9', 'c10'] }] }, turn: 2, grown })
  assert.deepEqual(res.clusters.map(x => x.renamed || x.split), ['k2', 'k2'])
  assert.equal(store.claims.filter(c => c.cluster === 'k6').length, 6)
  // a split named as a cluster this same turn's claims made: one cluster of that name, holding both
  const r3 = applyTurn(store, { places: [{ row: 'r9', by: 'claude', turn: 3, text: 'Wren reverted page 9 twice.' }], turn: 3, out: { claims: [{ quote: 'Wren reverted page 9 twice', cluster: "Wren's edits" }], clusters: [{ split: 'k6', name: "Wren's edits", claims: ['c5', 'c6'] }] } })
  assert.equal(r3.added.length, 1)
  assert.equal(store.clusters.filter(c => c.name === "Wren's edits").length, 1)
  assert.equal(store.claims.filter(c => c.cluster === store.clusters.find(k => k.name === "Wren's edits").id).length, 3)
  noteGap(store, 3, 'the check of the answer did not run')
  assert.deepEqual(readStore(JSON.stringify(store), 's1').gaps, [{ turn: 3, why: 'the check of the answer did not run' }])
  assert.deepEqual(readStore('not json', 's2').claims, [])
})

test("the lens's digest holds every claim so far, one line each, with who said it, its correction and how often it was said", () => {
  const { store } = turn1()
  for (let i = 0; i < 60; i++) store.claims.push({ id: `x${i}`, text: `Page ${i} was moved twice`, said: [], sources: [], cluster: null })
  store.claims[0].revised_by = 'x1'
  store.claims[1].said.push({ by: 'person' })
  const d = lens.digest({ store, grown: [] })
  assert.equal(d.CLAIMS.split('\n').length, 64)
  assert.match(d.CLAIMS, /^- c1 · k1 · The tilt in the edits is one editor \(corrected by x1\)$/m)
  assert.match(d.CLAIMS, /^- c2 · k2 · Kestrel made 41% of June's edits \(×2\)$/m)
  assert.match(d.CLAIMS, /^- x59 · - · Page 59 was moved twice$/m)
  assert.match(d.CLUSTERS, /^- k1 · testing for bias · 1 claim$/m)
  assert.deepEqual(lens.digest({}), { CLAIMS: '(none yet)', CLUSTERS: '(none yet)', GROWN: '' })
})

// ------------------------------------------------------------------------------------------------ the folder's map

const MAP = {
  scope: { unit: 'trials', n: 3, what: 'every trial counted' },
  clusters: [{ id: 'belt', name: 'belt slips', lead: 'belt-skips' }, { id: 'scale', name: 'scale theory' }],
  claims: [
    { id: 'belt-skips', name: 'The belt skips a slot', cluster: 'belt', n: 2, of: 3, evidence: [{ ref: 'trials/t1.jsonl#L2', quote: 'The belt skips a slot' }] },
    { id: 'pinned', name: 'Pinned the belt', cluster: 'belt', evidence: [{ ref: 'trials/t3.jsonl#L2' }] },
    { id: 'scale-off', name: 'The scale is off', cluster: 'scale', evidence: [{ ref: 'trials/t2.jsonl#L2', quote: 'the scale is off' }] },
  ],
  relations: [{ from: 'belt-skips', to: 'scale-off', type: 'contradicts' }],
}

test("the folder's map joins the session's claims, marked as the folder's; saved again it changes in place", () => {
  assert.ok(isFolderCard('07-folder-claims') && isFolderCard('folder-claims') && !isFolderCard('07-folder-claims-2'))
  const store = emptyStore('s1')
  applyTurn(store, { places: [{ row: 'r1', by: 'claude', turn: 1, text: 'In trial 1, the belt skips a slot.' }], out: { claims: [{ quote: 'the belt skips a slot', cluster: 'the belt' }] }, turn: 1 })
  const res = mergeFolder(store, MAP, { card: '07-folder-claims', v: 1, at: 'T' })
  assert.equal(res.added.length, 2)
  assert.deepEqual(res.restated, ['c1'])
  assert.deepEqual(store.claims[0].said.map(p => p.by), ['claude', 'folder'])
  const pinned = store.claims.find(c => c.text === 'Pinned the belt')
  assert.deepEqual([pinned.by, store.clusters.find(k => k.id === pinned.cluster).name], ['folder', 'belt slips'])
  assert.deepEqual(store.folder, { card: '07-folder-claims', v: 1, at: 'T', claims: 3, clusters: 2, scope: { unit: 'trials', n: 3, what: 'every trial counted' } })
  assert.deepEqual(viewOf(store).groups.map(g => g.name), ['the belt', 'belt slips', 'scale theory'])
  // the map's relations are links on its claims
  assert.deepEqual(store.claims.find(c => c.id === 'c1').links, [{ to: store.claims.find(c => c.text === 'The scale is off').id, how: 'contradicts', folder: true }])
  // saved again with a claim fixed and one gone: changed in place, the gone one goes (the session's own stays)
  const v2 = { ...MAP, claims: [{ ...MAP.claims[0], name: 'The belt skips one slot in 3' }, MAP.claims[2]] }
  const again = mergeFolder(store, v2, { card: '07-folder-claims', v: 2, at: 'T2' })
  assert.deepEqual(again.dropped, [pinned.id])
  assert.equal(store.claims.find(c => c.id === 'c1').text, 'The belt skips one slot in 3')
  assert.equal(store.claims.length, 2)
  assert.equal(store.folder.v, 2)
})

// ------------------------------------------------------------------------------------------------ the graph

/** Turn 1, then turn 2: a correction of c1, a claim that cites a row c2 cites, and c3 said again. */
function turn2() {
  const { store } = turn1()
  const A2 = "Fix one thing: it is two editors, not one. Kestrel and Wren made [63%](q8#user=top2@share) of it, Kestrel's [41%](q4#user=Kestrel@share) the larger part. June 18 was the busiest day."
  applyTurn(store, { places: [{ row: 'r3', by: 'claude', turn: 2, text: A2 }], turn: 2, out: { claims: [
    { quote: 'it is two editors, not one', claim: 'The tilt is two editors, not one', revises: 'c1' },
    { quote: "Kestrel and Wren made 63% of it, Kestrel's 41% the larger part", claim: 'Kestrel and Wren made 63% of the tilt', cluster: 'k2', links: [{ to: '#1', how: 'supports' }, { to: 'c9', how: 'supports' }] },
    { same: 'c3', quote: 'June 18 was the busiest day', links: [{ to: 'c4', how: 'same topic' }] },
  ] } })
  return { store, A2 }
}

test("the graph's edges: a correction, a link one claim names to another, and claims that cite the same rows (a star to the first that cites them), one per pair", () => {
  const { store } = turn2()
  // a link to #N is to that claim of the same turn; a link to a claim that is not there is dropped
  assert.deepEqual(store.claims.find(c => c.id === 'c6').links, [{ to: 'c5', how: 'supports' }])
  assert.deepEqual(store.claims.find(c => c.id === 'c3').links, [{ to: 'c4', how: 'same topic' }])
  assert.deepEqual(edgesOf(viewOf(store).flat), [{ a: 'c5', b: 'c1', kind: 'corrects' }, { a: 'c6', b: 'c5', kind: 'relates', how: 'supports' }, { a: 'c3', b: 'c4', kind: 'relates', how: 'same topic' }, { a: 'c6', b: 'c2', kind: 'rows', ref: 'q4#user=Kestrel@share' }])
  const flat = [{ id: 'a', sources: [{ ref: 'x' }, { ref: 'y' }] }, { id: 'b', sources: [{ ref: 'x' }, { ref: 'y' }] }, { id: 'c', sources: [{ ref: 'x' }] }, { id: 'd', revises: 'a', sources: [{ ref: 'x' }] }]
  assert.deepEqual(edgesOf(flat).map(e => `${e.a}-${e.b} ${e.kind}`), ['d-a corrects', 'b-a rows', 'c-a rows'])
  // two values of one selection are the same rows
  assert.deepEqual(edgesOf([{ id: 'a', sources: [{ ref: 'q4#user=K@n' }] }, { id: 'b', sources: [{ ref: 'q4#user=K@share' }] }, { id: 'c', sources: [{ ref: 'q4#user=W@n' }] }]).map(e => `${e.a}-${e.b}`), ['b-a'])
})

test('the layout: each cluster an island in the order said, no two dots touching, each name clear of the dots, the same every time', () => {
  const nodes = Array.from({ length: 24 }, (_, i) => ({ id: `c${i + 1}`, cluster: `k${(i % 4) + 1}` }))
  const clusters = [1, 2, 3, 4].map(i => ({ id: `k${i}`, name: `cluster number ${i}` }))
  const lay = layout(nodes, clusters, { w: 80, h: 24 })
  assert.ok(lay.fits)
  const ps = [...lay.pos.values()]
  assert.equal(ps.length, 24)
  for (const p of ps) assert.ok(p.x >= 1 && p.x <= 78 && p.y >= 1 && p.y <= 23, JSON.stringify(p))
  for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) assert.ok(ps[i].y !== ps[j].y || Math.abs(ps[i].x - ps[j].x) >= 2, `${JSON.stringify(ps[i])} ${JSON.stringify(ps[j])}`)
  assert.equal(lay.names.length, 4)
  for (const n of lay.names) assert.ok(!ps.some(p => p.y === n.y && p.x >= n.x && p.x < n.x + n.name.length), n.name)
  // a cluster's claims are nearer each other than the claims of another
  const mid = k => { const m = nodes.filter(n => n.cluster === k).map(n => lay.pos.get(n.id)); return [m.reduce((s, p) => s + p.x, 0) / m.length, m.reduce((s, p) => s + p.y, 0) / m.length] }
  const d = (a, b) => Math.hypot(a[0] - b[0], (a[1] - b[1]) * 2)
  const p1 = lay.pos.get('c1')
  assert.ok(d([p1.x, p1.y], mid('k1')) < d([p1.x, p1.y], mid('k2')))
  // in the order said: an earlier claim of a cluster stands left of a later one in its row, or in a row above
  const before = (a, b) => { const p = lay.pos.get(a), q = lay.pos.get(b); return p.y < q.y || (p.y === q.y && p.x < q.x) }
  assert.ok(before('c1', 'c5') && before('c5', 'c9') && before('c2', 'c22'))
  assert.deepEqual([...layout(nodes, clusters, { w: 80, h: 24 }).pos], [...lay.pos])
  // a hundred and fifty claims in twelve clusters fit a side panel's graph
  const many = Array.from({ length: 150 }, (_, i) => ({ id: `c${i + 1}`, cluster: `k${(i % 12) + 1}` }))
  const big = layout(many, Array.from({ length: 12 }, (_, i) => ({ id: `k${i + 1}`, name: `question ${i + 1}` })), { w: 100, h: 30 })
  assert.ok(big.fits)
  const bp = [...big.pos.values()]
  assert.equal(new Set(bp.map(p => `${p.x},${p.y}`)).size, 150)
  for (const p of bp) assert.ok(p.x >= 0 && p.x < 100 && p.y >= 0 && p.y < 30, JSON.stringify(p))
})

// ------------------------------------------------------------------------------------------------ the pane

const draw = (data, o = {}) => {
  const d = DK.run(pane.program, data, { w: 90, h: 44, mode: 'pane', ...o })
  assert.equal(d.error, undefined, d.error && d.error.message)
  return { d, text: gridText(renderTerm(d, { w: 90 })) }
}

test('the pane: the count, the graph with a dot per claim and each cluster named, and the newest claim under it, with no captions', () => {
  const { store } = turn2()
  const data = pane.data({ claims: { ...store, offer: { what: '3 trials', minutes: 4 } }, threads: [] })
  const { d, text } = draw(data)
  // the head: the count, and the folder's one action (a press), no estimate
  assert.match(text, /^6 claims {3}add the whole folder's claims\n/)
  assert.ok(d.regions.some(r => r.id === 'folder'))
  for (const name of ['testing for bias', 'finding who edited', 'the June 18 burst', 'ruling out bots']) assert.ok(text.includes(name), name)
  // a dot per claim, each a part of its own: hollow once corrected, heavier when said again
  assert.deepEqual(d.regions.filter(r => /^n-/.test(r.id)).map(r => r.id).sort(), ['n-c1', 'n-c2', 'n-c3', 'n-c4', 'n-c5', 'n-c6'])
  assert.equal((text.match(/○/g) || []).length, 2)
  assert.ok(text.includes('◉'))
  // no legend, no turn numbers, no "from" or "supported by" lines
  assert.ok(!/earlier left|related|turn \d|\bfrom\b|supported by|to turn/.test(text), text)
  // at rest: the last turn's correction selected: its sentence, then the claim it corrects
  assert.equal(d.selected, 'n-c5')
  assert.match(text, /● The tilt is two editors, not one\.\n {2}cites no rows\n {2}corrects ○ The tilt in the edits is one editor\.$/)
  // a claim selected: its sentence, then its evidence (read through the kernel)
  const six = draw(data, { state: { claim: 'c6' } })
  assert.match(six.text, /● Kestrel and Wren made 63% of the tilt\.\n {2}63% reading its rows…/)
  // a selection made before the last turn gives way to what is new
  assert.equal(draw(data, { state: { claim: 'c3', part: 'n-c3', at: 1 } }).d.selected, 'n-c5')
  assert.equal(draw(data, { state: { claim: 'c3', part: 'n-c3', at: 2 } }).d.selected, 'n-c3')
  // its keys, as the side panel's bar names them (esc is the panel's own: back, then close): ↵ says what it does there
  assert.deepEqual(keysOf(six.d).map(k => `${k.key} ${k.words}`), ['↑↓ move', '↵ message'])
  assert.deepEqual(keysOf(draw(data, { state: { claim: 'c5', part: 'fix-c1' } }).d).map(k => `${k.key} ${k.words}`), ['↑↓ move', '↵ earlier claim'])
  assert.deepEqual(keysOf(draw(data, { state: { claim: 'c1', part: 'fix-c5' } }).d).map(k => `${k.key} ${k.words}`), ['↑↓ move', '↵ correction'])
})

test('the pane: the ring on a dot selects its claim; ↵ on it opens where it was said; its evidence is a table of the rows it cites; a correction goes to the other claim', () => {
  const { store } = turn2()
  const data = pane.data({ claims: store, threads: [] })
  const run = (state, event, got) => DK.run(pane.program, data, { w: 90, h: 44, mode: 'pane', state, event, got })
  const st = run({}, { type: 'focus', region: 'n-c2' }).state
  assert.deepEqual(st, { claim: 'c2', part: 'n-c2', at: 2 })
  // the dot selected is what the panel's thread asks about, with the claim's citations as its refs
  const sel = run(st)
  assert.equal(sel.selected, 'n-c2')
  assert.deepEqual(sel.regions.find(r => r.id === 'n-c2').meta.ref, ['q4#user=Kestrel@share'])
  assert.match(pane.thread({}, st, data).about, /the claim selected is "Kestrel made 41% of June's edits" \(turn 1, said as "Kestrel made 41% of June's edits, and 212 of them were reverts\."\)/)
  assert.deepEqual(sel.wants.map(w => w.request.rows[0]), ['q4#user=Kestrel@share'])
  // the row the citation names, read through the kernel: a table under the query's name, the value cited marked
  const got = { [JSON.stringify({ rows: ['q4#user=Kestrel@share'] })]: { chain: [{ step: 'query', id: 'q4', about: 'share by user', rows: [{ i: 3, user: 'Kestrel', n: 212, share: 0.41 }] }], rows: ['revisions.jsonl#L28'], count: 517 } }
  const shown = draw(data, { state: st, got })
  assert.match(shown.text, /● Kestrel made 41% of June's edits\.\n {2}share by user {4}n {2}share\n {2}Kestrel {8}212 {3}0\.41/)
  // a row of a file reads as its text
  const file = { [JSON.stringify({ rows: ['q4#user=Kestrel@share'] })]: { chain: [], rows: ['revisions.jsonl#L28'], count: 1, records: [{ ref: 'revisions.jsonl#L28', text: 'Kestrel saved Lexicon' }] } }
  assert.match(draw(data, { state: st, got: file }).text, /41% revisions\.jsonl:28 Kestrel saved Lexicon/)
  // a press on the dot selected (↵) opens where it was said; on another dot it selects that one
  assert.deepEqual(run(st, { type: 'press', region: 'n-c2' }).effects, [{ id: 'c2', row: 'r2', do: 'source' }])
  assert.deepEqual(run(st, { type: 'press', region: 'n-c4' }).state, { claim: 'c4', part: 'n-c4', at: 2 })
  assert.deepEqual(run(st, { type: 'press', region: 'said' }).effects, [{ id: 'c2', row: 'r2', do: 'source' }])
  // a press on a row of evidence opens it as a citation opens (over the pane, in the side panel)
  assert.deepEqual(run(st, { type: 'press', region: 'ev-1' }).effects, [{ mark: { kind: 'cite', ref: 'q4#user=Kestrel@share', label: '41%' }, do: 'open' }])
  // the ring on an evidence row selects that row, the claim kept
  const ev = run(st, { type: 'focus', region: 'ev-1' })
  assert.deepEqual(ev.state, { claim: 'c2', part: 'ev-1', at: 2 })
  assert.equal(run(ev.state).regions.find(r => r.id === 'ev-1').meta.ref, 'q4#user=Kestrel@share')
  // the claims it is linked to are drawn bold on a tinted ground, with no line and no row of words
  const linked = run({ claim: 'c5' })
  const ops = linked.root.kids.find(n => n.t === 'canvas').ops
  assert.ok(ops.some(o => o[0] === 'bg' && /-faint/.test(o[5])))
  assert.ok(!ops.some(o => o[0] === 'link'))
  assert.ok(!draw(data, { state: { claim: 'c5' } }).text.includes('Kestrel and Wren'))
  // a corrected claim names the claim that corrects it, and a press goes there
  const old = draw(data, { state: { claim: 'c1' } }).text
  assert.match(old, /○ The tilt in the edits is one editor\.\n {2}cites no rows\n {2}corrected by ● The tilt is two editors, not one\./)
  assert.deepEqual(run({ claim: 'c1' }, { type: 'press', region: 'fix-c5' }).state, { claim: 'c5', part: 'n-c5', at: 2 })
  // the pane takes no esc (the panel's own)
  assert.ok(!(run(st, { type: 'key', key: 'esc' }).effects || []).length)
  // the dots keep their places while the ring walks them, whatever the claim under the graph
  const dots = state => draw(data, { state }).text.split('\n').slice(0, 8).join('\n')
  assert.equal(dots({ claim: 'c1' }), dots({ claim: 'c3' }))
})

test('where it was said: the message as the person reads it, the claim\'s words marked, and where it was said again', () => {
  const { store } = turn2()
  const data = pane.data({ claims: store, 'record:r2': { text: A1 } }, { source: 'c3', row: 'r2' })
  assert.equal(pane.titleOf({ source: 'c3' }), 'Where it was said')
  assert.deepEqual(pane.reads({ source: 'c3', row: 'r2' }), ['claims', 'record:r2'])
  const d = DK.run(pane.program, data, { w: 70, h: 30, mode: 'pane', state: {} })
  assert.equal(d.error, undefined)
  const text = gridText(renderTerm(d, { w: 70 }))
  assert.match(text, /^Where it was said {2}Claude's message\n\nYes\. The tilt is one editor\./)
  assert.match(text, /\n\n• June 18 had 6,543 saves, the busiest day\.\n• Bots made 4% of edits\./)
  assert.match(text, /also said\n“June 18 was the busiest day\.”/)
  assert.ok(!/turn \d/.test(text))
  assert.ok(!d.selected)
  assert.match(pane.thread({ source: 'c3' }, {}, data).about, /where the claim "June 18 had 6,543 saves" was said \(turn 1\)/)
  assert.equal(pane.thread({ source: 'c3' }, {}, data).label, 'where "June 18 had 6,543 saves" was said')
  // the marked words: the quote's, also where the offsets no longer hold them
  const m = messageRows(A1, { quote: 'June 18 had 6,543 saves', start: 0, end: 3 }, 60)
  const marked = m.rows[m.at].filter(x => x.on).map(x => x.s).join('')
  assert.match(marked, /^June 18 had 6,543 saves,?$/)
  assert.equal(messageRows(A1, { quote: 'nothing like it' }, 60), null)
})

test('the pane: its thread\'s conversation is the panel\'s, under it; with no claims it says how they come; the folder being read says so', () => {
  const { store } = turn1()
  const thread = { key: 'pane-claims-claims', status: 'done', turns: [{ role: 'person', text: 'is this all of June?' }, { role: 'claude', text: 'Yes.' }] }
  const data = pane.data({ claims: store, threads: [thread] })
  assert.equal(data.talk, true)
  assert.ok(!draw(data).text.includes('is this all of June'))
  assert.match(draw(pane.data({ claims: emptyStore('s'), threads: [] })).text, /No claims yet\./)
  assert.match(draw(pane.data({ claims: { ...store, folderAsked: 'T' }, threads: [] })).text, /Claude is reading the whole folder for its claims/)
  const folder = emptyStore('s')
  mergeFolder(folder, MAP, { card: '07-folder-claims', v: 1 })
  const f = draw(pane.data({ claims: folder, threads: [] }))
  assert.match(f.text, /^3 claims\n/)
  assert.ok(f.text.includes('belt slips (folder)'))
  // a claim of the folder's map: its evidence is its quote, and a press on it opens its first evidence row
  const st = { claim: folder.claims.find(c => c.text === 'The belt skips a slot').id }
  assert.match(draw(pane.data({ claims: folder, threads: [] }), { state: st }).text, /● The belt skips a slot\. · from the folder's map\n {2}“The belt skips a slot” t1\.jsonl:2/)
  const pr = DK.run(pane.program, pane.data({ claims: folder, threads: [] }), { w: 90, h: 44, mode: 'pane', state: st, event: { type: 'press', region: 'said' } })
  assert.deepEqual(pr.effects, [{ mark: { kind: 'cite', ref: 'trials/t1.jsonl#L2', label: 'The belt skips a slot' }, do: 'open' }])
})

test('the pane is never taller than its rows: the graph takes the rows the claim under it leaves, also with 150 claims', () => {
  // n claims over turns of 30 claims each, in 12 clusters
  const build = n => {
    const st = emptyStore('s')
    for (let from = 0, turn = 1; from < n; from += 30, turn++) {
      const ids = Array.from({ length: Math.min(30, n - from) }, (_, i) => from + i + 1)
      const t = ids.map(i => `Wiki ${i} had [${i + 10} saves](q${i % 7}#n).`).join(' ')
      applyTurn(st, { places: [{ row: `r${turn}`, by: 'claude', turn, text: t }], turn, out: { claims: ids.map(i => ({ quote: `Wiki ${i} had ${i + 10} saves`, cluster: `wiki group ${(i % 12) + 1}` })) } })
    }
    return st
  }
  const many = build(40)
  for (const claim of ['c1', 'c20', 'c40']) {
    const { d, text: t } = draw(pane.data({ claims: many, threads: [] }), { h: 24, state: { claim } })
    assert.ok(t.split('\n').length <= 24, `${claim}: ${t.split('\n').length} rows`)
    assert.equal(d.selected, `n-${claim}`)
    assert.equal(d.regions.filter(r => /^n-/.test(r.id)).length, 40)
  }
  const lots = build(150)
  for (const claim of ['c1', 'c75', 'c150']) {
    const { d, text: t } = draw(pane.data({ claims: lots, threads: [] }), { w: 100, h: 44, state: { claim } })
    assert.ok(t.split('\n').length <= 44, `${claim}: ${t.split('\n').length} rows`)
    assert.equal(d.selected, `n-${claim}`)
    assert.equal(d.regions.filter(r => /^n-/.test(r.id)).length, 150)
  }
  // a conversation under the pane: about two fifths of the rows are its, and the input bar's
  const talk = pane.data({ claims: many, threads: [{ key: 'pane-claims-claims', turns: [{ role: 'person', text: 'q' }] }] })
  const { d: dm, text: tm } = draw(talk, { h: 44, state: { claim: 'c13' } })
  assert.ok(tm.split('\n').length <= 44 - 4 - 17, `${tm.split('\n').length} rows`)
  assert.equal(dm.selected, 'n-c13')
})

// ------------------------------------------------------------------------------------------------ the folder's estimate

const line = (type, text) => JSON.stringify({ type, sessionId: 's1', message: { role: type, content: [{ type: 'text', text }] } })

test('the estimate: transcripts are runs, a folder of records is files; time and tokens grow slowly with the size', () => {
  const root = mkdtempSync(join(tmpdir(), 'claims-'))
  mkdirSync(join(root, 'trials'))
  for (let i = 1; i <= 3; i++) writeFileSync(join(root, 'trials', `t${i}.jsonl`), [line('user', 'sort the parcels'), line('assistant', 'The belt skips a slot.')].join('\n') + '\n')
  const e = estimate(root)
  assert.equal(e.kind, 'runs')
  assert.equal(e.what, '3 trials')
  assert.deepEqual(Object.keys(e.offer), ['what', 'minutes', 'tokens', 'read', 'detail'])
  assert.ok(e.minutes >= 1)
  assert.ok(looksLikeTranscript(line('assistant', 'hi')))
  assert.ok(!looksLikeTranscript('{"day": "2026-01-02", "n": 4}'))
  assert.equal(runsOf([{ path: 'runs/a/x.jsonl' }, { path: 'runs/b/y.jsonl' }]).runs.length, 2)
  const data = mkdtempSync(join(tmpdir(), 'claims-'))
  writeFileSync(join(data, 'orders.csv'), 'id,n\n1,2\n3,4\n')
  const d = estimate(data)
  assert.deepEqual([d.kind, d.what, d.rows], ['dataset', 'orders.csv', 2])
  const a = cost(2, 1e6)
  const b = cost(40, 1e9)
  assert.ok(b.minutes > a.minutes && b.minutes < a.minutes * 4)
})
