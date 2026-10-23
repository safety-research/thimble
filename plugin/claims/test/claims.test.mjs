// Claims (claims/store.js, graph.js, lens.mjs): the lens's claims as the observer's reply gives them, placed by their
// words with the citations near them, and the Claims pane as graph.js lays it out, whose count stays
// on screen however many claims a session has. Made-up data only.
//   node --test plugin/claims/test/
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseAnswer } from '../../observer/reply.mjs'
import { cardOf, checkChips, citationRows, correctionsOf, FEW, fitClusters, graphView, historyRows, hopCluster, mapCapacity, paneData, repairable, rowText, snippetOf, spread, wordDiff } from '../graph.js'
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
  assert.deepEqual(Object.keys(got[0]).sort(), ['at', 'by', 'cluster', 'links', 'quote', 'revises', 'same', 'text', 'why'])
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

test('the map takes the top of the pane; at rest nothing is chosen and no detail shows; a claim picked keeps its list in a window', () => {
  const data = paneData(uneven())
  for (const h of [46, 40, 34]) {
    const rest = graphView(data, {}, { w: 136, h })
    const tu = text(rest)
    // three columns of cells in a wide pane, as many rows of the shortest cells as fit over the detail's room: all
    // seven clusters at each of these heights
    const n = 7
    assert.equal(mapCapacity(136, h), 3 * Math.floor((h - 14) / 4))
    assert.match(tu, new RegExp(`^Claims · 155 claims · ${n} clusters`))
    assert.equal(rest.head[0][0].s, 'Claims')
    assert.ok(rest.head[0][0].bold && !rest.head[0][0].tone)
    // at rest: no claim, nothing chosen, no detail; the map draws every cluster, and says of none that it is left out
    assert.equal(rest.claim, null)
    assert.equal(rest.chosen, false)
    assert.deepEqual(rest.panel, [])
    assert.equal(new Set(rest.graph.flat().filter(x => /^g:/.test(x.part || '') && x.s.trim()).map(x => x.part)).size, n)
    assert.doesNotMatch(tu, /more cluster/)
    const cols = tu.split('\n').slice(2).flatMap(l => [...l].map((ch, x) => (/[●◉○]/.test(ch) ? x : -1)).filter(x => x >= 0))
    assert.ok(Math.min(...cols) < 136 * 0.15 && Math.max(...cols) > 136 * 0.85, `${h}: dots from ${Math.min(...cols)} to ${Math.max(...cols)}`)
    const sel = graphView(data, { claim: 'c40' }, { w: 136, h })
    assert.equal(sel.claim.id, 'c40')
    assert.ok(rows(sel).length + 2 <= h, `${h}: ${rows(sel).length} rows`)
    // a claim: the cluster's list stays, the claim ▸ and bold in the cluster's color, the others dim, and under it one
    // line of chips: its citations' checks and its turn; no evidence until e. A long list keeps a window round it
    const p = panel(sel)
    assert.match(p, /^─+\n● group 5 · \d+ claims\n( {2}↑ \d+ earlier\n)?( {2}– Wiki .*\n)* {2}▸ Wiki 40 had 50 saves\.\n {4}\? 1 citation failed {2}turn 2\n {2}– Wiki /)
    // a list too long for the rows under the map keeps a window round the claim, and says which claims it shows
    if (sel.windowed) assert.match(p, /\n {2}(↓ \d+ more · )?claims \d+–\d+ of \d+$/)
    // above a claim the cluster's name is bold and plain, its dot in the color
    assert.ok(/^c\d$/.test(sel.panel[1][0].tone) && sel.panel[1][1].bold && !sel.panel[1][1].tone)
    assert.ok(sel.panel[1].every(x => x.part === `g:${sel.group}`))
    const picked = sel.panel.find(r => rowText(r).includes('▸'))
    assert.ok(picked.slice(1).every(x => x.bold && x.tone === sel.panel[1][0].tone))
    const other = sel.panel.find(r => rowText(r).startsWith('  – '))
    assert.ok(other.slice(1).every(x => x.tone === 'dim') && other.every(x => /^n:c/.test(x.part)))
    // the map stays a graph; its cells are shorter in a short pane, so the list keeps a few rows
    assert.ok(sel.cellRows >= 4 && sel.cellRows <= 7, `${h}: ${sel.cellRows}`)
    assert.ok(sel.graph.some(r => r.some(x => /^d:/.test(x.part || ''))))
    if (sel.cellRows !== rest.cellRows) continue
    // every dot is a press on its claim, and so is the blank cell beside it; the dots keep their places whatever is
    // chosen
    assert.ok(sel.graph.some(r => r.some(x => x.part === 'd:c40')))
    const dotsOf = v => v.graph.map(r => rowText(r).replace(/[^●◉○]/g, ' ').trimEnd()).join('\n')
    assert.equal(dotsOf(sel), dotsOf(graphView(data, { claim: 'c155' }, { w: 136, h })))
    assert.equal(dotsOf(sel), dotsOf(rest))
    assert.ok(sel.graph.some(r => r.some((x, i) => x.part === 'd:c40' && x.s === ' ' && r[i + 1]?.part === 'd:c40')))
  }
})

test('a cluster chosen: its name and its claims under the map, each a press on the claim, no checks; its dots and name bold, the rest dim', () => {
  const data = paneData(uneven())
  const key = String(data.groups[2].id)
  const v = graphView(data, { group: key }, { w: 136, h: 40 })
  assert.equal(v.claim, null)
  assert.equal(v.group, key)
  assert.ok(v.chosen)
  const p = panel(v)
  assert.match(p, new RegExp(`^─+\\n● ${data.groups[2].name} · \\d+ claims\\n {2}– Wiki`))
  assert.doesNotMatch(p, /▸|verified|not checked|cites/)
  // the dot and name bold in the cluster's color; each claim after a dim – in plain words, a press on the claim
  assert.ok(v.panel[1].slice(0, 2).every(x => x.bold && x.tone === 'c3') && v.panel[1][2].tone === 'dim')
  const subs = v.panel.slice(2).filter(r => r.some(x => /^n:/.test(x.part || '')))
  assert.ok(subs.length >= 3)
  assert.ok(subs.every(r => r[1].s === '– ' && r[1].tone === 'dim' && !r[2].tone))
  // its name on the map is a press on the cluster, bold in its color; every other name and dot dim
  assert.ok(v.graph.some(r => r.some(x => x.part === `g:${key}` && x.s.includes(data.groups[2].name) && x.bold && x.tone === 'c3')))
  const names = v.graph.flatMap(r => r.filter(x => /^g:/.test(x.part || '') && x.s.trim()))
  for (const nm of names) assert.equal(nm.tone === 'dim', nm.part !== `g:${key}`, nm.s)
  const mine = new Set(data.claims.filter(c => String(c.cluster) === key).map(c => c.id))
  const dots = v.graph.flatMap(r => r.filter(x => /^d:/.test(x.part || '') && /[●◉○]/.test(x.s)))
  for (const d of dots) {
    const on = mine.has(d.part.slice(2))
    assert.equal(d.bold, on, d.part)
    assert.equal(d.tone === 'dim', !on, d.part)
  }
  // p n walk the clusters, round
  const keys = data.groups.map(g => String(g.id))
  assert.equal(hopCluster(data, keys[0], 1), keys[1])
  assert.equal(hopCluster(data, keys[0], -1), keys.at(-1))
  assert.equal(hopCluster(data, keys.at(-1), 1), keys[0])
  // a claim picked keeps its whole cluster lit and bold on the map
  const c = graphView(data, { claim: [...mine][0] }, { w: 136, h: 40 })
  const bold = c.graph.flatMap(r => r.filter(x => x.bold && /[●◉○]/.test(x.s)))
  assert.deepEqual(new Set(bold.map(x => x.part.slice(2))), new Set([...mine].filter(id => c.graph.some(r => r.some(x => x.part === `d:${id}` && /[●◉○]/.test(x.s))))))
})

function linkedClaims() {
  const st = emptyStore('s')
  const quotes = ['The keys (v, s, ], 1, { }) need a reply to act on, and the bar finder returns null when there is no reply yet',
    ...Array.from({ length: 23 }, (_, i) => `Note ${i + 2} was a tip number ${i + 2}`)]
  applyTurn(st, { places: [{ row: 'r1', by: 'claude', turn: 1, text: quotes.map(q => q + '.').join(' ') }], turn: 1,
    out: { claims: quotes.map((q, i) => ({ quote: q, cluster: `group ${(i % 4) + 1}`, ...(i ? { links: [{ to: `c${Math.max(1, i - 1 - (i % 3))}`, how: 'supports' }] } : {}) })) } })
  return paneData(st)
}

test("a claim picked: its whole sentence wrapped under its first word, its chips; e opens its citations one at a time as the citation card draws them, the wrong ones first", () => {
  const data = linkedClaims()
  const rows = graphView(data, { claim: 'c1' }, { w: 110, h: 34 }).panel
  const at = rows.findIndex(r => rowText(r).startsWith('  ▸ '))
  const said = rows.slice(at, at + 2).map(rowText)
  assert.match(said[0], /^ {2}▸ The keys \(v, s, \], 1, \{ \}\) need a reply .* returns null when there is no reply$/)
  assert.equal(said[1], '    yet.')
  assert.equal(rowText(rows[at + 2]), '    no citations  turn 1')
  // computed evidence: the cited words bold in the citation color and the check beside them, the code line that printed
  // the value, then the output line after │, the cited words tinted, and how many output lines more under it; a file's:
  // its place, then the line; then which citation of how many. A press on a citation opens its evidence
  const computed = { kind: 'computed', code: 'n = len(saves)\nprint(f"{n:,} saves")', output: '3,752 saves labeled coordination\n2 runs\n0 errors\n', highlight: [[0, 11]] }
  const quote = { kind: 'quote', file: 'revisions.jsonl', line: 412, lines: [{ n: 411, text: 'before' }, { n: 412, text: 'summary: When round #5 arrives, answer first, then', highlight: [9, 44] }] }
  const c = { ...data.claims[0], sources: [
    { ref: 'a1@3', row: 'r1', at: 3, n: 2, label: '3,752 saves', status: 'verified', evidence: computed },
    { ref: 'a1@9', row: 'r1', at: 9, n: 3, label: 'When round #5 arrives, answer first', status: 'failed', failedBy: 'evidence', reason: 'The file says it once. More words.', evidence: quote },
  ] }
  const d2 = { ...data, claims: [c, ...data.claims.slice(1)] }
  const shut = graphView(d2, { claim: 'c1' }, { w: 110, h: 34 })
  assert.equal(shut.cites, 2)
  assert.match(panel(shut), /\n {4}✓ 1 verified {2}\? 1 failed {2}turn 1\n {2}– Note/)
  assert.doesNotMatch(panel(shut), /print\(|│/)
  // e: the list goes, the claim stays with its evidence; the failed one comes first; ‹ i of n › under it, ‹ and › a
  // press that steps
  const v = graphView(d2, { claim: 'c1', open: true }, { w: 110, h: 34 })
  assert.match(panel(v), /turn 1\n\n {4}When round #5 arrives, answer first {3}\? failed · cite\n {4}The file says it once\.\n {4}revisions\.jsonl:412\n {4}│ summary: When round #5 arrives, answer first, then\n\n {4}‹ 1 of 2 ›$/)
  assert.deepEqual(v.panel.at(-1).filter(x => x.part && x.s.trim()).map(x => [x.s, x.part]), [['‹', 'cite-prev'], ['›', 'cite-next']])
  assert.doesNotMatch(panel(v), /×|wrong|problems first/)
  assert.ok(repairable(v.shown))
  assert.ok(v.panel.flat().some(x => x.tint && x.s === 'When round #5 arrives, answer first' && x.part === 'ev-1'))
  const second = graphView(d2, { claim: 'c1', open: true, cite: 1 }, { w: 110, h: 34 })
  assert.match(panel(second), /turn 1\n\n {4}3,752 saves {3}✓ verified · cite\n {4}print\(f"\{n:,\} saves"\)\n {4}│ 3,752 saves labeled coordination\n {4}│ \+ 2 more lines\n\n {4}‹ 2 of 2 ›$/)
  assert.doesNotMatch(panel(second), /said in/)
  assert.ok(!repairable(second.shown))
  const runs = second.panel.flat()
  assert.ok(runs.some(x => x.bold && x.tint && x.s === '3,752 saves' && x.part === 'ev-2'))
  assert.ok(runs.some(x => x.tint && x.s === '3,752 saves'))
  assert.ok(runs.some(x => x.tone === 'code' && x.s.startsWith('print(')))
  // the chips count every check; a citation the check corrected says what it was; a long output line is cut round the
  // cited words, a long code line in the middle, and c shows both whole
  // two outcomes: verified (a corrected value too) and failed, whoever failed it
  assert.equal(rowText(checkChips({ sources: [{ status: 'verified' }, { status: 'corrected' }, { status: 'failed', failedBy: 'check' }, { status: 'failed', failedBy: 'evidence' }, { status: 'checking' }] })), '✓ 2 verified  ? 2 failed  … 1 checking')
  assert.match(rowText(citationRows({ label: '9', shown: '9', status: 'failed', failedBy: 'check', reason: 'Line 4 says 12.' }, 60)[0]), /\? failed · cite$/)
  assert.equal(rowText(checkChips({ sources: [{ status: 'verified' }, { status: 'verified' }] })), '✓ 2 citations verified')
  // a check that did not run is failed, with its plain reason, whatever status it came with
  assert.equal(rowText(checkChips({ sources: [{ status: 'failed', failedBy: 'none' }, {}, { status: 'unchecked' }] })), '? 3 citations failed')
  assert.deepEqual(citationRows({ label: '9', shown: '9', status: 'failed', failedBy: 'none', reason: 'The check did not run. The reply was interrupted.' }, 60).map(rowText), ['9   ? failed · cite', 'The check did not run.'])
  assert.equal(repairable({ row: 'r1', n: 2, status: 'failed', failedBy: 'none' }), true)
  const was = citationRows({ label: '12', shown: '12', was: '15', status: 'corrected', evidence: computed }, 60).map(rowText)
  assert.deepEqual(was.slice(0, 2), ['12   ✓ verified · cite', 'corrected; was 15'])
  const long = snippetOf({ kind: 'computed', code: 'print(x)', output: `${'a'.repeat(80)} 42 ${'b'.repeat(80)}`, highlight: [[81, 83]] }, 30)
  assert.ok(long.text.length <= 30 && long.text.slice(long.spans[0][0], long.spans[0][1]) === '42' && long.cut)
  const huge = { kind: 'computed', code: `daily = df.groupby(df.ts.dt.date).size().sort_values(ascending=False).reset_index(); print(daily.max())`, output: `${'x'.repeat(70)} 6,543 ${'y'.repeat(70)}\n${'z\n'.repeat(41)}`, highlight: [[71, 76]] }
  const card = cardOf({ label: '6,543', status: 'verified', evidence: huge }, 56)
  assert.ok(card.cut)
  assert.ok(card.rows.every(r => rowText(r).length <= 56), card.rows.map(rowText).join('\n'))
  assert.match(rowText(card.rows[1]), /^daily = df\.groupby.* … .*print\(daily\.max\(\)\)$/)
  assert.equal(rowText(card.rows.at(-1)), '│ + 41 more lines')
  const whole = cardOf({ label: '6,543', status: 'verified', evidence: huge }, 56, { whole: true })
  assert.ok(whole.rows.length > 40 && whole.rows.every(r => rowText(r).length <= 56))
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

test('a corrected claim: a corrected chip; e opens its History, one word-level diff per correction with its reason, then the evidence', () => {
  const data = corrected(2)
  const shut = graphView(data, { claim: 'c3' }, { w: 70, h: 40 })
  assert.match(panel(shut), /\n {2}▸ All of the admin's deletions came after the edits stopped, from\n {4}June 23 to July 14\.\n {4}no citations {2}corrected ×2 {2}turn 3$/)
  assert.ok(shut.panel.flat().some(x => x.s === 'corrected ×2' && x.tone === 'cite'))
  assert.equal(shut.fixes, 2)
  const open = graphView(data, { claim: 'c3', open: true }, { w: 70, h: 40 })
  const p = panel(open)
  assert.match(p, /turn 3\n\n {4}History\n {4}turn 1 → turn 2\n {4}The deletions began Most of the admin's deletions came after the\n {4}edits stopped, from June 23 to July 14\.\n {4}reason: 444 of the 5,217 deletions came before June 23\.\n\n {4}turn 2 → turn 3\n {4}Most All of the admin's deletions came after the edits stopped,\n {4}from June 23 to July 14\.\n {4}reason: none came before\.$/)
  // deleted words red and struck through, inserted green; a full stop alike stays plain
  const runs = open.panel.flat()
  assert.ok(runs.some(x => x.s === 'The' && x.tone === 'del') && runs.some(x => x.s === 'deletions' && x.tone === 'del'))
  assert.ok(runs.some(x => x.s === 'Most' && x.tone === 'ins') && runs.some(x => x.s === 'All' && x.tone === 'ins'))
  assert.ok(runs.some(x => x.s === 'June' && !x.tone))
  // a press on a correction's turns picks the other version
  assert.ok(open.panel.some(r => r.some(x => x.part === 'was-c2')))
  // when most words change, the old sentence and the new show whole, struck through and green
  assert.equal(wordDiff('The bot farm was run by one company.', 'The records do not show who ran the agents; 738 of the 3,102 names mention OpenAI.'), null)
  const all = historyRows([{ from: 'turn 2', to: 'turn 3', old: 'The bot farm was run by one company.', now: 'The records do not show who ran the agents.', why: 'no record names an operator.', part: null }], 60)
  assert.deepEqual(all.map(rowText), ['History', 'turn 2 → turn 3', 'The bot farm was run by one company.', 'The records do not show who ran the agents.', 'reason: no record names an operator.'])
  assert.deepEqual(all.slice(2, 4).map(r => r[0].tone), ['del', 'ins'])
  // a claim whose citation the check corrected: the words before the check and the check's reason
  const own = { id: 'c9', text: 'x', turn: 4, sources: [{ label: '12', status: 'corrected', was: '15', reason: 'agent-07 merged 12, not 15' }] }
  assert.deepEqual(correctionsOf(own, new Map()), [{ from: 'turn 4', to: 'the check', old: '15', now: '12', why: 'agent-07 merged 12, not 15.', part: null }])
})

test('five corrections: the newest two, newest first, and how many earlier; h shows all of them, oldest first', () => {
  const data = corrected(5)
  const v = graphView(data, { claim: 'c6', open: true }, { w: 66, h: 50 })
  assert.equal(v.fixes, 5)
  const p = panel(v)
  assert.match(p, /corrected ×5/)
  assert.match(p, /History\n {4}turn 5 → turn 6\n {4}Most of the admin's deletions came after the edits stopped,\n {4}from June 23 to July 13 12\.\n {4}reason: the last deletion is on July 12\.\n\n {4}turn 4 → turn 5\n(.*\n)+ {4}\+ 3 earlier corrections$/)
  // six claims: no map, the list alone, its history in full however short the pane (it scrolls)
  const short = graphView(data, { claim: 'c6', open: true }, { w: 66, h: 27 })
  assert.ok(v.listed && short.listed)
  assert.deepEqual(short.graph, [])
  assert.equal(panel(short), p)
  const all = panel(graphView(data, { claim: 'c6', open: true, all: true }, { w: 66, h: 50 }))
  assert.deepEqual([...all.matchAll(/turn (\d) → turn (\d)/g)].map(m => m[1]), ['1', '2', '3', '4', '5'])
  assert.doesNotMatch(all, /earlier corrections/)
})

test("a long cluster name wraps under its cluster's dots, three lines at most, and a press on any of its lines chooses the cluster", () => {
  const st = emptyStore('s')
  const long = 'How the wiki admin cleaned up after the agents left'
  const text = Array.from({ length: 12 }, (_, i) => `Note ${i + 1} is a fact about item ${i + 1}.`).join(' ')
  applyTurn(st, { turn: 1, places: [{ row: 'a1', by: 'claude', turn: 1, text }], out: { claims: Array.from({ length: 12 }, (_, i) => ({ quote: `Note ${i + 1} is a fact about item ${i + 1}`, cluster: i % 4 ? `topic ${i % 4}` : long })) } })
  const v = graphView(paneData(st), {}, { w: 60, h: 40 })
  const lines = v.graph.map(r => r.filter(x => x.part === 'g:k1').map(x => x.s).join('').trim()).filter(Boolean)
  assert.ok(lines.length >= 2 && lines.length <= 3, lines.join(' | '))
  assert.equal(lines.join(' '), long)
  // the name stands under its dots: every dot of the cluster on a row above the name's first
  const top = v.graph.findIndex(r => r.some(x => x.part === 'g:k1' && x.s.trim()))
  const dotRows = v.graph.map((r, y) => (r.some(x => /^d:/.test(x.part || '') && /[●◉○]/.test(x.s) && ['c1', 'c5', 'c9'].includes(x.part.slice(2))) ? y : -1)).filter(y => y >= 0)
  assert.ok(dotRows.every(y => y < top), `${dotRows} above ${top}`)
  // a name of more than three lines ends the third in …; the header under the map shows it whole
  const names = spread([{ id: 'a', cluster: '1' }], [{ id: '1', name: 'Risky behavior by the agents: script-injection probes, a hidden signal channel and blocked-site fetches' }], [], { w: 31, h: 7 }).names
  assert.deepEqual(names[0].lines, ['Risky behavior by the agents:', 'script-injection probes, a', 'hidden signal channel and …'])
})

test('a long claim takes two lines in the list, then …; picked, it shows whole', () => {
  const st = emptyStore('s')
  const long = "About 9 requests carry script-injection (XSS) probes against the wiki software; two of them try to show the browser's cookies"
  applyTurn(st, { turn: 1, places: [{ row: 'a1', by: 'claude', turn: 1, text: `${long}. A short one.` }], out: { claims: [{ quote: long, cluster: 'risky' }, { quote: 'A short one', cluster: 'risky' }] } })
  const data = paneData(st)
  const listed = panel(graphView(data, { claim: 'c2' }, { w: 62, h: 50 }))
  assert.match(listed, /\n {2}– About 9 requests carry script-injection \(XSS\) probes\n {4}against the wiki software; two of them try to show the …\n/)
  const picked = panel(graphView(data, { claim: 'c1' }, { w: 62, h: 50 }))
  assert.match(picked, /cookies\.\n/)
})

test('fourteen clusters: the map draws them all, cells shorter; only near clusters join, named for both; p n visit those drawn', () => {
  const build = (linkTwice, names = g => `topic ${g}`) => {
    const st = emptyStore('s')
    const sizes = [9, 8, 7, 6, 6, 5, 4, 3, 3, 2, 2, 2, 2, 1]
    const qs = sizes.flatMap((n, g) => Array.from({ length: n }, (_, i) => ({ quote: `Fact ${g}-${i} holds`, cluster: names(g),
      // the one-claim cluster's claim is linked to topic 2's claims: once, or twice (near)
      ...(g === 13 ? { links: [{ to: 'c18', how: 'supports' }, ...(linkTwice ? [{ to: 'c19', how: 'supports' }] : [])] } : {}) })))
    applyTurn(st, { turn: 1, places: [{ row: 'a1', by: 'claude', turn: 1, text: qs.map(q => `${q.quote}.`).join(' ') }], out: { claims: qs } })
    return st
  }
  // 62 columns by 26 rows: room for two columns of three rows of the shortest cells
  assert.equal(mapCapacity(62, 26), 6)
  // no two clusters near (one link, few words shared): none joins another, however many; the cells are as short as
  // they go and the pane scrolls
  const apart = paneData(build(false))
  assert.equal(fitClusters(apart, 6), apart)
  const v = graphView(apart, {}, { w: 62, h: 26 })
  assert.match(rowText(v.head[0]), /^Claims · 60 claims · 14 clusters$/)
  assert.equal(v.cellRows, 4)
  const onMap = new Set(v.graph.flatMap(r => r.filter(x => /^g:/.test(x.part || '') && x.s.trim()).map(x => x.part)))
  assert.equal(onMap.size, 14)
  assert.equal(new Set(v.graph.flat().filter(x => /^d:/.test(x.part || '') && /[●◉○]/.test(x.s)).map(x => x.part)).size, 60)
  // linked twice: the one-claim cluster joins topic 2, whose name now says both; every claim is in a cluster drawn
  const st = build(true)
  const data = paneData(st)
  const fit = fitClusters(data, 6)
  assert.equal(fit.groups.length, 13)
  const into = fit.claims.find(c => c.text.startsWith('Fact 13-0')).cluster
  assert.equal(into, data.claims.find(c => c.id === 'c18').cluster)
  assert.equal(fit.groups.find(g => g.id === into).name, 'topic 2 + topic 13')
  assert.ok(fit.claims.every(c => fit.groups.some(g => g.id === c.cluster)))
  assert.deepEqual(fit.groups.map(g => g.i), [...Array(13).keys()])
  // long names: the larger's name and how many claims joined it
  const long = fitClusters(paneData(build(true, g => `Topic ${g}: what the agents did with their pull requests`)), 6)
  assert.match(long.groups.find(g => g.id === into).name, /^Topic 2: what the agents did with their pull requests \+ \d+ other claims?$/)
  // the store is not changed, and a pane with room draws them apart
  assert.equal(paneData(st).groups.length, 14)
  assert.equal(graphView(data, {}, { w: 120, h: 50 }).data.groups.length, 14)
  const w = graphView(data, {}, { w: 62, h: 26 })
  const seen = new Set()
  let k = String(w.data.groups[0].id)
  for (let i = 0; i < 13; i++) { seen.add(k); k = hopCluster(w.data, k, 1) }
  assert.equal(seen.size, 13)
})

test('a long list pages by a screen: a press on ↑ N earlier or ↓ N more', () => {
  const st = emptyStore('s')
  const qs = Array.from({ length: 80 }, (_, i) => ({ quote: `Run ${i + 1} copied an answer`, cluster: 'copying' }))
  applyTurn(st, { turn: 1, places: [{ row: 'a1', by: 'claude', turn: 1, text: qs.map(q => `${q.quote}.`).join(' ') }], out: { claims: qs } })
  const data = paneData(st)
  const key = String(data.groups[0].id)
  const first = graphView(data, { group: key }, { w: 62, h: 40 })
  assert.ok(first.windowed)
  const down = first.panel.at(-1)
  assert.match(rowText(down), /^ {2}↓ \d+ more · claims 1–(\d+) of 80$/)
  const next = Number(down[0].part.slice(3))
  assert.equal(down[0].part, `pg:${next}`)
  const second = graphView(data, { group: key, from: next }, { w: 62, h: 40 })
  const up = second.panel.find(r => rowText(r).includes('↑'))
  assert.equal(rowText(up), `  ↑ ${next} earlier`)
  assert.equal(up[0].part, 'pg:0')
  assert.ok(second.panel.some(r => rowText(r) === `  – Run ${next + 1} copied an answer.`))
  // the last screen ends with the last claim
  const last = graphView(data, { group: key, from: 79 }, { w: 62, h: 40 })
  assert.match(rowText(last.panel.at(-1)), /^ {2}claims \d+–80 of 80$/)
  assert.ok(!last.panel.at(-1)[0].part)
})

test('a narrow pane lists the clusters one per line, the chosen one bold; in a short one the map stays a graph when the evidence is open', () => {
  const data = paneData(uneven())
  const key = String(data.groups[2].id)
  const v = graphView(data, { group: key }, { w: 44, h: 50 })
  assert.ok(v.narrow)
  assert.match(text(v), /^Claims · 155 · 7 clusters\n\n ● group/)
  assert.equal(v.graph.length, 7)
  assert.ok(v.graph.every(r => rowText(r).length <= 44))
  assert.ok(v.graph.find(r => r.some(x => x.part === `g:${key}`)).some(x => x.bold && x.tone === 'c3'))
  assert.ok(v.panel.every(r => rowText(r).length <= 44))
  const short = graphView(data, { claim: 'c40', open: true }, { w: 62, h: 30 })
  // every cluster, in cells shorter when the evidence needs the rows
  assert.equal(short.data.groups.length, 7)
  assert.ok(short.cellRows >= 4 && short.cellRows <= 7)
  assert.equal(short.graph.length, 4 * short.cellRows)
  assert.ok(short.graph.some(r => r.some(x => /^d:/.test(x.part || ''))))
})

test('new claims while browsing: the selection stays, the new dots are ◆, the new claims bold, and +N new shows for a moment', () => {
  const st = emptyStore('s')
  const first = 'ABCDEFGHI'.split('').map((l, i) => ({ quote: `${l} is ${i + 1}`, cluster: i % 2 ? 'y' : 'x' }))
  applyTurn(st, { turn: 1, places: [{ row: 'a1', by: 'claude', turn: 1, text: first.map(q => `${q.quote}.`).join(' ') }], out: { claims: first } })
  const before = paneData(st)
  applyTurn(st, { turn: 2, places: [{ row: 'a2', by: 'claude', turn: 2, text: 'J is 10. K is 11.' }], out: { claims: [{ quote: 'J is 10', cluster: 'k1' }, { quote: 'K is 11', cluster: 'k2' }] } })
  const data = paneData(st)
  const v = graphView(data, { claim: 'c1', at: before.last }, { w: 62, h: 40, bright: true })
  assert.equal(v.claim.id, 'c1')
  assert.match(rowText(v.head[0]), /^Claims · 11 claims · 2 clusters {2}\+2 new$/)
  const fresh = v.graph.flat().filter(x => x.s === '◆')
  assert.deepEqual(fresh.map(x => x.part).sort(), ['d:c10', 'd:c11'])
  assert.ok(fresh.every(x => x.bold))
  assert.ok(v.panel.some(r => rowText(r) === '  – J is 10.' && r.slice(1).every(x => x.bold)))
  // in a short session's list too, a new claim is bold
  const few = emptyStore('s')
  applyTurn(few, { turn: 1, places: [{ row: 'a1', by: 'claude', turn: 1, text: 'A is 1.' }], out: { claims: [{ quote: 'A is 1', cluster: 'x' }] } })
  applyTurn(few, { turn: 2, places: [{ row: 'a2', by: 'claude', turn: 2, text: 'B is 2.' }], out: { claims: [{ quote: 'B is 2', cluster: 'k1' }] } })
  const l = graphView(paneData(few), { claim: 'c1', at: 1 }, { w: 62, h: 40, bright: true })
  assert.ok(l.listed && l.panel.some(r => rowText(r) === '  – B is 2.' && r.slice(1).every(x => x.bold)))
  assert.doesNotMatch(rowText(graphView(data, { claim: 'c1', at: before.last }, { w: 62, h: 40 }).head[0]), /new/)
  assert.ok(!graphView(data, { claim: 'c1', at: data.last }, { w: 62, h: 40 }).graph.flat().some(x => x.s === '◆'))
})

/** A short session's claims: six in two clusters, the second linked to the first and citing `16 of 60`. */
function sixClaims() {
  const st = emptyStore('s')
  const qs = [['posts', 'Most posts are status updates: 37 of 60 sampled'], ['posts', 'Review requests come second: 16 of 60'], ['posts', 'Claiming work is rare: 4 of 60'],
    ['posts', 'Asking for help is rare: 2 of 60'], ['data', 'The label post_kind sorts every post'], ['data', '9,921 posts across 16 runs']]
    .map(([cluster, quote], i) => ({ quote, cluster, ...(i === 1 ? { links: [{ to: 'c1', how: 'supports' }] } : {}) }))
  const text = qs.map(q => `${q.quote}.`).join(' ').replace('16 of 60', '[16 of 60](#)')
  applyTurn(st, { turn: 1, places: [{ row: 'a1', by: 'claude', turn: 1, text }], out: { claims: qs } })
  return paneData(st)
}

test('a short session has no map: its clusters are listed, each its name then its claims, with the picking, chips and evidence of the detail', () => {
  const data = sixClaims()
  assert.equal(FEW, 10)
  const rest = graphView(data, {}, { w: 70, h: 36 })
  assert.ok(rest.listed)
  assert.deepEqual(rest.graph, [])
  assert.equal([...rest.head, ...rest.panel].map(rowText).join('\n'), [
    'Claims · 6 claims · 2 clusters', '─'.repeat(70),
    '● posts · 4 claims', '  – Most posts are status updates: 37 of 60 sampled.', '  – Review requests come second: 16 of 60.',
    '  – Claiming work is rare: 4 of 60.', '  – Asking for help is rare: 2 of 60.', '',
    '● data · 2 claims', '  – The label post_kind sorts every post.', '  – 9,921 posts across 16 runs.',
  ].join('\n'))
  // at rest nothing is chosen: each name a press on its cluster, each claim on itself, none dim
  assert.equal(rest.chosen, false)
  assert.ok(rest.panel.filter(r => rowText(r).startsWith('● ')).every((r, i) => r.every(x => x.part === `g:${data.groups[i].id}`) && r[0].tone === `c${i + 1}`))
  assert.ok(rest.panel.filter(r => rowText(r).startsWith('  – ')).every(r => /^n:c\d$/.test(r[0].part) && !r[2].tone))
  // a cluster chosen: its name bold in its color, the other cluster dim
  const key = String(data.groups[1].id)
  const g = graphView(data, { group: key }, { w: 70, h: 36 })
  assert.ok(g.chosen && g.group === key)
  const nameRow = name => g.panel.find(r => rowText(r).startsWith(`● ${name}`))
  assert.ok(nameRow('data').slice(0, 2).every(x => x.bold && x.tone === 'c2'))
  assert.ok(nameRow('posts').every(x => x.tone === 'dim'))
  assert.ok(g.panel.some(r => rowText(r) === '  – 9,921 posts across 16 runs.' && !r[2].tone))
  assert.ok(g.panel.some(r => rowText(r) === '  – Claiming work is rare: 4 of 60.' && r[2].tone === 'dim'))
  // a claim picked: ▸ bold in its cluster's color, its chips under it, every other claim dim; a press on it chooses
  // its cluster
  const c = graphView(data, { claim: 'c2' }, { w: 70, h: 36 })
  const p = panel(c)
  assert.match(p, /\n {2}▸ Review requests come second: 16 of 60\.\n {4}\? 1 citation failed {2}turn 1\n {2}– Claiming/)
  const picked = c.panel.find(r => rowText(r).includes('▸'))
  assert.ok(picked.slice(1).every(x => x.bold && x.tone === 'c1' && x.part === `g:${data.groups[0].id}`))
  assert.ok(c.panel.filter(r => /^ {2}– /.test(rowText(r))).every(r => r[2].tone === 'dim'))
  assert.equal(c.cites, 1)
  // e: only its cluster's name and the claim stay, its evidence under it
  const open = graphView(data, { claim: 'c2', open: true }, { w: 70, h: 36 })
  assert.ok(open.listed)
  assert.match(panel(open), /^─+\n● posts · 4 claims\n {2}▸ Review requests come second: 16 of 60\.\n {4}\? 1 citation failed {2}turn 1\n\n {4}16 of 60 {3}\? failed · cite\n/)
  assert.doesNotMatch(panel(open), /data|Claiming/)
  // a narrow pane lists them too, each row in its width
  const narrow = graphView(data, { claim: 'c1' }, { w: 40, h: 36 })
  assert.ok(narrow.listed && narrow.panel.every(r => rowText(r).length <= 40))
})

test('the map appears once a session has FEW claims', () => {
  const st = emptyStore('s')
  const qs = Array.from({ length: FEW }, (_, i) => ({ quote: `Fact ${i + 1} holds`, cluster: i % 2 ? 'odd' : 'even' }))
  applyTurn(st, { turn: 1, places: [{ row: 'a1', by: 'claude', turn: 1, text: qs.map(q => `${q.quote}.`).join(' ') }], out: { claims: qs.slice(0, FEW - 1) } })
  const under = graphView(paneData(st), {}, { w: 90, h: 36 })
  assert.ok(under.listed && !under.graph.length)
  applyTurn(st, { turn: 2, places: [{ row: 'a2', by: 'claude', turn: 2, text: `${qs.at(-1).quote}.` }], out: { claims: qs.slice(-1) } })
  const at = graphView(paneData(st), {}, { w: 90, h: 36 })
  assert.ok(!at.listed && at.graph.some(r => r.some(x => /^d:/.test(x.part || ''))))
  assert.deepEqual(at.panel, [])
})

test('no lines join the claims, however they are linked', () => {
  const data = linkedClaims()
  assert.ok(data.edges.length > 10)
  for (const st of [{}, { claim: 'c9' }, { claim: 'c14' }, { group: String(data.groups[0].id) }]) {
    const g = graphView(data, st, { w: 110, h: 34 }).graph.map(rowText).join('\n')
    assert.doesNotMatch(g, /[─│╭╮╰╯├┤┬┴┼]/, JSON.stringify(st))
  }
  // nor in a short session's list: linked claims are listed next to each other, the one rule over the list alone
  const few = graphView(sixClaims(), {}, { w: 70, h: 36 }).panel.map(rowText)
  assert.deepEqual(few.filter(l => /[─│╭╮╰╯├┤┬┴┼]/.test(l)), ['─'.repeat(70)])
  assert.equal(few[0], '─'.repeat(70))
})

test('with no claims the pane says so in its head', () => {
  const none = graphView(paneData(emptyStore('s')), {}, { w: 90, h: 30 })
  assert.deepEqual(none.head.map(rowText), ['Claims · no claims yet'])
  assert.deepEqual([...none.graph, ...none.panel], [])
})
