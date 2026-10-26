// Claims (claims/store.js, graph.js, lens.mjs): the lens's claims as the observer's reply gives them, placed by their
// words with the citations near them, and the Claims pane as graph.js lays it out, whose count stays
// on screen however many claims a session has. Made-up data only.
//   node --test plugin/claims/test/
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseAnswer } from '../../observer/reply.mjs'
import { cardOf, cellSlots, checkable, citationRows, correctionsOf, evidenceOf, fitClusters, graphView, historyRows, hopCluster, mapCapacity, paneData, reasonOf, repairable, rowText, rowsCapacity, scrollWindow, snippetOf, wordDiff } from '../graph.js'
import lens from '../lens.mjs'
import { applyTurn, edgesOf, emptyStore, parseClaims, promptLines, readStore, viewOf } from '../store.js'

test("the lens's claims are read as given: a quote names a claim that gives no words of its own; a same, a correction, who said it", () => {
  const got = parseClaims([
    { quote: 'June 18 had 6,543 saves', cluster: 'k1' },
    { same: 'c2', quote: 'the edits were biased', by: 'analyst' },
    { claim: 'A correction', quote: 'it is two editors', revises: 'c1', by: 'Person', why: 'the log shows two editors' },
    { claim: 'no quote' },
    'not an object',
  ])
  assert.deepEqual(got.map(x => [x.text, x.by, x.same, x.revises]), [
    ['June 18 had 6,543 saves', 'claude', null, null],
    ['', 'person', 'c2', null],
    ['A correction', 'person', null, 'c1'],
  ])
  assert.deepEqual(Object.keys(got[0]).sort(), ['at', 'because', 'by', 'cluster', 'links', 'quote', 'revises', 'same', 'text', 'why'])
  // a why is kept only with the claim it corrects
  assert.deepEqual(got.map(x => x.why), [null, null, 'the log shows two editors'])
  assert.equal(parseClaims([{ quote: 'q', why: 'no claim to correct' }])[0].why, null)
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
    out: { claims: [{ same: 'c1', quote: 'without Alice the sides are even' }, { claim: 'The edits were not biased; one editor tilted them.', quote: 'The edits were not biased, one editor tilted them', revises: 'c3', why: 'one editor made the tilt' }] } })
  assert.deepEqual(res.restated, ['c1'])
  assert.deepEqual(res.revised, ['c3'])
  assert.equal(st.claims[0].said.length, 2)
  assert.equal(st.claims.find(c => c.id === 'c3').revised_by, 'c4')
  // the reason the earlier one was wrong is kept with the claim that corrects it, and read back from the file
  assert.equal(st.claims.find(c => c.id === 'c4').why, 'one editor made the tilt')
  assert.equal(readStore(JSON.stringify(st), 's').claims.find(c => c.id === 'c4').why, 'one editor made the tilt')
  assert.match(promptLines(st).claims, /c3 · k1 · The edits were biased after June 18\. \(the analyst, corrected by c4\)/)
  // two claims citing the same place of a file are joined by a line (the pane adds `place` from the marks' evidence)
  const flat = viewOf(st).flat.map(c => ({ ...c, links: [], sources: c.sources.map(s => ({ ...s, place: 'edits.csv:4' })) }))
  assert.ok(edgesOf(flat).some(e => e.kind === 'rows'))
})

test("a claim said without citations of its own takes the ones its reason cites in its paragraph", () => {
  const st = emptyStore('s')
  const answer = 'Some runs also used a second channel. A post asks the run ahead to call a counter URL. [Saves on 87 pages](#) mention it, most on [June 17](#). Bots made [3 edits](#).'
  applyTurn(st, { turn: 1, places: [{ row: 'a1', by: 'claude', turn: 1, text: answer }], out: { claims: [
    { claim: 'Some runs used a counter URL as a second channel.', quote: 'Some runs also used a second channel', cluster: 'channels',
      because: 'A post asks the run ahead to call it, and [saves on 87 pages](#) mention it.' },
  ] } })
  assert.deepEqual(st.claims[0].sources.map(s => s.label), ['Saves on 87 pages'])
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

const rows = view => [...view.head, ...(view.graph.length ? [[]] : []), ...view.graph, ...view.panel]

/** A store of `n` clusters of `per` claims each (a list of sizes, or one size for all), one reply, the claims linked in
 *  a chain; `name(g)` the cluster's name, `about(g)` its orienting line. */
function sized(per, n = Array.isArray(per) ? per.length : 1, { name = g => `topic ${g}`, about = () => '', text = (g, i) => `Fact ${g}-${i} holds` } = {}) {
  const st = emptyStore('s')
  const sizes = Array.isArray(per) ? per : Array.from({ length: n }, () => per)
  const qs = sizes.flatMap((k, g) => Array.from({ length: k }, (_, i) => ({ quote: text(g, i), cluster: name(g) })))
  applyTurn(st, { turn: 1, places: [{ row: 'a1', by: 'claude', turn: 1, text: qs.map(q => `${q.quote}.`).join(' ') }], out: { claims: qs, clusters: sizes.map((_, g) => ({ name: name(g), about: about(g) })).filter(c => c.about) } })
  return paneData(st)
}

/** A claim's citations as the pane reads them (pane.tsx withMarks): `k` citations, the first `bad` failed, each with a
 *  file's line as its evidence. */
const cited = (k, bad = 0) => Array.from({ length: k }, (_, i) => ({
  ref: `a1@${i}`, row: 'a1', at: i, n: i + 1, label: `${(i + 1) * 111} saves`, status: i < bad ? 'failed' : 'verified', ...(i < bad ? { failedBy: 'evidence', reason: 'The file says otherwise. More words.' } : {}),
  evidence: { kind: 'quote', file: 'saves.jsonl', line: 40 + i, lines: [{ n: 40 + i, text: `day ${i}: ${(i + 1) * 111} saves in all`, highlight: [7 + String(i).length - 1, 7 + String(i).length - 1 + `${(i + 1) * 111} saves`.length] }] },
}))

/** The data with claim `id`'s citations and fields replaced. */
const withClaim = (data, id, o) => ({ ...data, claims: data.claims.map(c => (c.id === id ? { ...c, ...o } : c)) })

const dotRuns = v => v.graph.flatMap(r => r.filter(x => /^d:/.test(x.part || '') && x.s.trim()))

/** Ten clusters of five to ten claims each: the session the map is made for. */
const tenByTen = () => sized(Array.from({ length: 10 }, (_, g) => 5 + (g % 6)), 10, { name: g => ['what the agents did to the wiki', 'how the admin cleaned up', 'how copies shared answers', 'why the agents posted links', 'how often posts ask about timing', 'which pages were edited most', 'who edited under many names', 'what the vandalism looked like', 'when the edits came', 'how the counters were bumped'][g] })

test('the map: ten clusters of five to ten claims at the pane sizes of 160×50 and 120×40; at rest nothing shows under it, a cluster chosen its claims; a claim picked takes the pane', () => {
  const data = tenByTen()
  // a narrower or shorter pane: the clusters one row each
  assert.ok(graphView(data, {}, { w: 50, h: 34 }).rowsView)
  for (const [w, h] of [[70, 48], [70, 44]]) {
    const rest = graphView(data, {}, { w, h })
    const tu = text(rest)
    assert.equal(mapCapacity(w, h), 3 * Math.floor(Math.floor(h * 0.4) / 4))
    assert.equal(rest.rowsView, false, `${w}×${h}: the map, not the rows`)
    assert.match(tu, /^Evidence · 71 claims\n\n/)
    assert.ok(rest.head[0][0].bold && !rest.head[0][0].tone)
    // at rest: no claim, nothing chosen, no detail, no caption; every cluster and every claim drawn
    assert.equal(rest.chosen, false)
    assert.deepEqual(rest.panel, [])
    assert.equal(new Set(rest.graph.flat().filter(x => /^g:/.test(x.part || '') && x.s.trim()).map(x => x.part)).size, 10)
    assert.equal(dotRuns(rest).length, 71)
    const cols = tu.split('\n').slice(2).flatMap(l => [...l].map((ch, x) => (ch === '●' ? x : -1)).filter(x => x >= 0))
    assert.ok(Math.min(...cols) < w * 0.2 && Math.max(...cols) > w * 0.8, `${w}×${h}: dots from ${Math.min(...cols)} to ${Math.max(...cols)}`)
    // a cluster chosen: the map stays, the detail under it, all within the pane
    const chosen = graphView(data, { group: String(data.groups[4].id) }, { w, h })
    assert.equal(dotRuns(chosen).length, 71)
    assert.ok(chosen.cellRows >= 4 && chosen.cellRows <= 7, `${w}×${h}: ${chosen.cellRows}`)
    assert.ok(rows(chosen).length + 2 <= h, `${w}×${h}: ${rows(chosen).length + 2}`)
    // the dots keep their places whatever is chosen, and the blank cell beside a dot is a press on it too
    const dotsOf = v => v.graph.map(r => rowText(r).replace(/[^●]/g, ' ').trimEnd()).join('\n')
    if (chosen.cellRows === rest.cellRows) assert.equal(dotsOf(chosen), dotsOf(rest))
    assert.ok(chosen.graph.some(r => r.some((x, i) => /^d:/.test(x.part || '') && x.s === ' ' && r[i + 1]?.part === x.part)))
    // a claim picked: the map goes, the claim's detail takes the pane
    const picked = graphView(data, { claim: 'c3' }, { w, h })
    assert.deepEqual(picked.graph, [])
    assert.ok(picked.panel.length + 2 <= h)
  }
})

test("every claim is the same solid dot in its cluster's color; the cluster's current claim inverse in that color, on the map and in the list; a new one bold", () => {
  const data = tenByTen()
  const rest = graphView(data, {}, { w: 70, h: 44 })
  assert.ok(dotRuns(rest).every(x => x.s === '●' && /^c\d+$/.test(x.tone) && !x.inverse && !x.bold))
  const key = String(data.groups[2].id)
  const cs = data.claims.filter(c => String(c.cluster) === key)
  const v = graphView(data, { group: key, cur: 2, at: 0 }, { w: 70, h: 44 })
  const on = dotRuns(v).filter(x => x.inverse)
  assert.deepEqual(on.map(x => [x.part, x.tone]), [[`d:${cs[2].id}`, 'c3']])
  const row = v.panel.find(r => r.some(x => x.part === `n:${cs[2].id}`))
  assert.ok(rowText(row).startsWith('▸ ') && row.every(x => x.tone === 'c3' && x.bold && !x.inverse), 'the current claim of the list in its color')
  // claims that came in while the person browsed (the last look's, after `at`) are bold, never another glyph
  const fresh = new Set(data.claims.filter(c => c.turn === data.last).map(c => `d:${c.id}`))
  assert.ok(dotRuns(graphView(data, { at: 0 }, { w: 70, h: 44 })).filter(x => fresh.has(x.part)).every(x => x.bold && x.s === '●'))
})

test('a cluster chosen: its name bold, its orienting line, then its claims one line each, the current one marked; its dots and name bold, the rest plain', () => {
  const data = sized([12, 4, 3], 3, { about: g => (g ? '' : 'Whether the facts of topic 0 hold, and what they say about the runs.'), text: (g, i) => `Fact ${g}-${i} holds for every run of the sweep that the agents made on the shared wiki pages over the weeks` })
  const key = String(data.groups[0].id)
  const v = graphView(data, { group: key }, { w: 72, h: 50 })
  assert.equal(v.claim, null)
  assert.ok(v.chosen)
  const p = panel(v).split('\n')
  assert.match(p[0], /^─+$/)
  assert.equal(p[1], 'topic 0 · 12 claims')
  assert.equal(p[2], 'Whether the facts of topic 0 hold, and what they say about the runs.')
  assert.equal(p[3], '')
  // every claim numbered as the claim view counts them, the list under the cluster's words: the current one (the first
  // when none was chosen) whole, wrapped under its first word; the others one line each, cut after a whole word with …
  const list = p.slice(4)
  assert.equal(list.length, 13)
  assert.equal(list.slice(0, 2).join(' ').replace(/^▸ {2}1\. /, '').replace(/ {7}/, ' '), 'Fact 0-0 holds for every run of the sweep that the agents made on the shared wiki pages over the weeks.')
  assert.match(list[1], /^ {6}\S/)
  assert.ok(list.slice(2).every((l, i) => l.length <= 72 && / …$/.test(l) && l.startsWith(`  ${String(i + 2).padStart(2)}. Fact 0-`)), list.join('\n'))
  // the current one bold in the cluster's color; the others' numbers dim; each line a press that picks its claim; the
  // name a press on the cluster
  assert.ok(v.panel.slice(4, 6).every(r => r.every(x => x.bold && x.tone === 'c1' && x.part === 'n:c1')))
  assert.ok(v.panel[6].every(x => !x.bold && x.part === 'n:c2'))
  assert.deepEqual(v.panel[6].map(x => x.tone ?? null), [null, 'dim', null])
  assert.ok(v.panel[1][0].bold && v.panel[1][0].tone === 'c1' && v.panel[1].every(x => x.part === `g:${key}`))
  assert.doesNotMatch(panel(v), /verified|failed|citation/)
  // k j move the current claim (`cur`)
  assert.match(panel(graphView(data, { group: key, cur: 3 }, { w: 72, h: 50 })).split('\n')[7], /^▸ {2}4\. Fact 0-3/)
  // its name on the map bold in its color; every other name and dot plain (the text color)
  const names = v.graph.flatMap(r => r.filter(x => /^g:/.test(x.part || '') && x.s.trim()))
  for (const nm of names) assert.equal(nm.tone === 'plain', nm.part !== `g:${key}`, nm.s)
  const mine = new Set(data.claims.filter(c => String(c.cluster) === key).map(c => `d:${c.id}`))
  for (const d of dotRuns(v)) {
    assert.equal(d.bold, mine.has(d.part), d.part)
    assert.equal(d.tone === 'plain', !mine.has(d.part), d.part)
  }
  // p n walk the clusters, round
  const keys = data.groups.map(g => String(g.id))
  assert.equal(hopCluster(data, keys[0], 1), keys[1])
  assert.equal(hopCluster(data, keys[0], -1), keys.at(-1))
  assert.equal(hopCluster(data, keys.at(-1), 1), keys[0])
})

test('a detail taller than its room scrolls: a window with ↑ N and ↓ N more claims in a cluster list (more lines elsewhere), the current claim kept in view', () => {
  const data = sized([44, 3])
  const key = String(data.groups[0].id)
  for (const [w, h] of [[70, 44], [50, 34]]) {
    const at = (cur, top = 0, follow = true) => graphView(data, { group: key, cur, top, follow }, { w, h })
    const first = at(0)
    assert.ok(first.scroll.max > 0, `${w}×${h}`)
    assert.ok(rows(first).length + 2 <= h, `${w}×${h}: ${rows(first).length + 2}`)
    const p = first.panel.map(rowText)
    assert.match(p.at(-1), /^↓ \d+ more claims$/)
    // the claims under the window, each one line
    assert.equal(Number(p.at(-1).match(/\d+/)[0]), 44 - p.filter(l => /^(▸| ) +\d+\. Fact/.test(l)).length)
    assert.equal(first.panel.at(-1)[0].part, 'sc:1')
    assert.ok(!p.some(l => /earlier/.test(l)))
    // the current claim far down: the window follows it, with the way back up
    const deep = at(40).panel.map(rowText)
    assert.match(deep[0], /^↑ \d+ more claims$/)
    assert.ok(deep.some(l => l.startsWith('▸ 41. Fact 0-40 ')), deep.join('\n'))
    // the last claim: the window ends with it, nothing more under it
    const last = at(43)
    assert.equal(last.scroll.top, last.scroll.max)
    assert.ok(rowText(last.panel.at(-1)).startsWith('▸ 44. Fact 0-43'))
    // scrolled by the wheel (`top`, not following): the window moves, the current claim may leave it
    const moved = at(0, 5, false)
    assert.equal(moved.scroll.top, 5)
    assert.ok(!moved.panel.some(r => rowText(r).startsWith('▸ ')))
    assert.equal(moved.panel[0][0].part, 'sc:-1')
  }
  // the window itself
  const r = Array.from({ length: 20 }, (_, i) => [{ s: `row ${i}` }])
  assert.deepEqual(scrollWindow(r, 30).rows.length, 20)
  assert.deepEqual(scrollWindow(r, 8, 0).rows.map(rowText), ['row 0', 'row 1', 'row 2', 'row 3', 'row 4', 'row 5', 'row 6', '↓ 13 more lines'])
  assert.deepEqual(scrollWindow(r, 8, 4).rows.map(rowText), ['↑ 4 more lines', 'row 4', 'row 5', 'row 6', 'row 7', 'row 8', 'row 9', '↓ 10 more lines'])
  assert.deepEqual(scrollWindow(r, 8, 99).rows.map(rowText), ['↑ 13 more lines', 'row 13', 'row 14', 'row 15', 'row 16', 'row 17', 'row 18', 'row 19'])
  assert.equal(scrollWindow(r, 8, 0, 15).rows.map(rowText).includes('row 15'), true)
  // a current claim of several rows: all of them in view
  const many = scrollWindow(r, 8, 0, [10, 13]).rows.map(rowText)
  assert.ok(['row 10', 'row 11', 'row 12', 'row 13'].every(x => many.includes(x)), many.join('|'))
})

test('one cluster of one claim: the map draws it; picked, its cluster above it and one dim line for no citation', () => {
  const one = sized([1])
  const rest = graphView(one, {}, { w: 70, h: 36 })
  assert.equal(dotRuns(rest).length, 1)
  assert.equal(rest.graph.flat().filter(x => /^g:/.test(x.part || '') && x.s.trim()).length, 1)
  const picked = graphView(one, { claim: 'c1' }, { w: 70, h: 36 })
  assert.match(panel(picked), /^topic 0\n\nFact 0-0 holds\.\n\nNo citation: the reply cites no record for it\.$/)
  assert.ok(picked.panel[0][0].tone === 'c1' && picked.panel[0][0].part === 'g:k1')
})

test('crowded: twenty clusters, or a cluster with more claims than its cell holds, are listed one row each, a name and a row of dots', () => {
  const many = sized(Array.from({ length: 20 }, (_, g) => 2 + (g % 4)), 20, { name: g => `${['which', 'how', 'when', 'why', 'whether'][g % 5]} part ${g} of the runs merged the most PRs` })
  for (const [w, h] of [[70, 48], [50, 44]]) {
    const rest = graphView(many, {}, { w, h })
    assert.ok(rest.rowsView, `${w}×${h}`)
    assert.equal(rest.graph.length, 20)
    assert.equal(dotRuns(rest).length, many.claims.length)
    // a row: the name, cut after a whole word, a press on the cluster; the dots in the cluster's color, each a press
    const r0 = rest.graph[0]
    assert.match(rowText(r0), /^ which part 0 .*● ●$/)
    assert.ok(r0.filter(x => x.s === '●').every(x => x.tone === 'c1' && /^d:/.test(x.part)))
    assert.ok(r0[1].part === `g:${many.groups[0].id}` && r0[1].tone === 'c1')
    // a cluster chosen: its row bold in its color, the others plain; its current claim inverse; the detail under it
    const key = String(many.groups[3].id)
    const v = graphView(many, { group: key, cur: 1 }, { w, h })
    assert.ok(v.graph[3].filter(x => x.s.trim()).every(x => x.tone === 'c4' && x.bold))
    assert.ok(v.graph[0].filter(x => x.s.trim()).every(x => x.tone === 'plain' && !x.bold))
    assert.equal(v.graph[3].filter(x => x.inverse).length, 1)
    assert.ok(v.panel.some(r => rowText(r).startsWith('▸ ')))
    assert.ok(rows(v).length + 2 <= h, `${w}×${h}: ${rows(v).length + 2}`)
    assert.deepEqual(v.order, many.groups.map(g => String(g.id)))
  }
  // one cluster with more claims than its cell holds
  const big = sized([cellSlots(70) + 1, 4])
  assert.ok(graphView(big, {}, { w: 70, h: 44 }).rowsView)
  assert.ok(!graphView(sized([cellSlots(70), 4]), {}, { w: 70, h: 44 }).rowsView)
  // more claims than a row has room for: as many dots as fit, then +N
  const wide = graphView(sized([60, 3, 2]), {}, { w: 50, h: 34 })
  assert.match(rowText(wide.graph[0]), / \+\d+$/)
})

function linkedClaims() {
  const st = emptyStore('s')
  const quotes = ['The keys (v, s, ], 1, { }) need a reply to act on, and the bar finder returns null when there is no reply yet',
    ...Array.from({ length: 23 }, (_, i) => `Note ${i + 2} was a tip number ${i + 2}`)]
  applyTurn(st, { places: [{ row: 'r1', by: 'claude', turn: 1, text: quotes.map(q => q + '.').join(' ') }], turn: 1,
    out: { claims: quotes.map((q, i) => ({ quote: q, cluster: `group ${(i % 4) + 1}`, ...(i ? { links: [{ to: `c${Math.max(1, i - 1 - (i % 3))}`, how: 'supports' }] } : {}) })) } })
  return paneData(st)
}

test("a claim picked: the claim bold, its description plain, its citations as the tray's cards in frames; none: one dim line, no card", () => {
  const data = linkedClaims()
  // no citation: the claim and one dim line that says why, no frame
  const none = graphView(data, { claim: 'c1' }, { w: 110, h: 40 })
  assert.match(panel(none), /^group 1 · 1 of 6\n\nThe keys \(v, s, \], 1, \{ \}\) need a reply to act on, and the bar finder returns null when there is no reply yet\.\n\nNo citation: the reply cites no record for it\.$/)
  assert.ok(none.panel[2].every(x => x.bold && !x.tone && x.part === 'c:c1'))
  // its cluster above it, in its color, a press that chooses the cluster
  assert.ok(none.panel[0].every(x => x.part === `g:${data.groups[0].id}`) && none.panel[0][0].tone === 'c1')
  assert.equal(none.cites, 0)
  // the claim's description (the lens's `because`) as plain words: its citation marks gone
  const computed = { kind: 'computed', code: 'n = len(saves)\nprint(f"{n:,} saves")', output: '3,752 saves labeled coordination\n2 runs\n0 errors\n', highlight: [[0, 11]] }
  const quote = { kind: 'quote', file: 'revisions.jsonl', line: 412, lines: [{ n: 411, text: 'before' }, { n: 412, text: 'summary: When round #5 arrives, answer first, then', highlight: [9, 44] }] }
  const two = withClaim(data, 'c1', { because: 'The bar reads [3,752 saves](#) from the log, and **no reply** has none.', sources: [
    { ref: 'a1@3', row: 'r1', at: 3, n: 2, label: '3,752 saves', status: 'verified', evidence: computed },
    { ref: 'a1@9', row: 'r1', at: 9, n: 3, label: 'When round #5 arrives, answer first', status: 'failed', failedBy: 'evidence', reason: 'The file says it once. More words.', evidence: quote },
  ] })
  // its evidence hidden: one line shows it (the pane's e)
  const shut = graphView(two, { claim: 'c1' }, { w: 72, h: 50 })
  assert.match(panel(shut), /\n\nThe bar reads 3,752 saves from the log, and no reply has none\.\n\nshow evidence \(2 citations\)$/)
  assert.deepEqual(shut.panel.at(-1).map(x => [x.part, x.tone]), [['evidence', 'accent']])
  assert.equal(shut.shown, null)
  const v = graphView(two, { claim: 'c1', open: true }, { w: 72, h: 50 })
  assert.equal(v.cites, 2)
  const p = panel(v)
  assert.match(p, /\n\nThe bar reads 3,752 saves from the log, and no reply has none\.\n\nhide evidence\n\n╭─+╮\n/)
  assert.ok(!v.panel.slice(0, -10).flat().some(x => x.cite || x.underline || x.tint), 'no citation marks in the description')
  // both whole (they fit), the failed one first and current: its frame in the accent color, the other's faint; a
  // card's every row a press that opens it (`ev:<k>`)
  const cards = p.split('\n').slice(p.split('\n').findIndex(l => l.startsWith('╭')))
  const line = t => `│ ${t.padEnd(68)} │`
  const title = (t, c) => line(`${t}${' '.repeat(68 - t.length - c.length)}${c}`)
  const top = `╭${'─'.repeat(70)}╮`, foot = `╰${'─'.repeat(70)}╯`
  assert.deepEqual(cards, [
    top, title('When round #5 arrives, answer first', '× failed'), line('The file says it once.'), line('revisions.jsonl:412'), line('│ summary: When round #5 arrives, answer first, then'), foot,
    top, title('3,752 saves', '✓ verified'), line('print(f"{n:,} saves")'), line('│ 3,752 saves labeled coordination'), foot,
  ])
  const at = v.panel.length - cards.length
  assert.ok(v.panel.slice(at, at + 6).every(r => r.every(x => x.part === 'ev:0')))
  assert.equal(v.panel[at][0].tone, 'accent')
  assert.equal(v.panel[at + 6][0].tone, 'accent-faint')
  assert.ok(v.panel[at + 1].some(x => x.s === 'When round #5 arrives, answer first' && x.cite === 'failed' && x.bold))
  assert.ok(v.panel[at + 7].some(x => x.s === '3,752 saves' && x.cite === 'verified'))
  assert.ok(v.panel[at + 9].some(x => x.tint && x.s === '3,752 saves'))
  assert.ok(repairable(v.shown))
  // e: the next citation current; its frame lit, a repair not offered on a verified one; c (`whole`) shows the code and
  // output whole
  const second = graphView(two, { claim: 'c1', open: true, cite: 1 }, { w: 72, h: 50 })
  assert.equal(second.panel[at][0].tone, 'accent-faint')
  assert.equal(second.panel[at + 6][0].tone, 'accent')
  assert.ok(!repairable(second.shown))
  assert.ok(panel(graphView(two, { claim: 'c1', open: true, cite: 1, whole: true }, { w: 72, h: 50 })).includes('│ n = len(saves)'))
  // a long output line is cut round the cited words, a long code line in the middle, and the card says it was cut
  const huge = { kind: 'computed', code: `daily = df.groupby(df.ts.dt.date).size().sort_values(ascending=False).reset_index(); print(daily.max())`, output: `${'x'.repeat(70)} 6,543 ${'y'.repeat(70)}\n${'z\n'.repeat(41)}`, highlight: [[71, 76]] }
  const card = cardOf({ label: '6,543', status: 'verified', evidence: huge }, 56)
  assert.ok(card.cut && card.rows.every(r => rowText(r).length <= 56))
  assert.match(rowText(card.rows[1]), /^daily = df\.groupby.* … .*print\(daily\.max\(\)\)$/)
  assert.equal(rowText(card.rows.at(-1)), '│ + 41 more lines')
  const whole = cardOf({ label: '6,543', status: 'verified', evidence: huge }, 56, { whole: true })
  assert.ok(whole.rows.length > 40 && whole.rows.every(r => rowText(r).length <= 56))
  const long = snippetOf({ kind: 'computed', code: 'print(x)', output: `${'a'.repeat(80)} 42 ${'b'.repeat(80)}`, highlight: [[81, 83]] }, 30)
  assert.ok(long.text.length <= 30 && long.text.slice(long.spans[0][0], long.spans[0][1]) === '42' && long.cut)
})

test('many citations: every one in view or a scroll away; the current one whole and the others one line each when they do not fit whole; the description never cut', () => {
  const data = sized([12, 8, 6, 5, 4])
  const desc = 'The counts come from the saved revisions of the wiki, read again for each run. '.repeat(4).trim()
  const six = withClaim(data, 'c1', { because: desc, sources: cited(6, 1) })
  // room for all: six whole cards
  const tall = graphView(six, { claim: 'c1', open: true }, { w: 72, h: 60 })
  assert.equal(tall.compact, false)
  assert.equal(panel(tall).split('\n').filter(l => l.startsWith('╭')).length, 6)
  for (const [w, h] of [[70, 44], [50, 34], [50, 24]]) {
    const v = graphView(six, { claim: 'c1', open: true, cite: 2, follow: true }, { w, h })
    const p = panel(v).split('\n')
    assert.ok(v.panel.length + 2 <= h, `${w}×${h}: ${v.panel.length + 2}`)
    if (h <= 34) assert.ok(v.compact, `${w}×${h}`)
    // the description whole
    assert.ok(panel(graphView(six, { claim: 'c1', open: true, cite: 2 }, { w, h: 200 })).replace(/\n/g, ' ').includes(desc))
    assert.doesNotMatch(p.join('\n'), /saved revisions of the wiki, …/)
    // the current one (the third) whole between ├ ┤ rules, kept in view; the others one line, each a press that
    // makes it current, with their check's sign and place
    assert.ok(v.panel.some(r => r.some(x => x.part === 'ev:2' && x.s === '333 saves' && x.bold)), p.join('\n'))
    // what does not fit is a scroll away, never gone
    if (v.scroll.max) assert.match(p.at(-1), /^↓ \d+ more lines?$/)
  }
  const ones = graphView(six, { claim: 'c1', open: true, cite: 2 }, { w: 50, h: 34 }).panel.filter(r => r.some(x => /^at:/.test(x.part || '')))
  assert.deepEqual(ones.map(r => r[0].part), ['at:0', 'at:1', 'at:3', 'at:4', 'at:5'])
  assert.match(rowText(ones[0]), /^│ 111 saves +× · saves\.jsonl:40 │$/)
  assert.match(rowText(ones[1]), /^│ 222 saves +✓ · saves\.jsonl:41 │$/)
  // two citations never go to one line each: they scroll
  const two = withClaim(data, 'c1', { because: desc, sources: cited(2) })
  const v2 = graphView(two, { claim: 'c1', open: true }, { w: 50, h: 20 })
  assert.equal(v2.compact, false)
  assert.ok(v2.scroll.max > 0)
})

test('a corrected claim: one line says so; h shows its History, one word-level diff per correction with its reason', () => {
  const data = corrected(2)
  const shut = graphView(data, { claim: 'c3' }, { w: 70, h: 40 })
  assert.match(panel(shut), /^cleanup · 3 of 3\n\nAll of the admin's deletions came after the edits stopped, from June\n23 to July 14\.\ncorrected ×2\n\nNo citation: the reply cites no record for it\.$/)
  assert.ok(shut.panel.flat().some(x => x.s === 'corrected ×2' && x.tone === 'cite'))
  assert.equal(shut.fixes, 2)
  const open = graphView(data, { claim: 'c3', history: true }, { w: 70, h: 40 })
  const p = panel(open)
  assert.match(p, /corrected ×2\n\nHistory\nturn 1 → turn 2\nThe deletions began Most of the admin's deletions came after the edits\nstopped, from June 23 to July 14\.\nreason: 444 of the 5,217 deletions came before June 23\.\n\nturn 2 → turn 3\nMost All of the admin's deletions came after the edits stopped, from\nJune 23 to July 14\.\nreason: none came before\.\n\nNo citation/)
  // deleted words red and struck through, inserted green; a full stop alike stays plain
  const runs = open.panel.flat()
  assert.ok(runs.some(x => x.s === 'The' && x.tone === 'del') && runs.some(x => x.s === 'deletions' && x.tone === 'del'))
  assert.ok(runs.some(x => x.s === 'Most' && x.tone === 'ins') && runs.some(x => x.s === 'All' && x.tone === 'ins'))
  // a press on a correction's turns picks the other version
  assert.ok(open.panel.some(r => r.some(x => x.part === 'was-c2')))
  // a later claim corrected it: it says so
  assert.match(panel(graphView(data, { claim: 'c2' }, { w: 70, h: 40 })), /\ncorrected later\n/)
  // when most words change, the old sentence and the new show whole, struck through and green
  assert.equal(wordDiff('The bot farm was run by one company.', 'The records do not show who ran the agents; 738 of the 3,102 names mention OpenAI.'), null)
  const all = historyRows([{ from: 'turn 2', to: 'turn 3', old: 'The bot farm was run by one company.', now: 'The records do not show who ran the agents.', why: 'no record names an operator.', part: null }], 60)
  assert.deepEqual(all.map(rowText), ['History', 'turn 2 → turn 3', 'The bot farm was run by one company.', 'The records do not show who ran the agents.', 'reason: no record names an operator.'])
  // a claim whose citation the check corrected: the words before the check and the check's reason
  const own = { id: 'c9', text: 'x', turn: 4, sources: [{ label: '12', status: 'corrected', was: '15', reason: 'agent-07 merged 12, not 15' }] }
  assert.deepEqual(correctionsOf(own, new Map()), [{ from: 'turn 4', to: 'the check', old: '15', now: '12', why: 'agent-07 merged 12, not 15.', part: null }])
  // the failed citations first; one x checks again keeps its place among them while it runs and after
  assert.deepEqual(evidenceOf({ sources: [{ n: 1, status: 'verified' }, { n: 2, status: 'checking', repair: true }, { n: 3, status: 'failed' }, { n: 4, status: 'verified', repair: true }] }).map(s => s.n), [2, 3, 4, 1])
  assert.equal(repairable({ row: 'r1', n: 2, status: 'failed', failedBy: 'none' }), true)
  assert.deepEqual(citationRows({ label: '9', shown: '9', status: 'failed', failedBy: 'none', reason: 'The check did not run. The reply was interrupted.' }, 60).map(rowText), ['9   × failed · citation', 'The check did not run.'])
})

test('long cluster names wrap to two lines in their cells, never into a neighbor', () => {
  const data = sized([7, 4, 3, 3], 4, { name: g => ['how merges and closes differ between emergent and managed runs', 'when the runs claimed PRs', 'how long the runs lasted', 'whether adding issues changed the runs'][g] })
  for (const [w, h] of [[62, 40], [50, 40]]) {
    const v = graphView(data, { group: String(data.groups[0].id) }, { w, h })
    // no row holds more than the two names of its two cells
    for (const r of v.graph) assert.ok(new Set(r.filter(x => /^g:/.test(x.part || '') && x.s.trim()).map(x => x.part)).size <= 2, v.graph.map(rowText).join('\n'))
    const own = v.graph.flatMap(r => r.filter(x => x.part === `g:${data.groups[0].id}` && x.s.trim()))
    assert.equal(own.length, 2, own.map(x => x.s).join('|'))
    assert.ok(own.every(x => x.s.trim().length <= w / 2), own.map(x => x.s).join('|'))
  }
})

test('a narrow pane (fewer than 40 columns): the clusters one row each over the detail', () => {
  const data = sized([5, 3])
  const v = graphView(data, { group: String(data.groups[0].id) }, { w: 36, h: 30 })
  assert.ok(v.narrow && v.rowsView)
  assert.deepEqual(v.graph.map(rowText), [' topic 0  ● ● ● ● ●', ' topic 1  ● ● ●'])
  assert.match(panel(v), /^─+\ntopic 0 · 5 claims\n\n▸ 1\. Fact 0-0 holds\.\n {2}2\. Fact 0-1/)
})

/** A claim corrected n times, each in its own turn, with a reason each time. */
function corrected(n) {
  const st = emptyStore('s')
  const says = ['The deletions began June 23.', "Most of the admin's deletions came after the edits stopped, from June 23 to July 14.",
    "All of the admin's deletions came after the edits stopped, from June 23 to July 14.", "Most of the admin's deletions came after the edits stopped, from June 23 to July 14.",
    "Most of the admin's deletions came after the edits stopped, from June 23 to July 13.", "Most of the admin's deletions came after the edits stopped, from June 23 to July 12."]
  const why = ['', '444 of the 5,217 deletions came before June 23', 'none came before', '444 deletions came before June 23', 'one more on July 13', 'the last deletion is on July 12']
  for (let i = 0; i <= n; i++) {
    const t = says[i]
    applyTurn(st, { turn: i + 1, places: [{ row: `a${i + 1}`, by: 'claude', turn: i + 1, text: t }], out: { claims: [{ claim: t, quote: t.slice(0, -1), ...(i ? { revises: `c${i}`, why: why[i] } : { cluster: 'cleanup' }) }] } })
  }
  return paneData(st)
}

test('fourteen clusters: near clusters join, named for both; past what the map holds the rest share a cell; the pane never scrolls; p n visit those drawn', () => {
  const build = (linkTwice, names = g => `topic ${g}`) => {
    const st = emptyStore('s')
    const sizes = [9, 8, 7, 6, 6, 5, 4, 3, 3, 2, 2, 2, 2, 1]
    const qs = sizes.flatMap((n, g) => Array.from({ length: n }, (_, i) => ({ quote: `Fact ${g}-${i} holds`, cluster: names(g),
      // the one-claim cluster's claim is linked to topic 2's claims: once, or twice (near)
      ...(g === 13 ? { links: [{ to: 'c18', how: 'supports' }, ...(linkTwice ? [{ to: 'c19', how: 'supports' }] : [])] } : {}) })))
    applyTurn(st, { turn: 1, places: [{ row: 'a1', by: 'claude', turn: 1, text: qs.map(q => `${q.quote}.`).join(' ') }], out: { claims: qs } })
    return st
  }
  // 62 columns by 30 rows: two columns of three rows of the shortest cells in 40% of the rows
  assert.equal(mapCapacity(62, 30), 6)
  // no two clusters near (one link, few words shared), in a pane whose list of rows holds six: the five largest keep their
  // cells and the other nine share the sixth, which says so; every claim is drawn, and the map and the detail fit the pane, whatever is chosen
  const apart = paneData(build(false))
  const v = graphView(apart, {}, { w: 62, h: 12 })
  // the head counts the claims alone
  assert.match(rowText(v.head[0]), /^Evidence · 60 claims$/)
  assert.deepEqual(v.data.groups.map(g => g.name), ['topic 0', 'topic 1', 'topic 2', 'topic 3', 'topic 4', 'topic 5 + 8 other clusters'])
  const onMap = new Set(v.graph.flatMap(r => r.filter(x => /^g:/.test(x.part || '') && x.s.trim()).map(x => x.part)))
  assert.equal(onMap.size, 6)
  // every claim a dot, or counted in its row's +N
  assert.equal(new Set(v.graph.flat().filter(x => /^d:/.test(x.part || '') && x.s === '●').map(x => x.part)).size + v.graph.reduce((n, r) => n + Number(/\+(\d+)$/.exec(rowText(r))?.[1] || 0), 0), 60)
  for (const [w, h] of [[62, 34], [62, 22], [110, 30], [70, 40]]) {
    for (const st of [{}, { group: String(v.data.groups[5].id) }, { claim: 'c60' }, { claim: 'c60', cite: 1 }]) {
      const at = graphView(apart, st, { w, h })
      assert.ok(at.data.groups.length <= Math.max(mapCapacity(w, h), rowsCapacity(h)))
      assert.ok(rows(at).length + 2 <= h, `${w}×${h} ${JSON.stringify(st)}: ${rows(at).length + 2} rows`)
    }
  }
  // linked twice: the one-claim cluster joins topic 2, whose name now says both; every claim is in a cluster drawn
  const st = build(true)
  const data = paneData(st)
  const fit = fitClusters(data, 13)
  assert.equal(fit.groups.length, 13)
  const into = fit.claims.find(c => c.text.startsWith('Fact 13-0')).cluster
  assert.equal(into, data.claims.find(c => c.id === 'c18').cluster)
  assert.equal(fit.groups.find(g => g.id === into).name, 'topic 2 + topic 13')
  assert.ok(fit.claims.every(c => fit.groups.some(g => g.id === c.cluster)))
  assert.deepEqual(fit.groups.map(g => g.i), [...Array(13).keys()])
  // long names: the larger's name and how many claims joined it
  const long = fitClusters(paneData(build(true, g => `Topic ${g}: what the agents did with their pull requests`)), 13)
  assert.match(long.groups.find(g => g.id === into).name, /^Topic 2: what the agents did with their pull requests \+ \d+ other claims?$/)
  // the store is not changed, and a pane with room draws them apart
  assert.equal(paneData(st).groups.length, 14)
  assert.equal(graphView(data, {}, { w: 120, h: 50 }).data.groups.length, 14)
  const w = graphView(data, {}, { w: 62, h: 30 })
  const seen = new Set()
  let k = String(w.data.groups[0].id)
  for (let i = 0; i < 6; i++) { seen.add(k); k = hopCluster(w.data, k, 1) }
  assert.equal(seen.size, 6)
})

/** A session's eleven clusters as a long session names them, two names longer than 60 characters, and 89 claims. */
const ELEVEN = ['How many board posts mention a merge conflict in each run', 'What the merge-conflict count includes',
  'How many PRs were bug fixes versus new features, by model', 'How the PRs were sorted into bug fixes and features',
  'Which runs merged the most PRs, and whether emergent or managed runs merged more', 'How long PRs waited between opening and merge, by model',
  'What share of PR reviews asked for changes, by model', 'Which agents reviewed the most PRs in each run',
  'When the agents were busiest and whether activity dropped late in the runs', 'Why PRs were closed without merging',
  'Whether runs with issues merged more PRs']
function eleven() {
  const st = emptyStore('s')
  const qs = Array.from({ length: 89 }, (_, i) => ({ quote: `Fact ${i + 1} holds`, cluster: ELEVEN[(i * 7) % 11] }))
  // the clusters come in an order of their own: the newest claim's cluster is not the first drawn
  applyTurn(st, { turn: 1, places: [{ row: 'a1', by: 'claude', turn: 1, text: qs.map(q => `${q.quote}.`).join(' ') }], out: { claims: qs } })
  return st
}

test('a store of v 1 cut cluster names at 60 characters: read, such a name ends after its last whole word in …', () => {
  const cut60 = 'When the agents were busiest and whether activity dropped la'
  assert.equal(cut60.length, 60)
  const old = readStore({ v: 1, claims: [{ id: 'c1', text: 'A fact.', by: 'claude', cluster: 'k1' }, { id: 'c2', text: 'Another.', by: 'claude', cluster: 'k2' }],
    clusters: [{ id: 'k1', name: cut60, turn: 1, named: 1 }, { id: 'k2', name: 'Why PRs were closed without merging', turn: 1, named: 1 }] }, 's')
  assert.deepEqual(old.clusters.map(c => c.name), ['When the agents were busiest and whether activity dropped …', 'Why PRs were closed without merging'])
  assert.equal(old.v, 2)
  // the header wraps it with its … on the line of the word before
  const head = graphView(paneData(old), { group: 'k1' }, { w: 72, h: 40 }).panel.map(rowText)
  assert.equal(head[1], 'When the agents were busiest and whether activity dropped … · 1 claim')
  // a store of v 2 keeps a name of 60 characters as it is
  assert.equal(readStore({ v: 2, claims: [], clusters: [{ id: 'k1', name: cut60 }] }, 's').clusters[0].name, cut60)
})

test('a cluster named #N is the cluster of the Nth claim of the same list, never a cluster called "#N"', () => {
  const st = emptyStore('s')
  const text = 'Run A merged 40 PRs. Run B merged 12 PRs. Managed teams merged more.'
  applyTurn(st, { turn: 1, places: [{ row: 'a1', by: 'claude', turn: 1, text }], out: { claims: [
    { quote: 'Run A merged 40 PRs', cluster: 'which runs merged the most PRs' },
    { quote: 'Run B merged 12 PRs', cluster: '#1' },
    { quote: 'Managed teams merged more', cluster: '#4' },
  ] } })
  assert.deepEqual(st.clusters.map(c => c.name), ['which runs merged the most PRs'])
  assert.deepEqual(st.claims.map(c => c.cluster), ['k1', 'k1', null])
  // a later claim of the list may name the cluster first
  applyTurn(st, { turn: 2, places: [{ row: 'a2', by: 'claude', turn: 2, text: 'Reviews took 2 days. Most reviews asked for changes.' }], out: { claims: [
    { quote: 'Reviews took 2 days', cluster: '#2' },
    { quote: 'Most reviews asked for changes', cluster: 'how reviews went' },
  ] } })
  assert.deepEqual(st.clusters.map(c => c.name), ['which runs merged the most PRs', 'how reviews went'])
  assert.deepEqual(st.claims.slice(3).map(c => c.cluster), ['k2', 'k2'])
})

test("a cluster's orienting line: the lens gives it by the new cluster's name or by id, the lens reads it back, the detail shows it under the name", () => {
  const st = emptyStore('s')
  applyTurn(st, { turn: 1, places: [{ row: 'a1', by: 'claude', turn: 1, text: 'Copies left answers on the wiki for each other.' }],
    out: { claims: [{ claim: 'Copies left answers on the wiki for each other.', quote: 'Copies left answers on the wiki for each other', cluster: 'how copies shared answers' }],
      clusters: [{ name: 'How copies shared answers', about: 'Whether copies of the agent passed answers to each other; it decides if their scores are their own.' }] } })
  assert.equal(st.clusters[0].about, 'Whether copies of the agent passed answers to each other; it decides if their scores are their own.')
  assert.match(promptLines(st).clusters, /k1 · how copies shared answers · 1 claim · Whether copies/)
  // by id, in a later turn: a new line in its place
  applyTurn(st, { turn: 2, places: [], out: { claims: [], clusters: [{ id: 'k1', about: 'How copies passed answers on.' }] } })
  assert.equal(st.clusters[0].about, 'How copies passed answers on.')
  const data = paneData(st)
  assert.match(panel(graphView(data, { group: 'k1' }, { w: 80, h: 30 })), /^─+\nhow copies shared answers · 1 claim\nHow copies passed answers on\.\n\n▸ 1\. Copies left/)
  // at rest nothing shows under the map
  assert.deepEqual(graphView(data, {}, { w: 80, h: 30 }).panel, [])
})

/** A short session: one reply with two citations, its claims, and an explainer of a term it says. */
function withPassage() {
  const st = emptyStore('s')
  const md = 'Some copies used a public hit counter as a signal. They bumped [the counter to 412](#) when a round ended, and the next copy read [412 on the counter](#).\n\nAnother paragraph.'
  applyTurn(st, { turn: 1, places: [{ row: 'a1', by: 'claude', turn: 1, text: md }], out: { claims: [
    { claim: 'Some copies used public hit counters as signals.', quote: 'Some copies used a public hit counter as a signal', cluster: 'signals' },
    { claim: 'A copy bumped the counter to 412 when a round ended.', quote: 'They bumped the counter to 412 when a round ended', cluster: 'signals' },
  ] } })
  return { st, md }
}

test("a claim picked: why it holds under it, the lens's words, its citations in the reply's look and a press that opens each; the session's explainers are not marked", () => {
  const { st, md } = withPassage()
  const kept = st.claims.find(c => c.id === 'c2')
  kept.because = 'The copy that finished a round bumped [the counter to 412](#), so the next copy knew it ended.'
  kept.sources.push({ ref: 'a1@0', row: 'a1', at: md.indexOf('[412 on'), label: '412 on the counter' })
  const data = paneData(st)
  const c2 = data.claims.find(c => c.id === 'c2')
  const why = reasonOf(c2, { md, place: c2.said[0] })
  assert.equal(why.text, 'The copy that finished a round bumped the counter to 412, so the next copy knew it ended.')
  // its link is the claim's source of the same words; the source it does not name follows on a line of its own
  const cite = why.spans.find(x => x.look.cite)
  assert.equal(why.text.slice(cite.a, cite.b), 'the counter to 412')
  assert.equal(cite.look.part, `cite:${c2.sources.findIndex(x => x.label === 'the counter to 412')}`)
  assert.equal(why.more.text, '412 on the counter')
  // in the pane: the claim, its description in plain words (no citation marks), then its citations' cards
  const v = graphView(data, { claim: 'c2' }, { w: 90, h: 40, passage: { md, place: c2.said[0] } })
  assert.match(panel(v), /^signals · 2 of 2\n\nA copy bumped the counter to 412 when a round ended\.\n\nThe copy that finished a round bumped the counter to 412, so the next copy knew it ended\.\n\nshow evidence \(2 citations\)$/)
  assert.ok(v.panel.slice(0, 4).flat().every(x => !x.cite && !x.underline && !x.tint))
  // the session's explainers are not marked on the claims: the claim's words are its own explainer
  assert.ok(!v.panel.flat().some(x => x.bg === 'gloss'))
})

test("with no reason from the lens: the reply's sentences that said it, with their citations; sentences that only say it again put its citations in its own words", () => {
  const { st, md } = withPassage()
  const data = paneData(st)
  // c2's sentence of the reply says more than the claim: it shows, its citations in place, matched by their offsets
  const c2 = data.claims.find(c => c.id === 'c2')
  const why = reasonOf({ ...c2, text: 'The counter showed when a round was over.' }, { md, place: c2.said[0] })
  assert.match(why.text, /^They bumped the counter to 412 when a round ended, and the next copy read 412 on the counter\.$/)
  assert.deepEqual(why.spans.map(x => why.text.slice(x.a, x.b)), ['the counter to 412'])
  assert.equal(why.more.text, '')
  // the claim said again: no sentence, its citation drawn in the claim's words
  const same = reasonOf({ ...c2, text: 'They bumped the counter to 412 when a round ended, and the next copy read 412 on the counter.' }, { md, place: c2.said[0] })
  assert.equal(same.text, '')
  assert.deepEqual(same.inClaim.map(x => x.look.part), ['cite:0'])
  // a claim of Claude's with no citation says why under it
  const c1 = data.claims.find(c => c.id === 'c1')
  assert.match(panel(graphView(data, { claim: 'c1' }, { w: 90, h: 40, passage: { md, place: c1.said[0] } })), /\n\nNo citation: the reply cites no record for it\.$/)
})

test("a claim said in a table row: why it holds is that row, its cells between ·", () => {
  const md = 'The kinds:\n\n| Kind | Edits |\n|---|---|\n| Shares a task answer | [138](#) |\n| Ordinary edit | 111 |\n'
  const at = md.indexOf('Shares')
  const claim = { id: 'c1', text: 'A third of the edits share answers.', sources: [{ label: '138', row: 'a1', at: md.indexOf('[138]'), status: 'verified' }] }
  const why = reasonOf(claim, { md, place: { row: 'a1', quote: 'Shares a task answer', start: at, end: at + 20 } })
  assert.equal(why.text, 'Shares a task answer · 138')
  assert.deepEqual(why.spans.map(x => [why.text.slice(x.a, x.b), x.look.part]), [['138', 'cite:0']])
  // two citations of the same words (two replies said them) show once
  const twice = reasonOf({ id: 'c2', text: 'The admin deleted pages.', sources: [{ label: '5,144 pages', status: 'verified' }, { label: '5,144 pages', status: 'failed' }] })
  assert.equal(twice.more.text, '5,144 pages')
})

test("a claim keeps the lens's reason it holds (`because`), and a restatement gives one to a claim that had none", () => {
  const st = emptyStore('s')
  const md = 'The gate held for [nine rounds](#). Two admins read the logs.'
  applyTurn(st, { turn: 1, places: [{ row: 'a1', by: 'claude', turn: 1, text: md }], out: { claims: [
    { claim: 'The gate held for nine rounds.', quote: 'The gate held for nine rounds', cluster: 'gate', because: 'No relay got past it in [nine rounds](#).' },
    { claim: 'Two admins read the logs.', quote: 'Two admins read the logs', cluster: 'gate' },
  ] } })
  assert.equal(st.claims[0].because, 'No relay got past it in [nine rounds](#).')
  assert.equal(st.claims[1].because, undefined)
  applyTurn(st, { turn: 2, places: [{ row: 'a2', by: 'claude', turn: 2, text: 'As said, two admins read the logs.' }], out: { claims: [
    { same: 'c2', quote: 'two admins read the logs', because: 'The logs show both of their names.' },
  ] } })
  assert.equal(st.claims[1].because, 'The logs show both of their names.')
  assert.equal(paneData(st).claims[0].because, 'No relay got past it in [nine rounds](#).')
})

test('a citation not checked yet (auto cite) reads "not checked", never "× failed" without a reason; x checks it', () => {
  const s = { label: '419 and 411', status: 'deferred', row: 'r1', n: 3 }
  const text = cardOf(s, 60).rows.map(r => r.map(x => x.s).join('')).join('\n')
  assert.match(text, /not checked/)
  assert.doesNotMatch(text, /failed/)
  assert.equal(checkable(s), true)
  assert.equal(repairable(s), false)
  // a failed one says why
  const bad = cardOf({ label: '419', status: 'failed', reason: 'The forge counts 412. The rest match.', row: 'r1', n: 3 }, 60).rows.map(r => r.map(x => x.s).join('')).join('\n')
  assert.match(bad, /× failed[\s\S]*The forge counts 412\./)
})
