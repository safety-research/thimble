// The card runner (cards/runner.mjs), started as the hooks start it: a view's error and time-out, state, keys, presses,
// clicks, the search, actions and the card put back after them, and the sandbox around a view. All rows are made up.
//   node --test plugin/cards/test/runner.test.mjs
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { startRunner } from './start.mjs'
import { checkView } from '../runner.mjs'

let dir
let runner

const ask = (op, body) => runner.ask(op, body)

const ROWS = [{ name: 'ada', score: 3 }, { name: 'bram', score: 5 }, { name: 'cleo', score: 1 }]
const COUNTER = `const keys = "+r"
function onKey(k, s) { const st = s.state || { n: 0 }; if (k === '+') s.setState({ n: st.n + 1 }); if (k === 'r') s.setState({ n: 0 }) }
function view(props, surface) {
  const { Box, Text, Button } = surface.elements
  const st = surface.state || { n: 0 }
  surface.onPointer(e => { if (e.type === 'up') surface.setState({ ...st, at: e.x + ',' + e.y }) })
  const rows = st.n >= 7 ? props.rows.filter(r => r.score < 3) : props.rows
  return Box({ flexDirection: 'column', children: [
    Text({ children: 'count ' + st.n + (st.at ? ' clicked ' + st.at : '') }),
    ...rows.map(r => Text({ children: r.name + ' ' + r.score })),
    Button({ onPress: () => surface.setState({ ...st, n: st.n + 10 }), children: 'add ten' }),
  ] })
}`

let n = 0
async function load(view, extra = {}) {
  const id = `c${(++n).toString(16).padStart(8, '0')}`
  const r = await ask('load', { id, version: 1, title: 'Scores', view, rows: join(dir, 'rows.json'), width: 40, ...extra })
  return { id, r }
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'thimble-runner-'))
  writeFileSync(join(dir, 'rows.json'), JSON.stringify(ROWS))
  runner = await startRunner(dir)
})

after(() => {
  runner?.stop()
  rmSync(dir, { recursive: true, force: true })
})

test('a card loads: its text copy, what it read, and its keys', async () => {
  const { r } = await load(COUNTER)
  assert.equal(r.ok, true)
  assert.deepEqual(r.lines, ['count 0', 'ada 3', 'bram 5', 'cleo 1', '[ add ten ]'])
  assert.deepEqual(r.summary, { rows: 3, read: '3 rows', columns: ['name', 'score'], first: '{"name":"ada","score":3}' })
  assert.equal(r.keys, '+r')
})

test('a key, a press and a click reach the view, and the state comes back to keep', async () => {
  const { id } = await load(COUNTER)
  let r = await ask('key', { id, key: '+' })
  assert.equal(r.handled, true)
  assert.deepEqual(JSON.parse(r.state), { n: 1 })
  const button = r.tree.c.find(x => x.t === 'Button').p.onPress
  r = await ask('press', { id, button })
  assert.deepEqual(JSON.parse(r.state), { n: 11 })
  r = await ask('pointer', { id, down: { x: 2, y: 1 }, up: { x: 2, y: 1 } })
  assert.equal(r.handled, true)
  // a view that reads clicks by cell says so in its tree, so the Client leaves its clicks to it (client.tsx)
  assert.equal(r.tree.p.cells, true)
  r = await ask('copy', { id, width: 40 })
  assert.equal(r.lines[0], 'count 11 clicked 2,1')
})

// A sentence that fits the card and wraps on its own line where a side pane narrows the card reads the same there: the
// call brings no narrower copy back for it, so the answer gives no reason for a new version. Parts side by side that
// wrap do (a row of Texts in a Box laid across).
test('a sentence that wraps at the narrower width alone brings no copy back; parts side by side that wrap there do', async () => {
  const sentence = `function view(p, s) { const { Box, Text } = s.elements
  return Box({ flexDirection: 'column', children: [
    Text({ children: 'Failures jump after the change on the 21st, from five of twenty to all of them.' }),
    Text({ children: 'ada 3' }),
  ] }) }`
  const one = await load(sentence, { width: 90, beside: 40 })
  assert.equal(one.r.ok, true)
  assert.equal(one.r.beside, undefined)
  const parts = sentence.replace("Text({ children: 'ada 3' }),", "Box({ children: [Text({ children: 'ada' }), Text({ children: ' 3 of 9 merged, the longest run of the afternoon by far' })] }),")
  const two = await load(parts, { width: 90, beside: 40 })
  assert.equal(two.r.beside.wrapped.length, 1)
  assert.match(two.r.beside.lines[two.r.beside.wrapped[0] - 1], /3 of 9 merged/)
})

test('the tree holds only what Claude Code draws: a Button of words, and strings with no control character', async () => {
  const boxed = 'function view(p, s) { const { Box, Text, Button } = s.elements; return Text({ children: Box({ children: Text({ children: "x" }) }) }) }'
  const r1 = (await load(boxed)).r
  assert.equal(r1.ok, false)
  assert.match(r1.error, /a Text holds <Box>/)
  const empty = 'function view(p, s) { const { Button } = s.elements; return Button({ onPress: () => {} }) }'
  assert.match((await load(empty)).r.error, /a Button has no words/)
  const ctrl = 'function view(p, s) { const { Text } = s.elements; return Text({ children: "a\\u0080b\\u0007c\\td" }) }'
  const r3 = (await load(ctrl)).r
  assert.equal(r3.ok, true)
  assert.deepEqual(r3.tree.c[0].c, ['abc d'])
})

test('a file that is an object gives its rows as props.rows and the whole object as props.data; each answer has a newer seq', async () => {
  writeFileSync(join(dir, 'obj.json'), JSON.stringify({ rows: [{ a: 1 }], meta: { total: 9 } }))
  const view = 'function view(p, s) { return s.elements.Text({ children: p.rows.length + " of " + p.data.meta.total }) }'
  const r = await ask('load', { id: 'c0000aaaa', version: 1, title: 'T', view, rows: join(dir, 'obj.json'), width: 40 })
  assert.deepEqual([r.lines, r.summary.other], [['1 of 9'], ['meta']])
  const again = await ask('draw', { id: 'c0000aaaa', width: 40 })
  assert.ok(again.seq > r.seq)
  // an object of parts with no "rows" list draws from props.data, and props.rows is empty
  writeFileSync(join(dir, 'parts.json'), JSON.stringify({ hist: [1, 2], growth: [3] }))
  const parts = 'function view(p, s) { return s.elements.Text({ children: p.rows.length + " " + p.data.hist.length + " " + p.data.growth.length }) }'
  const r2 = await ask('load', { id: 'c0000aaab', version: 1, title: 'T', view: parts, rows: join(dir, 'parts.json'), width: 40 })
  assert.deepEqual([r2.ok, r2.lines, r2.summary.other, r2.summary.hasRows, r2.summary.read], [true, ['0 2 1'], ['hist', 'growth'], false, 'an object with hist (2), growth (1)'])
})

test('a card loads again with the state it kept', async () => {
  const { r } = await load(COUNTER, { state: { n: 7 } })
  assert.deepEqual(r.lines.slice(0, 2), ['count 7', 'cleo 1'])
})

test('actions give a copy after each, then the card is as it was', async () => {
  const { id } = await load(COUNTER)
  await ask('key', { id, key: '+' })
  const r = await ask('act', { id, width: 40, actions: [{ key: '+' }, { click: 'add ten' }, { click: [0, 0] }, { click: 'no such button' }, { key: 'x' }] })
  assert.equal(r.ok, true)
  assert.deepEqual(r.copies.map(c => c.lines?.[0]), ['count 2', 'count 12', 'count 12 clicked 0,0', 'count 12 clicked 0,0', 'count 12 clicked 0,0'])
  assert.match(r.copies[3].note, /no Button shows "no such button"/)
  assert.deepEqual(JSON.parse(r.state), { n: 1 })
})

test('a view that fails says where; a view that runs too long is stopped and leaves the runner, to load again', async () => {
  let { r } = await load('function view(props) { return props.rows[99].name }')
  assert.equal(r.ok, false)
  assert.match(r.error, /^line 1: .*name/)
  ;({ r } = await load('function view( {'))
  assert.match(r.error, /does not parse/)
  ;({ r } = await load('function view() { while (true) {} }'))
  assert.match(r.error, /ran past its 5 s limit/)
  const { id } = await load(`const keys = "x"
function onKey(k, s) { if (k === 'x') { while (true) {} } }
function view(p, s) { return s.elements.Text({ children: 'ok' }) }`)
  const k = await ask('key', { id, key: 'x' })
  assert.match(k.error, /ran past its 1 s limit/)
  // the time limit stopped the view part way, so the runner holds the card no more: the hooks load it again
  assert.equal((await ask('copy', { id, width: 20 })).missing, true)
  assert.equal((await ask('draw', { id: 'c0000ffff', width: 20 })).missing, true)
})

test('a drawing too big at one width leaves the runner, and the card loads again at its width with its state', async () => {
  const view = `const keys = "+"
function onKey(k, s) { s.setState({ n: ((s.state || {}).n || 0) + 1 }) }
function view(p, s) { return s.elements.Text({ children: 'n ' + ((s.state || {}).n || 0) + ' ' + (s.columns === 30 ? 'x'.repeat(96000) : '') }) }`
  const { id } = await load(view)
  const k = await ask('key', { id, key: '+' })
  assert.equal(k.state, '{"n":1}')
  const big = await ask('draw', { id, width: 30 })
  assert.match(big.error, /more than 95000 characters/)
  assert.equal((await ask('key', { id, key: '+' })).missing, true)
  const again = await ask('load', { id, version: 1, title: 'Scores', view, rows: join(dir, 'rows.json'), width: 40, state: { n: 1 } })
  assert.equal(again.ok, true)
  assert.equal((await ask('key', { id, key: '+' })).state, '{"n":2}')
})

test('at another width: a text copy leaves the card as it was, a row wider than a side pane leaves comes back with that copy, and a drawing that fails narrow leaves the card at its width with its keys and Buttons', async () => {
  // a text copy at another width leaves the card as it was: its width and its Buttons
  {
    const wide = `function view(p, s) { const { Box, Text, Button } = s.elements
    const st = s.state || { n: 0 }
    return Box({ flexDirection: 'column', children: [Text({ children: 'n ' + st.n }),
      s.columns > 30 ? Button({ onPress: () => s.setState({ n: st.n + 1 }), children: 'one' }) : Button({ onPress: () => s.setState({ n: st.n + 100 }), children: 'hundred' })] }) }`
    const { id, r } = await load(wide)
    const button = r.tree.c.find(x => x.t === 'Button').p.onPress
    assert.deepEqual((await ask('copy', { id, width: 20 })).lines, ['n 0', '[ hundred ]'])
    const p = await ask('press', { id, button })
    assert.deepEqual(JSON.parse(p.state), { n: 1 })
    assert.deepEqual((await ask('copy', { id })).lines, ['n 1', '[ one ]'])
  }
  // a row laid out wider than the width a side pane leaves the card comes back with that copy; a paragraph that wraps
  // at both widths does not
  {
    const view = `function view(p, s) { const { Box, Text } = s.elements
    return Box({ flexDirection: 'column', children: [
      Text({ children: '-'.repeat(s.columns) }),
      Text({ children: 'a paragraph of words that wraps at either width, so the person reads it as words' }),
      Text({ children: 'ada'.padEnd(12) + '3 of 9 merged'.padEnd(16) + '1.19 h run' }),
    ] }) }`
    const { r } = await load(view, { width: 40, beside: 24 })
    assert.equal(r.lines.length, 5)
    assert.deepEqual(r.beside.wrapped, [6])
    assert.equal(r.beside.width, 24)
    assert.deepEqual(r.beside.lines.slice(5), ['ada         3 of 9', 'merged   1.19 h run'])
    // the row fits at the narrower width too: nothing comes back
    const fits = await load(view.replace("'1.19 h run'", "''"), { width: 40, beside: 30 })
    assert.equal(fits.r.beside, undefined)
  }
  // a drawing that fails at a narrow width leaves the card at its width, with its keys and Buttons
  {
    const { id } = await load(`const keys = "+"
  function onKey(k, s) { s.setState({ n: ((s.state || {}).n || 0) + 1 }) }
  function view(p, s) {
    const { Box, Text, Button } = s.elements
    return Box({ flexDirection: 'column', children: [
      Text({ children: 'n ' + ((s.state || {}).n || 0) + ' ' + '-'.repeat(s.columns - 13) }),
      Button({ onPress: () => s.setState({ n: 100 }), children: 'hundred' }),
    ] })
  }`)
    const narrow = await ask('draw', { id, width: 12 })
    assert.equal(narrow.ok, false)
    assert.match(narrow.error, /Invalid count value/)
    // the card still draws at its width, takes its key, and its Button still presses
    const k = await ask('key', { id, key: '+' })
    assert.equal(k.ok, true)
    assert.equal(k.tree.c[0].c[0], `n 1 ${'-'.repeat(27)}`)
    assert.equal((await ask('press', { id, button: 0 })).ok, true)
    assert.equal((await ask('draw', { id, width: 40 })).ok, true)
  }
})

test('the sandbox: no process, require, import, fetch or timers, and no code from strings by any path', async () => {
  const probe = `function view(p, s) {
  const out = []
  const g = (function () { return this })()
  out.push(typeof g.require, typeof g.fetch, typeof g.setTimeout, typeof g.Buffer, typeof g.process)
  try { out.push(String((() => {}).constructor('return 1')())) } catch (e) { out.push('no Function') }
  try { out.push(String(s.constructor.constructor('return 1')())) } catch (e) { out.push('no Function') }
  try { out.push(String(Object.getPrototypeOf(async () => {}).constructor('return 1'))) } catch (e) { out.push('no AsyncFunction') }
  try { out.push(String(this.constructor.constructor('return 1')())) } catch (e) { out.push('no host') }
  return s.elements.Text({ children: out.join(' ') })
}`
  const { r } = await load(probe)
  assert.equal(r.ok, true, r.error)
  assert.equal(r.lines.join(' '), 'undefined undefined undefined undefined undefined no Function no Function no AsyncFunction no host')
  for (const bad of ['function view() { return process.env }', 'function view() { return require("fs") }', 'function view() { return import("fs") }', 'function view() { return eval("1") }', 'function view() { return globalThis }', 'function view() { return $.fs }']) {
    assert.equal((await load(bad)).r.ok, false, bad)
  }
})

test('a view cannot reach the runner, the prelude, or files outside the card', async () => {
  const { r } = await load(`function view(p, s) {
  const g = (function () { return this })()
  try { g.__thimble = null } catch (e) { /* refused */ }
  try { Object.defineProperty(g, '__thimble', { value: null }) } catch (e) { /* refused */ }
  return s.elements.Text({ children: typeof g.__thimble.call })
}`)
  assert.equal(r.ok, true, r.error)
  assert.equal(r.lines[0], 'function')
  const out = await ask('load', { id: 'c0000fffe', version: 1, title: 'x', view: 'function view(p, s) { return s.elements.Text({ children: "x" }) }', rows: '/etc/passwd', width: 20 })
  assert.equal(out.ok, false)
  assert.match(out.error, /cannot be read/)
})

test('the static check names what a view must not hold, and leaves words in strings and comments alone', () => {
  assert.deepEqual(checkView('function view() { return "import process eval( Function(" } // require'), [])
  assert.deepEqual(checkView('const x = 1'), ['define `function view(props, surface)`'])
  assert.ok(checkView('function view() { return import("x") }').some(s => /import/.test(s)))
  // a regular expression is no code: its `$` and its words are not checked, a division still is code
  assert.deepEqual(checkView('function view(p) { const a = 4 / 2 / 1; return "x in 2s".replace(/ in [\\d.]+s$|process/, "") }'), [])
})

test('the cards undo the last keys they took, and only those', async () => {
  const { id } = await load(COUNTER)
  await ask('key', { id, key: '+' })
  await ask('key', { id, key: '+' })
  await ask('key', { id, key: '+' })
  const back = await ask('undo', { id, n: 2 })
  assert.equal(JSON.parse(back.state).n, 1)
  // a press ends what can be undone
  await ask('press', { id, button: 0 })
  const kept = await ask('undo', { id, n: 1 })
  assert.equal(JSON.parse(kept.state).n, 11)
})

test("a view's stray rejected promise or async error does not take the runner down for other cards", async () => {
  // a bare Promise.reject, and an async built-in whose rejection no one awaits: Node would make each a fatal
  // unhandledRejection, ending the one runner for every card; the runner swallows a card's own async failure.
  for (const bad of [
    'function view(p, s) { Promise.reject(new Error("x")); return s.elements.Text({ children: "ok" }) }',
    'function view(p, s) { WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0])); return s.elements.Text({ children: "ok" }) }',
  ]) {
    const { r } = await load(bad)
    assert.equal(r.ok, true, r.error)
  }
  // a key handler that leaves a rejected promise, too
  const { id } = await load('const keys = "x"\nfunction onKey(k, s) { Promise.reject("boom") }\nfunction view(p, s) { return s.elements.Text({ children: "ok" }) }')
  await ask('key', { id, key: 'x' })
  // the runner still answers after every one of these
  assert.equal((await ask('ping', {})).ok, true)
  assert.deepEqual((await load(COUNTER)).r.lines, ['count 0', 'ada 3', 'bram 5', 'cleo 1', '[ add ten ]'])
})
