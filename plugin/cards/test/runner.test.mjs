// The card runner (cards/runner.mjs), started as the hooks start it: a card loads, keys, presses and clicks reach it,
// and its state comes back; a view's error and time-out; a drawing no larger than Claude Code draws; actions and the
// card put back after them; and the sandbox around a view, which keeps it from the runner, the files and other cards.
// All rows are made up.
//   node --test plugin/cards/test/runner.test.mjs
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { startRunner } from './start.mjs'

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
  assert.deepEqual(r3.tree.c[0].c, ['a\\x80b\\x07c d'])
})

test('a card is no larger than Claude Code draws: too large with a Button around each run, it draws without them; too large even so, it does not draw and says what to change', async () => {
  // `n` dots, a Text each, 30 to a row: a small tree, but the Client puts a Button around each dot (drawn.js)
  const dots = n => `function view(p, s) {
  const { Box, Text } = s.elements
  const rows = []
  for (let i = 0; i < ${n}; i += 30) {
    const marks = []
    for (let j = i; j < Math.min(${n}, i + 30); j++) marks.push(Text({ color: j % 3 ? '#67cda8' : '#f59183', children: '●' }))
    rows.push(Box({ flexDirection: 'row', children: [Text({ children: 'run ' + (i + 1) + ' ' }), ...marks] }))
  }
  return Box({ flexDirection: 'column', children: rows })
}`
  let { r } = await load(dots(30))
  assert.equal(r.ok, true, r.error)
  assert.equal(r.tree.p.bare, undefined)
  ;({ r } = await load(dots(600)))
  assert.equal(r.ok, true, r.error)
  assert.equal(r.tree.p.bare, true)
  ;({ r } = await load(dots(3000)))
  assert.equal(r.ok, false)
  assert.match(r.error, /^the drawing is [\d,]+ characters as Claude Code holds it, and a card draws at most 95,000; draw fewer elements: group the rows, or show a page of them$/)
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
  assert.match(r.copies[3].note, /no line shows "no such button"/)
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
