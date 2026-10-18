// Panes as programs on the card runtime (panes/*.js, panes/host.js): each pane is one program both surfaces run on the
// same stores; the state one surface answers with draws the same on the other; keys go down a focus stack to the first
// program that takes them, and the bar says the keys in words. node --test lean/panes/test
import assert from 'node:assert/strict'
import { test } from 'node:test'
import '../../draw/kit.js'
import { renderSvg } from '../../draw/svg.js'
import { gridText, renderTerm } from '../../draw/term.js'
import { runProgram } from '../../draw/sandbox-node.mjs'
import PANES from '../index.js'
import { barText, keyEvent, keysOf, nextState, route, takes } from '../host.js'

const DK = globalThis.DrawKit
const run = (pane, data, o = {}) => DK.run(pane.program, data, { w: 100, h: 30, mode: 'pane', ...o })
/** One surface's turn: the event answered, the new state kept. */
const act = (pane, data, state, event, surface) => {
  const d = run(pane, data, { state, event, surface })
  return { d, state: nextState(state, d) }
}

// ---------------------------------------------------------------- claims
const STORE = {
  v: 1, session: 's-1', claims: [
    { id: 'c1', text: 'June 18 had 6,543 saves', kind: 'event', by: 'claude', cluster: 'k1', turn: 1, said: [{ row: 'r1', by: 'claude', turn: 1, start: 0 }], sources: [{ ref: 'q1#day=2026-06-18@n' }], precisely: 'saves on June 18, all users' },
    { id: 'c2', text: 'Kestrel made 41% of June edits', kind: 'finding', by: 'claude', cluster: 'k2', turn: 1, said: [{ row: 'r1', by: 'claude', turn: 1, start: 30 }], sources: [{ ref: 'q4#user=Kestrel@share' }] },
    { id: 'c3', text: 'The tilt is two editors', kind: 'finding', by: 'claude', cluster: 'k2', turn: 2, said: [{ row: 'r2', by: 'claude', turn: 2, start: 0 }], sources: [] },
  ],
  clusters: [{ id: 'k1', name: 'the June 18 burst', turn: 1 }, { id: 'k2', name: 'who edited', turn: 1 }],
}
const claimsData = () => PANES.claims.data({ claims: STORE, index: [{ row: 'r1', kind: 'assistant' }, { row: 'r2', kind: 'assistant' }] }, {}, { w: 90, h: 24 })

test('claims: the ring in the terminal and the pointer in the browser are one hover: the same state, the same card on both surfaces', () => {
  const data = claimsData()
  const term = act(PANES.claims, data, {}, { type: 'focus', region: 'cl-c2' }, 'terminal')
  const web = act(PANES.claims, data, {}, { type: 'hover', region: 'cl-c2' }, 'browser')
  assert.deepEqual(term.state, web.state)
  assert.equal(term.state.hover, 'c2')
  // the state the browser kept, drawn in the terminal: the card of what c2 means
  const t = gridText(renderTerm(run(PANES.claims, data, { state: web.state, surface: 'terminal' }), { w: 90 }))
  assert.match(t, /Kestrel made 41% of June edits/)
  // and in the browser, from the same program: the same parts
  const s = renderSvg(run(PANES.claims, data, { state: term.state, surface: 'browser' }), { w: 90 })
  assert.ok(s.regions.some(r => r.id === 'cl-c2'))
  assert.equal(barText([run(PANES.claims, data)]), 'r replay · esc close')
})

test('claims: r replays the graph by later events (k.after) in the order made; any key stops it', () => {
  const data = claimsData()
  let { d, state } = act(PANES.claims, data, { hover: 'c1' }, keyEvent('r'), 'terminal')
  assert.deepEqual(state, { hover: null, replay: { k: 0 } })
  const seen = []
  for (let i = 0; i < 20 && d.after?.length; i++) {
    assert.ok(d.after[0].ms >= 80)
    ;({ d, state } = act(PANES.claims, data, state, d.after[0].event, 'terminal'))
    seen.push(state.replay ? state.replay.k : 'done')
  }
  assert.deepEqual(seen, [1, 2, 3, 'done'])
  // a replay running: any key ends it (the program takes every key only then)
  const running = { replay: { k: 1 } }
  assert.ok(takes(run(PANES.claims, data, { state: running }), keyEvent('x')))
  assert.ok(!takes(run(PANES.claims, data), keyEvent('x')))
  assert.deepEqual(act(PANES.claims, data, running, keyEvent('x'), 'browser').state.replay, null)
})

// ---------------------------------------------------------------- chips
const REC = { text: 'Mostly [6,543 saves](q1#day=2026-06-18@n) on June 18.\n\nThe rest spread out.', shown: null, verbs: {}, squeeze: { at: {} } }
const chipsData = (rec = REC, w = 100) => PANES.chips.data({ 'record:r1': rec, 'sqz:r1': null }, { row: 'r1' }, { w, h: 3 })

test('chips: keys pick and change a chip; the rewrite is the host\'s action; the same presses in both surfaces', () => {
  const data = chipsData()
  const d0 = run(PANES.chips, data)
  assert.equal(barText([d0]), '< > change · ] next chip · + new stretch · 0 close · s done')
  let { d, state } = act(PANES.chips, data, {}, keyEvent('<'), 'terminal')
  assert.deepEqual(d.effects, [{ row: 'r1', at: { length: 2 }, do: 'squeeze' }])
  ;({ d, state } = act(PANES.chips, data, state, keyEvent(']'), 'terminal'))
  assert.equal(state.focus, 'interpret')
  // a press on a dot in the browser sets that level at once
  const web = act(PANES.chips, data, state, { type: 'press', region: 'lvl-familiarity-4' }, 'browser')
  assert.deepEqual(web.d.effects, [{ row: 'r1', at: { familiarity: 4 }, do: 'squeeze' }])
  assert.equal(web.state.focus, 'familiarity')
  // + asks the host for the two ends (the terminal's prompt, the browser's field), and the ends make a stretch
  const plus = act(PANES.chips, data, web.state, keyEvent('+'), 'browser')
  assert.equal(plus.d.effects[0].do, 'input')
  const made = act(PANES.chips, data, plus.state, { type: 'stretch', text: '+engineer and manager' }, 'browser')
  assert.deepEqual(made.d.effects, [{ row: 'r1', stretch: '+engineer and manager', do: 'squeeze' }])
  assert.equal(made.state.focus, 'x-engineer-manager')
})

test('chips: a change on its way shows at once from the record (squeeze.want), and the bar says it is rewriting', () => {
  const data = chipsData({ ...REC, squeeze: { at: {}, want: { length: 1 } } })
  const d = run(PANES.chips, data)
  assert.match(gridText(renderTerm(d, { w: 100 })), /Length ○●○○ short/)
  assert.equal(d.status.text, 's ● rewriting…')
})

// ---------------------------------------------------------------- the card detail
const OBJECT = {
  id: '01-saves', version: 2, title: 'Saves per day', text: 'June 18 had [6,543](#day-2026-06-18) saves.', history: [{ v: 1 }, { v: 2 }],
  program: "k.examples('ex-18', { label: 'saves on Jun 18', total: 3, records: [{ text: 'Hello agents' }, { text: 'Put it back' }] }); return k.stack(k.region('day-2026-06-17', { label: 'Jun 17' }, k.bar(4, { max: 9 })), k.region('day-2026-06-18', { label: 'Jun 18', examples: 'ex-18' }, k.bar(9, { max: 9 })))",
  data: {},
}
const detailData = () => {
  const drawing = runProgram(OBJECT, { w: 80, h: 20, mode: 'detail' })
  return PANES.detail.data({ 'card:01-saves': { object: OBJECT, drawing, versions: [{ v: 1 }, { v: 2 }], v: 2, state: {}, thread: true, browser: true } }, { id: '01-saves' }, { w: 90, h: 30 })
}

test('detail: one page on both surfaces; the part selected and the bar are its state, and a state from either surface draws the same', () => {
  const data = detailData()
  let { state } = act(PANES.detail, data, {}, { type: 'key', key: 'down' }, 'browser')
  assert.equal(state.region, 'day-2026-06-18')
  ;({ state } = act(PANES.detail, data, state, keyEvent('e'), 'browser'))
  assert.equal(state.bar, 'examples')
  // the browser's state, drawn in the terminal: the same part selected, its examples labelled
  const d = run(PANES.detail, data, { state, surface: 'terminal' })
  assert.equal(d.selected, 'day-2026-06-18')
  const t = gridText(renderTerm(d, { w: 90 }))
  assert.match(t, /examples of saves on Jun 18 · 1 of 3/)
  assert.match(t, /Hello agents/)
  // the terminal's ring on a part is the same selection the browser's click makes
  const ring = act(PANES.detail, data, {}, { type: 'focus', region: 'day-2026-06-18' }, 'terminal')
  const click = act(PANES.detail, data, {}, { type: 'press', region: 'day-2026-06-18' }, 'browser')
  assert.deepEqual(ring.state, click.state)
  // a click on the part already selected opens its details (the ring resting on it does not)
  assert.equal(act(PANES.detail, data, click.state, { type: 'press', region: 'day-2026-06-18' }, 'browser').state.bar, 'details')
  assert.equal(barText([run(PANES.detail, data)]), '↑↓ part · ↵ details · e examples · p program · h versions · t thread · m send to main · o browser · esc back')
  // the browser has no o: it is the browser
  assert.ok(!barText([run(PANES.detail, data, { surface: 'browser' })]).includes('o browser'))
})

test('detail: what the card does is the host\'s (k.do): a version, the thread, closing; rows behind a part are wanted (k.want)', () => {
  const data = detailData()
  assert.deepEqual(act(PANES.detail, data, {}, keyEvent('h'), 'terminal').d.effects, [{ v: 1, do: 'version' }])
  assert.deepEqual(act(PANES.detail, data, {}, keyEvent('esc'), 'terminal').d.effects, [{ do: 'close' }])
  // esc with the bar open empties it instead
  const open = act(PANES.detail, data, { bar: 'details' }, keyEvent('esc'), 'terminal')
  assert.equal(open.d.effects, undefined)
  assert.equal(open.state.bar, null)
  const d = run(PANES.detail, data, { state: { region: 'day-2026-06-17', bar: 'details' } })
  assert.ok(d.wants.some(w => w.request.facts === '01-saves'))
})

// ---------------------------------------------------------------- the focus stack and the bar
test('the focus stack: a key goes to the top program that takes it, then down; the bar says the top keys first', () => {
  const card = { id: 'card', drawing: { on: [{ name: 'j', label: 'next run' }, { name: 'press:run-3', label: '' }] } }
  const pane = { id: 'detail', drawing: run(PANES.detail, detailData()) }
  assert.equal(route([card, pane], keyEvent('j')).id, 'card')
  assert.equal(route([card, pane], keyEvent('e')).id, 'detail')
  assert.equal(route([card, pane], keyEvent('z')), null)
  assert.equal(route([card, pane], { type: 'press', region: 'run-3' }).id, 'card')
  assert.match(barText([card.drawing, pane.drawing]), /^j next run · ↑↓ part · ↵ details/)
  // keys that share their words are one entry; a key with no words is an alias, not shown
  assert.deepEqual(keysOf({ on: [{ name: '<', label: 'change' }, { name: '>', label: 'change' }, { name: ',', label: '' }, { name: 'up', label: 'part' }, { name: 'down', label: 'part' }, { name: 'press', label: 'x' }] }), [{ key: '< >', words: 'change' }, { key: '↑↓', words: 'part' }])
})
