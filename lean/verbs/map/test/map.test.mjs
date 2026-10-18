// The Map verb: k.map's three forms in cells (a line, a metro map, regions), calm and full, the regions it names with
// their rows, the terminal's rules (a lane per lens value with its count, a striped lane where rows run out), the
// browser drawing the same regions, the verb's moves (the full map, a zoom, asking Claude) and its hint.
// node --test lean/verbs/map/test/*.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { runProgram } from '../../../draw/sandbox-node.mjs'
import { renderSvg } from '../../../draw/svg.js'
import { gridText, renderTerm } from '../../../draw/term.js'
import { applies } from '../hint.mjs'
import { askFor, filterThreads, isMap, PROGRAM, run } from '../run.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))

function draw(data, { w = 100, mode, program = PROGRAM } = {}) {
  const drawing = runProgram({ program, data }, { w, mode })
  assert.equal(drawing.error, undefined, JSON.stringify(drawing.error))
  const grid = renderTerm(drawing, { w })
  return { drawing, grid, text: gridText(grid), ids: grid.regions.map(r => r.id) }
}
const region = (g, id) => g.grid.regions.find(r => r.id === id)

// one made-up run: five stops, its moves bound from a query (each keeps _rows)
const ONE = {
  title: 'agent-07 · 300 calls', unit: 'calls',
  threads: [{ id: 'agent-07', steps: 300 }],
  moves: [
    { thread: 'agent-07', station: 'read', start: 1, end: 40, _rows: ['agents/agent-07.jsonl#L2-80'] },
    { thread: 'agent-07', station: 'claim', start: 41, end: 60, _rows: ['agents/agent-07.jsonl#L81-120'] },
    { thread: 'agent-07', station: 'test', start: 61, end: 200, repeat: 12, _rows: ['agents/agent-07.jsonl#L121-400'] },
    { thread: 'agent-07', station: 'review', start: 201, end: 240, _rows: ['agents/agent-07.jsonl#L401-480'] },
    { thread: 'agent-07', station: 'merge', start: 241, end: 300, _rows: ['agents/agent-07.jsonl#L481-600'] },
  ],
  stations: [
    { id: 'read', label: 'reads the board' }, { id: 'claim', label: 'claims PR #12', note: 'the first unclaimed PR' },
    { id: 'test', label: 'runs the tests' }, { id: 'review', label: 'asks for review' }, { id: 'merge', label: 'merges', end: true },
  ],
}

// made-up runs: 24 runs, a fork into three theories, three endings, an outcome to color by
function many(n = 24) {
  const theories = ['timezone', 'fixture', 'flaky']
  const ends = { timezone: ['gave-up', 'fixed'], fixture: ['fixed'], flaky: ['masked'] }
  const threads = []
  const moves = []
  for (let i = 0; i < n; i++) {
    const id = `r${String(i + 1).padStart(2, '0')}`
    const th = theories[i % 3]
    const end = ends[th][i % ends[th].length]
    threads.push({ id, outcome: end === 'fixed' ? 'fixed' : end === 'masked' ? 'masked' : 'gave up', steps: 100 })
    const path = ['read', 'search', th, ...(th === 'timezone' ? ['revert'] : []), end]
    path.forEach((s, j) => moves.push({ thread: id, station: s, start: j * 10 + 1, end: j * 10 + 10, _rows: [`runs/${id}.jsonl#L${j * 10 + 1}-${j * 10 + 10}`] }))
  }
  return {
    title: `${n} runs`, unit: 'runs', lens: 'outcome', threads, moves,
    stations: [
      { id: 'read', label: 'reads the test' }, { id: 'search', label: 'searches the code' },
      { id: 'timezone', label: 'theory: timezone' }, { id: 'fixture', label: 'theory: shared fixture' }, { id: 'flaky', label: 'theory: just flaky' },
      { id: 'revert', label: 'reverts' },
      { id: 'fixed', label: 'fixed', end: true }, { id: 'masked', label: 'masked', end: true }, { id: 'gave-up', label: 'gave up', end: true },
    ],
  }
}

test('one thread, calm: one row to scale, each stop a region with its rows', () => {
  const g = draw(ONE, { w: 100 })
  assert.equal(g.grid.h, 3, g.text)
  const row = g.text.split('\n')[1]
  for (const w of ['reads the board', 'claims PR #12', 'runs the tests', 'merges ✓', '⟳12']) assert.ok(row.includes(w), row)
  assert.deepEqual(g.ids, ['st-read', 'st-claim', 'st-test', 'st-review', 'st-merge'])
  assert.equal(region(g, 'st-test').meta.ref, 'agents/agent-07.jsonl#L121-400')
  // to scale: the stop with the most calls takes the most cells
  const w = id => region(g, id).rects[0].w
  assert.ok(w('st-test') > w('st-claim') && w('st-test') > w('st-read'))
  // its examples are the thread's rows at that station
  const ex = g.drawing.examples[region(g, 'st-claim').meta.examples]
  assert.equal(ex.records[0].ref, 'agents/agent-07.jsonl#L81-120')
})

test('one thread, calm, narrow: the stops with the fewest steps give up words first', () => {
  const g = draw(ONE, { w: 56 })
  const row = g.text.split('\n')[1]
  assert.ok(row.includes('runs') && row.length <= 56, row)
  assert.ok(!row.includes('reads the board'), row)
})

test('one thread, full: stations spaced for reading, first steps, a strip to scale, notes', () => {
  const g = draw({ ...ONE, full: true }, { w: 100 })
  const t = g.text
  for (const w of ['reads the board', '◆', '1', '41', '61', '300 calls to scale', 'the first unclaimed PR']) if (w !== '◆') assert.ok(t.includes(w), w + '\n' + t)
  assert.ok(region(g, 'st-claim').rects.length >= 4, 'label, mark, step, strip and note rows')
})

test('k.mode detail draws the full form of the same object', () => {
  const calm = draw(ONE, { w: 100 })
  const detail = draw(ONE, { w: 100, mode: 'detail' })
  assert.ok(detail.grid.h > calm.grid.h)
})

test('many threads, calm: an origin forking into the stations that split them, then the endings, lanes counted', () => {
  const g = draw(many(24), { w: 100 })
  const t = g.text
  assert.ok(t.includes('24 runs'), t)
  for (const w of ['theory: timezone', 'theory: shared fixture', 'theory: just flaky', 'fixed', 'masked', 'gave up']) assert.ok(t.includes(w), w + '\n' + t)
  assert.ok(!t.includes('searches the code'), 'a station every run passes is folded into the lanes')
  const lane = g.grid.regions.find(r => r.id.startsWith('ln-all-timezone'))
  assert.ok(lane && lane.meta.threads.length === 8, JSON.stringify(lane && lane.meta))
  assert.ok(/ 8 /.test(t), 'the lane prints its count')
})

test('many threads, full: every station, one lane per lens value with its count, distinct tones, back links named', () => {
  const data = many(24)
  // a run that goes back: fixture -> search
  data.moves.push({ thread: 'r02', station: 'search', start: 200, end: 210 })
  const g = draw({ ...data, full: true }, { w: 110 })
  const t = g.text
  assert.ok(t.includes('searches the code'), t)
  const lanes = g.grid.regions.filter(r => r.id.startsWith('ln-'))
  const byValue = lanes.filter(r => r.id.startsWith('ln-timezone-'))
  assert.ok(byValue.length >= 2, 'the bundles out of timezone split by outcome: ' + lanes.map(r => r.id).join(' '))
  assert.ok(t.includes('outcome:') && t.includes('line weight = runs'), t)
  assert.ok(t.includes('back:'), 'a move against the order is named, not drawn as a lane')
  // the lens values get three different tones
  const key = g.grid.rows.find(r => r.map(c => c.ch).join('').includes('outcome:'))
  const tones = new Set(key.filter(c => c.ch === '■').map(c => c.tone))
  assert.equal(tones.size, 3)
})

test('many threads, few rows: a bundle keeps one striped lane with a count per value (cells cannot hold every lane)', () => {
  const g = draw({ ...many(24), full: true }, { w: 100, program: "return k.map(data, { rows: 8 })" })
  assert.ok(g.text.includes('a striped lane holds several'), g.text)
  assert.ok(/\d+·\d+/.test(g.text), 'counts per value on a striped lane\n' + g.text)
})

test('links alone make a flow map; loose names are read (nodes, edges, source, target, weight)', () => {
  const g = draw({ title: 'flow', nodes: [{ id: 'a', label: 'asked' }, { id: 'b', label: 'answered' }, { id: 'c', label: 'dropped' }],
    edges: [{ source: 'a', target: 'b', weight: 30 }, { source: 'a', target: 'c', weight: 6 }], full: true }, { w: 80 })
  assert.ok(g.text.includes('answered') && g.text.includes('30'), g.text)
})

test('regions: a strip of groups to scale, then boxes of stations with their counts', () => {
  const data = { title: 'what it holds', unit: 'saves',
    groups: [{ id: 'coord', label: 'coordination pages' }, { id: 'links', label: 'link pages' }],
    stations: [{ id: 'live', label: 'LIVE pages', group: 'coord', n: 5200, ref: 'q1#kind=live' }, { id: 'seq', label: 'sequence pages', group: 'coord', n: 2600 },
      { id: 'api', label: 'API lists', group: 'links', n: 1800 }, { id: 'blank', label: 'blank saves', n: 51 }] }
  const calm = draw(data, { w: 90 })
  assert.equal(calm.grid.h, 4)
  assert.ok(calm.text.includes('coordination pages 7,800'), calm.text)
  const full = draw({ ...data, full: true }, { w: 90 })
  assert.ok(full.text.includes('LIVE pages') && full.text.includes('5,200') && full.text.includes('other 51'), full.text)
  assert.equal(region(full, 'st-live').meta.ref, 'q1#kind=live')
  assert.ok(region(full, 'grp-coord').meta.label.startsWith('coordination pages'))
})

test('the browser draws the same regions as the terminal', () => {
  const data = { ...many(12), full: true }
  const drawing = runProgram({ program: PROGRAM, data }, { w: 100 })
  const term = renderTerm(drawing, { w: 100 }).regions.filter(r => r.rects.length).map(r => r.id).sort()
  const svg = renderSvg(drawing, { w: 840 })
  assert.ok(svg.svg.startsWith('<svg'))
  assert.deepEqual(svg.regions.filter(r => r.rects.length).map(r => r.id).sort(), term)
})

test('the verb: m on a calm map saves its full map from the spec Claude gave, once per version', async () => {
  const saved = []
  const kernel = { list: () => ({ error: 'no object' }) }
  const object = { id: '03-runs-map', version: 2, title: '24 runs', program: PROGRAM, data: many(24), source: { data: { title: '24 runs', moves: 'q5', threads: 'q4' } } }
  const out = await run({ object, kernel, region: null })
  assert.equal(out.object.name, 'runs-map-full')
  assert.deepEqual(out.object.data, { title: '24 runs', moves: 'q5', threads: 'q4', full: true })
  assert.equal(out.object.declared.from, 'obj:03-runs-map@2')
  const again = await run({ object, kernel: { list: () => ({ id: '04-runs-map-full', version: 1, lineage: { declared: { from: 'obj:03-runs-map@2' } } }) } })
  assert.deepEqual(again.object, { id: '04-runs-map-full', version: 1 })
  assert.equal(saved.length, 0)
})

test('the verb: m on a lane maps its threads on their own; one thread becomes its line', async () => {
  const data = many(24)
  const object = { id: '03-runs-map', version: 1, title: '24 runs', program: PROGRAM, data }
  const g = draw(data, { w: 100 })
  const lane = g.grid.regions.find(r => r.id.startsWith('ln-all-fixture'))
  const out = await run({ object, region: lane.id, regionMeta: lane.meta, kernel: {} })
  assert.equal(out.object.data.threads.length, 8)
  assert.ok(out.object.data.moves.every(m => lane.meta.threads.includes(m.thread)))
  const one = await run({ object, region: 'x', regionMeta: { label: 'r01', threads: ['r01'] }, kernel: {} })
  const d = draw(one.object.data, { w: 100 })
  assert.ok(d.text.includes('reads the test') && d.text.includes('to scale'), d.text)
})

test('the verb: m on something that is not a map asks Claude, in words the person sees', async () => {
  const out = await run({ object: { id: '01-saves', version: 1, title: 'Saves per day', program: 'return k.text("x")', data: {} }, kernel: {} })
  assert.ok(out.ask.startsWith('Map 01-saves@1 "Saves per day"'))
  assert.ok(askFor({ id: 'x', version: 1 }, 'day-3').includes('the part day-3'))
  assert.equal(isMap({ program: PROGRAM }), true)
  assert.equal(isMap({ program: 'return k.bars(data.x)' }), false)
})

test('filterThreads keeps stations and groups, and only the moves of the threads kept', () => {
  const f = filterThreads({ runs: { a: {}, b: {} }, moves: [{ run: 'a' }, { run: 'b' }], stations: [1, 2] }, ['a'])
  assert.deepEqual(f, { runs: { a: {} }, moves: [{ run: 'a' }], stations: [1, 2] })
})

test('the hint says what m would do for this object', () => {
  assert.equal(applies({ program: PROGRAM, data: ONE }), 'full map · 5 stations')
  assert.equal(applies({ program: PROGRAM, data: { ...ONE, full: true } }), 'map the threads of one station')
  assert.equal(applies({ program: 'x', lineage: { rows: { 'runs/a/agents/agent-01.jsonl': { count: 4 }, 'runs/a/agents/agent-02.jsonl': { count: 9 } } } }), 'map the 2 runs')
  assert.equal(applies({ program: 'x', lineage: { rows: { 'revisions.jsonl': { count: 14591 } } } }), 'map what revisions.jsonl holds')
  assert.equal(applies({ program: 'x', lineage: { rows: { 'a.csv': { count: 10 } } } }), null)
  assert.equal(applies(null), null)
})

test("the skill's examples are JSON the kernel takes, and draw", () => {
  const skill = readFileSync(HERE + '../SKILL.md', 'utf8')
  const blocks = [...skill.matchAll(/<<'JSON'\n([\s\S]*?)\nJSON/g)].map(m => m[1]).filter(b => !b.includes('...'))
  assert.equal(blocks.length, 3)
  for (const b of blocks) {
    const spec = JSON.parse(b)
    const d = runProgram(spec, { w: 100 })
    assert.equal(d.error, undefined, b)
  }
})

test('one thread with many stations, full: down the left, a station a row with its note and its share', () => {
  const stations = Array.from({ length: 11 }, (_, i) => ({ id: 's' + i, label: `station number ${i} with a long name`, note: `what happened at ${i}, said in a few more words than fit` }))
  const moves = stations.map((s, i) => ({ thread: 'a', station: s.id, start: i * 10 + 1, end: i * 10 + 10, _rows: [`a.jsonl#L${i * 10 + 1}-${i * 10 + 10}`] }))
  const g = draw({ title: 'long', unit: 'calls', threads: [{ id: 'a', steps: 110 }], moves, stations, links: [{ from: 's9', to: 's4', label: 'goes back' }], full: true }, { w: 72 })
  const lines = g.text.split('\n')
  assert.ok(lines.some(l => /●\s+1\s+station number 0/.test(l)), g.text)
  assert.ok(g.text.includes('↺') && g.text.includes('back: station number 9'), g.text)
  assert.ok(g.text.includes('110 calls in all'), g.text)
  const r = region(g, 'st-s3')
  assert.equal(r.rects.length, 1)
  assert.ok(r.rects[0].h >= 2, 'the station and its note are one part')
})

test("the verb: a zoom's stations show only the zoomed threads' rows", async () => {
  const data = many(24)
  data.stations = data.stations.map(s => ({ ...s, ref: `q1#station=${s.id}` }))
  const object = { id: '03-runs-map', version: 1, title: '24 runs', program: PROGRAM, data }
  const out = await run({ object, region: 'x', regionMeta: { label: 'some', threads: ['r01', 'r04'] }, kernel: {} })
  const g = draw(out.object.data, { w: 100 })
  const st = region(g, 'st-search')
  assert.ok(String(st.meta.ref).startsWith('runs/r01.jsonl') || (Array.isArray(st.meta.ref) && st.meta.ref.every(r => /r0[14]/.test(r))), JSON.stringify(st.meta.ref))
  assert.equal(st.meta.ref_all, 'q1#station=search')
})
