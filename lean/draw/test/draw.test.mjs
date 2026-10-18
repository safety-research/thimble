// The drawing contract's tests: node --test lean/draw/test
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadExamples } from '../examples/load.mjs'
import { fromArgs, fromHash, objectRef, toCommand, toHash } from '../handoff.js'
import { runProgram } from '../sandbox-node.mjs'
import { renderSvg } from '../svg.js'
import { len, nextRegion, regionAt, renderTerm } from '../term.js'

const DRAW = fileURLToPath(new URL('..', import.meta.url))
const examples = loadExamples()
const WIDTHS = [72, 100, 140]
const json = v => JSON.stringify(v)

test('one program gives the same regions and values in both renderers', () => {
  for (const o of examples) for (const w of WIDTHS) {
    const d = runProgram(o, { w, h: 24 })
    assert.equal(d.error, undefined, `${o.id} at ${w}: ${d.error && d.error.message}`)
    const t = renderTerm(d, { w }), s = renderSvg(d, { w })
    // values: every text, number, series and row each renderer drew, in the same order
    assert.equal(json(t.marks), json(s.marks), `${o.id} at ${w}: the marks differ`)
    // regions: the same ids, in the same order, with the same meaning; each drawn somewhere in both
    assert.deepEqual(t.regions.map(r => r.id), s.regions.map(r => r.id), `${o.id} at ${w}: region ids differ`)
    assert.deepEqual(t.regions.map(r => r.meta), s.regions.map(r => r.meta), `${o.id} at ${w}: region meanings differ`)
    for (const r of t.regions) assert.ok(r.rects.length > 0, `${o.id} at ${w}: the terminal did not draw ${r.id}`)
    for (const r of s.regions) assert.ok(r.rects.length > 0, `${o.id} at ${w}: the browser did not draw ${r.id}`)
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
  // the region a terminal selects is a region the browser draws, at its own width
  const t = renderTerm(runProgram(o, { w: 100 }), { w: 100 })
  const b = renderSvg(runProgram(o, { w: 140 }), { w: 140 })
  for (const r of t.regions) assert.ok(b.regions.some(x => x.id === r.id && x.rects.length), `the browser lost ${r.id}`)
})

test('the demo plugin carries the current renderer files', () => {
  const lib = DRAW + 'demo-plugin/hooks/lib/'
  for (const f of readdirSync(lib)) {
    if (f === 'README') continue
    assert.equal(readFileSync(lib + f, 'utf8'), readFileSync(DRAW + f, 'utf8'), `demo-plugin/hooks/lib/${f} is out of date: run node lean/draw/demo-plugin/sync.mjs`)
  }
})
