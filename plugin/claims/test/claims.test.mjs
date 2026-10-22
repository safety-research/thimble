// Claims (claims/store.js, graph.js, lens.mjs): the lens's claims as the observer's reply gives them, placed by their
// words with the citations near them, and the Claims pane as graph.js lays it out, whose count stays
// on screen however many claims a session has. Made-up data only.
//   node --test plugin/claims/test/
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseAnswer } from '../../observer/reply.mjs'
import { graphView, hopCluster, paneData, rowText } from '../graph.js'
import lens from '../lens.mjs'
import { applyTurn, edgesOf, emptyStore, parseClaims, promptLines, readStore, viewOf } from '../store.js'

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
  assert.deepEqual(Object.keys(got[0]).sort(), ['at', 'by', 'cluster', 'links', 'quote', 'revises', 'same', 'text'])
  assert.deepEqual(parseClaims([{ quote: 'q', links: [{ to: 'c1', how: 'Supports' }, { to: '#2', how: 'contradiction' }, { to: 'c3', how: 'same topic' }, { to: 'c4', how: 'causes' }, { how: 'supports' }] }])[0].links,
    [{ to: 'c1', how: 'supports' }, { to: '#2', how: 'contradicts' }, { to: 'c3', how: 'same topic' }])
  assert.equal(parseClaims(Array.from({ length: 75 }, (_, i) => ({ quote: `claim number ${i + 1}` }))).length, 75)
  const a = parseAnswer('{"glosses": [], "claims": [{"claim": "x", "quote": "y"}], "clusters": [{"id": "k1", "name": "z"}]}')
  assert.deepEqual(lens.read(a), { claims: [{ claim: 'x', quote: 'y' }], clusters: [{ id: 'k1', name: 'z' }] })
  // the digest is what claims/term.ts claimsDigest gives, else none yet
  assert.equal(lens.digest({}).CLAIMS, '(none yet)')
  assert.equal(lens.digest({ claims: { CLAIMS: '- c1', CLUSTERS: '- k1', GROWN: '' } }).CLAIMS, '- c1')
})

test("a claim's sources are the citations [words](#) in or near its words, by row and offset; a restatement, a correction and the person's own", () => {
  const st = emptyStore('s')
  const answer = 'The tilt is one editor: without [212 edits](#) by Alice, the sides are even. Bots made [3 edits](#).'
  applyTurn(st, { turn: 1, places: [
    { row: 'u1', by: 'person', turn: 1, text: 'Were the edits biased after June 18?' },
    { row: 'a1', by: 'claude', turn: 1, text: answer },
  ], out: { claims: [
    { claim: 'Without the 212 edits by Alice, the sides are even.', quote: 'without 212 edits by Alice, the sides are even', cluster: 'who tilted it' },
    { claim: 'Bots made 3 edits.', quote: 'Bots made 3 edits', cluster: 'who tilted it', links: [{ to: '#1', how: 'same topic' }] },
    { claim: 'The edits were biased after June 18.', quote: 'the edits biased after June 18', by: 'analyst', cluster: 'who tilted it' },
  ] } })
  assert.deepEqual(st.claims.map(c => [c.id, c.by, c.sources.map(s => [s.row, s.at, s.label])]), [
    ['c1', 'claude', [['a1', answer.indexOf('[212'), '212 edits']]],
    ['c2', 'claude', [['a1', answer.indexOf('[3 edits'), '3 edits']]],
    ['c3', 'person', []],
  ])
  assert.deepEqual(st.claims[1].links, [{ to: 'c1', how: 'same topic' }])
  // a later turn says c1 again and corrects c3
  const res = applyTurn(st, { turn: 2, places: [{ row: 'a2', by: 'claude', turn: 2, text: 'Again: without Alice the sides are even. The edits were not biased, one editor tilted them.' }],
    out: { claims: [{ same: 'c1', quote: 'without Alice the sides are even' }, { claim: 'The edits were not biased; one editor tilted them.', quote: 'The edits were not biased, one editor tilted them', revises: 'c3' }] } })
  assert.deepEqual(res.restated, ['c1'])
  assert.deepEqual(res.revised, ['c3'])
  assert.equal(st.claims[0].said.length, 2)
  assert.equal(st.claims.find(c => c.id === 'c3').revised_by, 'c4')
  assert.match(promptLines(st).claims, /c3 · k1 · The edits were biased after June 18\. \(the analyst, corrected by c4\)/)
  // two claims citing the same place of a file are joined by a line (the pane adds `place` from the marks' evidence)
  const flat = viewOf(st).flat.map(c => ({ ...c, links: [], sources: c.sources.map(s => ({ ...s, place: 'edits.csv:4' })) }))
  assert.ok(edgesOf(flat).some(e => e.kind === 'rows'))
})

test("a store an earlier version kept leaves out the whole folder's map it held", () => {
  const st = readStore({ claims: [
    { id: 'c1', text: 'The run failed at step 4.', by: 'claude', cluster: 'k1', said: [{ row: 'r1', by: 'claude', quote: 'failed at step 4' }, { by: 'folder', quote: 'step 4' }], folder: { card: 'folder-claims', id: 'a' }, links: [{ to: 'c2', how: 'supports', folder: true }] },
    { id: 'c2', text: 'Agents blame a timezone bug', by: 'folder', cluster: 'k2', said: [{ by: 'folder', quote: 'a timezone mismatch' }] }],
  clusters: [{ id: 'k1', name: 'failures', turn: 1, named: 1 }, { id: 'k2', name: 'timezone detour', from: 'folder', named: 1 }],
  folder: { card: 'folder-claims', claims: 1 }, folderAsked: 't' }, 's')
  assert.deepEqual(st.claims.map(c => [c.id, c.said.length, c.links, c.folder]), [['c1', 1, [], undefined]])
  assert.deepEqual(st.clusters.map(k => k.id), ['k1'])
  assert.ok(!('folder' in st) && !('folderAsked' in st))
})

/** A store of many claims in uneven clusters with links, as a long session makes them. */
function uneven() {
  const st = emptyStore('s')
  for (let from = 0, turn = 1; from < 155; from += 31, turn++) {
    const ids = Array.from({ length: Math.min(31, 155 - from) }, (_, i) => from + i + 1)
    const t = ids.map(i => `Wiki ${i} had [${i + 10} saves](#).`).join(' ')
    applyTurn(st, { places: [{ row: `r${turn}`, by: 'claude', turn, text: t }], turn, out: { claims: ids.map(i => ({ quote: `Wiki ${i} had ${i + 10} saves`, cluster: `group ${i % 3 ? (i % 9) + 1 : 1}`, ...(i > 1 ? { links: [{ to: `c${i - 1}`, how: 'supports' }] } : {}) })) } })
  }
  return st
}

const text = view => [...view.head, [], ...view.graph].map(rowText).join('\n')
const panel = view => view.panel.map(rowText).join('\n')

test('the claims graph uses the whole pane above the panel, which shows the cluster selected, or the claim selected', () => {
  const data = paneData(uneven())
  for (const h of [46, 40, 34]) {
    const rest = graphView(data, {}, { w: 136, h })
    const tu = text(rest)
    assert.match(tu, /^Claims {3}155 · 7 clusters/)
    assert.ok(tu.split('\n').length + rest.panel.length <= h, `${h}: ${tu.split('\n').length} + ${rest.panel.length} rows`)
    // at rest: the newest claim's cluster, as a cluster (no claim selected), nothing dimmed
    assert.equal(rest.claim, null)
    assert.equal(rest.chosen, false)
    assert.match(panel(rest), /^─+\ngroup 3 {3}\d+ claims · turns 1–5\n {2}. Wiki /)
    const cols = tu.split('\n').slice(2).flatMap(l => [...l].map((ch, x) => (/[●◉○]/.test(ch) ? x : -1)).filter(x => x >= 0))
    assert.ok(Math.min(...cols) < 136 * 0.15 && Math.max(...cols) > 136 * 0.85, `${h}: dots from ${Math.min(...cols)} to ${Math.max(...cols)}`)
    const sel = graphView(data, { claim: 'c40' }, { w: 136, h })
    assert.equal(sel.claim.id, 'c40')
    // a claim: its cluster's name (a press selects the cluster) and its whole sentence, no other claim, no citation
    const p = panel(sel)
    assert.match(p, /^─+\ngroup 5 {3}\d+ claims · turns \d–\d\n. Wiki 40 had 50 saves\.$/)
    assert.ok(sel.panel[1].every(x => x.part === `g:${sel.group}`))
    // every dot is a press on its claim, and so is the blank cell beside it; the dots keep their places whatever is
    // selected (the graph's rows do not follow the panel's)
    assert.ok(sel.graph.some(r => r.some(x => x.part === 'd:c40')))
    const dotsOf = v => v.graph.map(r => rowText(r).replace(/[^●◉○]/g, ' ').trimEnd()).join('\n')
    assert.equal(dotsOf(sel), dotsOf(graphView(data, { claim: 'c155' }, { w: 136, h })))
    assert.equal(dotsOf(sel), dotsOf(rest))
    assert.ok(sel.graph.some(r => r.some((x, i) => x.part === 'd:c40' && x.s === ' ' && r[i + 1]?.part === 'd:c40')))
  }
})

test('a cluster selected: its name and its claims in the panel, each a press on the claim, no checks; its dots bold, the rest dim', () => {
  const data = paneData(uneven())
  const key = String(data.groups[2].id)
  const v = graphView(data, { group: key }, { w: 136, h: 40 })
  assert.equal(v.claim, null)
  assert.equal(v.group, key)
  assert.ok(v.chosen)
  const p = panel(v)
  assert.match(p, new RegExp(`^─+\\n${data.groups[2].name} {3}\\d+ claims`))
  assert.doesNotMatch(p, /▸|verified|not checked|cites/)
  const subs = v.panel.slice(2).filter(r => r.some(x => /^n:/.test(x.part || '')))
  assert.ok(subs.length >= 3)
  // its name is a press on the cluster; its dots are bold and lit, every other dot faint and plain
  assert.ok(v.graph.some(r => r.some(x => x.part === `g:${key}` && x.s.includes(data.groups[2].name))))
  const mine = new Set(data.claims.filter(c => String(c.cluster) === key).map(c => c.id))
  const dots = v.graph.flatMap(r => r.filter(x => /^d:/.test(x.part || '') && /[●◉○]/.test(x.s)))
  for (const d of dots) {
    const on = mine.has(d.part.slice(2))
    assert.equal(d.bold, on, d.part)
    assert.equal(/-faint$/.test(d.tone), !on, d.part)
  }
  // n p walk the clusters, round
  const keys = data.groups.map(g => String(g.id))
  assert.equal(hopCluster(data, keys[0], 1), keys[1])
  assert.equal(hopCluster(data, keys[0], -1), keys.at(-1))
  assert.equal(hopCluster(data, keys.at(-1), 1), keys[0])
  // a claim selected keeps its cluster lit, only its own dot bold
  const c = graphView(data, { claim: [...mine][0] }, { w: 136, h: 40 })
  const bold = c.graph.flatMap(r => r.filter(x => x.bold && /[●◉○]/.test(x.s)))
  assert.deepEqual(bold.map(x => x.part), [`d:${[...mine][0]}`])
})

function linkedClaims() {
  const st = emptyStore('s')
  const quotes = ['The keys (v, s, ], 1, { }) need a reply to act on, and the bar finder returns null when there is no reply yet',
    ...Array.from({ length: 23 }, (_, i) => `Note ${i + 2} was a tip number ${i + 2}`)]
  applyTurn(st, { places: [{ row: 'r1', by: 'claude', turn: 1, text: quotes.map(q => q + '.').join(' ') }], turn: 1,
    out: { claims: quotes.map((q, i) => ({ quote: q, cluster: `group ${(i % 4) + 1}`, ...(i ? { links: [{ to: `c${Math.max(1, i - 1 - (i % 3))}`, how: 'supports' }] } : {}) })) } })
  return paneData(st)
}

test("the panel wraps the claim's whole sentence, braces and all, with no word cut; e shows its citations with their checks and the cited lines", () => {
  const data = linkedClaims()
  const rows = graphView(data, { claim: 'c1' }, { w: 110, h: 34 }).panel
  const said = rows.slice(2).map(r => rowText(r).slice(2).trim()).join(' ')
  assert.match(said, /^The keys \(v, s, \], 1, \{ \}\) need a reply .* returns null when there is no reply yet\.$/)
  assert.doesNotMatch(said, /…/)
  // the citations show only on e: each check as the evidence pane words it, its words, the cited place and line
  const c = { ...data.claims[0], sources: [{ ref: 'a1@3', row: 'a1', at: 3, n: 2, label: '212 edits', status: 'failed', failedBy: 'evidence', place: 'edits.csv:4', line: 'Alice,212' }] }
  const shut = panel(graphView({ ...data, claims: [c, ...data.claims.slice(1)] }, { claim: 'c1' }, { w: 110, h: 34 }))
  assert.doesNotMatch(shut, /212 edits|not confirmed/)
  const ev = graphView({ ...data, claims: [c, ...data.claims.slice(1)] }, { claim: 'c1', open: 'ev' }, { w: 110, h: 34 })
  assert.match(panel(ev), /\n {2}not confirmed 212 edits {2}edits\.csv:4 {2}Alice,212/)
  assert.ok(ev.panel.some(r => r.some(x => x.part === 'ev-1')))
})

test('no lines join the claims, however they are linked', () => {
  const data = linkedClaims()
  assert.ok(data.edges.length > 10)
  for (const st of [{}, { claim: 'c9' }, { claim: 'c14' }, { group: String(data.groups[0].id) }]) {
    const g = graphView(data, st, { w: 110, h: 34 }).graph.map(rowText).join('\n')
    assert.doesNotMatch(g, /[─│╭╮╰╯├┤┬┴┼]/, JSON.stringify(st))
  }
})

test('with no claims the pane says what comes there', () => {
  const none = graphView(paneData(emptyStore('s')), {}, { w: 90, h: 30 })
  assert.match(text(none), /^Claims\n\nNo claims yet\. After each answer, the statements in it come here\./)
})
