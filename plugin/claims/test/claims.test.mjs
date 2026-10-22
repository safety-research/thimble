// Claims (claims/store.js, graph.js, lens.mjs): the lens's claims as the observer's reply gives them, placed by their
// words with the citations near them, and the Claims pane as graph.js lays it out, whose count stays
// on screen however many claims a session has. Made-up data only.
//   node --test plugin/claims/test/
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseAnswer } from '../../observer/reply.mjs'
import { citationRows, correctionsOf, graphView, hopCluster, paneData, rowText, snippetOf } from '../graph.js'
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
    assert.match(panel(rest), /^─+\n● group 3 {2}\d+ claims · turns 1–5\n {2}. Wiki /)
    const cols = tu.split('\n').slice(2).flatMap(l => [...l].map((ch, x) => (/[●◉○]/.test(ch) ? x : -1)).filter(x => x >= 0))
    assert.ok(Math.min(...cols) < 136 * 0.15 && Math.max(...cols) > 136 * 0.85, `${h}: dots from ${Math.min(...cols)} to ${Math.max(...cols)}`)
    const sel = graphView(data, { claim: 'c40' }, { w: 136, h })
    assert.equal(sel.claim.id, 'c40')
    // a claim: its cluster's name (a press selects the cluster), its whole sentence with its turn, no other claim, and
    // its citation with its check
    const p = panel(sel)
    assert.match(p, /^─+\n● group 5\nWiki 40 had 50 saves\. {2}turn 2\n\n· 50 saves {2}not checked$/)
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
  assert.match(p, new RegExp(`^─+\\n● ${data.groups[2].name} {2}\\d+ claims`))
  assert.doesNotMatch(p, /▸|verified|not checked|cites/)
  const subs = v.panel.slice(2).filter(r => r.some(x => /^n:/.test(x.part || '')))
  assert.ok(subs.length >= 3)
  // its name is a press on the cluster, bold in its color; every other name faint; its dots are bold and lit, every
  // other dot faint and plain
  assert.ok(v.graph.some(r => r.some(x => x.part === `g:${key}` && x.s.includes(data.groups[2].name) && x.bold && x.tone === 'c3')))
  const names = v.graph.flatMap(r => r.filter(x => /^g:/.test(x.part || '') && x.s.trim()))
  for (const nm of names) assert.equal(/-faint$/.test(nm.tone), nm.part !== `g:${key}`, nm.s)
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

test("a claim selected shows all of it: its whole sentence, braces and all, no word cut, and each citation with its check and evidence", () => {
  const data = linkedClaims()
  const rows = graphView(data, { claim: 'c1' }, { w: 110, h: 34 }).panel
  const said = rows.slice(2, rows.findIndex((r, i) => i > 2 && !r.length)).map(r => rowText(r).trim()).join(' ')
  assert.match(said, /^The keys \(v, s, \], 1, \{ \}\) need a reply .* returns null when there is no reply yet\.\s+turn 1$/)
  assert.doesNotMatch(said, /…/)
  // computed evidence: the code line that printed the value, then the output line after │, the cited words tinted,
  // and how many output lines more; a file's: its place, then the line. A press on a citation opens its evidence
  const computed = { kind: 'computed', code: 'n = len(saves)\nprint(f"{n:,} saves")', output: '3,752 saves labeled coordination\n2 runs\n0 errors\n', highlight: [[0, 11]] }
  const quote = { kind: 'quote', file: 'revisions.jsonl', line: 412, lines: [{ n: 411, text: 'before' }, { n: 412, text: 'summary: When round #5 arrives, answer first, then', highlight: [9, 44] }] }
  const c = { ...data.claims[0], sources: [
    { ref: 'a1@3', row: 'a1', at: 3, n: 2, label: '3,752 saves', status: 'verified', evidence: computed },
    { ref: 'a1@9', row: 'a1', at: 9, n: 3, label: 'When round #5 arrives, answer first', status: 'failed', failedBy: 'evidence', reason: 'The file says it once. More words.', evidence: quote },
  ] }
  const v = graphView({ ...data, claims: [c, ...data.claims.slice(1)] }, { claim: 'c1' }, { w: 110, h: 34 })
  assert.match(panel(v), /\n\n✓ 3,752 saves\n {2}print\(f"\{n:,\} saves"\)\n {2}│ 3,752 saves labeled coordination {2}\+ 2 more lines\n\? When round #5 arrives, answer first {2}not confirmed\n {2}The file says it once\.\n {2}revisions\.jsonl:412\n {2}│ summary: When round #5 arrives, answer first, then$/)
  const runs = v.panel.flat()
  assert.ok(runs.some(x => x.underline && x.s === '3,752 saves' && x.part === 'ev-1'))
  assert.ok(runs.some(x => x.tint && x.s === '3,752 saves'))
  assert.ok(runs.some(x => x.tint && x.s === 'When round #5 arrives, answer first' && x.part === 'ev-2'))
  assert.ok(runs.some(x => x.tone === 'code' && x.s.startsWith('print(')))
  // a citation the check corrected says what it was; a long output line is cut round the cited words
  const was = citationRows({ label: '12', shown: '12', was: '15', status: 'corrected', evidence: computed }, 60).map(rowText)
  assert.deepEqual(was.slice(0, 2), ['✓ 12', '  was 15'])
  const long = snippetOf({ kind: 'computed', code: 'print(x)', output: `${'a'.repeat(80)} 42 ${'b'.repeat(80)}`, highlight: [[81, 83]] }, 30)
  assert.ok(long.text.length <= 30 && long.text.slice(long.spans[0][0], long.spans[0][1]) === '42')
})

test('a corrected claim says what it said before and why, from the claims look or else the check; the claim it corrected says what came later', () => {
  const st = emptyStore('s')
  applyTurn(st, { turn: 1, places: [{ row: 'a1', by: 'claude', turn: 1, text: 'The deletions began [June 23](#).' }], out: { claims: [{ claim: 'The deletions began June 23.', quote: 'The deletions began June 23', cluster: 'cleanup' }] } })
  applyTurn(st, { turn: 2, places: [{ row: 'a2', by: 'claude', turn: 2, text: 'The deletions came from June 23 to July 14, after the edits stopped.' }],
    out: { claims: [{ claim: "The admin's deletions came after the edits stopped, from June 23 to July 14.", quote: 'The deletions came from June 23 to July 14', revises: 'c1', why: '444 of the 5,217 deletions came before June 23, the first on June 4' }] } })
  const data = paneData(st)
  const fixed = panel(graphView(data, { claim: 'c2' }, { w: 70, h: 34 }))
  assert.match(fixed, /^─+\n● cleanup\nThe admin's deletions came after the edits stopped, from June 23 to\nJuly 14\. {2}turn 2\n\nCorrected\. Before: "The deletions began June 23"\.\nWhy: 444 of the 5,217 deletions came before June 23, the first on June\n4\.\n\nIt cites nothing\.$/)
  // a press on the earlier words selects the earlier claim, which says what came later and why
  assert.ok(graphView(data, { claim: 'c2' }, { w: 70, h: 34 }).panel.some(r => r.some(x => x.part === 'was-c1')))
  assert.match(panel(graphView(data, { claim: 'c1' }, { w: 70, h: 34 })), /\nCorrected later: "The admin's deletions came after .*\n.*\nWhy: 444 of /)
  // with no reason from the look, the reason of the check that failed the earlier claim's citation stands for it
  const byId = new Map(data.claims.map(c => [c.id, c]))
  delete byId.get('c2').why
  byId.get('c1').sources = [{ label: 'June 23', status: 'failed', reason: 'the first deletion was on June 4' }]
  assert.deepEqual(correctionsOf(byId.get('c2'), byId).map(x => x.why), ['The first deletion was on June 4.'])
  // a claim whose citation the check corrected: the words before and the check's reason
  const own = { id: 'c9', text: 'x', sources: [{ label: '12', status: 'corrected', was: '15', reason: 'agent-07 merged 12, not 15' }] }
  assert.deepEqual(correctionsOf(own, byId), [{ head: 'Corrected. Before: "15".', why: 'Agent-07 merged 12, not 15.', part: null }])
})

test("a long cluster name wraps under its cluster's dots in full, and a press on any of its lines selects the cluster", () => {
  const st = emptyStore('s')
  const long = 'How the wiki admin cleaned up after the agents left'
  const text = Array.from({ length: 8 }, (_, i) => `Note ${i + 1} is a fact about item ${i + 1}.`).join(' ')
  applyTurn(st, { turn: 1, places: [{ row: 'a1', by: 'claude', turn: 1, text }], out: { claims: Array.from({ length: 8 }, (_, i) => ({ quote: `Note ${i + 1} is a fact about item ${i + 1}`, cluster: i % 4 ? `topic ${i % 4}` : long })) } })
  const v = graphView(paneData(st), {}, { w: 60, h: 30 })
  const lines = v.graph.map(r => r.filter(x => x.part === 'g:k1').map(x => x.s).join('').trim()).filter(Boolean)
  assert.ok(lines.length >= 2, lines.join(' | '))
  assert.equal(lines.join(' '), long)
  // the name stands under its dots: every dot of the cluster on a row above the name's first
  const top = v.graph.findIndex(r => r.some(x => x.part === 'g:k1' && x.s.trim()))
  const dotRows = v.graph.map((r, y) => (r.some(x => /^d:/.test(x.part || '') && /[●◉○]/.test(x.s) && ['c1', 'c5'].includes(x.part.slice(2))) ? y : -1)).filter(y => y >= 0)
  assert.ok(dotRows.every(y => y < top), `${dotRows} above ${top}`)
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
