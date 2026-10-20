// Claims as pure functions (claims/store.js, atlas.js, lens.mjs, estimate.mjs): the lens's claims parsed with what
// each leaves open, each placed by its words with the citations near it, a restatement counted (×N), a correction
// linked both ways, clusters named, renamed and split, the folder's map merged and merged again, what a claim bears
// on, the links between clusters as arcs, the pane drawn on the card runtime, and the folder's estimate.
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
import pane, { arcRows } from '../atlas.js'
import lens from '../lens.mjs'
import { cost, estimate, looksLikeTranscript, runsOf } from '../estimate.mjs'
import { applyTurn, claimless, clusterFor, clusterLinks, emptyStore, findQuote, grownClusters, isFolderCard, laneLinks, likeness, locate, mergeFolder, meaningOf, nearLines, noteFor, noteGap, parseClaims, plainOf, promptLines, readStore, related, sentenceAt, shortRef, sourcesNear, viewOf } from '../store.js'

const DK = globalThis.DrawKit

// a made-up wiki: the analyst's question and two of Claude's messages in turn 1
const Q1 = 'was there any bias in the edits? who drove it?'
const A1 = 'Yes. **The tilt is one editor.** Kestrel made [41%](q4#user=Kestrel@share) of June\'s edits, and [212 of them](q7#user=Kestrel@n) were reverts.\n\n- June 18 had [6,543 saves](q1#day=2026-06-18@n), the busiest day.\n- Bots made [4%](q5#bot=yes@share) of edits.'
const PLACES1 = [{ row: 'u1', by: 'person', turn: 1, text: Q1 }, { row: 'r1', by: 'claude', turn: 1, text: 'Let me count the edits per user.' }, { row: 'r2', by: 'claude', turn: 1, text: A1 }]
const OUT1 = { claims: [
  { quote: 'The tilt is one editor', claim: 'The tilt in the edits is one editor', kind: 'judgment', cluster: 'testing for bias', unstated: 'Of all June edits, or of the reverts?' },
  { quote: "Kestrel made 41% of June's edits", kind: 'finding', cluster: 'finding who edited', precisely: "41% of the 517 edits saved in June were Kestrel's" },
  { quote: 'June 18 had 6,543 saves', kind: 'event', cluster: 'the June 18 burst' },
  { quote: 'Bots made 4% of edits', kind: 'finding', cluster: 'ruling out bots' },
] }

function turn1() {
  const store = emptyStore('s1')
  const res = applyTurn(store, { places: PLACES1, out: OUT1, turn: 1, at: '2026-10-18T10:00:00Z' })
  return { store, res }
}

// ------------------------------------------------------------------------------------------------ the lens's claims

test("the lens's claims are read as given: a quote names a claim that gives no words of its own; a same, a correction, who said it", () => {
  const got = parseClaims([
    { quote: 'June 18 had 6,543 saves', kind: 'Event', cluster: 'k1' },
    { same: 'c2', quote: 'the edits were biased', by: 'analyst' },
    { claim: 'A correction', quote: 'it is two editors', kind: 'judgement call', revises: 'c1', by: 'Person' },
    { claim: 'no quote' },
    'not an object',
  ])
  assert.deepEqual(got.map(x => [x.text, x.by, x.kind, x.same, x.revises]), [
    ['June 18 had 6,543 saves', 'claude', 'event', null, null],
    ['', 'person', 'claim', 'c2', null],
    ['A correction', 'person', 'judgment', null, 'c1'],
  ])
  const a = parseAnswer('{"notes": [], "claims": [{"claim": "x", "quote": "y"}], "clusters": [{"id": "k1", "name": "z"}]}')
  assert.deepEqual(lens.read(a), { claims: [{ claim: 'x', quote: 'y' }], clusters: [{ id: 'k1', name: 'z' }] })
  assert.deepEqual(meaningOf({ precisely: 'x '.repeat(200), judgment: 'none', unstated: '' }), { precisely: 'x '.repeat(120).trim() })
})

test("the lens's text composes: its principles in the system prompt, its digest of the claims so far and its quiet rule in the message", () => {
  const t = textOf('lens-claims', ROOT, {}).text
  const s = sectionsOf(t)
  assert.match(s.body, /^## The claims of this turn/)
  assert.ok(s.digest.includes('{{NEAR}}') && s.when.quiet)
  const { store } = turn1()
  const st = { store, grown: [], turnText: 'and the bots?' }
  const sys = composeSystem('F {{LENSES}} {{SKELETON}}', [{ lens, text: t }])
  assert.match(sys.text, /"claims": \[\]\}$/)
  const turn = composeTurn('T {{DIGEST}}{{RULES}}', {}, [{ lens, text: t }], st)
  assert.match(turn.text, /- c2 · k2 · Kestrel made 41% of June's edits/)
  // a turn whose words state nothing true or false gets the quiet rule
  assert.ok(composeTurn('T {{DIGEST}}{{RULES}}', {}, [{ lens, text: t }], st).text.includes('nothing that could be true or false'))
  assert.ok(!composeTurn('T {{DIGEST}}{{RULES}}', {}, [{ lens, text: t }], { ...st, turnText: 'June had 41% bots' }).text.includes('nothing that could be true or false'))
  assert.ok(claimless('Thanks! Can you look at the logs next?'))
  assert.ok(!claimless('Most runs [failed](r1#x@n).'))
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
  assert.deepEqual(sourcesNear(A1, hit.start, hit.end), [{ ref: 'q4#user=Kestrel@share', label: '41%' }, { ref: 'q7#user=Kestrel@n', label: '212 of them' }])
  assert.equal(shortRef('runs/r1/agents/a.jsonl#L12-L14'), 'a.jsonl:12-14')
  assert.equal(locate('any bias in the edits', PLACES1, 'person').place.row, 'u1')
  assert.equal(locate('Bots made 4% of edits', PLACES1).place.sentence, 'Bots made 4% of edits.')
})

// ------------------------------------------------------------------------------------------------ a turn

test('a turn adds its claims with where each was said, its sources, its kind and a cluster; c lights only for one that reads two ways', () => {
  const { store, res } = turn1()
  assert.deepEqual(res.added, ['c1', 'c2', 'c3', 'c4'])
  assert.deepEqual(store.clusters.map(c => c.name), ['testing for bias', 'finding who edited', 'the June 18 burst', 'ruling out bots'])
  const c2 = store.claims[1]
  assert.equal(c2.text, "Kestrel made 41% of June's edits")
  assert.deepEqual(c2.said.map(p => [p.row, p.by, p.turn]), [['r2', 'claude', 1]])
  assert.deepEqual(c2.sources.map(s => s.label), ['41%', '212 of them'])
  assert.equal(noteFor(res), '1 claim reads two ways')
  assert.equal(noteFor({ added: ['c1', 'c2'] }), '')
  assert.equal(noteFor({ added: ['c5'], revised: ['c1'] }), '1 claim corrected')
  const r = applyTurn(store, { places: PLACES1, out: { claims: [{ claim: 'Made up', quote: 'words nobody wrote down' }] }, turn: 1 })
  assert.deepEqual(r.added, [])
  assert.match(r.dropped[0].why, /are not in this turn's messages/)
})

test('a claim said again adds its place (×N); a correction is linked both ways, also one of the same turn (#N)', () => {
  const { store } = turn1()
  const A2 = 'Fix one thing: it is two editors, not one. June 18 was the busiest day, with [6,543 saves](q1#day=2026-06-18@n).'
  const res = applyTurn(store, { places: [{ row: 'u2', by: 'person', turn: 2, text: "I'll say the tilt is one editor." }, { row: 'r3', by: 'claude', turn: 2, text: A2 }], turn: 2, out: { claims: [
    { same: 'c1', quote: 'the tilt is one editor', by: 'analyst' },
    { quote: 'it is two editors, not one', claim: 'The tilt is two editors, not one', kind: 'finding', revises: 'c1' },
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
  assert.equal(noteFor(res), '1 claim corrected')
  assert.match(promptLines(store).claims, /- c1 · k1 · The tilt in the edits is one editor \(corrected by c5, ×2\)/)
  const same = applyTurn(store, { places: [{ row: 'u4', by: 'person', turn: 4, text: 'bots drove it' }, { row: 'r6', by: 'claude', turn: 4, text: 'Bots made only [4%](q5#bot=yes@share) of the edits.' }], turn: 4, out: { claims: [
    { quote: 'bots drove it', claim: 'Bots drove the bias', by: 'analyst', kind: 'claim', cluster: 'k4' },
    { quote: 'Bots made only 4% of the edits', kind: 'finding', cluster: 'k4', revises: '#1' },
  ] } })
  assert.deepEqual(same.revised, ['c6'])
  assert.ok(likeness("Kestrel made 41% of June's edits", 'Kestrel made 41% of the edits in June') >= 0.8)
})

test('clusters: named by id or by name, a new name makes one; a grown one is offered to rename or split', () => {
  const { store } = turn1()
  assert.equal(clusterFor(store, 'Finding Who Edited'), 'k2')
  assert.equal(clusterFor(store, 'new: checking the reverts', 2), 'k5')
  assert.equal(clusterFor(store, ''), null)
  const many = Array.from({ length: 6 }, (_, i) => ({ claim: `Kestrel reverted page ${i + 1} twice in June`, quote: `page ${i + 1} reverted twice`, kind: 'event', cluster: 'k2' }))
  const text = Array.from({ length: 6 }, (_, i) => `On page ${i + 1} reverted twice.`).join(' ')
  applyTurn(store, { places: [{ row: 'r5', by: 'claude', turn: 2, text }], out: { claims: many }, turn: 2 })
  const grown = grownClusters(store)
  assert.deepEqual(grown, [{ id: 'k2', name: 'finding who edited', from: 1, to: 7 }])
  const res = applyTurn(store, { places: [], out: { claims: [], clusters: [{ id: 'k2', name: "Kestrel's edits" }, { split: 'k2', name: 'the reverts', claims: ['c5', 'c6', 'c7', 'c8', 'c9', 'c10'] }] }, turn: 2, grown })
  assert.deepEqual(res.clusters.map(x => x.renamed || x.split), ['k2', 'k2'])
  assert.equal(store.claims.filter(c => c.cluster === 'k6').length, 6)
  // a split named as a cluster this same turn's claims made: one cluster of that name, holding both
  const r3 = applyTurn(store, { places: [{ row: 'r9', by: 'claude', turn: 3, text: 'Wren reverted page 9 twice.' }], turn: 3, out: { claims: [{ quote: 'Wren reverted page 9 twice', kind: 'event', cluster: "Wren's edits" }], clusters: [{ split: 'k6', name: "Wren's edits", claims: ['c5', 'c6'] }] } })
  assert.equal(r3.added.length, 1)
  assert.equal(store.clusters.filter(c => c.name === "Wren's edits").length, 1)
  assert.equal(store.claims.filter(c => c.cluster === store.clusters.find(k => k.name === "Wren's edits").id).length, 3)
  noteGap(store, 3, 'the check of the answer did not run')
  assert.deepEqual(readStore(JSON.stringify(store), 's1').gaps, [{ turn: 3, why: 'the check of the answer did not run' }])
  assert.deepEqual(readStore('not json', 's2').claims, [])
})

test('the claims so far that bear on a turn: all of a small store; of a long one, those that share words, and the latest', () => {
  const { store } = turn1()
  assert.equal(nearLines(store, 'anything').left, 0)
  for (let i = 0; i < 30; i++) store.claims.push({ id: `x${i}`, text: `Page ${i} was moved twice`, said: [], sources: [], cluster: null })
  const near = nearLines(store, "Kestrel's 41% share of edits")
  assert.ok(near.left > 0)
  assert.match(near.claims, /c2 · k2 · Kestrel made 41%/)
})

// ------------------------------------------------------------------------------------------------ the folder's map

const MAP = {
  scope: { unit: 'trials', n: 3, what: 'every trial counted' },
  clusters: [{ id: 'belt', name: 'belt slips', lead: 'belt-skips' }, { id: 'scale', name: 'scale theory' }],
  claims: [
    { id: 'belt-skips', name: 'The belt skips a slot', kind: 'finding', cluster: 'belt', n: 2, of: 3, evidence: [{ ref: 'trials/t1.jsonl#L2', quote: 'The belt skips a slot' }] },
    { id: 'pinned', name: 'Pinned the belt', kind: 'judgment call', cluster: 'belt', evidence: [{ ref: 'trials/t3.jsonl#L2' }] },
    { id: 'scale-off', name: 'The scale is off', kind: 'claim', cluster: 'scale', evidence: [{ ref: 'trials/t2.jsonl#L2', quote: 'the scale is off' }] },
  ],
  relations: [{ from: 'belt-skips', to: 'scale-off', type: 'contradicts' }, { from: 'pinned', to: 'belt-skips', type: 'supports' }],
}

test("the folder's map joins the session's claims, marked as the folder's; saved again it changes in place", () => {
  assert.ok(isFolderCard('07-folder-claims') && isFolderCard('folder-claims') && !isFolderCard('07-folder-claims-2'))
  const store = emptyStore('s1')
  applyTurn(store, { places: [{ row: 'r1', by: 'claude', turn: 1, text: 'In trial 1, the belt skips a slot.' }], out: { claims: [{ quote: 'the belt skips a slot', kind: 'finding', cluster: 'the belt' }] }, turn: 1 })
  const res = mergeFolder(store, MAP, { card: '07-folder-claims', v: 1, at: 'T' })
  assert.equal(res.added.length, 2)
  assert.deepEqual(res.restated, ['c1'])
  assert.deepEqual(store.claims[0].said.map(p => p.by), ['claude', 'folder'])
  const pinned = store.claims.find(c => c.text === 'Pinned the belt')
  assert.deepEqual([pinned.by, pinned.kind, store.clusters.find(k => k.id === pinned.cluster).name], ['folder', 'judgment', 'belt slips'])
  assert.deepEqual(store.folder, { card: '07-folder-claims', v: 1, at: 'T', claims: 3, clusters: 2, scope: { unit: 'trials', n: 3, what: 'every trial counted' } })
  // the map's relations: what each claim bears on, with why
  const v = viewOf(store)
  assert.deepEqual(related(v.flat, 'c1').map(r => [r.id, r.why]), [['c3', 'contradicts'], [pinned.id, 'supported by']])
  assert.deepEqual(v.groups.map(g => g.name), ['the belt', 'belt slips', 'scale theory'])
  // saved again with a claim fixed and one gone: changed in place, the gone one goes (the session's own stays)
  const v2 = { ...MAP, claims: [{ ...MAP.claims[0], name: 'The belt skips one slot in 3' }, MAP.claims[2]], relations: [] }
  const again = mergeFolder(store, v2, { card: '07-folder-claims', v: 2, at: 'T2' })
  assert.deepEqual(again.dropped, [pinned.id])
  assert.equal(store.claims.find(c => c.id === 'c1').text, 'The belt skips one slot in 3')
  assert.equal(store.claims.length, 2)
  assert.equal(store.folder.v, 2)
})

test('what a claim bears on, and the links between clusters as arcs in lanes at the map\'s left', () => {
  const { store } = turn1()
  applyTurn(store, { places: [{ row: 'r3', by: 'claude', turn: 2, text: 'Fix one thing: it is two editors. Kestrel and Wren made [63%](q8#user=top2@share) of it; Kestrel alone [41%](q4#user=Kestrel@share).' }], turn: 2, out: { claims: [
    { quote: 'it is two editors', claim: 'The tilt is two editors', kind: 'finding', revises: 'c1' },
    { quote: 'Kestrel and Wren made 63% of it', claim: 'Kestrel and Wren made 63% of the tilt', kind: 'finding', cluster: 'k2' },
  ] } })
  const v = viewOf(store)
  assert.deepEqual(related(v.flat, 'c6').map(r => [r.id, r.why]), [['c2', 'same evidence'], ['c5', 'said beside it']])
  assert.deepEqual(related(v.flat, 'c5').map(r => r.why), ['corrects', 'said beside it'])
  // c2 and c6 cite the same row, in one cluster: no link; a correction across clusters is one
  store.claims.find(c => c.id === 'c6').cluster = 'k3'
  const links = clusterLinks(viewOf(store))
  assert.deepEqual(links.map(l => [l.a, l.b, l.n]), [['k2', 'k3', 1]])
  const rows = { k1: 0, k2: 1, k3: 2, k4: 3 }
  const lanes = laneLinks([{ a: 'k1', b: 'k4' }, { a: 'k2', b: 'k3' }, { a: 'k1', b: 'k2', corrects: true }], id => rows[id])
  // two links that meet at a row never share a lane
  assert.equal(lanes.lanes, 3)
  const arcs = arcRows(4, lanes.links, lanes.lanes + 1, l => l.a === 'k1')
  assert.deepEqual(arcs.map(r => r.replace(/\{[a-z-]+:(.)\}/g, '$1')), ['╭─┬─', '│╭┴─', '│╰──', '╰───'])
  // the selected cluster's links are bright, a correction in amber; the rest dim
  assert.match(arcs[1], /^\{accent:│\}\{dim:╭\}\{warn:┴\}/)
})

// ------------------------------------------------------------------------------------------------ the pane

const draw = (data, o = {}) => {
  const d = DK.run(pane.program, data, { w: 90, h: 44, mode: 'pane', ...o })
  assert.equal(d.error, undefined, d.error && d.error.message)
  return { d, text: gridText(renderTerm(d, { w: 90 })) }
}

test('the pane: the head, the map of clusters with their dots and lead claims, the selected cluster and its claim', () => {
  const { store } = turn1()
  const data = pane.data({ claims: { ...store, offer: { what: '3 trials', minutes: 4 } }, threads: [] })
  const { d, text } = draw(data)
  assert.match(text, /^Claims {2}4 claims · 4 clusters · to turn 1/)
  assert.match(text, /● finding 2 {3}● judgment call 1 {3}● event 1/)
  assert.match(text, /map the claims of the whole folder · 3 trials · about 4 min/)
  for (const name of ['testing for bias', 'finding who edited', 'the June 18 burst', 'ruling out bots']) assert.ok(text.includes(name), name)
  // at rest: the newest claim's cluster, its lead claim selected with what it leaves open
  assert.match(text, /▸testing for bias/)
  assert.equal(d.selected, 'c-c1')
  assert.match(text, /not stated {2}Of all June edits, or of the reverts\?/)
  assert.match(text, /“The tilt is one editor\.”/)
  // its keys, as the bar names them: no key hint in the pane itself
  // its keys, as the side panel's bar names them (esc is the panel's own: back, then close)
  assert.deepEqual(keysOf(d).map(k => `${k.key} ${k.words}`), ['↑↓ move', '↵ open'])
  assert.ok(!/esc|↵/.test(text))
})

test('the pane: the ring on a cluster or a claim selects it; a claim shows its evidence, read through the kernel, and what it bears on', () => {
  const { store } = turn1()
  const data = pane.data({ claims: store, threads: [] })
  const run = (state, event, got) => DK.run(pane.program, data, { w: 90, h: 44, mode: 'pane', state, event, got })
  let st = run({}, { type: 'focus', region: 'cl-k2' }).state
  assert.deepEqual(st, { cluster: 'k2', claim: 'c2', part: 'cl-k2' })
  // the row selected is what the panel's thread asks about: here the cluster
  assert.equal(run(st).selected, 'cl-k2')
  const want = run(st).wants.map(w => w.request.rows[0])
  assert.deepEqual(want, ['q4#user=Kestrel@share', 'q7#user=Kestrel@n'])
  const got = { [JSON.stringify({ rows: ['q4#user=Kestrel@share'] })]: { chain: [{ step: 'query', id: 'q4', about: 'share by user' }], rows: ['revisions.jsonl#L28'], count: 517, records: [{ ref: 'revisions.jsonl#L28', text: 'Kestrel saved Lexicon' }] } }
  const { d, text } = draw(data, { state: st, got })
  assert.match(text, /1 41% +q4 · share by user ← 517 source rows in revisions\.jsonl/)
  assert.match(text, /“Kestrel saved Lexicon”/)
  assert.match(text, /2 212 of them +reading its rows…/)
  assert.match(text, /precisely {3}41% of the 517 edits saved in June were Kestrel's/)
  // the digits open the evidence as a citation opens (over the pane, in the side panel)
  assert.deepEqual(keysOf(d).map(k => `${k.key} ${k.words}`), ['↑↓ move', '↵ open', '1 2 evidence'])
  const opened = run(st, { type: 'key', key: '2' })
  assert.deepEqual(opened.effects, [{ mark: { kind: 'cite', ref: 'q7#user=Kestrel@n', label: '212 of them' }, do: 'open' }])
  // the ring on an evidence row selects that row, the claim kept: a question there is about that evidence
  const ev = run(st, { type: 'focus', region: 'ev-1' })
  assert.deepEqual(ev.state, { cluster: 'k2', claim: 'c2', part: 'ev-1' })
  assert.equal(run(ev.state).selected, 'ev-1')
  assert.deepEqual(run(ev.state).regions.find(r => r.id === 'ev-1').meta.ref, 'q4#user=Kestrel@share')
  // ↵ on a cluster goes into it: its lead claim selected
  assert.deepEqual(run(st, { type: 'press', region: 'cl-k3' }).state, { cluster: 'k3', claim: 'c3', part: 'c-c3' })
  // a press on the claim's sentence shows the message; the pane takes no esc (the panel's own)
  assert.deepEqual(run(st, { type: 'press', region: 'said' }).effects, [{ row: 'r2', do: 'said' }])
  assert.ok(!(run(st, { type: 'key', key: 'esc' }).effects || []).length)
})

test('the pane: its thread\'s conversation is the panel\'s, under it; with no claims it says how they come; the folder being mapped says so', () => {
  const { store } = turn1()
  const thread = { key: 'pane-claims-claims', status: 'done', turns: [{ role: 'person', text: 'is this all of June?' }, { role: 'claude', text: 'Yes.' }] }
  const data = pane.data({ claims: store, threads: [thread] })
  assert.equal(data.talk, true)
  assert.ok(!draw(data).text.includes('is this all of June'))
  assert.match(draw(pane.data({ claims: emptyStore('s'), threads: [] })).text, /No claims yet\./)
  assert.match(draw(pane.data({ claims: { ...store, folderAsked: 'T' }, threads: [] })).text, /Claude is mapping the folder's claims/)
  const folder = emptyStore('s')
  mergeFolder(folder, MAP, { card: '07-folder-claims', v: 1 })
  const f = draw(pane.data({ claims: folder, threads: [] })).text
  assert.match(f, /the folder's map: 3 claims in 2 clusters, from 3 trials/)
  assert.match(f, /belt slips folder/)
  // the map's contradiction joins its two clusters with an arc
  assert.match(f, /╭─.*belt slips/)
  assert.match(f, /╰─.*scale theory/)
})

test('the pane is never taller than its rows: the cluster\'s claims are a window around the selected one, the panel cut at its end', () => {
  const store = emptyStore('s')
  const text = Array.from({ length: 30 }, (_, i) => `Page ${i + 1} was edited ${i + 2} times.`).join(' ')
  applyTurn(store, { places: [{ row: 'r1', by: 'claude', turn: 1, text }], turn: 1, out: { claims: Array.from({ length: 30 }, (_, i) => ({ quote: `Page ${i + 1} was edited ${i + 2} times`, kind: 'finding', cluster: 'the pages', precisely: 'x' })) } })
  const data = pane.data({ claims: store, threads: [] })
  for (const claim of ['c1', 'c15', 'c30']) {
    const { d, text: t } = draw(data, { h: 24, state: { claim } })
    assert.ok(t.split('\n').length <= 24, `${claim}: ${t.split('\n').length} rows`)
    assert.equal(d.selected, `c-${claim}`)
    assert.ok(t.includes(`Page ${claim.slice(1)} was edited`), claim)
  }
  const mid = draw(data, { h: 24, state: { claim: 'c15' } }).text
  assert.match(mid, /↑ \d+ more/)
  assert.match(mid, /↓ \d+ more/)
  // many clusters and a conversation under the pane: the map is a window, and the selected claim keeps its rows
  const many = emptyStore('s')
  const t2 = Array.from({ length: 24 }, (_, i) => `Wiki ${i + 1} had [${i + 10} saves](q${i + 1}#n).`).join(' ')
  applyTurn(many, { places: [{ row: 'r1', by: 'claude', turn: 1, text: t2 }], turn: 1, out: { claims: Array.from({ length: 24 }, (_, i) => ({ quote: `Wiki ${i + 1} had ${i + 10} saves`, kind: 'finding', cluster: `wiki group ${Math.floor(i / 2) + 1}` })) } })
  const talk = pane.data({ claims: many, threads: [{ key: 'pane-claims-claims', turns: [{ role: 'person', text: 'q' }] }] })
  const { d: dm, text: tm } = draw(talk, { h: 44, state: { claim: 'c13' } })
  assert.ok(tm.split('\n').length <= 44 - 4 - 17, `${tm.split('\n').length} rows`)
  assert.equal(dm.selected, 'c-c13')
  assert.match(tm, /evidence/)
  assert.match(tm, /▸wiki group 7/)
  assert.match(tm, /more/)
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
