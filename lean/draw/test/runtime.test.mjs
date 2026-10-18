// The card runtime's tests: lineage carried by itself, interaction state and events, ask(selection), the sandbox's
// budgets and its one-line fallback, and a title for every card. node --test lean/draw/test
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runProgram } from '../sandbox-node.mjs'
import { renderSvg } from '../svg.js'
import { gridText, renderTerm } from '../term.js'

// data as the kernel binds it: each row of a query's output with its own ref and its source rows
const DATA = {
  outcomes: [
    { outcome: 'won (clean ep)', n: 3, median: 110, _ref: 'q11#outcome=won-clean-ep', _rows: ['runs.jsonl#L1-3'] },
    { outcome: 'lost (clean ep)', n: 2, median: 135, _ref: 'q11#outcome=lost-clean-ep', _rows: ['runs.jsonl#L4-5'] },
    { outcome: 'failed/adversarial', n: 4, median: 165, _ref: 'q11#outcome=failed/adversarial', _rows: ['runs.jsonl#L6-9'] },
  ],
  runs: [
    { run: 'ep01', lang: 'Rust', calls: 143, _ref: 'q12#run=ep01', _rows: ['runs.jsonl#L1'] },
    { run: 'ep02', lang: 'Go', calls: 152, _ref: 'q12#run=ep02', _rows: ['runs.jsonl#L2'] },
    { run: 'ep03', lang: 'Rust', calls: 201, _ref: 'q12#run=ep03', _rows: ['runs.jsonl#L3'] },
  ],
}
const run = (program, opts = {}) => runProgram({ id: '07-outcomes', title: 'How the episodes ended', program, data: DATA }, { w: 80, h: 24, ...opts })
const meta = (d, id) => (d.regions.find(r => r.id === id) || {}).meta || {}

test('a part drawn from a row of the data opens that row, with no ref written by the program', () => {
  // bars made by spreading rows, a table of rows, a region whose meta is {row}: each part carries its row's own ref
  const d = run(`
    const bars = k.bars(data.outcomes.map(o => ({ ...o, label: o.outcome, value: o.n })))
    const table = k.table(data.runs, { cols: ['run', 'lang', 'calls'] })
    const one = k.region('slowest', { label: 'the slowest run', row: data.runs[2] }, k.text('ep03 took 201 calls'))
    return k.stack(bars, table, one)`)
  assert.equal(d.error, undefined, d.error && d.error.message)
  assert.equal(meta(d, 'won-clean-ep').ref, 'q11#outcome=won-clean-ep', 'a bar with a punctuated key: its id is the slug, its ref the row\'s')
  assert.equal(meta(d, 'outcome-failed-adversarial').ref ?? meta(d, 'failed-adversarial').ref, 'q11#outcome=failed/adversarial')
  assert.equal(meta(d, 'run-ep02').ref, 'q12#run=ep02', 'a table row of the data is a part by itself')
  assert.equal(meta(d, 'slowest').ref, 'q12#run=ep03')
  assert.ok(!('row' in meta(d, 'slowest')), 'the row itself is not copied into the drawing')
  // the kernel's fields are lineage, never columns
  assert.doesNotMatch(gridText(renderTerm(d, { w: 80 })), /_ref|_rows|runs\.jsonl/)
})

test('a part the program drew from values alone is matched to the rows whose words it shows', () => {
  const d = run(`
    const rust = data.runs.filter(r => r.lang === 'Rust')
    return k.stack(
      k.region('lang-rust', { label: 'Rust' }, k.text('Rust: ' + rust.length + ' runs')),
      k.region('ep02', {}, k.text('ep02 · 152 calls')),
      k.region('total', { label: 'all runs' }, k.text('3 runs in all')))`)
  assert.equal(meta(d, 'ep02').ref, 'q12#run=ep02', 'one row holds these words: its ref')
  assert.equal(meta(d, 'ep02').lineage, 'matched')
  assert.equal(meta(d, 'lang-rust').ref, 'q12#lang=Rust', 'rows of one query that share the words are one group')
  assert.equal(meta(d, 'total').ref, undefined, 'no words in common: no guess')
})

test('a key or a press reaches the program; its handler sets the state the next run draws with', () => {
  const program = `
    const i = k.state.i ?? 0
    const r = data.runs[i]
    k.on('j', () => ({ i: Math.min(i + 1, data.runs.length - 1) }), 'next run')
    k.on('k', () => ({ i: Math.max(i - 1, 0) }), 'previous run')
    return k.stack(
      k.text('**' + r.run + '** ' + r.calls + ' calls'),
      ...data.runs.map((x, j) => k.region('pick-' + x.run, { label: x.run, onPress: () => ({ i: j }) }, k.text(x.run))))`
  const first = run(program)
  assert.deepEqual(first.on.map(h => h.name).slice(0, 2), ['j', 'k'], 'the drawing names the keys its handlers take')
  assert.equal(first.on[0].label, 'next run')
  const next = run(program, { state: first.state, event: { type: 'key', key: 'j' } })
  assert.deepEqual(next.state, { i: 1 })
  assert.equal(next.handled, 'j')
  assert.match(gridText(renderTerm(next, { w: 80 })), /ep02 152 calls/)
  // a press on a part runs its onPress, the same as k.on('press:<id>')
  const pressed = run(program, { state: next.state, event: { type: 'press', region: 'pick-ep03' } })
  assert.deepEqual(pressed.state, { i: 2 })
  // the same program in the browser: the same state, the same drawing
  const svg = renderSvg(pressed, { w: 80 }).marks
  assert.equal(JSON.stringify(svg), JSON.stringify(renderTerm(pressed, { w: 80 }).marks))
  // a key no handler takes changes nothing
  assert.deepEqual(run(program, { state: { i: 1 }, event: { type: 'key', key: 'z' } }).state, { i: 1 })
})

test('ask(selection) from inside a card names what is selected and the rows behind it', () => {
  const program = `
    const sel = k.state.sel || []
    k.on('brush', e => {
      const runs = data.runs.filter(r => r.calls >= e.from && r.calls <= e.to)
      k.set('sel', runs.map(r => r.run))
      k.ask({ label: runs.length + ' runs with ' + e.from + '–' + e.to + ' calls', rows: runs })
    })
    k.on('a', () => k.ask())
    return k.plot([{ name: 'calls', points: data.runs.map((r, i) => [i, r.calls]) }], { h: 4 })`
  const d = run(program, { event: { type: 'brush', id: 'calls', from: 140, to: 160 } })
  assert.deepEqual(d.state, { sel: ['ep01', 'ep02'] })
  assert.deepEqual(d.ask, { label: '2 runs with 140–160 calls', refs: ['q12#run=ep01', 'q12#run=ep02'] })
  // with no selection of its own, ask() asks about the part the person acted on
  const e = run(program, { event: { type: 'key', key: 'a', region: 'calls' } })
  assert.deepEqual(e.ask, { region: 'calls', label: 'calls' })
  // ask outside a handler does nothing but warn: a card never opens a thread by drawing
  const quiet = run('k.ask({ label: "x" }); return k.text("hi")')
  assert.equal(quiet.ask, undefined)
  assert.ok(quiet.warnings.some(w => /k\.ask/.test(w)))
})

test('every error draws as one readable line under the title, with what to fix', () => {
  const cases = [
    ['return k.text(data.missing.field)', /could not draw: TypeError \(line 1\) · fix: a value is undefined where the program reads \.field/],
    ['return 1 +', /SyntaxError.*· fix: the program does not parse/],
    ['k.text("no return")', /ReturnError.*· fix: end the program with return/],
    ['return k.text(nope)', /ReferenceError.*· fix: nope is not defined: a program has only k and data/],
  ]
  for (const [program, want] of cases) {
    const d = run(program)
    const text = gridText(renderTerm(d, { w: 200 })).trim()
    assert.equal(text.split('\n').length, 1, `${program}: one line, not a box`)
    assert.match(text, /^× How the episodes ended could not draw:/)
    assert.match(text, want)
    assert.ok(d.error.fix, 'the fix is in the drawing for every host')
  }
})

test('the sandbox stops a program past its time or its size budget, and says so in one line', () => {
  const slow = run('while (true) {}', { limit: 100 })
  assert.equal(slow.error.name, 'TimeLimit')
  assert.match(gridText(renderTerm(slow, { w: 200 })), /× How the episodes ended could not draw: TimeLimit.*· fix: it ran past 100 ms/)
  const big = run('return k.stack(Array.from({ length: 3000 }, (_, i) => k.text("row " + i + " ".repeat(40))))', { maxBytes: 100000 })
  assert.equal(big.error.name, 'SizeLimit')
  assert.match(gridText(renderTerm(big, { w: 200 })), /SizeLimit: the drawing is .* MB, over the 0\.1 MB budget · fix: draw fewer parts/)
})

test('the card\'s title is in every drawing, even when the program draws none', () => {
  assert.equal(run('return k.text("3 runs")').title, 'How the episodes ended')
  const framed = runProgram({ program: 'return k.frame(k.text("x"), { title: "From the frame" })', data: {} }, { w: 40 })
  assert.equal(framed.title, 'From the frame')
  // the program reads it, and the surface it is drawn on
  assert.match(gridText(renderTerm(run('return k.text(k.title + " · " + k.surface)'), { w: 80 })), /How the episodes ended · terminal/)
})

test('the browser surface: a plot or a canvas area takes a brush, which reads in its own units', () => {
  const d = run(`
    const c = k.canvas(40, 2)
    c.text(0, 0, 'May 17 → Jul 2')
    c.brush('days', 0, 1, 40, 1, { min: 0, max: 46 })
    return k.stack(k.plot([{ name: 'calls', points: data.runs.map((r, i) => [i + 1, r.calls]) }], { h: 5, brush: 'runs' }), c)`)
  const s = renderSvg(d, { w: 80 })
  assert.deepEqual(s.brushes.map(b => [b.id, b.min, b.max]), [['runs', 1, 3], ['days', 0, 46]])
  assert.match(s.svg, /<rect class="dk-brush" data-brush="runs" data-min="1" data-max="3"/)
  // the terminal draws the same cells and no brush: there a program binds keys to the same state
  assert.equal(JSON.stringify(renderTerm(d, { w: 80 }).marks), JSON.stringify(s.marks))
})
