// Claims (claims/store.js, graph.js, lens.mjs): the lens's claims as the observer's reply gives them, and the Claims
// pane on the card runtime, whose count stays on screen however many claims a session has.
//   node --test plugin/claims/test/
import '../../test-home.mjs'
import '../../draw/kit.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { gridText, renderTerm } from '../../draw/term.js'
import { parseAnswer } from '../../observer/evidence.js'
import pane, { boxAt } from '../graph.js'
import lens from '../lens.mjs'
import { applyTurn, emptyStore, parseClaims } from '../store.js'

const DK = globalThis.DrawKit

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
  // a turn that states many claims keeps every one
  assert.equal(parseClaims(Array.from({ length: 75 }, (_, i) => ({ quote: `claim number ${i + 1}` }))).length, 75)
  const a = parseAnswer('{"notes": [], "claims": [{"claim": "x", "quote": "y"}], "clusters": [{"id": "k1", "name": "z"}]}')
  assert.deepEqual(lens.read(a), { claims: [{ claim: 'x', quote: 'y' }], clusters: [{ id: 'k1', name: 'z' }] })
})

const draw = (data, o = {}) => {
  const d = DK.run(pane.program, data, { w: 90, h: 44, mode: 'pane', ...o })
  assert.equal(d.error, undefined, d.error && d.error.message)
  return { d, text: gridText(renderTerm(d, { w: o.w || 90 })).replace(/\u00a0/g, ' ') }
}

test('the claims graph uses the whole pane, and a claim selected opens a framed box over it that hides no dot it needs', () => {
  // uneven clusters with links, as a long session makes them: the count stays on the first row and the pane stays
  // within the side panel's rows (the input bar and the actions above it take six), so nothing scrolls the count away
  const uneven = emptyStore('s')
  for (let from = 0, turn = 1; from < 155; from += 31, turn++) {
    const ids = Array.from({ length: Math.min(31, 155 - from) }, (_, i) => from + i + 1)
    const t = ids.map(i => `Wiki ${i} had [${i + 10} saves](q${i % 7}#n).`).join(' ')
    applyTurn(uneven, { places: [{ row: `r${turn}`, by: 'claude', turn, text: t }], turn, out: { claims: ids.map(i => ({ quote: `Wiki ${i} had ${i + 10} saves`, cluster: `group ${i % 3 ? (i % 9) + 1 : 1}`, ...(i > 1 ? { links: [{ to: `c${i - 1}`, how: 'supports' }] } : {}) })) } })
  }
  const data = pane.data({ claims: uneven, threads: [] })
  for (const h of [46, 40, 34]) {
    // at rest: no box, the dots spread from the left edge to the right one
    const { d: du, text: tu } = draw(data, { w: 136, h })
    assert.match(tu, /^Claims {3}155 · 7 clusters/)
    assert.ok(tu.split('\n').length <= h - 6, `${h}: ${tu.split('\n').length} rows`)
    assert.equal(du.selected, 'n-c155')
    assert.doesNotMatch(tu, /╭/)
    const cols = tu.split('\n').slice(2).flatMap(l => [...l].map((ch, x) => (/[●◉○]/.test(ch) ? x : -1)).filter(x => x >= 0))
    assert.ok(Math.min(...cols) < 136 * 0.15 && Math.max(...cols) > 136 * 0.85, `${h}: dots from ${Math.min(...cols)} to ${Math.max(...cols)}`)
    // a claim selected: its sentence in a framed box over the graph, and its own dot still drawn
    const { d: ds, text: ts } = draw(data, { w: 136, h, state: { claim: 'c40' } })
    assert.match(ts, /╭─+╮/)
    assert.match(ts, /│ . Wiki 40 had 50 saves\./)
    assert.equal(ds.selected, 'n-c40')
  }
  // the box never covers the dot it is about, and keeps clear of its linked claims where it can
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
  return pane.data({ claims: st, threads: [] })
}

test("a claim's box wraps its whole sentence, braces and all, with no word cut", () => {
  const data = linkedClaims()
  const { text: box } = draw(data, { w: 110, h: 34, state: { claim: 'c1' } })
  // the words inside the box's frame, from the row under its top edge to the row over its bottom edge
  const rows = box.split('\n').map(l => [...l])
  const top = rows.findIndex(r => /╭─{20,}╮/.test(r.join('')))
  const left = rows[top].join('').search(/╭─{20,}╮/), right = rows[top].lastIndexOf('╮')
  const bottom = rows.findIndex((r, y) => y > top && r[left] === '╰')
  const said = rows.slice(top + 1, bottom).map(r => r.slice(left + 4, right).join('').trim()).join(' ')
  assert.match(said, /returns null when there is no reply yet\./)
  assert.doesNotMatch(said, /…/)
})
