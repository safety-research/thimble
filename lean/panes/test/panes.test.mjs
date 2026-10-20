// Panes as programs on the card runtime (panes/*.js, panes/host.js): each pane is one program both surfaces run on the
// same stores; the state one surface answers with draws the same on the other; keys go down a focus stack to the first
// program that takes them, and the bar says the keys in words. node --test lean/panes/test
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import '../../draw/kit.js'
import { renderSvg } from '../../draw/svg.js'
import { gridText, renderTerm } from '../../draw/term.js'
import { runProgram } from '../../draw/sandbox-node.mjs'
import PANES from '../index.js'
import { barText, keyEvent, keysOf, nextState, route, takes } from '../host.js'
import { gapLines } from '../claims.js'

const DK = globalThis.DrawKit
const run = (pane, data, o = {}) => DK.run(pane.program, data, { w: 100, h: 30, mode: 'pane', ...o })
/** One surface's turn: the event answered, the new state kept. */
const act = (pane, data, state, event, surface, o = {}) => {
  const d = run(pane, data, { state, event, surface, ...o })
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

test('claims in the browser: the same program draws dots and links between cells and the card as an opaque box; the terminal keeps its cells', () => {
  const data = claimsData()
  const opsOf = d => { const out = []; const walk = n => { if (!n || typeof n !== 'object') return; if (n.t === 'canvas') out.push(...n.ops); (n.kids || []).forEach(walk); if (n.kid) walk(n.kid) }; walk(d.root); return out }
  const rest = opsOf(run(PANES.claims, data, { surface: 'browser' }))
  assert.equal(rest.filter(o => o[0] === 'dot').length, 3, 'a dot per claim')
  assert.ok(rest.filter(o => o[0] === 'dot').every(o => /^cl-/.test(o[4].region)), 'each dot is its claim\'s part')
  assert.equal(rest.filter(o => o[0] === 'link').length, 0, 'no line at rest')
  assert.ok(!rest.some(o => o[0] === 'put' && /[●◉○]/.test(o[3])), 'no dot as a glyph')
  const hov = run(PANES.claims, data, { surface: 'browser', state: { hover: 'c2' } })
  const ops = opsOf(hov)
  assert.ok(ops.some(o => o[0] === 'link'), 'the hovered claim\'s links')
  assert.ok(ops.some(o => o[0] === 'box' && o[7] && o[7].fill), 'its card is an opaque box')
  const s = renderSvg(hov, { w: 90 })
  assert.ok(s.marks.some(m => m.k === 'text' && /Kestrel made 41% of June edits/.test(m.s)), 'the card says the claim')
  assert.ok(s.regions.some(r => r.id === 'cl-c1'))
  // the terminal draws the same program in cells, as before
  const t = run(PANES.claims, data, { surface: 'terminal', state: { hover: 'c2' } })
  assert.ok(!opsOf(t).some(o => o[0] === 'dot' || o[0] === 'link'))
  assert.match(gridText(renderTerm(t, { w: 90 })), /┌─+┐/)
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
  // the step names its key, so a rewrite that fails says which key tries again
  assert.deepEqual(d.effects, [{ row: 'r1', at: { length: 2 }, key: '<', do: 'squeeze' }])
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
  // one esc closes what was opened last: the examples (with the details over them) in one press, then the detail
  const ex = act(PANES.detail, data, { bar: 'examples', ex: 2 }, keyEvent('esc'), 'terminal')
  assert.equal(ex.d.effects, undefined)
  assert.equal(ex.state.bar, null)
  assert.deepEqual(act(PANES.detail, data, ex.state, keyEvent('esc'), 'terminal').d.effects, [{ do: 'close' }])
  // the program over the card closes first, the bar under it after
  const both = act(PANES.detail, data, { bar: 'examples', prog: true }, keyEvent('esc'), 'terminal')
  assert.equal(both.state.prog, false)
  assert.equal(both.state.bar, 'examples')
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

// ---------------------------------------------------------------- the bar in the room it has
test('the bar is always one line: it drops the counts first (coverage last), then says each key by its first word, then its label, then cuts', async () => {
  const { barLine, fitBar } = await import('../host.js')
  const bar = { label: 'thimble', left: [{ key: 'v', words: 'visualize' }, { key: 's', words: '● 6 of 24 lines', short: '● squeeze' }, { key: 'c', words: 'claims' }, { key: ']', words: 'cite & explain' }, { key: '1', words: 'open detail' }], counts: [{ id: 'cov', text: 'coverage 34%' }, { id: 'cards', text: '2 cards' }, { id: 'claims', text: '22 claims' }] }
  const at = w => barLine(fitBar(bar, w))
  assert.equal(at(200), 'thimble  v visualize · s ● 6 of 24 lines · c claims · ] cite & explain · 1 open detail   coverage 34% · 2 cards · 22 claims')
  // the counts go first, coverage last
  assert.ok(at(110).endsWith('coverage 34%') && !at(110).includes('cards'))
  assert.ok(!at(90).includes('coverage'))
  // then the words: each key keeps its first word (a lit verb its dot and name)
  assert.equal(at(60), 'v visualize · s ● squeeze · c claims · ] cite · 1 open')
  for (const w of [200, 140, 110, 90, 75, 60]) assert.ok(at(w).length <= w, `${w}: ${at(w)}`)
  // narrower than the shortest form: the last form, marked to be cut at its end (never a second line)
  const narrow = fitBar(bar, 30)
  assert.equal(narrow.cut, true)
  assert.ok(!barLine(narrow).includes('\n'))
})

test('a status in the bar is cut at its end, never to its first word, and the keys keep their words longest', async () => {
  const { barLine, fitBar } = await import('../host.js')
  const status = '! "55" is not in the original, so it shows as plain words'
  const bar = { label: 'thimble', left: [{ key: '', words: status, tone: 'warning', status: true }, { key: '< >', words: 'change' }, { key: ']', words: 'next chip' }, { key: '+', words: 'new stretch' }, { key: '0', words: 'original' }, { key: 's', words: 'done' }], counts: [{ id: 'cites', text: '22 cites' }, { id: 'claims', text: '19 claims' }] }
  const at = w => barLine(fitBar(bar, w))
  assert.equal(at(200), `thimble  ${status} · < > change · ] next chip · + new stretch · 0 original · s done   22 cites · 19 claims`)
  // short of room: the counts go, then the status is cut at its end and every key keeps its words
  const mid = at(110)
  assert.ok(mid.length <= 110, mid)
  assert.ok(mid.startsWith('thimble  ! "55" is not in'), mid)
  assert.ok(mid.includes('…'), mid)
  assert.ok(mid.endsWith('< > change · ] next chip · + new stretch · 0 original · s done'), mid)
  assert.ok(!/! "55 ·/.test(mid) && !/! "55$/.test(mid), mid)
  for (const w of [200, 140, 110, 90, 80]) assert.ok(at(w).length <= w, `${w}: ${at(w)}`)
})

test('keys in a row of digits read as a range; the keys a host keeps where a card is drawn say why', async () => {
  const { hostKeys } = await import('../host.js')
  assert.deepEqual(keysOf({ on: [{ name: '2', label: 'open' }, { name: '3', label: 'open' }, { name: '4', label: 'open' }] }), [{ key: '2–4', words: 'open' }])
  const inline = hostKeys('inline', 'terminal')
  for (const k of ['0', '1', ']', '[', 'esc', 'return', 'up']) assert.ok(inline[k], k)
  assert.ok(!inline.c && !inline.v && !inline.left, 'letters and ← → reach a focused card')
  const detail = hostKeys('detail', 'terminal')
  assert.ok(detail.esc && detail.up && detail['0'] && !detail[']'])
})

test('local state: a hover and a replay stay on the surface they were set on; the rest is shared', async () => {
  const { joinShared, localKeys, shared } = await import('../host.js')
  const d = run(PANES.claims, { claims: [], total: 0, clusters: 0, order: [], groups: [], pos: {}, names: [] })
  assert.deepEqual(localKeys(d, PANES.claims).sort(), ['hover', 'replay'])
  assert.deepEqual(shared({ hover: 'c1', replay: { k: 2 }, zoom: 3 }, ['hover', 'replay']), { zoom: 3 })
  // the other surface's state, with this surface's own hover kept
  assert.deepEqual(joinShared({ hover: 'c4', zoom: 1 }, { hover: 'c9', zoom: 3 }, ['hover', 'replay']), { zoom: 3, hover: 'c4' })
})

// ---------------------------------------------------------------- the tray and v's proposals
test('tray: a mark is a frame that carries what it shows; the card comes from the host (k.want), keys open, go back and step', async () => {
  const { frameOf, scopeOf } = await import('../tray.js')
  const rec = { row: 'r1', marks: [{ kind: 'cite', start: 0, end: 5, ref: 'q3#day=2026-06-18@n', label: '6,543' }, { kind: 'gloss', start: 9, end: 12, gloss: 'g1', label: 'SEC' }], glosses: { g1: { term: 'SEC', body: 'a county file', here: 'it named the county' } } }
  const f0 = frameOf(rec, 0)
  assert.deepEqual(f0, { row: 'r1', i: 0, kind: 'cite', ref: 'q3#day=2026-06-18@n', label: '6,543' })
  assert.equal(frameOf(rec, 1).gloss.body, 'a county file')
  assert.deepEqual(scopeOf(frameOf(rec, 1)), { row: 'r1', mark: { kind: 'gloss', term: 'SEC' } })
  const data = PANES.tray.data({ threads: [] })
  const d = run(PANES.tray, data, { state: { stack: [f0] }, w: 70 })
  assert.equal(d.wants[0].request.card.ref, 'q3#day=2026-06-18@n')
  assert.match(gridText(renderTerm(d, { w: 70 })), /6,543.*cite[\s\S]*reading it through the kernel/)
  const inner = globalThis.DrawKit.run('return k.text("Jun 18 **6,543**")', {}, { w: 60 })
  const got = { [d.wants[0].key]: { drawings: [inner], links: [{ id: 'n1', ref: 'q1#user=A@n', label: 'A' }, { id: 'n2', ref: 'q2', label: 'B' }] } }
  const full = run(PANES.tray, data, { state: { stack: [f0] }, w: 70, got })
  assert.match(gridText(renderTerm(full, { w: 70 })), /Jun 18 6,543/)
  assert.equal(barText([full]), '1 ask · 2 3 open · 0 close · ] next')
  // 2 opens the first citation inside the card over it; 0 goes back to the card under it
  const opened = act(PANES.tray, data, { stack: [f0] }, keyEvent('2'), 'terminal', { got, w: 70 })
  assert.deepEqual(opened.state.stack.at(-1), { kind: 'cite', ref: 'q1#user=A@n', label: 'A' })
  assert.equal(act(PANES.tray, data, opened.state, keyEvent('0'), 'terminal').state.stack.length, 1)
  // back from the first card closes the tray; ] asks the host for the next mark or card
  assert.deepEqual(act(PANES.tray, data, { stack: [f0] }, keyEvent('0'), 'terminal').d.effects, [{ do: 'close' }])
  assert.deepEqual(act(PANES.tray, data, { stack: [f0] }, keyEvent(']'), 'terminal').d.effects, [{ dir: 1, do: 'step' }])
  // 1 asks: in the browser the question is typed in the tray (an input), in the terminal in the prompt
  assert.equal(act(PANES.tray, data, { stack: [f0] }, keyEvent('1'), 'browser').d.effects[0].do, 'input')
  const asking = run(PANES.tray, data, { state: { stack: [f0], asking: true }, w: 70, got })
  assert.equal([asking.status?.text, barText([asking])].filter(Boolean).join(' · '), 'type to ask · ↵ asks this thread · 0 back')
})

test('proposals: v\'s line is a program on the message\'s record: 1–9 pick (the host runs the verb), 0 closes', async () => {
  const data = PANES.proposals.data({ 'record:r1': { verbs: { v: { lit: true, proposals: ['saves per day around June 18', 'who edited most'] } } } }, { row: 'r1', verb: 'v' })
  const d = run(PANES.proposals, data, { w: 90 })
  assert.match(gridText(renderTerm(d, { w: 90 })), /▸ 1 saves per day around June 18 {3}▸ 2 who edited most/)
  assert.equal(barText([d]), '1 2 pick · 0 close')
  assert.deepEqual(act(PANES.proposals, data, {}, keyEvent('2'), 'terminal').d.effects, [{ row: 'r1', verb: 'v', choice: 'who edited most', i: 1, do: 'pick' }, { do: 'close' }])
  assert.deepEqual(act(PANES.proposals, data, {}, { type: 'press', region: 'opt-0' }, 'browser').d.effects[0].choice, 'saves per day around June 18')
  // none proposed: one option, another view of this answer
  assert.deepEqual(PANES.proposals.data({ 'record:r1': { verbs: {} } }, { row: 'r1', verb: 'v' }).options, ['another view of this answer'])
})

test('claims: a turn the observer could not read is said under the head, with why and whether it is read again', () => {
  const lines = gapLines([{ turn: 3, why: "the observer's call failed: the sign-in failed or expired", again: true }, { turn: 1, why: 'old {gap}' }, { turn: 4, why: 'x', again: true, reading: true }, { turn: 5, why: 'y' }])
  assert.equal(lines[0], '{bad:Turn 1 was not read: old \\{gap\\}.}')
  assert.equal(lines[1], "{bad:Turn 3 was not read: the observer's call failed: the sign-in failed or expired.} {dim:Press c twice to read it again.}")
  assert.equal(lines[2], '{dim:Turn 4 was not read (x). Reading it again…}')
  assert.equal(lines[3], '{dim:1 more turn not read.}')
})
