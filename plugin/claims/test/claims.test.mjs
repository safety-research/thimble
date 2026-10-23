// Claims (claims/store.js, graph.js, lens.mjs): the lens's claims as the observer's reply gives them, placed by their
// words with the citations near them, and the Claims pane as graph.js lays it out, every cluster a row that fits the
// pane however many clusters and claims a session has. Made-up data only.
//   node --test plugin/claims/test/
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseAnswer } from '../../observer/reply.mjs'
import { cardOf, checkChips, citationRows, correctionsOf, evidenceOf, graphView, historyRows, hopCluster, MARK, paneData, repairable, rowText, snippetOf, wordDiff } from '../graph.js'
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

/** The pane's rows as pane.tsx draws them over the keys: the head, a blank row, the body. */
const rows = view => [...view.head, ...(view.body.length ? [[]] : []), ...view.body]
const body = view => view.body.map(rowText).join('\n')
/** The row of a cluster's name: the row whose name run is a press on it (not a fold, whose press chooses it too). */
const rowOf = (view, key) => view.body.find(r => !/more clusters?$/.test(rowText(r)) && r.some(x => x.part === `g:${key}` && x.s.trim()))
/** Where the name starts in a row: the dots' column and a space before it. */
const nameAt = r => { let x = 0; for (const run of r) { if (/^g:/.test(run.part || '') && run.s.trim()) return x + run.s.length - run.s.trimStart().length; x += run.s.length } return -1 }
/** The rows the keys take at least: the rule and their row. */
const KEYS = 2

test('every cluster is a row: its claims as dots in one purple, right-aligned, then its name; at rest nothing is chosen', () => {
  const data = paneData(uneven())
  for (const [w, h] of [[136, 40], [74, 42], [60, 30]]) {
    const rest = graphView(data, {}, { w, h })
    assert.equal(rowText(rest.head[0]), 'Claims · 155 claims · 7 clusters')
    assert.ok(rest.head[0][0].bold && !rest.head[0][0].tone)
    assert.equal(rest.claim, null)
    assert.equal(rest.chosen, false)
    // seven clusters of 17 to 51 claims: seven rows, top to bottom in the order the lens named them, each name a press
    // on its cluster and plain at rest
    assert.equal(rest.every, false)
    assert.deepEqual(rest.order, data.groups.map(g => String(g.id)))
    const named = rest.body.filter(r => r.some(x => /^g:/.test(x.part || '')))
    assert.deepEqual(named.map(r => r.find(x => /^g:/.test(x.part)).part.slice(2)), rest.order)
    assert.ok(named.every(r => r.filter(x => /^g:/.test(x.part || '')).every(x => !x.bold && !x.tone)))
    // the names start in one column, after the dots; every dot is MARK's purple and a press on its claim
    assert.equal(new Set(named.map(nameAt)).size, 1)
    const dots = rest.body.flat().filter(x => /^d:/.test(x.part || ''))
    assert.ok(dots.length && dots.every(x => /^[●◉○]$/.test(x.s) && x.tone === MARK && !x.bold))
    assert.equal(MARK, 'c2')
    // the largest clusters hold more claims than the column: their count, dim, before their newest dots
    const big = rowOf(rest, data.groups.find(g => g.name === 'group 1').id)
    assert.match(rowText(big), /^ *51 [●◉○]+ group 1$/)
    assert.ok(big.some(x => x.s === '51 ' && x.tone === 'dim'))
    assert.ok(big.some(x => x.part === 'd:c153'))
    assert.ok(rest.body.every(r => rowText(r).length <= w))
    assert.ok(rows(rest).length + KEYS <= h)
    assert.deepEqual([...rest.body.flat()].filter(x => /[─│╭╮╰╯├┤┬┴┼]/.test(x.s)), [])
  }
  // a claim picked: its cluster's row opens in place, its list with the claim ▸ and bold in MARK, the others dim, its
  // chips under it, and the other rows stay
  const sel = graphView(data, { claim: 'c40' }, { w: 136, h: 40 })
  assert.equal(sel.claim.id, 'c40')
  const p = body(sel)
  assert.match(p, /\n {4}[●◉○]+ group 5\n( {22}– Wiki .*\n)+ {22}▸ Wiki 40 had 50 saves\.\n {24}× 1 citation failed {2}turn 2\n {22}– Wiki /)
  assert.ok(data.groups.every(g => rowOf(sel, g.id)))
  const picked = sel.body.find(r => rowText(r).includes('▸'))
  assert.ok(picked.filter(x => x.s.trim()).every(x => x.bold && x.tone === MARK && x.part === 'c:c40'))
  const other = sel.body.find(r => rowText(r).includes('– Wiki'))
  assert.ok(other.filter(x => x.s.trim()).slice(1).every(x => x.tone === 'dim') && other.every(x => /^n:c/.test(x.part)))
  assert.ok(rows(sel).length + KEYS <= 40)
})

test('a cluster chosen: its row opens in place, its dots and name bold, its claims under the name, each a press on the claim; the other rows stay', () => {
  const data = paneData(uneven())
  const key = String(data.groups[2].id)
  const v = graphView(data, { group: key }, { w: 136, h: 46 })
  assert.equal(v.claim, null)
  assert.equal(v.group, key)
  assert.ok(v.chosen)
  const at = v.body.indexOf(rowOf(v, key))
  // the rows above it and under it are the other clusters, one line each, in their order
  assert.deepEqual(v.body.slice(0, at).map(r => r.find(x => /^g:/.test(x.part || '')).part.slice(2)), v.order.slice(0, 2))
  const own = rowOf(v, key)
  assert.ok(own.filter(x => x.part).every(x => x.bold))
  assert.ok(own.filter(x => /^d:/.test(x.part || '')).every(x => x.tone === MARK))
  // its claims under its name, after a dim –, in plain words; no checks until a claim is picked
  const subs = v.body.slice(at + 1).filter(r => r.some(x => /^n:/.test(x.part || '')))
  assert.ok(subs.length >= 3)
  assert.ok(subs.every(r => rowText(r).indexOf('–') === nameAt(own) && r.find(x => x.s === '– ').tone === 'dim' && !r.at(-1).tone))
  assert.doesNotMatch(body(v), /▸|verified|not checked/)
  // the other rows: names plain, dots not bold
  for (const g of data.groups.filter(g => String(g.id) !== key)) assert.ok(rowOf(v, g.id).every(x => !x.bold))
  // p n walk the clusters top to bottom, round
  assert.equal(hopCluster(v.order, key, 1), v.order[3])
  assert.equal(hopCluster(v.order, v.order[0], -1), v.order.at(-1))
  assert.equal(hopCluster(v.order, v.order.at(-1), 1), v.order[0])
  assert.equal(hopCluster(v.order, null, 1), v.order[0])
  assert.equal(hopCluster(v.order, null, -1), v.order.at(-1))
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
  const rs = graphView(data, { claim: 'c1' }, { w: 110, h: 34 }).body
  const at = rs.findIndex(r => rowText(r).trimStart().startsWith('▸ '))
  const said = rs.slice(at, at + 2).map(rowText)
  assert.match(said[0], /^ {7}▸ The keys \(v, s, \], 1, \{ \}\) need a reply .* returns null when there is no$/)
  assert.equal(said[1], '         reply yet.')
  // every line of it is bold in MARK and one press (pane.tsx draws the lines as one Button)
  assert.ok(rs.slice(at, at + 2).every(r => r.every(x => x.part === 'c:c1') && r.filter(x => x.s.trim()).every(x => x.bold && x.tone === MARK)))
  assert.equal(rowText(rs[at + 2]), '         no citations  turn 1')
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
  assert.match(body(shut), /\n {9}✓ 1 verified {2}× 1 failed {2}turn 1\n {7}– Note/)
  assert.doesNotMatch(body(shut), /print\(|│/)
  // e: the list goes, the claim stays with its evidence; the failed one comes first; ‹ i of n › under it, ‹ and › a
  // press that steps; the other clusters stay, one row each
  const v = graphView(d2, { claim: 'c1', open: true }, { w: 110, h: 34 })
  assert.match(body(v), /turn 1\n\n {9}When round #5 arrives, answer first {3}× failed · cite\n {9}The file says it once\.\n {9}revisions\.jsonl:412\n {9}│ summary: When round #5 arrives, answer first, then\n\n {9}‹ 1 of 2 ›\n[●◉○]+ group 2\n[●◉○]+ group 3\n[●◉○]+ group 4$/)
  assert.deepEqual(v.body.find(r => rowText(r).includes('‹')).filter(x => x.part && x.s.trim()).map(x => [x.s, x.part]), [['‹', 'cite-prev'], ['›', 'cite-next']])
  assert.doesNotMatch(body(v), /\?|wrong|problems first|Note/)
  assert.ok(repairable(v.shown))
  assert.ok(v.body.flat().some(x => x.tint && x.s === 'When round #5 arrives, answer first' && x.part === 'ev-1'))
  const second = graphView(d2, { claim: 'c1', open: true, cite: 1 }, { w: 110, h: 34 })
  assert.match(body(second), /turn 1\n\n {9}3,752 saves {3}✓ verified · cite\n {9}print\(f"\{n:,\} saves"\)\n {9}│ 3,752 saves labeled coordination\n {9}│ \+ 2 more lines\n\n {9}‹ 2 of 2 ›\n/)
  assert.doesNotMatch(body(second), /said in/)
  assert.ok(!repairable(second.shown))
  const runs = second.body.flat()
  assert.ok(runs.some(x => x.bold && x.tint && x.s === '3,752 saves' && x.part === 'ev-2'))
  assert.ok(runs.some(x => x.tint && x.s === '3,752 saves'))
  assert.ok(runs.some(x => x.tone === 'code' && x.s.startsWith('print(')))
  // the chips count every check; a citation the check corrected says what it was; a long output line is cut round the
  // cited words, a long code line in the middle, and c shows both whole
  // two outcomes: verified (a corrected value too) and failed, whoever failed it
  assert.equal(rowText(checkChips({ sources: [{ status: 'verified' }, { status: 'corrected' }, { status: 'failed', failedBy: 'check' }, { status: 'failed', failedBy: 'evidence' }, { status: 'checking' }] })), '✓ 2 verified  × 2 failed  … 1 checking')
  assert.match(rowText(citationRows({ label: '9', shown: '9', status: 'failed', failedBy: 'check', reason: 'Line 4 says 12.' }, 60)[0]), /× failed · cite$/)
  assert.equal(rowText(checkChips({ sources: [{ status: 'verified' }, { status: 'verified' }] })), '✓ 2 citations verified')
  // a check that did not run is failed, with its plain reason, whatever status it came with
  assert.equal(rowText(checkChips({ sources: [{ status: 'failed', failedBy: 'none' }, {}, { status: 'unchecked' }] })), '× 3 citations failed')
  // the failed ones first; one x checks again keeps its place among them while it runs and after
  assert.deepEqual(evidenceOf({ sources: [{ n: 1, status: 'verified' }, { n: 2, status: 'checking', repair: true }, { n: 3, status: 'failed' }, { n: 4, status: 'verified', repair: true }] }).map(s => s.n), [2, 3, 4, 1])
  assert.deepEqual(citationRows({ label: '9', shown: '9', status: 'failed', failedBy: 'none', reason: 'The check did not run. The reply was interrupted.' }, 60).map(rowText), ['9   × failed · cite', 'The check did not run.'])
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
  // a card's value: the card's title, then the header over the cited row, the cited cell tinted; never a file's place
  const table = { corner: 'run', cols: ['model', 'merged', 'backlog'], rows: [{ label: 'r1', values: ['opus', '143', '176'] }], at: { r: 0, c: 1 } }
  const ofCard = { kind: 'card', card: 'c1', title: 'Merges by run', ref: 'card:c1#merged/r1', value: '143', table }
  for (const whole of [false, true]) {
    const rows = cardOf({ label: '143', status: 'verified', evidence: ofCard }, 56, { whole }).rows
    assert.deepEqual(rows.map(rowText), ['143   ✓ verified · cite', 'card Merges by run', '│ run  model  merged  backlog', '│ r1    opus     143      176'])
    assert.ok(rows[1][0].tone === 'dim' && rows[1][1].bold)
    assert.ok(rows[3].some(x => x.tint && x.s === '143'))
  }
  // without a table: the card's value, or the line its code printed
  assert.deepEqual(citationRows({ label: '9', status: 'verified', evidence: { kind: 'card', card: 'c2', title: 'Counts', value: '9 runs' } }, 40).map(rowText), ['9   ✓ verified · cite', 'card Counts', '│ 9 runs'])
  assert.deepEqual(citationRows({ label: '9', status: 'verified', evidence: { kind: 'card', card: 'c2', title: 'Counts', value: '9', output: 'runs\n9 runs\n', highlight: [[5, 6]] } }, 40).map(rowText), ['9   ✓ verified · cite', 'card Counts', '│ 9 runs'])
  assert.doesNotMatch(JSON.stringify(cardOf({ label: '9', status: 'verified', evidence: ofCard }, 40, { whole: true }).rows), /undefined/)
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
  assert.match(body(shut), /\n {4}▸ All of the admin's deletions came after the edits stopped, from\n {6}June 23 to July 14\.\n {6}no citations {2}corrected ×2 {2}turn 3$/)
  // a corrected claim's dot is hollow
  assert.match(rowText(shut.body[0]), /^○○● cleanup$/)
  assert.ok(shut.body.flat().some(x => x.s === 'corrected ×2' && x.tone === 'cite'))
  assert.equal(shut.fixes, 2)
  const open = graphView(data, { claim: 'c3', open: true }, { w: 70, h: 40 })
  const p = body(open)
  assert.match(p, /turn 3\n\n {6}History\n {6}turn 1 → turn 2\n {6}The deletions began Most of the admin's deletions came after the\n {6}edits stopped, from June 23 to July 14\.\n {6}reason: 444 of the 5,217 deletions came before June 23\.\n\n {6}turn 2 → turn 3\n {6}Most All of the admin's deletions came after the edits stopped,\n {6}from June 23 to July 14\.\n {6}reason: none came before\.$/)
  // deleted words red and struck through, inserted green; a full stop alike stays plain
  const runs = open.body.flat()
  assert.ok(runs.some(x => x.s === 'The' && x.tone === 'del') && runs.some(x => x.s === 'deletions' && x.tone === 'del'))
  assert.ok(runs.some(x => x.s === 'Most' && x.tone === 'ins') && runs.some(x => x.s === 'All' && x.tone === 'ins'))
  assert.ok(runs.some(x => x.s === 'June' && !x.tone))
  // a press on a correction's turns picks the other version
  assert.ok(open.body.some(r => r.some(x => x.part === 'was-c2')))
  // when most words change, the old sentence and the new show whole, struck through and green
  assert.equal(wordDiff('The bot farm was run by one company.', 'The records do not show who ran the agents; 738 of the 3,102 names mention OpenAI.'), null)
  const all = historyRows([{ from: 'turn 2', to: 'turn 3', old: 'The bot farm was run by one company.', now: 'The records do not show who ran the agents.', why: 'no record names an operator.', part: null }], 60)
  assert.deepEqual(all.map(rowText), ['History', 'turn 2 → turn 3', 'The bot farm was run by one company.', 'The records do not show who ran the agents.', 'reason: no record names an operator.'])
  assert.deepEqual(all.slice(2, 4).map(r => r[0].tone), ['del', 'ins'])
  // a claim whose citation the check corrected: the words before the check and the check's reason
  const own = { id: 'c9', text: 'x', turn: 4, sources: [{ label: '12', status: 'corrected', was: '15', reason: 'agent-07 merged 12, not 15' }] }
  assert.deepEqual(correctionsOf(own, new Map()), [{ from: 'turn 4', to: 'the check', old: '15', now: '12', why: 'agent-07 merged 12, not 15.', part: null }])
})

test('five corrections: the newest two, newest first, and how many earlier; h shows all of them, oldest first; a short pane keeps the head of the evidence', () => {
  const data = corrected(5)
  const v = graphView(data, { claim: 'c6', open: true }, { w: 66, h: 50 })
  assert.equal(v.fixes, 5)
  const p = body(v)
  assert.match(p, /corrected ×5/)
  assert.match(p, /History\n {9}turn 5 → turn 6\n {9}Most of the admin's deletions came after the edits\n {9}stopped, from June 23 to July 13 12\.\n {9}reason: the last deletion is on July 12\.\n\n {9}turn 4 → turn 5\n(.*\n)+ {9}\+ 3 earlier corrections$/)
  // a pane too short for it: the head of the evidence and how many rows more, so the pane does not scroll
  const short = graphView(data, { claim: 'c6', open: true }, { w: 66, h: 16 })
  assert.ok(rows(short).length + KEYS <= 16, `${rows(short).length}`)
  assert.match(rowText(short.body.at(-1)), /^ {9}… \d+ more rows$/)
  assert.ok(short.cut)
  const all = body(graphView(data, { claim: 'c6', open: true, all: true }, { w: 66, h: 50 }))
  assert.deepEqual([...all.matchAll(/turn (\d) → turn (\d)/g)].map(m => m[1]), ['1', '2', '3', '4', '5'])
  assert.doesNotMatch(all, /earlier corrections/)
})

test("a cluster's name: whole in an open row, wrapped under its first letter, a press on any of its lines chooses the cluster; cut after a word in a folded row", () => {
  const st = emptyStore('s')
  const long = 'How the wiki admin cleaned up after the agents left the wiki for good'
  const text = Array.from({ length: 12 }, (_, i) => `Note ${i + 1} is a fact about item ${i + 1}.`).join(' ')
  applyTurn(st, { turn: 1, places: [{ row: 'a1', by: 'claude', turn: 1, text }], out: { claims: Array.from({ length: 12 }, (_, i) => ({ quote: `Note ${i + 1} is a fact about item ${i + 1}`, cluster: i % 4 ? `topic ${i % 4}` : long })) } })
  const data = paneData(st)
  // every row open (all fit): the name whole over two lines, the second under the first's first letter
  const v = graphView(data, {}, { w: 50, h: 40 })
  assert.ok(v.every)
  const lines = v.body.filter(r => r.some(x => x.part === 'g:k1' && x.s.trim()))
  assert.ok(lines.length >= 2, lines.map(rowText).join(' | '))
  assert.equal(lines.map(r => rowText(r).trim().replace(/^[●◉○]+ /, '')).join(' '), long)
  assert.ok(lines.slice(1).every(r => nameAt(r) === nameAt(lines[0])))
  assert.ok(lines.slice(1).every(r => r.every(x => x.part === 'g:k1')))
  // folded (a short pane): one line, cut after a whole word in …
  const f = graphView(data, {}, { w: 50, h: 14 })
  assert.ok(!f.every)
  const one = rowText(rowOf(f, 'k1')).replace(/^ *[●◉○]+ /, '')
  assert.match(one, / …$/)
  assert.ok(long.startsWith(one.slice(0, -2) + ' '), one)
  assert.ok(rowText(rowOf(f, 'k1')).length <= 50)
})

test('a long claim takes two lines in the list, then …; picked, it shows whole', () => {
  const st = emptyStore('s')
  const long = "About 9 requests carry script-injection (XSS) probes against the wiki software; two of them try to show the browser's cookies"
  applyTurn(st, { turn: 1, places: [{ row: 'a1', by: 'claude', turn: 1, text: `${long}. A short one.` }], out: { claims: [{ quote: long, cluster: 'risky' }, { quote: 'A short one', cluster: 'risky' }] } })
  const data = paneData(st)
  const listed = body(graphView(data, { claim: 'c2' }, { w: 62, h: 50 }))
  assert.match(listed, /\n {3}– About 9 requests carry script-injection \(XSS\) probes\n {5}against the wiki software; two of them try to show the …\n/)
  const picked = body(graphView(data, { claim: 'c1' }, { w: 62, h: 50 }))
  assert.match(picked, /cookies\.\n/)
})

/** A session of clusters of these sizes, each named in its own turn when `turns`, else all in turn 1; a cluster's
 *  claims `Fact g-i holds`. */
function sized(sizes, { turns = false, names = g => `topic ${g}` } = {}) {
  const st = emptyStore('s')
  const qs = sizes.flatMap((n, g) => Array.from({ length: n }, (_, i) => ({ g, quote: `Fact ${g}-${i} holds`, cluster: names(g) })))
  for (const [turn, part] of turns ? sizes.map((_, g) => [g + 1, qs.filter(q => q.g === g)]) : [[1, qs]]) {
    applyTurn(st, { turn, places: [{ row: `a${turn}`, by: 'claude', turn, text: part.map(q => `${q.quote}.`).join(' ') }], out: { claims: part.map(({ quote, cluster }) => ({ quote, cluster })) } })
  }
  return paneData(st)
}

test('2, 6, 20 and 30 clusters, sparse ones and a giant: each cluster keeps its row and its name, the head counts them all, and the pane never scrolls, whatever is chosen', () => {
  const cases = {
    two: [6, 5], six: [9, 8, 7, 6, 5, 4], twenty: [5, 5, 5, 4, 8, 9, 4, 4, 2, 6, 5, 4, 7, 5, 6, 1, 5, 4, 9, 5],
    thirty: Array.from({ length: 30 }, (_, i) => 1 + (i * 7) % 6), sparse: [6, 1, 1, 1, 1, 3, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 1, 4],
    giant: [49, 4, 4, 4, 5, 5],
  }
  for (const [name, sizes] of Object.entries(cases)) {
    const data = sized(sizes, { turns: true })
    const total = sizes.reduce((a, b) => a + b, 0)
    for (const [w, h] of [[74, 42], [62, 30], [110, 34], [44, 26]]) {
      const keys = data.groups.map(g => String(g.id))
      const last = data.claims.at(-1).id
      for (const st of [{}, { group: keys[0] }, { group: keys.at(-1) }, { group: keys[Math.floor(keys.length / 2)] }, { claim: last }, { claim: last, open: true }]) {
        const v = graphView(data, st, { w, h })
        const at = `${name} ${w}×${h} ${JSON.stringify(st)}`
        assert.equal(rowText(v.head[0]), `Claims · ${total}${w < 48 ? '' : ' claims'}${sizes.length > 1 ? ` · ${sizes.length} clusters` : ''}`, at)
        // the keys of an open evidence take two rows below 110 columns
        assert.ok(rows(v).length + KEYS + (st.open && w < 110 ? 1 : 0) <= h, `${at}: ${rows(v).length} rows`)
        assert.ok(v.body.every(r => rowText(r).length <= w), at)
        // every cluster: its row, or counted in a fold that chooses the next one
        const shown = keys.filter(k => rowOf(v, k))
        const folded = v.body.map(rowText).map(l => /([↑↓]) (\d+) more clusters?$/.exec(l)).filter(Boolean)
        assert.equal(shown.length + folded.reduce((a, m) => a + Number(m[2]), 0), keys.length, at)
        assert.deepEqual(shown, keys.filter(k => shown.includes(k)), at)
        if (st.group) assert.ok(rowOf(v, st.group), at)
        if (st.claim) assert.ok(v.body.some(r => r.some(x => x.part === `c:${st.claim}`)), at)
        assert.deepEqual(v.order, keys)
      }
    }
  }
  // a giant: its count before its newest dots; the others' dots line up beside it
  const g = graphView(sized(cases.giant, { turns: true }), {}, { w: 74, h: 42 })
  assert.equal(rowText(g.body[0]), '49 ●●●●●●●●●●● topic 0')
  assert.ok(g.body.filter(r => r.length).every(r => nameAt(r) === 15))
  // a blank row between turns while they fit; none when the rows need the room
  assert.equal(g.body.filter(r => !r.length).length, 5)
  const tight = graphView(sized(cases.twenty, { turns: true }), {}, { w: 74, h: 30 })
  assert.equal(tight.body.filter(r => !r.length).length, 0)
  assert.equal(tight.body.length, 20)
  // two small clusters: every row open, a blank row between them
  const two = graphView(sized(cases.two), {}, { w: 74, h: 42 })
  assert.ok(two.every)
  assert.equal(body(two), ['●●●●●● topic 0', ...Array.from({ length: 6 }, (_, i) => `       – Fact 0-${i} holds.`), '',
    ' ●●●●● topic 1', ...Array.from({ length: 5 }, (_, i) => `       – Fact 1-${i} holds.`)].join('\n'))
})

test('rows that do not fit fold to ↑ N more clusters and ↓ N more clusters round the open one, a few above it; a press on a fold chooses the next cluster', () => {
  const data = sized(Array.from({ length: 30 }, () => 3), { turns: true })
  const keys = data.groups.map(g => String(g.id))
  // at rest: from the top, the rest under one fold
  const rest = graphView(data, {}, { w: 74, h: 24 })
  const down = rest.body.at(-1)
  assert.match(rowText(down), /^ {4}↓ \d+ more clusters$/)
  const firstHidden = keys.find(k => !rowOf(rest, k))
  assert.equal(down.find(x => x.part).part, `g:${firstHidden}`)
  assert.equal(rowText(rest.body[0]).trim(), '●●● topic 0')
  // a cluster chosen in the middle: up to three rows above it, its claims, the rest under it
  const mid = graphView(data, { group: keys[15] }, { w: 74, h: 24 })
  const up = mid.body[0]
  assert.match(rowText(up), /^ {4}↑ 12 more clusters$/)
  assert.equal(up.find(x => x.part).part, `g:${keys[11]}`)
  const at = mid.body.indexOf(rowOf(mid, keys[15]))
  assert.equal(at, 4)
  assert.match(rowText(mid.body.at(-1)), /^ {4}↓ \d+ more clusters$/)
  assert.ok(mid.body.slice(at + 1, at + 4).every(r => /– Fact 15-/.test(rowText(r))))
  // the last cluster: the rows above it only
  const end = graphView(data, { group: keys.at(-1) }, { w: 74, h: 24 })
  assert.doesNotMatch(body(end), /↓/)
  assert.match(rowText(end.body[0]), /↑ \d+ more clusters/)
  assert.equal(rowText(end.body.at(-1)), '    – Fact 29-2 holds.')
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
  applyTurn(st, { turn: 1, places: [{ row: 'a1', by: 'claude', turn: 1, text: qs.map(q => `${q.quote}.`).join(' ') }], out: { claims: qs } })
  return st
}

test('p n walk the clusters top to bottom as drawn; nothing chosen, n the first and p the last', () => {
  const data = paneData(eleven())
  for (const w of [44, 70, 110]) {
    const v = graphView(data, {}, { w, h: 70 })
    const drawn = v.body.filter(r => r.some(x => /^g:/.test(x.part || '') && x.s.trim())).map(r => r.find(x => /^g:/.test(x.part || '')).part.slice(2))
    assert.deepEqual(v.order, drawn)
    assert.equal(drawn.length, 11)
    let k = null
    const walked = []
    for (let i = 0; i < 11; i++) { k = hopCluster(v.order, k, 1); walked.push(k) }
    assert.deepEqual(walked, drawn)
    assert.equal(hopCluster(v.order, null, -1), drawn.at(-1))
  }
})

test('a cluster name is never cut in a word: a folded row ends it after a word in …, the open row shows it whole', () => {
  const st = eleven()
  assert.ok(ELEVEN.every(n => st.clusters.some(c => c.name === n)))
  const data = paneData(st)
  for (const w of [44, 70]) {
    const v = graphView(data, {}, { w, h: 40 })
    for (const g of data.groups) {
      const shown = rowText(rowOf(v, g.id)).replace(/^ *(\d+ )?[●◉○]+ /, '')
      if (shown === g.name) continue
      assert.match(shown, / …$/, shown)
      assert.ok(g.name.startsWith(shown.slice(0, -2) + ' '), shown)
    }
  }
  const late = data.groups.find(g => g.name.startsWith('When the agents')).id
  const chosen = graphView(data, { group: late }, { w: 50, h: 70 })
  const head = chosen.body.filter(r => r.some(x => x.part === `g:${late}` && x.s.trim())).map(r => rowText(r).replace(/^ *(\d+ )?[●◉○]* /, '').trim())
  assert.equal(head.join(' '), 'When the agents were busiest and whether activity dropped late in the runs')
  // a name too long for the store is cut after a word
  const big = emptyStore('s')
  applyTurn(big, { turn: 1, places: [{ row: 'a1', by: 'claude', turn: 1, text: 'One fact holds.' }], out: { claims: [{ quote: 'One fact holds', cluster: 'word '.repeat(60) }] } })
  assert.match(big.clusters[0].name, /^(word )+…$/)
  assert.ok(big.clusters[0].name.length <= 160)
})

test('a store of v 1 cut cluster names at 60 characters: read, such a name ends after its last whole word in …', () => {
  const cut60 = 'When the agents were busiest and whether activity dropped la'
  assert.equal(cut60.length, 60)
  const old = readStore({ v: 1, claims: [{ id: 'c1', text: 'A fact.', by: 'claude', cluster: 'k1' }, { id: 'c2', text: 'Another.', by: 'claude', cluster: 'k2' }],
    clusters: [{ id: 'k1', name: cut60, turn: 1, named: 1 }, { id: 'k2', name: 'Why PRs were closed without merging', turn: 1, named: 1 }] }, 's')
  assert.deepEqual(old.clusters.map(c => c.name), ['When the agents were busiest and whether activity dropped …', 'Why PRs were closed without merging'])
  assert.equal(old.v, 2)
  // the open row wraps it with its … on the line of the word before
  const lines = graphView(paneData(old), { group: 'k1' }, { w: 50, h: 40 }).body.map(rowText)
  assert.ok(lines.some(l => /whether$/.test(l)) && lines.some(l => /^ {2}activity dropped …$/.test(l)), lines.join('\n'))
  // a store of v 2 keeps a name of 60 characters as it is
  assert.equal(readStore({ v: 2, claims: [], clusters: [{ id: 'k1', name: cut60 }] }, 's').clusters[0].name, cut60)
})

test('a long list pages by a screen: a press on ↑ N earlier or ↓ N more', () => {
  const st = emptyStore('s')
  const qs = Array.from({ length: 80 }, (_, i) => ({ quote: `Run ${i + 1} copied an answer`, cluster: i < 78 ? 'copying' : 'other' }))
  applyTurn(st, { turn: 1, places: [{ row: 'a1', by: 'claude', turn: 1, text: qs.map(q => `${q.quote}.`).join(' ') }], out: { claims: qs } })
  const data = paneData(st)
  const key = String(data.groups[0].id)
  const first = graphView(data, { group: key }, { w: 62, h: 40 })
  assert.ok(first.windowed)
  const down = first.body.find(r => /↓ \d+ more ·/.test(rowText(r)))
  assert.match(rowText(down), /^ {15}↓ \d+ more · claims 1–(\d+) of 78$/)
  const next = Number(down[0].part.slice(3))
  assert.equal(down[0].part, `pg:${next}`)
  assert.ok(rows(first).length + KEYS <= 40)
  // the other cluster's row stays under it
  assert.ok(rowOf(first, data.groups[1].id))
  const second = graphView(data, { group: key, from: next }, { w: 62, h: 40 })
  const up = second.body.find(r => rowText(r).includes('↑'))
  assert.equal(rowText(up), `${' '.repeat(15)}↑ ${next} earlier`)
  assert.equal(up[0].part, 'pg:0')
  assert.ok(second.body.some(r => rowText(r) === `${' '.repeat(15)}– Run ${next + 1} copied an answer.`))
  // the last screen ends with the last claim
  const last = graphView(data, { group: key, from: 77 }, { w: 62, h: 40 })
  const end = last.body.find(r => /claims \d+–78 of 78$/.test(rowText(r)))
  assert.ok(end && !end[0].part)
})

test('a narrow pane: a column of eight dots at most, its rows in its width', () => {
  const data = paneData(uneven())
  const key = String(data.groups[2].id)
  const v = graphView(data, { group: key }, { w: 44, h: 50 })
  assert.ok(v.narrow)
  assert.equal(rowText(v.head[0]), 'Claims · 155 · 7 clusters')
  assert.ok(v.body.every(r => rowText(r).length <= 44))
  assert.ok(v.body.filter(r => r.some(x => /^g:/.test(x.part || '') && x.s.trim())).every(r => nameAt(r) === 9))
  assert.ok(rowOf(v, key).some(x => x.bold && x.part === `g:${key}`))
})

test('new claims while browsing: the selection stays, the new dots are ◆, the new claims bold, and +N new shows for a moment', () => {
  const st = emptyStore('s')
  const first = 'ABCDEFGHIJKLMNOPQRSTU'.split('').map((l, i) => ({ quote: `${l} is ${i + 1}`, cluster: i % 2 ? 'y' : 'x' }))
  applyTurn(st, { turn: 1, places: [{ row: 'a1', by: 'claude', turn: 1, text: first.map(q => `${q.quote}.`).join(' ') }], out: { claims: first } })
  const before = paneData(st)
  applyTurn(st, { turn: 2, places: [{ row: 'a2', by: 'claude', turn: 2, text: 'V is 22. W is 23.' }], out: { claims: [{ quote: 'V is 22', cluster: 'k1' }, { quote: 'W is 23', cluster: 'k2' }] } })
  const data = paneData(st)
  const v = graphView(data, { claim: 'c1', at: before.last }, { w: 62, h: 20, bright: true })
  assert.equal(v.claim.id, 'c1')
  assert.match(rowText(v.head[0]), /^Claims · 23 claims · 2 clusters {2}\+2 new$/)
  const fresh = v.body.flat().filter(x => x.s === '◆')
  assert.deepEqual(fresh.map(x => x.part).sort(), ['d:c22', 'd:c23'])
  assert.ok(fresh.every(x => x.bold && x.tone === MARK))
  // folded or open, a new claim in a list is bold
  const all = graphView(data, { at: before.last }, { w: 62, h: 60 })
  assert.ok(all.every && all.body.some(r => rowText(r).endsWith('– V is 22.') && r.slice(-2).every(x => x.bold)))
  assert.doesNotMatch(rowText(graphView(data, { claim: 'c1', at: before.last }, { w: 62, h: 40 }).head[0]), /new/)
  assert.ok(!graphView(data, { claim: 'c1', at: data.last }, { w: 62, h: 40 }).body.flat().some(x => x.s === '◆'))
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

test('when every cluster and its claims fit, every row is open, with the picking, chips and evidence of an open row', () => {
  const data = sixClaims()
  const rest = graphView(data, {}, { w: 70, h: 36 })
  assert.ok(rest.every)
  assert.equal([...rest.head, [], ...rest.body].map(rowText).join('\n'), [
    'Claims · 6 claims · 2 clusters', '',
    '●●●● posts', '     – Most posts are status updates: 37 of 60 sampled.', '     – Review requests come second: 16 of 60.',
    '     – Claiming work is rare: 4 of 60.', '     – Asking for help is rare: 2 of 60.', '',
    '  ●● data', '     – The label post_kind sorts every post.', '     – 9,921 posts across 16 runs.',
  ].join('\n'))
  // at rest nothing is chosen: each name a press on its cluster, each claim on itself, none dim
  assert.equal(rest.chosen, false)
  assert.ok(rest.body.filter(r => r.some(x => /^n:/.test(x.part || ''))).every(r => /^n:c\d$/.test(r[0].part) && !r.at(-1).tone))
  // a cluster chosen: its name and dots bold, the other cluster's claims dim
  const key = String(data.groups[1].id)
  const g = graphView(data, { group: key }, { w: 70, h: 36 })
  assert.ok(g.every && g.chosen && g.group === key)
  assert.ok(rowOf(g, key).filter(x => x.s.trim()).every(x => x.bold))
  assert.ok(g.body.some(r => rowText(r).endsWith('– 9,921 posts across 16 runs.') && !r.at(-1).tone))
  assert.ok(g.body.some(r => rowText(r).endsWith('– Claiming work is rare: 4 of 60.') && r.at(-1).tone === 'dim'))
  // a claim picked: ▸ bold in MARK, its chips under it, every other claim dim
  const c = graphView(data, { claim: 'c2' }, { w: 70, h: 36 })
  assert.match(body(c), /\n {5}▸ Review requests come second: 16 of 60\.\n {7}× 1 citation failed {2}turn 1\n {5}– Claiming/)
  assert.ok(c.body.find(r => rowText(r).includes('▸')).every(x => x.part === 'c:c2'))
  assert.ok(c.body.filter(r => rowText(r).includes(' – ')).every(r => r.at(-1).tone === 'dim'))
  assert.equal(c.cites, 1)
  // e: its cluster's name and the claim stay, its evidence under it; the other cluster folds to its row
  const open = graphView(data, { claim: 'c2', open: true }, { w: 70, h: 36 })
  assert.ok(!open.every)
  assert.match(body(open), /^●●●● posts\n {5}▸ Review requests come second: 16 of 60\.\n {7}× 1 citation failed {2}turn 1\n\n {7}16 of 60 {3}× failed · cite\n/)
  assert.match(body(open), /\n {2}●● data$/)
  assert.doesNotMatch(body(open), /Claiming|9,921/)
  // a narrow pane opens them too, each row in its width
  const narrow = graphView(data, { claim: 'c1' }, { w: 40, h: 36 })
  assert.ok(narrow.every && narrow.body.every(r => rowText(r).length <= 40))
})

test('no lines join the claims, however they are linked', () => {
  const data = linkedClaims()
  assert.ok(data.edges.length > 10)
  for (const st of [{}, { claim: 'c9' }, { claim: 'c14' }, { group: String(data.groups[0].id) }]) {
    assert.doesNotMatch(body(graphView(data, st, { w: 110, h: 34 })), /[─│╭╮╰╯├┤┬┴┼]/, JSON.stringify(st))
  }
})

test('with no claims the pane says so in its head', () => {
  const none = graphView(paneData(emptyStore('s')), {}, { w: 90, h: 30 })
  assert.deepEqual(none.head.map(rowText), ['Claims · no claims yet'])
  assert.deepEqual(none.body, [])
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
