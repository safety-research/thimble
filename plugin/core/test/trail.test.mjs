// The side pane's way back (core/trail.mjs): which pane goes on the trail, which takes another's place, which goes back
// down it; the rows a drawing takes. All data is made up.
//   node --test plugin/core/test/trail.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { crumbOf, nextTrail, TRAIL_MAX, treeRows } from '../trail.mjs'

/** The pane after `kind, args` opens over `was` (open), as core/pane.ts openPane keeps it. */
const go = (was, kind, args, open = true) => ({ kind, args, title: kind, trail: nextTrail(was, open, kind, args) })
const words = now => [...(now.trail ?? []).map(t => crumbOf(t.kind, t.args).words), crumbOf(now.kind, now.args).words]

test('claims › cluster › claim › evidence: each step deeper goes on the trail, j and k take the place, e back down', () => {
  let p = go(null, 'claims', {})
  assert.deepEqual(p.trail, [])
  p = go(p, 'claims', { group: 'k1', at: 0 })
  p = go(p, 'claims', { claim: 'c1', at: 0 })
  // k and j in the cluster: the claim's place, not a new step
  p = go(p, 'claims', { claim: 'c2', at: 1 })
  assert.deepEqual(words(p), ['claims', 'cluster', 'claim'])
  assert.deepEqual(p.trail.at(-1).args, { group: 'k1', at: 0 })
  p = go(p, 'claims', { claim: 'c2', at: 1, open: true, cite: 0 })
  assert.deepEqual(words(p), ['claims', 'cluster', 'claim', 'evidence'])
  // e closes the evidence: back to the claim, the trail as it was under it
  p = go(p, 'claims', { claim: 'c2', at: 1 })
  assert.deepEqual(words(p), ['claims', 'cluster', 'claim'])
  // the claims' own way back to the cluster
  p = go(p, 'claims', { group: 'k1', at: 1 })
  assert.deepEqual(words(p), ['claims', 'cluster'])
})

test('a pane of another kind goes on top: a citation of a side answer stands over the claim it was asked about', () => {
  let p = go(null, 'claims', {})
  p = go(p, 'claims', { claim: 'c1' })
  p = go(p, 'evidence', { row: 'r1', n: 3 })
  assert.deepEqual(words(p), ['claims', 'claim', 'citation 3'])
  assert.deepEqual(p.trail.at(-1), { kind: 'claims', args: { claim: 'c1' }, title: 'claims' })
  // another citation takes the citation's place
  p = go(p, 'evidence', { row: 'r1', n: 4 })
  assert.deepEqual(words(p), ['claims', 'claim', 'citation 4'])
})

test("another side thread goes on top of the thread shown: the earlier conversation stays one ‹ back away", () => {
  let p = go(null, 'thread', { key: 'card-c1' })
  // the same thread drawn again (a key in it) keeps its place
  p = go(p, 'thread', { key: 'card-c1', from: 'pane' })
  assert.deepEqual(p.trail, [])
  // a heads-up asked about from the tray while the card's thread shows
  p = go(p, 'thread', { key: 'mark-r2-heads-h1' })
  assert.deepEqual(words(p), ['thread', 'thread'])
  assert.deepEqual(p.trail.at(-1).args, { key: 'card-c1', from: 'pane' })
})

test('a pane opened while none was open starts a new trail; the trail keeps its last panes', () => {
  let p = go(null, 'claims', {})
  p = go(p, 'claims', { claim: 'c1' })
  assert.deepEqual(go(p, 'labels', {}, false).trail, [])
  // kinds that take turns: each goes on top
  for (let n = 1; n <= TRAIL_MAX + 5; n++) p = go(p, n % 2 ? 'evidence' : 'threads', { row: 'r1', n })
  assert.equal(p.trail.length, TRAIL_MAX)
})

test("a drawing's rows: a column adds its children, a row takes its tallest, text wraps unless cut, as Claude Code's elements hold their children", () => {
  const T = (children, props = {}) => ({ type: 'Text', props, children: [children] })
  const B = (children, props = {}) => ({ type: 'Box', props, children })
  assert.equal(treeRows(T('a'.repeat(25)), 10), 3)
  assert.equal(treeRows(T('a'.repeat(25), { wrap: 'truncate-end' }), 10), 1)
  assert.equal(treeRows(B([T('one'), T('two\nthree')], { flexDirection: 'column' }), 40), 3)
  assert.equal(treeRows(B([T('left'), B([T('x'), T('y')], { flexDirection: 'column' })]), 40), 2)
  assert.equal(treeRows(B([T('x')], { flexDirection: 'column', marginTop: 1, borderStyle: 'round' }), 40), 4)
  // the plain elements of the tests and the fixer's copy hold their children in their props
  assert.equal(treeRows({ type: 'Box', props: { flexDirection: 'column', children: [{ type: 'Text', props: { children: 'a' } }, { type: 'Input', props: {} }] } }, 40), 2)
})

test("a wrapping row of items with margins beside them wraps by whole items, their margins counted", () => {
  const el = (type, props, children) => ({ type, props: { ...props, children } })
  const choice = (w) => el('Box', { marginRight: 3 }, [el('Text', {}, w)])
  const row = el('Box', { flexDirection: 'row', flexWrap: 'wrap' }, [choice('1 run all (about 6 min)'), choice('2 run on a sample of 300 (about 30 s)'), choice('0 cancel')])
  // 26 + 40 + 11 cells: two rows at 70 columns (the words alone, 66 cells, would fit one), one at 80
  assert.equal(treeRows(row, 70), 2)
  assert.equal(treeRows(row, 80), 1)
})

test("a key's Button counts the hotkey Claude Code draws before its words", () => {
  const el = (type, props, children) => ({ type, props: { ...props, children } })
  const key = (k, w) => el('Button', { hotkey: k, plain: true, label: w }, [el('Text', {}, w)])
  const row = el('Box', { flexDirection: 'row', flexWrap: 'wrap' }, [key('k', 'previous claim'), el('Text', {}, ' · '), key('j', 'next claim'), el('Text', {}, ' · '), key('e', 'evidence')])
  // `k: previous claim · j: next claim · e: evidence`, 47 cells: two rows at 40 columns, where the words alone (38) fit one
  assert.equal(treeRows(row, 40), 2)
})
