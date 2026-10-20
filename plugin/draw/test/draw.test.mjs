// The drawing contract's tests: node --test plugin/draw/test
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadExamples } from '../examples/load.mjs'
import { fromArgs, fromHash, knobOf, objectRef, toCommand, toHash, turn } from '../handoff.js'
import { runProgram } from '../sandbox-node.mjs'
import { gridText, len, nextRegion, regionAt, renderTerm } from '../term.js'

const DRAW = fileURLToPath(new URL('..', import.meta.url))
const examples = loadExamples()
const WIDTHS = [72, 100, 140]
const json = v => JSON.stringify(v)

test('one program draws every region and value it names, at every width', () => {
  for (const o of examples) for (const w of WIDTHS) {
    const d = runProgram(o, { w, h: 24 })
    assert.equal(d.error, undefined, `${o.id} at ${w}: ${d.error && d.error.message}`)
    const t = renderTerm(d, { w })
    // regions: every part the program named is drawn somewhere
    for (const r of d.regions) assert.ok(t.regions.some(x => x.id === r.id), `${o.id} at ${w}: ${r.id} is not drawn`)
    for (const r of t.regions) assert.ok(r.rects.length > 0, `${o.id} at ${w}: the terminal did not draw ${r.id}`)
  }
})

test('region ids are the program\'s, and stay the same across widths and runs', () => {
  const prog = `return k.stack(
    k.region('total', { cite: k.cite('c-total', { text: '12 rows', rows: [{ a: 1 }] }) }, k.text('**12** in all')),
    k.bars([{ id: 'apples', label: 'apples', value: 3 }, { id: 'pears', label: 'pears', value: 9, cite: 'c-total' }]),
    k.table([{ name: 'x', n: 1 }, { name: 'y', n: 2 }], { id: r => 'row-' + r.name }),
    k.text('see [the total](#c-total)'))`
  const ids = w => renderTerm(runProgram({ program: prog }, { w }), { w }).regions.map(r => r.id)
  assert.deepEqual(ids(60), ['total', 'apples', 'pears', 'row-x', 'row-y', 'c-total'])
  assert.deepEqual(ids(60), ids(140))
  for (const o of examples) {
    const a = runProgram(o, { w: 72 }).regions.map(r => r.id), b = runProgram(o, { w: 140 }).regions.map(r => r.id)
    assert.deepEqual(a, b, `${o.id}: region ids change with the width`)
    assert.ok(a.every(id => !/^r\d+$/.test(id)), `${o.id}: an id was made up from a position`)
  }
})

test('a program without ids still draws, with ids from what the regions show', () => {
  const d = runProgram({ program: `return k.stack(k.region(null, 'Jun 18', 'a'), k.region(undefined, { cite: k.cite('peak', { text: 'p' }) }, 'b'))` }, { w: 40 })
  assert.equal(d.error, undefined)
  assert.deepEqual(d.regions.map(r => r.id), ['jun-18', 'peak'])
  assert.ok(d.warnings.some(x => /has no id/.test(x)))
})

test('extra metadata passes through untouched', () => {
  const d = runProgram({ program: `return k.region('a', { label: 'A', lineage: { query: 'q', rows: [3, 4] }, confidence: 0.8, cite: k.cite('c', { text: 't', ids: ['row:3'], version: 2 }) }, 'x')` }, { w: 40 })
  assert.deepEqual(d.regions[0].meta.lineage, { query: 'q', rows: [3, 4] })
  assert.equal(d.regions[0].meta.confidence, 0.8)
  assert.deepEqual(d.cites.c.ids, ['row:3'])
  assert.equal(d.cites.c.version, 2)
})

test('programs run sandboxed: no host, no file system, no network, a time limit', () => {
  const run = p => runProgram({ program: p }, { w: 60, limit: 300 })
  const seen = run(`return [typeof process, typeof require, typeof fetch, typeof setTimeout, typeof XMLHttpRequest, typeof WebSocket].join(' ')`)
  assert.equal(seen.root.runs.map(r => r.s).join(''), 'undefined undefined undefined undefined undefined undefined')
  const viaCtor = run(`const g = (() => {}).constructor('return this')(); return [typeof g.process, typeof g.require, typeof g.fetch].join(' ')`)
  assert.equal(viaCtor.root.runs.map(r => r.s).join(''), 'undefined undefined undefined')
  const dyn = run(`return import('node:fs')`)
  assert.equal(dyn.error.name, 'ReturnError')
  const loop = run('while (true) {}')
  assert.equal(loop.error.name, 'TimeLimit')
  const thrown = run('const a = 1\nnull.x\nreturn a')
  assert.equal(thrown.error.line, 2)
  assert.match(thrown.error.message, /null/)
})

test('the terminal grid is cell-honest', () => {
  for (const o of examples) for (const w of WIDTHS) {
    const g = renderTerm(runProgram(o, { w, h: 24 }), { w })
    assert.ok(g.w <= w, `${o.id}: ${g.w} columns at width ${w}`)
    g.rows.forEach((row, y) => {
      assert.equal(row.length, g.w, `${o.id} row ${y} has ${row.length} cells`)
      row.forEach((c, x) => {
        if (c.cont) { assert.ok(row[x - 1] && row[x - 1].w2, `${o.id} (${x},${y}): a continuation with no wide cell before it`); return }
        assert.equal(len(c.ch), c.w2 ? 2 : 1, `${o.id} (${x},${y}) "${c.ch}" is not one cell`)
      })
    })
    for (const r of g.regions) for (const q of r.rects) assert.ok(q.x >= 0 && q.y >= 0 && q.x + q.w <= g.w && q.y + q.h <= g.h, `${o.id}: ${r.id} is outside the grid`)
    if (w >= 100) assert.deepEqual(g.cut, [], `${o.id} at ${w}: something was cut: ${json(g.cut)}`)
  }
})

test('the terminal finds regions by cell and moves between them in reading order', () => {
  const o = examples.find(e => e.id === 'messages-by-day')
  const g = renderTerm(runProgram(o, { w: 100 }), { w: 100 })
  const day = g.regions.find(r => r.id === 'day-06-18')
  const q = day.rects[0]
  assert.equal(regionAt(g, q.x + 3, q.y).id, 'day-06-18')
  const after = nextRegion(g, 'day-06-18', 1), before = nextRegion(g, after, -1)
  assert.equal(before, 'day-06-18')
})

test('the handoff carries the object and its selection both ways', () => {
  const o = examples[0]
  const sel = { object: o.id, v: o.v, region: 'day-06-18', w: 100 }
  assert.deepEqual(fromHash(toHash(sel)), sel)
  assert.equal(toCommand(sel), '/draw messages-by-day@1 day-06-18')
  assert.deepEqual(fromArgs('messages-by-day@1 day-06-18'), { object: 'messages-by-day', v: 1, region: 'day-06-18' })
  assert.equal(objectRef(o), 'messages-by-day@1')
  assert.equal(fromHash('#o=<script>&r=x'), null)
  // the region selected at one width is a region drawn at another
  const t = renderTerm(runProgram(o, { w: 100 }), { w: 100 })
  const b = renderTerm(runProgram(o, { w: 140 }), { w: 140 })
  for (const r of t.regions) assert.ok(b.regions.some(x => x.id === r.id && x.rects.length), `140 columns lost ${r.id}`)
})

test('the card guide\'s opening program runs', () => {
  // the card guide's opening program (its other programs are the visualize forms, which their tests draw)
  const md = readFileSync(DRAW + '../skills/thimble/cards.md', 'utf8')
  const blocks = [...md.matchAll(/```js\n([\s\S]*?)```/g)].map(m => m[1]).slice(0, 1)
  const rows = [{ day: '06-16', messages: 3 }]
  // the worked programs further down are skills/thimble/forms, which the visualize tests draw
  const DATA = [
    { days: [{ day: '06-16', messages: 1546 }, { day: '06-17', messages: 870 }] },
  ]
  assert.equal(blocks.length, DATA.length)
  blocks.forEach((program, i) => {
    const d = runProgram({ program, data: DATA[i] }, { w: 100 })
    assert.equal(d.error, undefined, `cards.md block ${i + 1}: ${d.error && d.error.message}`)
    assert.ok(renderTerm(d, { w: 100 }).marks.length > 0, `cards.md block ${i + 1} draws nothing`)
    if (i > 0) assert.ok(d.regions.length > 0, `cards.md block ${i + 1} has no regions`)
  })
})

test('paint.js draws text rows as Text and pixel rows as one Raster', async () => {
  const { paintGrid } = await import('../paint.js')
  const el = type => props => ({ type, props })
  const els = { Box: el('Box'), Text: el('Text'), Raster: el('Raster') }
  const o = examples.find(e => e.id === 'senders')
  const g = renderTerm(runProgram(o, { w: 100 }), { w: 100 })
  const tree = paintGrid(g, els, { theme: 'dark', selected: 'sender-april-scout', key: 't' })
  const kids = tree.props.children
  const rasters = kids.filter(k => k.type === 'Raster')
  assert.equal(rasters.length, 1, 'the plot rows are one Raster band')
  const r = rasters[0].props
  assert.equal(r.columns, g.w)
  assert.equal(Buffer.from(r.cells, 'base64').length, r.columns * r.rows * 12)
  const rowsDrawn = kids.reduce((s, k) => s + (k.type === 'Raster' ? k.props.rows : 1), 0)
  assert.equal(rowsDrawn, g.h, 'every grid row is drawn once')
  // the selected row is tinted: in a Raster as the select color, in a Text line as the theme's selection background
  const words = new Uint32Array(new Uint8Array(Buffer.from(r.cells, 'base64')).buffer)
  const sel = parseInt('26384f', 16)
  const tinted = [...words].filter((v, i) => i % 3 === 2 && v === sel).length
  const textTinted = kids.filter(k => k.type === 'Text').some(k => k.props.children.some(c => c.props.backgroundColor === 'selectionBg'))
  assert.ok(tinted > 0 || textTinted, 'the selected region is tinted')
})

test('selected text reads on the selection in either theme, and ink on a pane takes the theme\'s text color', async () => {
  const { paintGrid } = await import('../paint.js')
  const { selectedColor, selectedHex, termColor, hex } = await import('../palette.js')
  const el = type => props => ({ type, props })
  const els = { Box: el('Box'), Text: el('Text'), Raster: el('Raster') }
  // one row: a name in ink, then a stacked bar's segment with its label in paper on its fill, then a dim total
  const cells = (s, tone, bg) => [...s].map(ch => ({ ch, tone, ...(bg ? { bg } : {}) }))
  const row = [...cells('north ', 'ink'), ...cells(' done 179 ', 'paper', 'c3'), ...cells(' 49', 'dim')]
  const g = { w: row.length, h: 1, rows: [row], regions: [{ id: 'north', rects: [{ x: 0, y: 0, w: row.length, h: 1 }] }] }
  const runs = tree => tree.props.children[0].props.children
  for (const theme of ['light', 'dark']) {
    // selected: every neutral text and the label on its fill in the theme's text color, on the selection background
    const on = runs(paintGrid(g, els, { theme, selected: 'north', raster: false }))
    for (const r of on) assert.deepEqual([r.props.color, r.props.backgroundColor], ['text', 'selectionBg'], `${theme}: "${r.props.children}"`)
    // not selected, in the transcript: ink is the terminal's own color, the label keeps its paper on its fill
    const off = runs(paintGrid(g, els, { theme, raster: false }))
    assert.equal(off[0].props.color, undefined)
    assert.deepEqual([off[1].props.color, off[1].props.backgroundColor], [hex('paper', theme), hex('c3', theme)])
    // on a pane: ink takes the theme's text color
    assert.equal(runs(paintGrid(g, els, { theme, raster: false, painted: true }))[0].props.color, 'text')
  }
  assert.equal(termColor('ink', 'light'), undefined)
  assert.equal(termColor('ink', 'light', { painted: true }), 'text')
  // a colored tone keeps its color on the selection; a neutral one, or text on a fill, reads as text
  assert.equal(selectedColor('accent', 'light'), hex('accent', 'light'))
  assert.equal(selectedColor('c2', 'dark', true), 'text')
  assert.equal(selectedColor('dim', 'dark'), 'text')
  // as pixels: the label on the palette's select reads in its ink
  assert.equal(selectedHex('paper', 'light', true), hex('ink', 'light'))
  assert.equal(selectedHex('c1', 'light'), hex('c1', 'light'))
})

test('a knob keeps its value across runs: the host turns it, the program runs again, words and marks follow', () => {
  const program = `
    const s = k.knob('scale', { values: [1, 2, 4, 8, 16], at: 2, label: 'lr scale', fmt: v => '×' + v })
    const step = k.knob('step', { min: 0, max: 199, label: 'step' })
    return k.stack(
      k.text(\`gap **\${data.gap[s]}** pts when lr is scaled by [◂ ×\${s} ▸](#scale)\`),
      k.dial('step'),
      k.region('step-' + step, { label: 'step ' + step, rows: ['run.jsonl#L' + (step + 1)] }, k.bar(step, { max: 199 })))`
  const data = { gap: { 1: 28, 2: 18.4, 4: 9.7, 8: 1.6, 16: 9.5 } }
  const d0 = runProgram({ program, data }, { w: 80 })
  assert.deepEqual(d0.controls.map(c => [c.id, c.i, c.values.length]), [['scale', 1, 5], ['step', 0, 200]])
  assert.equal(d0.controls[0].shown[1], '×2')
  assert.deepEqual(d0.state, {})
  // ▸ three times on scale: stops at the last value; the program reads it and rewrites the sentence
  let st = {}
  for (let i = 0; i < 3; i++) st = turn(runProgram({ program, data }, { w: 80, state: st }), st, 'scale', 1)
  assert.deepEqual(st, { scale: 16 })
  st = turn(runProgram({ program, data }, { w: 80, state: st }), st, 'scale', 1)
  assert.deepEqual(st, { scale: 16 }, 'a knob stops at its end')
  // the first knob turns when no id is given; a step of 25 scrubs a run
  st = turn(d0, st, null, -1)
  assert.deepEqual(st, { scale: 1 })
  st = turn(d0, st, 'step', 25)
  const d1 = runProgram({ program, data }, { w: 80, state: st })
  assert.equal(d1.controls[1].i, 25)
  const t = renderTerm(d1, { w: 80 })
  assert.match(gridText(t), /gap 28 pts when lr is scaled by ◂ ×1 ▸/)
  assert.match(gridText(t), /step ◂ 25 ▸/)
  // the region follows the knob, with its rows; the knob's link is a part the person can select
  assert.deepEqual(t.regions.find(r => r.id === 'step-25').meta.rows, ['run.jsonl#L26'])
  assert.deepEqual(t.regions.filter(r => r.meta.knob).map(r => r.id), ['scale', 'step'])
  assert.equal(knobOf(d1, 'step').label, 'step')
  // a value that is not one of the knob's goes to the nearest number; a word that is not one keeps the start
  const d2 = runProgram({ program, data }, { w: 80, state: { scale: 7, step: 'x' } })
  assert.deepEqual(d2.controls.map(c => c.i), [3, 0])
  assert.deepEqual(d2.warnings, [])
  // the state rides the handoff: the URL and the command
  const sel = { object: 'sweep', v: 3, region: 'step-25', state: { scale: 8, split: 'by wiki' } }
  assert.deepEqual(fromHash(toHash(sel)), sel)
  assert.deepEqual(fromArgs(toCommand(sel).replace(/^\/draw /, '')), sel)
})

test('a knob that is badly made still draws, and says why', () => {
  const d = runProgram({ program: `const a = k.knob('a b', {}); const b = k.knob('ok', { values: ['all', 'links'], at: 'none' }); return k.stack(k.dial('nope'), k.text('[x](#ok)'), k.text(String(a) + ' ' + b))` }, { w: 60 })
  assert.equal(d.error, undefined)
  assert.ok(d.warnings.some(w => /a b/.test(w)) && d.warnings.some(w => /no values/.test(w)))
  assert.ok(d.warnings.some(w => /starts at "none"/.test(w)) && d.warnings.some(w => /k.dial\("nope"\)/.test(w)))
  assert.ok(!d.warnings.some(w => /link points at "#ok"/.test(w)), 'a link to a knob is a known id')
})

test('a node-link drawing: the terminal puts dots and links on the nearest cells', () => {
  const program = `const c = k.canvas(30, 8)
    c.link(2, 1, 20.4, 6.3, 'dim')
    c.link(2, 1, 12, 1, 'warn', { dash: true })
    c.dot(2, 1, 'c1', { part: 'a', meta: { label: 'claim a', claim: 'a' } })
    c.dot(20.4, 6.3, 'c2', { size: 2, part: 'b', label: '×3' })
    c.dot(12, 1, 'c3', { hollow: true })
    c.box(14, 2, 10, 4, { fill: true })
    c.text(15, 3, 'over it')
    return c`
  const d = runProgram({ program, data: {} }, { w: 30, h: 8 })
  assert.equal(d.error, undefined)
  assert.deepEqual(d.warnings, [])
  assert.deepEqual(d.regions.map(r => r.id), ['a', 'b'], 'a dot with a part is a region')
  const t = renderTerm(d, { w: 30 })
  assert.deepEqual(t.regions.map(r => r.id), ['a', 'b'])
  // the terminal: each dot's glyph on its nearest cell, a link on the blank cells between its ends, dashed every other
  // cell, and the filled box clears what is under it
  const rows = gridText(t).split('\n')
  assert.equal(rows[1][2], '●')
  assert.equal(rows[6][20], '◉')
  assert.equal(rows[1][12], '○')
  assert.match(rows[1].slice(3, 12), /^─ ╌ ╌ ╌ ╌$/)
  assert.ok([...rows.slice(2, 6).join('')].some(ch => '╲─'.includes(ch)), 'the long link is drawn')
  assert.equal(rows[3].slice(15, 22), 'over it')
  assert.ok(!/[╲─]/.test(rows[4].slice(15, 23)), 'nothing of the link shows inside the filled box')
  assert.deepEqual(t.regions.find(r => r.id === 'b').rects, [{ x: 20, y: 6, w: 1, h: 1 }])
})
