// Every part drawn as clickable answers a click: in the card detail (panes/detail.js) a link in a card's words to a
// cite opens its rows, to examples opens them, to a knob turns it; a region opens as selecting it does. A link to an
// id the card does not define, or one drawn where no click reaches, is not drawn as a link (shell/cells.ts).
//   node --test plugin/panes/test/links.test.mjs
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import '../../draw/kit.js'
import { gridText, renderTerm } from '../../draw/term.js'
import { runProgram } from '../../draw/sandbox-node.mjs'
import PANES from '../index.js'
import { nextState } from '../host.js'
import { paintRegions } from '../../shell/cells.ts'

const DK = globalThis.DrawKit
const OBJECT = {
  id: 'lk', version: 1, title: 'Links', text: '', data: {}, program: `
k.knob('page', { values: [1, 2, 3], at: 1, label: 'page' })
k.cite('c1', { text: '42 runs', query: 'q1', rows: [] })
k.examples('ex1', { label: 'runs that failed', total: 2, records: [{ text: 'run 7' }, { text: 'run 9' }] })
return k.stack(
  k.text('See [the total](#c1), [the failures](#ex1), [the bar](#b1), [next page](#page) and [nowhere](#zz).', { wrap: true }),
  k.region('b1', { label: 'bar one' }, k.bar(4, { max: 9 })),
  k.region('b2', { label: 'bar two' }, k.bar(7, { max: 9 })),
)`,
}
const drawing = runProgram(OBJECT, { w: 80, h: 20, mode: 'detail' })
const data = PANES.detail.data({ 'card:lk': { object: OBJECT, drawing, versions: [{ v: 1 }], v: 1, state: {}, thread: false } }, { id: 'lk' }, { w: 90, h: 30 })
const run = (state, event) => DK.run(PANES.detail.program, data, { w: 100, h: 30, mode: 'pane', state, event, surface: 'terminal' })
const press = (region, dir, state = { region: 'b2' }) => { const d = run(state, { type: 'press', region, ...(dir ? { dir } : {}) }); return { state: nextState(state, d), effects: d.effects || [] } }

test('in the detail a click on a link opens what it points at: a cite its rows, examples the examples, a knob turns', () => {
  assert.deepEqual(press('c1').state, { region: 'c1', ex: 0, bar: 'details' })
  assert.match(gridText(renderTerm(run(press('c1').state, null), { w: 90 })), /42 runs/)
  assert.deepEqual(press('ex1').state, { region: 'ex1', ex: 0, bar: 'examples' })
  // the examples show as records, with their place among them, and no caption that repeats the part's label
  assert.match(gridText(renderTerm(run(press('ex1').state, null), { w: 90 })), /1 of 2\n.*\n  ▸ run 7/)
  // a knob: on with a click on its right half (or words that point at it), back with one on its left half
  assert.deepEqual(press('page').effects, [{ state: { page: 2 }, knob: 'page', do: 'card' }])
  assert.deepEqual(press('page', -1, { region: 'b2' }).effects.length, 1)
  // a link to a region selects that region, as a click on the region does
  assert.equal(press('b1').state.region, 'b1')
  // a link to nothing the card defines answers nothing
  assert.deepEqual(press('zz').state, { region: 'b2' })
})

test('the keys walk the parts in reading order, the links to a cite, examples or a knob among them', () => {
  // the links stand in the words above the bars: ↓ from the last bar wraps to them, in the order they are written (a
  // link to a bar is that bar, reached where the link stands first)
  const walk = []
  let state = { region: 'b2' }
  for (let i = 0; i < 4; i++) { state = nextState(state, run(state, { type: 'key', key: 'down' })); walk.push(state.region) }
  assert.deepEqual(walk, ['c1', 'ex1', 'b1', 'page'])
  // ↑ walks back
  assert.equal(nextState({ region: 'c1' }, run({ region: 'c1' }, { type: 'key', key: 'up' })).region, 'b2')
})

test('a link is underlined only where a click answers it: never with no press, never to an id nothing defines', () => {
  const grid = renderTerm(drawing, { w: 80 })
  const Text = props => ({ type: 'Text', props })
  const Box = props => ({ type: 'Box', props })
  const Button = props => ({ type: 'Button', props })
  const els = { Text, Box, Button, Raster: props => ({ type: 'Raster', props }) }
  const walk = (n, f) => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) return n.forEach(x => walk(x, f)); f(n); walk(n.props?.children, f) }
  const underlined = t => { const out = []; walk(t, x => { if (x.type === 'Text' && x.props?.underline) out.push(String(x.props.children)) }); return out }
  const pressed = t => { const out = []; walk(t, x => { if (x.type === 'Button') out.push(String(x.props.label)) }); return out }
  const live = paintRegions(grid, els, { onPress: () => undefined })
  assert.deepEqual(underlined(live), ['the total', 'the failures', 'the bar', 'next ', 'page'])
  assert.ok(!pressed(live).some(l => /nowhere|zz/.test(l)), 'a link to nothing is no press')
  assert.deepEqual(underlined(paintRegions(grid, els, {})), [])
})
