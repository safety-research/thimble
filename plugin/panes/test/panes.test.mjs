// Panes as programs on the card runtime (panes/*.js, panes/host.js): each pane is one program both surfaces run on the
// same stores; the state one surface answers with draws the same on the other; keys go down a focus stack to the first
// program that takes them, and the bar says the keys in words. node --test plugin/panes/test
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import '../../draw/kit.js'
import { gridText, renderTerm } from '../../draw/term.js'
import { runProgram } from '../../draw/sandbox-node.mjs'
import PANES from '../index.js'
import { barText, keyEvent, keysOf, nextState, route, takes } from '../host.js'

const DK = globalThis.DrawKit
const run = (pane, data, o = {}) => DK.run(pane.program, data, { w: 100, h: 30, mode: 'pane', ...o })
/** One surface's turn: the event answered, the new state kept. */
const act = (pane, data, state, event, surface, o = {}) => {
  const d = run(pane, data, { state, event, surface, ...o })
  return { d, state: nextState(state, d) }
}

// ---------------------------------------------------------------- chips
const REC = { text: 'Mostly [6,543 saves](q1#day=2026-06-18@n) on June 18.\n\nThe rest spread out.', shown: null, verbs: {}, squeeze: { at: {} } }
const chipsData = (rec = REC, w = 100) => PANES.chips.data({ 'record:r1': rec, 'sqz:r1': null }, { row: 'r1' }, { w, h: 3 })

test('chips: keys pick and change a chip; the rewrite is the host\'s action; the same presses in both surfaces', () => {
  const data = chipsData()
  const d0 = run(PANES.chips, data)
  // no key reads as an arrow key: [ ] move the picked chip, in its words, and a digit picks a chip (drawn before it)
  assert.equal(barText([d0]), '[ ] shorter / longer · 1–3 pick chip · 0 close · s done')
  assert.match(gridText(renderTerm(d0, { w: 100 })), /1 Length ○○○● full\s+2 Report ↔ Interpret ○●○ balanced\s+3 Familiarity/)
  let { d, state } = act(PANES.chips, data, {}, keyEvent('['), 'terminal')
  // the step names the key the bar names, so a rewrite that fails says which key tries again
  assert.deepEqual(d.effects, [{ row: 'r1', at: { length: 2 }, key: '[', do: 'squeeze' }])
  // < and , still change, unnamed, and name [ for a retry too
  assert.deepEqual(act(PANES.chips, data, {}, keyEvent('<'), 'terminal').d.effects, [{ row: 'r1', at: { length: 2 }, key: '[', do: 'squeeze' }])
  ;({ d, state } = act(PANES.chips, data, state, keyEvent('2'), 'terminal'))
  assert.equal(state.focus, 'interpret')
  assert.equal(barText([d]), '[ ] more report / more interpret · 1–3 pick chip · 0 close · s done')
  // a press on a dot in the browser sets that level at once
  const web = act(PANES.chips, data, state, { type: 'press', region: 'lvl-familiarity-4' }, 'browser')
  assert.deepEqual(web.d.effects, [{ row: 'r1', at: { familiarity: 4 }, do: 'squeeze' }])
  assert.equal(web.state.focus, 'familiarity')
  // + is no key of the chips
  assert.equal(takes(run(PANES.chips, data), keyEvent('+')), false)
})

test('chips: a change on its way shows at once from the record (squeeze.want), and the bar says it is rewriting', () => {
  const data = chipsData({ ...REC, squeeze: { at: {}, want: { length: 1 } } })
  const d = run(PANES.chips, data)
  assert.match(gridText(renderTerm(d, { w: 100 })), /Length ○●○○ short/)
  assert.equal(d.status.text, 's ● rewriting…')
})

test('chips on a catch-up: 0 dismisses it, no step lands on its original (the replies above it), and the bar names its replies, never lines', () => {
  const CU = { ...REC, shown: 'Mostly [6,543 saves](q1#day=2026-06-18@n).', catchup: { host: 'r0', rows: ['r0'], replies: 3, question: 'when?', prompt: 'p0' }, squeeze: { at: { length: 1 } } }
  const data = chipsData(CU)
  const d0 = run(PANES.chips, data)
  assert.equal(barText([d0]), '[ ] shorter / longer · 1–3 pick chip · 0 dismiss · s done')
  assert.equal(d0.status.text, 's ● catch-up of 3 replies')
  assert.deepEqual(act(PANES.chips, data, {}, keyEvent(']'), 'terminal').d.effects, [{ row: 'r1', at: { length: 2 }, key: ']', do: 'squeeze' }])
  // at medium, a step up would be its original: none, and a press on full's dot neither
  const medium = chipsData({ ...CU, squeeze: { at: { length: 2 } } })
  assert.deepEqual(act(PANES.chips, medium, {}, keyEvent(']'), 'terminal').d.effects || [], [])
  assert.deepEqual(act(PANES.chips, medium, {}, { type: 'press', region: 'lvl-length-3' }, 'browser').d.effects || [], [])
  // with another chip moved, full is a rewrite like any other
  const moved = chipsData({ ...CU, squeeze: { at: { length: 2, familiarity: 1 } } })
  assert.deepEqual(act(PANES.chips, moved, {}, keyEvent(']'), 'terminal').d.effects, [{ row: 'r1', at: { length: 3, familiarity: 1 }, key: ']', do: 'squeeze' }])
  assert.deepEqual(act(PANES.chips, data, {}, keyEvent('0'), 'terminal').d.effects, [{ row: 'r1', do: 'dismiss' }])
  // its first version on its way
  const writing = run(PANES.chips, chipsData({ ...CU, shown: null, squeeze: { at: {}, want: { length: 1 } } }))
  assert.equal(writing.status.text, 's ● writing the catch-up of 3 replies…')
  assert.match(gridText(renderTerm(writing, { w: 100 })), /Length ○●○○ short/)
})

// ---------------------------------------------------------------- the card detail
const OBJECT = {
  id: '01-saves', version: 2, title: 'Saves per day', text: 'June 18 had [6,543](#day-2026-06-18) saves.', history: [{ v: 1 }, { v: 2 }],
  program: "k.examples('ex-18', { label: 'saves on Jun 18', total: 3, records: [{ text: 'Hello agents' }, { text: 'Put it back' }] }); return k.stack(k.region('day-2026-06-17', { label: 'Jun 17' }, k.bar(4, { max: 9 })), k.region('day-2026-06-18', { label: 'Jun 18', examples: 'ex-18' }, k.bar(9, { max: 9 })))",
  data: {},
}
const detailData = () => {
  const drawing = runProgram(OBJECT, { w: 80, h: 20, mode: 'detail' })
  return PANES.detail.data({ 'card:01-saves': { object: OBJECT, drawing, versions: [{ v: 1 }, { v: 2 }], v: 2, state: {}, thread: true } }, { id: '01-saves' }, { w: 90, h: 30 })
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
  assert.equal(barText([run(PANES.detail, data)]), '↑↓ part · ↵ details · e examples · p program · h earlier version · esc back')
  // the browser has no o: it is the browser
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
  const bar = { label: 'thimble', left: [{ key: 'v', words: 'visualize' }, { key: 's', words: '● 6 of 24 lines', short: '● squeeze' }, { key: ']', words: 'cite & explain' }, { key: '1', words: 'open detail' }], counts: [{ id: 'threads', text: '2 threads' }, { id: 'cov', text: 'coverage 34%' }] }
  const at = w => barLine(fitBar(bar, w))
  assert.equal(at(200), 'thimble  v visualize · s ● 6 of 24 lines · ] cite & explain · 1 open detail   2 threads · coverage 34%')
  // the counts go first, coverage last
  assert.ok(at(90).endsWith('coverage 34%') && !at(90).includes('threads'))
  assert.ok(!at(70).includes('coverage'))
  // then the words: each key keeps its first word (a lit verb its dot and name)
  assert.equal(at(50), 'v visualize · s ● squeeze · ] cite · 1 open')
  for (const w of [200, 140, 110, 90, 75, 60]) assert.ok(at(w).length <= w, `${w}: ${at(w)}`)
  // narrower than the shortest form: the last form, marked to be cut at its end (never a second line)
  const narrow = fitBar(bar, 30)
  assert.equal(narrow.cut, true)
  assert.ok(!barLine(narrow).includes('\n'))
})

test('a status in the bar is cut at its end, never to its first word, and the keys keep their words longest', async () => {
  const { barLine, fitBar } = await import('../host.js')
  const status = '! "55" is not in the original, so it shows as plain words'
  const bar = { label: 'thimble', left: [{ key: '', words: status, tone: 'warning', status: true }, { key: '[ ]', words: 'change' }, { key: '1–3', words: 'chip' }, { key: '0', words: 'original' }, { key: 's', words: 'done' }], counts: [{ id: 'cites', text: '22 cites' }, { id: 'threads', text: '19 threads' }] }
  const at = w => barLine(fitBar(bar, w))
  assert.equal(at(200), `thimble  ${status} · [ ] change · 1–3 chip · 0 original · s done   22 cites · 19 threads`)
  // short of room: the counts go, then the status is cut at its end and every key keeps its words
  const mid = at(110)
  assert.ok(mid.length <= 110, mid)
  assert.ok(mid.startsWith('thimble  ! "55" is not in'), mid)
  assert.ok(mid.includes('…'), mid)
  assert.ok(mid.endsWith('[ ] change · 1–3 chip · 0 original · s done'), mid)
  assert.ok(!/! "55 ·/.test(mid) && !/! "55$/.test(mid), mid)
  for (const w of [200, 140, 110, 90, 80]) assert.ok(at(w).length <= w, `${w}: ${at(w)}`)
})

test('keys in a row of digits read as a range; the keys a host keeps where a card is drawn say why', async () => {
  const { hostKeys } = await import('../host.js')
  assert.deepEqual(keysOf({ on: [{ name: '2', label: 'open' }, { name: '3', label: 'open' }, { name: '4', label: 'open' }] }), [{ key: '2–4', words: 'open' }])
  const inline = hostKeys('inline', 'terminal')
  for (const k of ['0', '1', ']', '[', 'esc', 'return', 'up']) assert.ok(inline[k], k)
  assert.ok(!inline.c && !inline.v, 'letters reach a focused card')
  // ← and → never reach the prompt's hook in an empty prompt: Claude Code keeps them (← opens its agents view)
  assert.ok(inline.left && inline.right, '← → stay with Claude Code')
  const detail = hostKeys('detail', 'terminal')
  assert.ok(detail.esc && detail.up && detail['0'] && !detail[']'])
})

test('local state: a hover and a replay stay on the surface they were set on; the rest is shared', async () => {
  const { joinShared, localKeys, shared } = await import('../host.js')
  const pane = { local: ['replay'], program: k => { k.local('hover'); return k.text('x') } }
  const d = run(pane, {})
  assert.deepEqual(localKeys(d, pane).sort(), ['hover', 'replay'])
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
  // 1 asks: the host opens the card in the side panel as the mark's thread (the question is typed in its input bar)
  assert.deepEqual(act(PANES.tray, data, { stack: [f0] }, keyEvent('1'), 'terminal').d.effects, [{ do: 'thread', frame: { ...f0, open: null } }])
  // a mark with a thread says so, and 1 opens it
  const withThread = PANES.tray.data({ threads: [{ key: 'mark-r1-q3-day-2026-06-18-n', turns: [{ role: 'person', text: 'why so high?' }] }] })
  const t = run(PANES.tray, withThread, { state: { stack: [f0] }, w: 70, got })
  assert.match(gridText(renderTerm(t, { w: 70 })), /↳ thread: why so high\? · 1 opens it/)
  assert.equal(barText([t]), '1 thread · 2 3 open · 0 close · ] next')
})

test('tray: a citation opens on its most readable form; each section the card names (r rows, c code) is a key away in the same panel, never shown first', async () => {
  const { markedPart } = await import('../tray.js')
  const f0 = { row: 'r1', i: 0, kind: 'cite', ref: 'q3#day=2026-06-18@n', label: '6,543' }
  const data = PANES.tray.data({ threads: [] })
  const key = run(PANES.tray, data, { state: { stack: [f0] }, w: 70 }).wants[0].key
  const text = s => globalThis.DrawKit.run(`return k.text(${JSON.stringify(s)})`, {}, { w: 60 })
  const got = { [key]: { drawings: [text('day 06-18 6,543')], sections: [{ id: 'rows', key: 'r', words: 'rows', drawings: [text('L28 a save')] }, { id: 'code', key: 'c', words: 'code', drawings: [text('tally(df, "day")')] }], links: [] } }
  const full = run(PANES.tray, data, { state: { stack: [f0] }, w: 70, got })
  const shown = gridText(renderTerm(full, { w: 70 }))
  assert.match(shown, /day 06-18 6,543/)
  assert.doesNotMatch(shown, /tally|L28/)
  assert.equal(barText([full]), '1 ask · r rows · c code · 0 close · ] next')
  // c shows the code in place of the card, in the same panel; the frame says which; c again or 0 brings the card back
  const code = act(PANES.tray, data, { stack: [f0] }, keyEvent('c'), 'terminal', { got, w: 70 })
  assert.equal(code.state.stack.at(-1).open, 'code')
  const drawn = run(PANES.tray, data, { state: code.state, w: 70, got })
  assert.match(gridText(renderTerm(drawn, { w: 70 })), /6,543.*cite · code[\s\S]*tally\(df, "day"\)/)
  assert.doesNotMatch(gridText(renderTerm(drawn, { w: 70 })), /day 06-18 6,543/)
  assert.equal(barText([drawn]), '1 ask · r rows · c code · 0 back · ] next')
  assert.equal(act(PANES.tray, data, code.state, keyEvent('c'), 'terminal', { got, w: 70 }).state.stack.at(-1).open, null)
  assert.equal(act(PANES.tray, data, code.state, keyEvent('0'), 'terminal', { got, w: 70 }).state.stack.at(-1).open, null)
  assert.equal(act(PANES.tray, data, code.state, keyEvent('r'), 'terminal', { got, w: 70 }).state.stack.at(-1).open, 'rows')
  // a value of a card: the card itself, the part that holds the value selected as a part is
  const card = globalThis.DrawKit.run("return k.stack(k.region('day-06-17', { ref: 'q1#day=06-17' }, k.text('06-17 870')), k.region('day-06-18', { ref: 'q1#day=06-18' }, k.text('06-18 132')))", {}, { w: 60 })
  assert.equal(markedPart(card, ['obj:x#/days/1', 'q1#day=06-18']), 'day-06-18')
  assert.equal(markedPart(card, ['q9']), null)
  const marked = run(PANES.tray, data, { state: { stack: [f0] }, w: 70, got: { [key]: { drawings: [card], sections: [], mark: ['q1#day=06-18'], links: [] } } })
  assert.equal(marked.selected, 'day-06-18')
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

test('the keys Claude Code keeps never reach a program in the terminal: ← and → among them, so no bar names them there', async () => {
  const { hostKeys } = await import('../host.js')
  for (const mode of ['inline', 'detail']) {
    assert.ok('left' in hostKeys(mode, 'terminal') && 'right' in hostKeys(mode, 'terminal'), mode)
    // the browser's page gets them
    assert.ok(!('left' in hostKeys(mode, 'browser')), mode)
  }
})

// ---------------------------------------------------------------- the side panel's panes
test('threads: the list is a tree under main, the newest first; the selected thread is the pane\'s thread; ↵ or a press on the selected row opens it', async () => {
  const { rowsOf, selectedOf, ago } = await import('../threads.js')
  const now = Date.parse('2026-10-20T12:00:00Z')
  const list = [
    { key: 'mark-r1-q3', name: 'main/6,543 saves', status: 'running', asks: 1, at: '2026-10-20T11:59:30Z', turns: [{ role: 'person', text: 'why so high?' }] },
    { key: 'card-01-saves', name: 'main/Saves per day', status: 'done', asks: 2, at: '2026-10-20T11:40:00Z', turns: [{ role: 'person', text: 'why?' }, { role: 'claude', text: 'x' }, { role: 'person', text: 'and the day before?' }] },
  ]
  assert.equal(ago('2026-10-20T11:40:00Z', now), '20m')
  const data = { rows: rowsOf(list, now) }
  assert.deepEqual(data.rows.map(r => [r.name, r.asks, r.last]), [['main/6,543 saves', 1, 'why so high?'], ['main/Saves per day', 2, 'and the day before?']])
  // nothing chosen yet: the newest is selected, and the pane's thread is it
  assert.equal(selectedOf({}, data), 'mark-r1-q3')
  assert.deepEqual(PANES.threads.thread({}, {}, data), { key: 'mark-r1-q3' })
  assert.equal(PANES.threads.thread({}, {}, { rows: [] }), null)
  const d = run(PANES.threads, data, { w: 70 })
  const text = gridText(renderTerm(d, { w: 70 }))
  assert.match(text, /main\n[\s\S]*├─ main\/6,543 saves +answering…[\s\S]*why so high\?[\s\S]*└─ main\/Saves per day +2 questions · 20m/)
  assert.equal(d.selected, 't0')
  // the ring onto the second row selects it; a press on the selected row (or ↵) opens it
  const moved = act(PANES.threads, data, {}, { type: 'focus', region: 't1' }, 'terminal', { w: 70 })
  assert.equal(moved.state.sel, 'card-01-saves')
  assert.deepEqual(act(PANES.threads, data, moved.state, { type: 'press', region: 't1' }, 'terminal', { w: 70 }).d.effects, [{ do: 'open', thread: 'card-01-saves' }])
  assert.deepEqual(act(PANES.threads, data, moved.state, keyEvent('return'), 'terminal', { w: 70 }).d.effects, [{ do: 'open', thread: 'card-01-saves' }])
  assert.match(gridText(renderTerm(run(PANES.threads, { rows: [] }, { w: 70 }), { w: 70 })), /No threads yet/)
})

test('mark: a citation in the side panel is the tray\'s card at the panel\'s width; its thread is the mark\'s own; ] [ step a message\'s marks, a citation inside opens over it', async () => {
  const { scopeOf } = await import('../tray.js')
  const { threadKey } = await import('../../shell/threads.js')
  const f0 = { row: 'r1', i: 0, kind: 'cite', ref: 'q3#day=2026-06-18@n', label: '6,543' }
  // one thread per mark: the same as the tray's
  assert.deepEqual(PANES.mark.thread({ frame: f0 }), { scope: scopeOf(f0), label: '6,543', refs: ['q3#day=2026-06-18@n'] })
  assert.equal(threadKey(PANES.mark.thread({ frame: f0 }).scope), 'mark-r1-q3-day-2026-06-18-n')
  assert.equal(PANES.mark.titleOf({ frame: f0 }), 'Cite · 6,543')
  const data = PANES.mark.data({}, { frame: f0 })
  const d = run(PANES.mark, data, { w: 70 })
  assert.equal(d.wants[0].request.card.ref, 'q3#day=2026-06-18@n')
  const inner = globalThis.DrawKit.run('return k.text("Jun 18 **6,543**")', {}, { w: 60 })
  const got = { [d.wants[0].key]: { drawings: [inner], links: [{ id: 'n1', ref: 'q1#user=A@n', label: 'A' }] } }
  const full = run(PANES.mark, data, { w: 70, got })
  assert.match(gridText(renderTerm(full, { w: 70 })), /6,543[\s\S]*Jun 18 6,543/)
  assert.equal(barText([full]), '2 open · ] next')
  assert.deepEqual(act(PANES.mark, data, {}, keyEvent(']'), 'terminal', { got, w: 70 }).d.effects, [{ dir: 1, do: 'step' }])
  assert.deepEqual(act(PANES.mark, data, {}, keyEvent('2'), 'terminal', { got, w: 70 }).d.effects, [{ do: 'open', mark: { kind: 'cite', ref: 'q1#user=A@n', label: 'A' } }])
  // a citation opened from an answer (no message): no stepping
  const loose = run(PANES.mark, PANES.mark.data({}, { frame: { kind: 'cite', ref: 'q2#n', label: '2,994' } }), { w: 70 })
  assert.ok(!loose.on.some(h => h.name === ']'))
})
