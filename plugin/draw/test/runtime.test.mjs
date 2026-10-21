// The card runtime's tests: lineage carried by itself, interaction state and events, ask(selection), what a handler
// asks of the host, and the sandbox's budgets and its one-line fallback. node --test plugin/draw/test
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runProgram } from '../sandbox-node.mjs'
import { gridText, renderTerm } from '../term.js'
import '../kit.js'

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
  // no words, but the numbers of one row: a bar item the program built from a row's fields (no spread, no row)
  const tenths = { tenths: [
    { tenth: 0, n: 132, read: 74, write: 28, _ref: 'q3#row=1', _rows: ['t.jsonl#L1-132'] },
    { tenth: 1, n: 133, read: 85, write: 26, _ref: 'q3#row=2', _rows: ['t.jsonl#L133-265'] },
    { tenth: 2, n: 140, read: 74, write: 30, _ref: 'q3#row=3', _rows: ['t.jsonl#L266-405'] },
  ] }
  const t = runProgram({ id: '08-tenths', program: `return k.bars(data.tenths.map((d, i) => ({ id: 't' + i, label: (i * 10) + '–' + (i * 10 + 10) + '%', parts: [{ value: d.read }, { value: d.write }], text: k.fmt(d.n) })))`, data: tenths }, { w: 80, h: 24 })
  assert.equal(meta(t, 't0').ref, 'q3#row=1', 'three of its numbers are one row\'s, and no other row has as many')
  assert.equal(meta(t, 't2').ref, 'q3#row=3', 'a number another row shares (74) does not tie: the row with the most wins')
  const two = runProgram({ id: '08-tenths', program: `return k.region('x', { label: 'reads' }, k.text('74 reads'))`, data: tenths }, { w: 80, h: 24 })
  assert.equal(meta(two, 'x').ref, undefined, 'one number is no match: a guess never picks between rows')
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

test('a handler asks the host for later events (k.after), its actions (k.do) and nothing it does not have; the bar line (k.status)', () => {
  const program = `
    const n = k.state.n ?? 0
    k.on('r', () => { k.after(120, 'tick', { from: n }); return { n: 0 } }, 'replay')
    k.on('tick', () => { if (n < 2) k.after(120, 'tick'); return { n: n + 1 } })
    k.on('o', () => { k.do('open', { row: 'r7' }) }, 'open')
    k.status('step ' + n + ' of 3')
    return k.text('step ' + n)`
  const r = run(program, { event: { type: 'key', key: 'r' }, state: { n: 3 } })
  assert.deepEqual(r.after, [{ ms: 120, event: { from: 3, type: 'tick' } }])
  assert.deepEqual(r.state, { n: 0 })
  assert.equal(r.status.text, 'step 0 of 3')
  const t = run(program, { event: r.after[0].event, state: r.state })
  assert.deepEqual([t.state, t.after.length], [{ n: 1 }, 1])
  const o = run(program, { event: { type: 'key', key: 'o' } })
  assert.deepEqual(o.effects, [{ row: 'r7', do: 'open' }])
  assert.equal(o.state, undefined)
  // outside a handler they do nothing and say so
  const out = run("k.do('open'); k.after(10, 'tick'); return k.text('x')")
  assert.equal(out.effects, undefined)
  assert.ok(out.warnings.some(w => /k\.do asks the host/.test(w)))
})

test('k.want asks the host for data not in hand; the host runs the program again with it (opts.got)', () => {
  const program = "const rows = k.want({ rows: ['q1#day=2026-06-18'] }); return k.text(rows ? rows.count + ' rows' : 'reading…')"
  const first = run(program)
  assert.equal(first.wants.length, 1)
  assert.match(gridText(renderTerm(first, { w: 40 })), /reading…/)
  const key = first.wants[0].key
  const again = run(program, { got: { [key]: { count: 6543 } } })
  assert.equal(again.wants, undefined)
  assert.match(gridText(renderTerm(again, { w: 40 })), /6543 rows/)
})

test('k.fmt rounds halves up on the decimal digits a reply shows, not on the binary value', () => {
  const f = globalThis.DrawKit.fmt
  // 7.925 is 7.92499… in binary, so toFixed(2) reads 7.92 while a reply that cites it reads 7.93
  assert.deepEqual([f(7.925, { dp: 2 }), f(-7.925, { dp: 2 }), f(1.005, { dp: 2 }), f(9.995, { dp: 2 })], ['7.93', '-7.93', '1.01', '10.00'])
  assert.deepEqual([f(17.925), f(0.0012345), f(95.4321), f(1546)], ['17.93', '0.001235', '95.43', '1,546'])
  assert.deepEqual([f(1150, { compact: true }), f(0.07925, { pct: true, dp: 2 })], ['1.2k', '7.93%'])
})

test('a share that is not zero never reads 0%', () => {
  const f = globalThis.DrawKit.fmt
  assert.deepEqual([f(7 / 8571, { pct: true, dp: 0 }), f(0.0004, { pct: true, dp: 1 }), f(0, { pct: true, dp: 0 }), f(0.006, { pct: true, dp: 0 })], ['<1%', '<0.1%', '0%', '1%'])
  // the label card's note: 7 of 8,571 records
  const d = runProgram({ id: 'share', program: "return k.bars([{ id: 'a', label: 'yes', value: 7, note: k.fmt(7 / 8571, { pct: true, dp: 0 }) }, { id: 'b', label: 'no', value: 8564, note: k.fmt(8564 / 8571, { pct: true, dp: 0 }) }])", data: {} }, { w: 60, h: 10 })
  const t = gridText(renderTerm(d, { w: 60 }))
  assert.match(t, /yes.*<1%/)
  assert.doesNotMatch(t, / 0%/)
})

test('a flow\'s boxes widen to show their notes whole when the frame has room', () => {
  const nodes = [
    { id: 'a', label: 'write step', note: 'packs the order, checks the totals, writes the batch file' },
    { id: 'b', label: 'pickup()', note: 'after each tick, reads new batches and sorts them' },
  ]
  const graph = o => `return k.graph({ nodes: ${JSON.stringify(nodes)}, edges: [{ from: 'a', to: 'b' }] }, ${JSON.stringify(o)})`
  const draw = (o, w) => { const d = runProgram({ id: 'flow', program: graph(o), data: {} }, { w, h: 40 }); return { d, t: gridText(renderTerm(d, { w })) } }
  const wide = draw({ dir: 'down' }, 100)
  assert.equal(wide.d.error, undefined)
  assert.doesNotMatch(wide.t, /…/)
  assert.match(wide.t.replace(/[│\s]+/g, ' '), /writes the batch file/)
  // a width the program set is kept, and a narrow frame still fits, its notes cut as before
  assert.match(draw({ dir: 'down', nodeW: 18 }, 100).t, /…/)
  const narrow = draw({ dir: 'down' }, 26)
  assert.ok(narrow.t.split('\n').every(l => l.length <= 26) && !narrow.d.warnings.some(w => /cut at the right/.test(w)))
})

test('a plot key with more series than its row holds wraps onto more rows, so every series is named', () => {
  const names = ['north depot', 'south depot', 'harbor', 'airport', 'rail yard', 'east market', 'old town']
  const program = `return k.plot(data.names.map((name, i) => ({ name, points: [1, 2, 3].map(x => [x, x * (i + 1)]) })), { h: 10 })`
  for (const w of [30, 60]) {
    const d = runProgram({ id: 'key', program, data: { names } }, { w, h: 30 })
    const g = renderTerm(d, { w })
    const t = gridText(g)
    for (const n of names) assert.match(t, new RegExp('━ ' + n), `${n} at ${w}`)
    assert.ok(t.split('\n').every(l => l.trimEnd().length <= w))
  }
  // a name wider than the row is cut with …, and said in cut
  const long = runProgram({ id: 'key', program, data: { names: ['a depot whose name runs past the row', 'b'] } }, { w: 24, h: 30 })
  const g = renderTerm(long, { w: 24 })
  assert.match(gridText(g), /━ a depot.*…/)
  assert.deepEqual(g.cut.filter(c => c.k === 'key').map(c => c.s), ['a depot whose name runs past the row'])
})
