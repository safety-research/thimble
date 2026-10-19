// The card runtime's tests: lineage carried by itself, interaction state and events, ask(selection), the sandbox's
// budgets and its one-line fallback, and a title for every card. node --test lean/draw/test
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runProgram } from '../sandbox-node.mjs'
import { renderSvg } from '../svg.js'
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

test('a stacked bar\'s part drawn from a row is a part by itself: it opens that row and has its cells and its span', () => {
  // one bar per language, split into the runs it holds: each run's part keeps the run's row
  const program = `
    const langs = ['Rust', 'Go']
    return k.stack(langs.map(l => k.beside(k.text(l, { w: 6 }), k.bar(data.runs.filter(r => r.lang === l).map(r => ({ value: r.calls, label: r.run, row: r })), { max: 400 }))))`
  const d = run(program)
  assert.equal(d.error, undefined, d.error && d.error.message)
  assert.deepEqual(d.regions.map(r => r.id), ['run-ep01', 'run-ep03', 'run-ep02'])
  assert.equal(meta(d, 'run-ep03').ref, 'q12#run=ep03')
  assert.equal(meta(d, 'run-ep03').label, 'ep03 201')
  assert.deepEqual(d.warnings, [], 'ids the runtime made need no warning')
  // the terminal: each part covers its own cells of the bar, side by side
  const g = renderTerm(d, { w: 60 })
  const rect = id => g.regions.find(r => r.id === id).rects[0]
  assert.equal(rect('run-ep01').y, rect('run-ep03').y)
  assert.equal(rect('run-ep01').x + rect('run-ep01').w, rect('run-ep03').x)
  assert.ok(rect('run-ep03').w > rect('run-ep01').w, 'the longer part has more cells')
  // the browser: the same parts, as spans of the bar
  const s = renderSvg(d, { w: 60 })
  assert.deepEqual(s.regions.filter(r => r.rects.length).map(r => r.id).sort(), ['run-ep01', 'run-ep02', 'run-ep03'])
  // a part with no row stays a part of the bar only
  const plain = run(`return k.bar([{ value: 3, label: 'a' }, { value: 4, label: 'b' }], { max: 10 })`)
  assert.deepEqual(plain.regions, [])
})

test('a stacked bar\'s label stays inside its own part in both renderers, and a total beside the total is drawn once', async () => {
  const { hex } = await import('../palette.js')
  // a narrow part whose label is wide characters, a part labelled with a number, and a note that repeats the total
  const parts = [{ value: 9, label: '数据集', tone: 'c1' }, { value: 30, label: 'names 11–50', tone: 'c2' }, { value: 61, label: '1,119 other names', tone: 'c4' }]
  const program = `return k.bars([{ id: 'answers', label: 'answers', parts: data.parts, note: k.fmt(100) }, { id: 'proxy', label: 'proxy', parts: data.parts.slice(1), note: 'two kinds' }])`
  for (const w of [40, 60, 90, 120, 150]) {
    const d = runProgram({ program, data: { parts } }, { w, h: 12 })
    assert.equal(d.error, undefined, d.error && d.error.message)
    // the terminal: the cells on a part's fill hold that part's words only, whole, and nothing on a fill strays
    const g = renderTerm(d, { w })
    for (const row of g.rows.slice(0, 2)) {
      for (const p of parts) {
        const on = row.filter(c => c.bg === p.tone)
        const words = on.map(c => c.ch).join('').trim()
        const value = p.value.toLocaleString('en-US')
        assert.ok(!words || words === p.label || words === `${p.label} ${value}`, `${w}: "${words}" on the part ${p.label}`)
      }
      assert.ok(row.every(c => c.tone !== 'paper' || c.bg || c.cont), `${w}: words off their part's fill`)
    }
    // a total beside the same total is drawn once; another note is kept
    const text = gridText(g)
    assert.equal(text.split('\n')[0].split('100').length - 1, 1, `${w}: ${text}`)
    if (w >= 90) assert.ok(text.includes('two kinds'), text)
    // the browser: each label measured in its own size ends inside its part's span, in a face wider than the cells
    // (a CJK face, where each character is about 1 em)
    const wide = (t, o = {}) => [...String(t)].length * (o.size || 13)
    const svg = renderSvg(d, { w, measure: wide }).svg
    const fills = parts.map(p => hex(p.tone, 'light'))
    const rects = [...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" fill="([^"]+)"/g)].filter(m => fills.includes(m[5])).map(m => ({ x: +m[1], y: +m[2], w: +m[3], h: +m[4] }))
    // the size each label is drawn in: its own inline style (the drawing's stylesheet sets every other text's size)
    const texts = [...svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)" style="font-size:(\d+)px" fill="[^"]+" xml:space="preserve">([^<]*)</g)].map(m => [m[0], m[1], m[3], m[4], +m[2]])
    if (w >= 90) assert.ok(texts.length > 0, `${w}: no label in place`)
    for (const t of texts) {
      const x = +t[1]
      const r = rects.find(q => q.x <= x && x < q.x + q.w && q.y <= t[4] && t[4] <= q.y + q.h)
      assert.ok(r, `${w}: a label outside every part: ${t[3]}`)
      assert.ok(x + wide(t[3], { size: +t[2] }) <= r.x + r.w, `${w}: "${t[3]}" runs past its part`)
    }
  }
})

test('every text the browser draws is drawn in the size it was measured in, whatever the stylesheet says', () => {
  // axis labels, a dot's label and a bar part's label each have a size of their own; the drawing's stylesheet sets every
  // text's size, so a size of its own must be an inline style, and the size measured must be the size drawn
  const d = run(`
    const c = k.canvas(30, 3)
    c.dot(2, 1, 'accent', { label: 'reviewer ×3' })
    return k.stack(
      k.plot([{ name: 'a', points: [[1, 40], [10, 71], [100, 88]] }, { name: 'b', points: [[1, 22], [10, 55], [100, 81]] }],
        { h: 8, x: { label: 'learning rate', log: true }, y: { label: 'val acc', min: 0, max: 100 } }),
      c,
      k.bars([{ label: 'saves', parts: [{ label: 'overwrote', value: 304, tone: 'accent' }, { label: 'kept', value: 10, tone: 'good' }] }]))`)
  const measured = new Map()
  const measure = (t, o = {}) => {
    const size = o.size || 13
    if (!measured.has(String(t))) measured.set(String(t), new Set())
    measured.get(String(t)).add(size)
    return [...String(t)].length * size * 0.55
  }
  const svg = renderSvg(d, { w: 90, fs: 13, measure }).svg
  const texts = [...svg.matchAll(/<text ([^>]*)>(.*?)<\/text>/g)].map(m => ({ attrs: m[1], s: m[2].replace(/<[^>]+>/g, ''), size: +(/style="[^"]*font-size:([\d.]+)px/.exec(m[1]) || [0, 13])[1] }))
  assert.ok(texts.length > 8, svg)
  for (const t of texts) assert.doesNotMatch(t.attrs, /font-size=/, `"${t.s}" sets its size by an attribute, which the stylesheet overrides`)
  for (const s of ['100', '0', 'val acc', 'reviewer ×3']) assert.ok(texts.find(t => t.s === s && t.size < 13), `"${s}" is drawn in a size of its own`)
  for (const t of texts) if (measured.has(t.s)) assert.ok(measured.get(t.s).has(t.size), `"${t.s}" drawn at ${t.size}px, measured at ${[...measured.get(t.s)]}`)
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

test('k.embed draws another program\'s drawing as a part, its parts and cites with it; k.select marks a part; c.bg grounds cells', () => {
  const card = run("k.cite('c18', { text: '6,543 saves', rows: ['revisions.jsonl#L28'] }); return k.region('day-18', { label: 'Jun 18', cite: 'c18' }, k.bar(9, { max: 9 }))")
  const page = globalThis.DrawKit.run((k, data) => {
    k.select('day-18')
    const c = k.canvas(10, 1)
    c.text(0, 0, 'picked')
    c.bg(0, 0, 6, 1, 'warn-faint')
    return k.stack(k.text('**the page**'), k.embed(data.card), c)
  }, { card }, { w: 40 })
  assert.equal(page.error, undefined)
  assert.equal(page.selected, 'day-18')
  assert.ok(page.regions.some(r => r.id === 'day-18'))
  assert.ok(page.cites.c18)
  const g = renderTerm(page, { w: 40 })
  const row = g.rows.find(r => r.map(c => c.ch).join('').startsWith('picked'))
  assert.equal(row[0].bg, 'warn-faint')
  assert.match(renderSvg(page, { w: 40 }).svg, /rx="5" fill="#/)
})

test('k.keys tells a program the keys that reach it where it is drawn; a key the host keeps is named at once (a warning)', () => {
  const prog = `k.on('c', () => ({ flip: !k.state.flip }), 'flip'); k.on('0', () => null, 'reset'); return k.text(k.keys.free('c') + ' ' + k.keys.free('0') + ' ' + k.keys.taken.join(''))`
  const d = DrawKit.run(prog, {}, { keys: { taken: { 0: 'goes back', ']': 'moves to the next thing' } } })
  assert.match(gridText(renderTerm(d, { w: 40 })), /true false 0\]/)
  assert.equal(d.warnings.length, 1)
  assert.match(d.warnings[0], /the key "0" does not reach this card where it is drawn now \(goes back\)/)
  // with no keys given (a pane of thimble's own), every key is free
  assert.deepEqual(DrawKit.run(prog, {}, {}).warnings, [])
  // the sandbox passes them on
  assert.equal(runProgram({ id: 'x', program: prog, data: {} }, { keys: { taken: ['c'] } }).warnings.length, 1)
})

test('k.local names the state keys each surface keeps for itself (a hover, a replay); the drawing lists them', () => {
  const d = DrawKit.run(`k.local('hover', 'replay'); k.on('hover', e => ({ hover: e.region })); return k.text(String(k.state.hover))`, {}, { state: { zoom: 2 }, event: { type: 'hover', region: 'r1' } })
  assert.deepEqual(d.local, ['hover', 'replay'])
  assert.deepEqual(d.state, { zoom: 2, hover: 'r1' })
})

test('a press on a canvas region runs its onPress, as on k.region; a handler that returns k changes no state', () => {
  const program = `
    const sel = k.state.sel || 'none'
    const c = k.canvas(20, 2)
    data.runs.forEach((r, i) => { c.text(i * 6, 0, r.run); c.region('cell-' + r.run, i * 6, 0, 5, 1, { row: r, onPress: () => ({ sel: r.run }) }) })
    k.on('a', () => k.ask({ label: 'the picked run', rows: data.runs.filter(r => r.run === sel) }))
    return k.stack(c, k.text('picked ' + sel))`
  const pressed = run(program, { event: { type: 'press', region: 'cell-ep02' } })
  assert.equal(pressed.handled, 'press:cell-ep02')
  assert.deepEqual(pressed.state, { sel: 'ep02' })
  assert.equal(meta(pressed, 'cell-ep02').ref, 'q12#run=ep02', 'the canvas region keeps its row')
  assert.ok(!('onPress' in meta(pressed, 'cell-ep02')))
  const asked = run(program, { state: pressed.state, event: { type: 'key', key: 'a' } })
  assert.deepEqual(asked.ask, { label: 'the picked run', refs: ['q12#run=ep02'] })
  assert.deepEqual(asked.state, { sel: 'ep02' }, 'k.ask returns k, which is not a patch of the state')
})
