// The drawing contract's tests: node --test plugin/draw/test
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadExamples } from '../examples/load.mjs'
import { fromArgs, fromHash, objectRef, toCommand, toHash } from '../handoff.js'
import { runProgram } from '../sandbox-node.mjs'
import { gridText, len, renderTerm } from '../term.js'

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

// the card guide's worked programs (skills/thimble/forms), which the guide holds word for word, and the forms earlier
// guides showed (draw/test/forms), which cards saved then still use
const GUIDE_FORMS = ['flow', 'anatomy', 'grid']
const OLD_FORMS = ['timeline', 'versions', 'knob', 'bars', 'trend', 'records', 'map', 'table', 'guide', 'weeks', 'trail', 'curves', 'diffmap', 'strips', 'unfold']

test('every form of the card guide, and of earlier guides, draws under a reply and in the detail with parts to select', () => {
  const guide = readFileSync(DRAW + '../skills/thimble/cards.md', 'utf8')
  for (const name of [...GUIDE_FORMS, ...OLD_FORMS]) {
    const dir = GUIDE_FORMS.includes(name) ? DRAW + '../skills/thimble/forms/' : DRAW + 'test/forms/'
    const program = readFileSync(join(dir, `${name}.program.js`), 'utf8').trimEnd()
    if (GUIDE_FORMS.includes(name)) assert.ok(guide.includes(program.replace(/^(\/\/[^\n]*\n)+/, '')), `the card guide holds ${name}.program.js`)
    const data = JSON.parse(readFileSync(join(dir, `${name}.data.json`), 'utf8'))
    for (const [w, mode] of [[96, 'inline'], [98, 'detail'], [60, 'inline']]) {
      const d = runProgram({ id: name, v: 1, program, data }, { w, h: mode === 'detail' ? 30 : 24, mode })
      assert.equal(d.error, undefined, `${name} at ${w} ${mode}: ${JSON.stringify(d.error)}`)
      assert.deepEqual(d.warnings, [], `${name} at ${w} ${mode}`)
      const g = renderTerm(d, { w })
      assert.ok(g.regions.filter(r => r.rects.length).length >= 3, `${name} has parts to select`)
      if (w >= 96) assert.deepEqual(g.cut.filter(c => c.k === 'clip'), [], `${name} fits ${w} columns`)
    }
  }
})

const plotRows = (program, w = 80) => {
  const d = runProgram({ program }, { w, h: 24 })
  assert.equal(d.error, undefined, d.error && d.error.message)
  const t = gridText(renderTerm(d, { w })).split('\n')
  return { t, area: t.slice(0, t.findIndex(l => l.includes('└'))).filter(l => /[┤│]/.test(l)) }
}
const PTS = [[1, 0], [2, 2.5], [3, 5], [4, 7.5], [5, 10], [6, 5]]

test('a plot asked for fewer rows still draws five, so its values do not flatten onto one line', () => {
  for (const h of [3, 4, 5]) {
    const { area } = plotRows(`return k.plot([{ name: 'win %', points: ${JSON.stringify(PTS)} }], { h: ${h}, dots: true, y: { min: 0 } })`)
    assert.ok(area.length >= 5, `h ${h}: ${area.length} rows of plot`)
    assert.ok(area.filter(l => /[⠀-⣿]/.test(l)).length >= 3, area.join('\n'))
  }
})

test("a plot's y ticks spread over its rows, points sit on their tick's row, and the legend draws dots as dots", () => {
  const { t, area } = plotRows(`return k.plot([{ name: 'win %', points: ${JSON.stringify(PTS)} }], { h: 4, dots: true, y: { min: 0 } })`)
  // the labels: no two on neighboring rows; 0 sits on the last row of plot, beside the dots at 0; 10 beside the dot at 10
  const labelled = area.map((l, i) => [i, (/^\s*([\d,.]+)┤/.exec(l) || [])[1]]).filter(r => r[1])
  assert.ok(labelled.length >= 2 && labelled.every((r, i) => i === 0 || r[0] - labelled[i - 1][0] >= 2), JSON.stringify(labelled))
  assert.deepEqual(labelled.at(-1), [area.length - 1, '0'])
  assert.match(area.at(-1), /0┤[⠀-⣿]/)
  assert.match(area[0], /10┤.*[⠀-⣿]/)
  // the legend draws the series as the plot does: a dot for dots, a stroke for a line
  assert.match(t.join('\n'), /⠶ win %/)
  assert.match(plotRows(`return k.plot([{ name: 'saves', points: ${JSON.stringify(PTS)} }], { h: 8 })`).t.join('\n'), /━ saves/)
  // a peak above the top tick plots above that tick's row, not level with it
  const big = plotRows(`return k.plot([{ name: 'actions', points: [[0, 180], [10, 1238], [20, 404], [30, 30]] }], { h: 8, dots: true, y: { min: 0 } })`).t
  const top = big.findIndex(l => /1,000┤/.test(l))
  assert.ok(top > 0 && big.slice(0, top).some(l => /[⠀-⣿]/.test(l)), big.join('\n'))
})

test("a plot's x label too long for the tick row has a row of its own, cut with … only when wider than the plot", () => {
  const under = label => {
    const d = runProgram({ program: `return k.plot([{ name: 'n', points: [[0, 1], [230, 5]] }], { h: 8, x: { label: ${json(label)} } })` }, { w: 60, h: 24 })
    const g = renderTerm(d, { w: 60 })
    const t = gridText(g).split('\n')
    return { below: t.slice(t.findIndex(l => l.includes('└')) + 1, t.findIndex(l => l.includes('└')) + 3), cut: g.cut }
  }
  // a short label sits on the tick row, after the last tick's value
  assert.match(under('min').below[0], /200\s+min$/)
  // a long one: whole, on the next row
  const long = 'minutes after 14:00 (pushed at 54, merged at 122)'
  assert.equal(under(long).below[1].trim(), long)
  // wider than the plot: cut with …, and said in `cut`
  const wide = under(long + ', reverted at 161, and the end of the run')
  assert.match(wide.below[1], /^minutes after .*…$/)
  assert.deepEqual(wide.cut.filter(c => c.k === 'axis').length, 1)
})

test('a plot reads an [x, y] pair in values as a point, and says so when a series has nothing to draw', () => {
  // the round-3 shape: values made of [step, value] pairs
  const pairs = [[500, 0], [1000, 2.5], [1500, 5], [2000, 2.5]]
  const d = runProgram({ program: `return k.plot([{ name: 'win %', values: ${json(pairs)} }, { name: 'n', values: [3, '4', null, 6] }], { h: 6 })` }, { w: 60, h: 24 })
  assert.deepEqual(d.root.series.map(s => s.pts), [pairs, [[0, 3], [1, 4], [2, null], [3, 6]]])
  assert.deepEqual(d.warnings, [])
  assert.match(gridText(renderTerm(d, { w: 60 })), /2,000/)
  // a series with no point: a warning that names it and the fix, not an empty plot
  const bad = runProgram({ program: `return k.plot([{ name: 'win %', values: data.rows }])`, data: { rows: [{ step: 1, win: 2 }] } }, { w: 60, h: 24 })
  assert.match(bad.warnings.join('\n'), /"win %" has no point to draw; give it values \(numbers\) or points \(\[x, y\] pairs\)/)
})

test('dots apply per series, and each legend entry shows its series as it is drawn', () => {
  const steps = [[500, 60], [1000, 68], [1500, 84], [2000, 87]]
  const { t } = plotRows(`return k.plot([{ name: 'legal %', points: ${json(steps)}, dots: true }, { name: 'goal 99%', points: [[500, 99], [2000, 99]], tone: 'dim' }], { h: 8 })`)
  assert.match(t.join('\n'), /⠶ legal %\s+━ goal 99%/)
  // the plot's own dots is the default; a series' dots: false keeps its line
  const d = runProgram({ program: `return k.plot([{ name: 'a', points: ${json(steps)} }, { name: 'b', points: [[500, 99], [2000, 99]], dots: false }], { dots: true })` }, { w: 60, h: 24 })
  assert.deepEqual(d.root.series.map(s => !!s.dots), [true, false])
  assert.match(gridText(renderTerm(d, { w: 60 })), /⠶ a\s+━ b/)
})
