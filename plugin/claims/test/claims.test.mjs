// Claims (claims/store.js, graph.js, lens.mjs): the lens's claims as the observer's reply gives them, and the Claims
// pane on the card runtime, whose count stays on screen however many claims a session has.
//   node --test plugin/claims/test/
import '../../test-home.mjs'
import '../../draw/kit.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { gridText, renderTerm } from '../../draw/term.js'
import { parseAnswer } from '../../observer/evidence.js'
import pane from '../graph.js'
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
  return { d, text: gridText(renderTerm(d, { w: 90 })).replace(/\u00a0/g, ' ') }
}

test('the claims count stays on the pane\'s first row with many uneven clusters, and the pane fits the side panel', () => {
  // uneven clusters with links, as a long session makes them: the count stays on the first row and the pane stays
  // within the side panel's rows (the input bar and the actions above it take six), so nothing scrolls the count away
  const uneven = emptyStore('s')
  for (let from = 0, turn = 1; from < 155; from += 31, turn++) {
    const ids = Array.from({ length: Math.min(31, 155 - from) }, (_, i) => from + i + 1)
    const t = ids.map(i => `Wiki ${i} had [${i + 10} saves](q${i % 7}#n).`).join(' ')
    applyTurn(uneven, { places: [{ row: `r${turn}`, by: 'claude', turn, text: t }], turn, out: { claims: ids.map(i => ({ quote: `Wiki ${i} had ${i + 10} saves`, cluster: `group ${i % 3 ? (i % 9) + 1 : 1}`, ...(i > 1 ? { links: [{ to: `c${i - 1}`, how: 'supports' }] } : {}) })) } })
  }
  for (const h of [46, 40, 34]) {
    const { d: du, text: tu } = draw(pane.data({ claims: uneven, threads: [] }), { w: 106, h, state: { claim: 'c155' } })
    assert.match(tu, /^155 claims/)
    assert.ok(tu.split('\n').length <= h - 6, `${h}: ${tu.split('\n').length} rows`)
    assert.equal(du.selected, 'n-c155')
  }
})
