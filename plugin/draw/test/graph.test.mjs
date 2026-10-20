// k.graph: nodes as boxes and edges as arrows, laid out in layers with no positions given. node --test plugin/draw/test
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runProgram } from '../sandbox-node.mjs'
import { gridText, renderTerm } from '../term.js'

const draw = (data, w = 100, o = '') => {
  const d = runProgram({ id: 'flow', program: `return k.graph(data${o ? ', ' + o : ''})`, data }, { w, h: 24 })
  assert.equal(d.error, undefined, d.error && d.error.message)
  return { d, g: renderTerm(d, { w }) }
}
const FLOW = {
  nodes: [
    { id: 'form', label: 'sign-in form', ref: 'web/login.tsx#L12-40' },
    { id: 'api', label: 'POST /session', ref: 'server/routes.py#L88-120' },
    { id: 'check', label: 'check password', ref: 'server/auth.py#L30-61' },
    { id: 'token', label: 'issue token', ref: 'server/auth.py#L63-80' },
    { id: 'deny', label: 'deny', tone: 'bad' },
  ],
  edges: [
    { from: 'form', to: 'api', label: 'submit' }, { from: 'api', to: 'check' },
    { from: 'check', to: 'token', label: 'match' }, { from: 'check', to: 'deny', label: 'no match' },
  ],
}

test('a flow draws each node as a box, in the order of its arrows, with the edge labels on them', () => {
  const { d, g } = draw(FLOW, 120)
  const text = gridText(g)
  const col = s => text.split('\n').find(l => l.includes(s)).indexOf(s)
  for (const s of ['sign-in form', 'POST /session', 'check password', 'issue token', 'deny', 'submit', 'match', 'no match']) assert.ok(text.includes(s), `${s} in\n${text}`)
  // left to right along the arrows, each arrow pointing into its box
  assert.ok(col('sign-in form') < col('POST /session') && col('POST /session') < col('check password') && col('check password') < col('issue token'), text)
  assert.equal((text.match(/▶/g) || []).length, 4, text)
  assert.deepEqual(d.warnings, [])
  // a node with a ref is a part over its box; the one with none is not
  const ids = g.regions.filter(r => r.rects.length).map(r => r.id)
  assert.deepEqual(ids.sort(), ['api', 'check', 'form', 'token'])
  assert.equal(d.regions.find(r => r.id === 'check').meta.ref, 'server/auth.py#L30-61')
})

test('a cycle keeps its arrow pointing at its own target, and an edge to itself is noted in the box', () => {
  const { g } = draw({ edges: [{ from: 'edit', to: 'test' }, { from: 'test', to: 'edit', label: 'fails' }, { from: 'test', to: 'test', label: '3 reruns' }] }, 80)
  const text = gridText(g)
  assert.ok(text.includes('◀'), text)
  assert.ok(text.includes('↻ 3 reruns'), text)
  assert.ok(text.includes('fails'), text)
})

test('a graph too wide to lie across the card is laid out down it, and fits', () => {
  for (const w of [60, 40]) {
    const { d, g } = draw(FLOW, w)
    assert.ok(g.w <= w, `${g.w} columns at ${w}`)
    assert.deepEqual(g.cut.filter(c => c.k === 'clip'), [])
    assert.ok(gridText(g).includes('▼'), gridText(g))
    assert.deepEqual(d.warnings, [])
  }
  // asked for, a direction is kept
  assert.ok(gridText(draw(FLOW, 200, "{ dir: 'down' }").g).includes('▼'))
})

test('the edges with the most weight are drawn heavy, and an edge with a ref is a part on its label', () => {
  const { d, g } = draw({ edges: [{ from: 'a', to: 'b', weight: 40, label: '40' }, { from: 'a', to: 'c', weight: 5, label: '5', ref: 'q2#from=a&to=c@n' }] }, 80)
  const text = gridText(g)
  assert.ok(/━/.test(text) && /─/.test(text), text)
  const part = g.regions.find(r => r.id === 'a-to-c')
  assert.ok(part && part.rects.length, JSON.stringify(g.regions.map(r => r.id)))
  assert.equal(d.regions.find(r => r.id === 'a-to-c').meta.label, 'a → c: 5')
})
