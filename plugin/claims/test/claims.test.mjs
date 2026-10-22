// Claims (claims/store.js, graph.js, lens.mjs): the lens's claims as the observer's reply gives them, placed by their
// words with the citations near them, the folder's map, and the Claims pane as graph.js lays it out, whose count stays
// on screen however many claims a session has. Made-up data only.
//   node --test plugin/claims/test/
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseAnswer } from '../../observer/reply.mjs'
import { boxAt, graphView, paneData, rowText, sourceView } from '../graph.js'
import lens from '../lens.mjs'
import { applyTurn, edgesOf, emptyStore, mergeFolder, parseClaims, promptLines, viewOf } from '../store.js'

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

test("the folder's map joins the claims, each with its evidence as sources, and a fixed map replaces its claims", () => {
  const st = emptyStore('s')
  const map = { scope: { unit: 'runs', n: 4, what: 'every run' }, clusters: [{ id: 'tz', name: 'timezone detour' }],
    claims: [{ id: 'a', name: 'Agents blame a timezone bug', cluster: 'tz', n: 3, of: 4, evidence: [{ ref: 'runs/r1.jsonl#L12', quote: 'a timezone mismatch' }] },
      { id: 'b', name: 'The cart fixture is shared', cluster: 'tz', evidence: [{ ref: 'runs/r2.jsonl#L7', quote: 'scope=module' }] }],
    relations: [{ from: 'b', to: 'a', type: 'contradicts' }] }
  const res = mergeFolder(st, map, { at: 't' })
  assert.deepEqual(res.added, ['c1', 'c2'])
  assert.deepEqual(st.claims[0].sources, [{ ref: 'runs/r1.jsonl#L12', label: 'r1.jsonl:12', quote: 'a timezone mismatch' }])
  assert.deepEqual(st.claims[1].links, [{ to: 'c1', how: 'contradicts', folder: true }])
  assert.equal(st.folder.claims, 2)
  const again = mergeFolder(st, { ...map, claims: map.claims.slice(0, 1) }, { at: 't2' })
  assert.deepEqual(again.dropped, ['c2'])
  // where a claim of the map was said: its evidence's quotes
  const said = sourceView({ ...st.claims[0], said: st.claims[0].said }, null).map(rowText).join('\n')
  assert.match(said, /the folder's map[\s\S]*“a timezone mismatch” r1\.jsonl:12/)
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

test('the claims graph uses the whole pane, and a claim selected opens a framed box over it that hides no dot it needs', () => {
  const data = paneData(uneven())
  for (const h of [46, 40, 34]) {
    const rest = graphView(data, {}, { w: 136, h })
    const tu = text(rest)
    assert.match(tu, /^Claims {3}155 · 7 clusters/)
    assert.ok(tu.split('\n').length <= h, `${h}: ${tu.split('\n').length} rows`)
    assert.equal(rest.claim.id, 'c155')
    assert.doesNotMatch(tu, /╭─{20,}╮/)
    const cols = tu.split('\n').slice(2).flatMap(l => [...l].map((ch, x) => (/[●◉○]/.test(ch) ? x : -1)).filter(x => x >= 0))
    assert.ok(Math.min(...cols) < 136 * 0.15 && Math.max(...cols) > 136 * 0.85, `${h}: dots from ${Math.min(...cols)} to ${Math.max(...cols)}`)
    const sel = graphView(data, { claim: 'c40' }, { w: 136, h })
    const ts = text(sel)
    assert.match(ts, /╭─+╮/)
    assert.match(ts, /│ . Wiki 40 had 50 saves\./)
    assert.equal(sel.claim.id, 'c40')
    // every dot is a press on its claim
    assert.ok(sel.graph.some(r => r.some(x => x.part === 'n:c40' || x.part === 'said')))
  }
  const p = { x: 60, y: 10 }
  const linked = [{ x: 52, y: 8 }, { x: 70, y: 12 }]
  for (const [bw, bh] of [[40, 4], [80, 8], [120, 6]]) {
    const at = boxAt(p, bw, bh, 136, 30, linked)
    const covers = q => q.x >= at.x - 1 && q.x <= at.x + bw && q.y >= at.y && q.y < at.y + bh
    assert.ok(!covers(p), `${bw}×${bh} covers the dot`)
    assert.ok(at.x >= 0 && at.x + bw <= 136 && at.y >= 0 && at.y + bh <= 30)
  }
})

function linkedClaims() {
  const st = emptyStore('s')
  const quotes = ['The keys (v, s, ], 1, { }) need a reply to act on, and the bar finder returns null when there is no reply yet',
    ...Array.from({ length: 23 }, (_, i) => `Note ${i + 2} was a tip number ${i + 2}`)]
  applyTurn(st, { places: [{ row: 'r1', by: 'claude', turn: 1, text: quotes.map(q => q + '.').join(' ') }], turn: 1,
    out: { claims: quotes.map((q, i) => ({ quote: q, cluster: `group ${(i % 4) + 1}`, ...(i ? { links: [{ to: `c${Math.max(1, i - 1 - (i % 3))}`, how: 'supports' }] } : {}) })) } })
  return paneData(st)
}

test("a claim's box wraps its whole sentence, braces and all, with no word cut; e shows its citations with their checks", () => {
  const data = linkedClaims()
  const rows = text(graphView(data, { claim: 'c1' }, { w: 110, h: 34 })).split('\n').map(l => [...l])
  const top = rows.findIndex(r => /╭─{20,}╮/.test(r.join('')))
  const left = rows[top].join('').search(/╭─{20,}╮/), right = rows[top].lastIndexOf('╮')
  const bottom = rows.findIndex((r, y) => y > top && r[left] === '╰')
  const said = rows.slice(top + 1, bottom).map(r => r.slice(left + 4, right).join('').trim()).join(' ')
  assert.match(said, /returns null when there is no reply yet\./)
  assert.doesNotMatch(said, /…/)
  // the evidence: each citation's check as the evidence pane words it, its words, the cited place and line
  const c = { ...data.claims[0], sources: [{ ref: 'a1@3', row: 'a1', at: 3, n: 2, label: '212 edits', status: 'failed', failedBy: 'evidence', place: 'edits.csv:4', line: 'Alice,212' }] }
  const ev = text(graphView({ ...data, claims: [c, ...data.claims.slice(1)] }, { claim: 'c1', open: 'ev' }, { w: 110, h: 34 }))
  assert.match(ev, /not confirmed 212 edits {2}edits\.csv:4 {2}Alice,212/)
})

test("the claims graph's lines join their dots: no line in pieces", () => {
  const data = linkedClaims()
  const SIDES = { '─': 'RL', '│': 'UD', '╭': 'RD', '╮': 'DL', '╰': 'UR', '╯': 'UL', '├': 'URD', '┤': 'UDL', '┬': 'RDL', '┴': 'URL', '┼': 'URDL' }
  const STEP = { U: [0, -1, 'D'], R: [1, 0, 'L'], D: [0, 1, 'U'], L: [-1, 0, 'R'] }
  for (const claim of ['c9', 'c14', 'c1']) {
    const g = text(graphView(data, { claim }, { w: 110, h: 34 })).split('\n').map(l => [...l])
    const at = (x, y) => (g[y] || [])[x] || ' '
    const top = g.findIndex(r => /╭─{20,}╮/.test(r.join('')))
    const bottom = g.findIndex(r => /╰─{20,}╯/.test(r.join('')))
    const left = top >= 0 ? g[top].join('').search(/╭─{20,}╮/) : -1, right = top >= 0 ? g[top].lastIndexOf('╮') : -1
    const inBox = (x, y) => top >= 0 && y >= top && y <= bottom && x >= left && x <= right
    let lines = 0
    g.forEach((row, y) => row.forEach((ch, x) => {
      if (!SIDES[ch] || y < 2 || inBox(x, y)) return
      lines++
      for (const s of SIDES[ch]) {
        const [dx, dy, back] = STEP[s]
        const n = at(x + dx, y + dy)
        assert.ok(/[●◉○]/.test(n) || (SIDES[n] || '').includes(back), `${claim}: ${ch} at ${x},${y} leaves ${s} to "${n}"\n${g.map(r => r.join('')).join('\n')}`)
      }
    }))
    assert.ok(claim === 'c1' || lines > 0, `${claim} draws its lines`)
  }
})

test('with no claims the pane says what comes there; the folder action shows while the folder has no map', () => {
  const none = graphView(paneData({ ...emptyStore('s'), offer: { what: '4 files', minutes: 4 } }), {}, { w: 90, h: 30 })
  assert.match(text(none), /^Claims {3}add the whole folder's claims\n\nNo claims yet\. After each answer, the statements in it come here\./)
  assert.ok(none.head[0].some(r => r.part === 'folder'))
  const asked = graphView(paneData({ ...emptyStore('s'), folderAsked: 't' }), {}, { w: 90, h: 30 })
  assert.match(text(asked), /Claude is reading the whole folder for its claims…/)
})
