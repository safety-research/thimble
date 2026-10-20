// A save's check (draw/exercise.mjs): every interaction a card declares tried once, as the person would, before they
// press anything; what fails is one line for Claude, a pass says nothing, and the tries change nothing.
//   node --test plugin/draw/test
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { brushAreas, exercise, exerciseLine, triesOf } from '../exercise.mjs'
import { runProgram } from '../sandbox-node.mjs'
import { prep } from '../../shell/node/prep.mjs'

const CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url))
const OPTS = { w: 80, h: 24, mode: 'inline', state: { browser: false } }
const card = (program, data) => ({ id: '02-hour', title: 'One agent hour', program, data })
const check = (o, budget) => { const d = runProgram(o, OPTS); return { d, r: exercise(o, OPTS, d, budget) } }

// a zoom by phase whose steps were bound to a name the kernel could not fill: the overview draws, every zoom fails
const ZOOM = `
const zoom = k.knob('zoom', { values: ['overview', ...data.phases.map(p => p.phase)], at: 'overview' })
if (zoom === 'overview') return k.stack(k.dial('zoom'), ...data.phases.map(p => k.region('phase-' + p.phase, { label: p.phase }, k.text(p.phase))))
const st = data.steps.filter(s => s.phase === zoom)
return k.stack(k.text(zoom + ': ' + st.length + ' steps'))`
const PHASES = [{ phase: 'orient' }, { phase: 'build' }, { phase: 'test' }]

test('a knob whose other values fail is caught at the save: one line, the first failure with its state, the count of the rest', () => {
  const { d, r } = check(card(ZOOM, { phases: PHASES, steps: 'a25_steps' }))
  assert.equal(d.error, undefined, 'the drawn state draws')
  assert.equal(r.tried, 3)
  assert.equal(r.failed.length, 3)
  const line = exerciseLine(r)
  assert.match(line, /^Tried as the analyst would, turning zoom to orient fails: TypeError: data\.steps\.filter is not a function/)
  assert.match(line, /\(state \{"zoom":"orient"\}\)/)
  assert.match(line, /2 more fail the same way/)
  assert.match(line, /save it again under the same name now/)
  assert.equal(line.split('\n').length, 1)
  // the same card with its steps bound: nothing to say
  const ok = check(card(ZOOM, { phases: PHASES, steps: [{ phase: 'build' }] })).r
  assert.equal(ok.tried, 3)
  assert.equal(ok.failed.length, 0)
  assert.equal(exerciseLine(ok), null)
})

test("each key, press and brush a card's handlers take is one try; a press on every part when it takes any press", () => {
  const program = `
  k.on('f', () => ({ flip: !k.state.flip }), 'flip')
  k.on('press', e => ({ picked: data.rows.find(r => r.id === e.region).n }))
  k.on('press:total', () => ({ total: true }))
  k.on('brush', e => ({ from: e.from.toFixed(1), to: e.to.toFixed(1) }))
  k.on('tick', e => ({ frame: e.k.toFixed(0) }))
  return k.stack(...data.rows.map(r => k.region(r.id, { label: r.id }, k.text(r.id))), k.region('total', {}, k.text('all')),
    k.plot([[0, 1], [10, 4]], { brush: 'span' }))`
  const o = card(program, { rows: [{ id: 'a', n: 1 }, { id: 'b', n: 2 }] })
  const d = runProgram(o, OPTS)
  const tries = triesOf(d, OPTS.state)
  const events = tries.map(t => t.event)
  assert.deepEqual(events.find(e => e.type === 'key'), { type: 'key', key: 'f', region: 'a' }, 'a key comes with the first part, as the host sends the part selected')
  assert.deepEqual(events.filter(e => e.type === 'press').map(e => e.region).sort(), ['a', 'b', 'total'])
  const brush = events.find(e => e.type === 'brush')
  assert.equal(brush.id, 'span')
  assert.deepEqual([brush.from, brush.to], [2.5, 7.5], 'across the middle half of the plot\'s x range')
  assert.ok(!events.some(e => e.type === 'tick'), 'an event no handler asks for is not sent bare: its payload is the asker\'s')
  assert.deepEqual(brushAreas(d), [{ id: 'span', min: 0, max: 10 }])
  const r = exercise(o, OPTS, d)
  assert.equal(r.failed.length, 0, JSON.stringify(r.failed))
  // a press on a part the data lacks fails, and says which part
  const bad = card(program, { rows: [{ id: 'a', n: 1 }] })
  const d2 = runProgram({ ...bad, data: { rows: [{ id: 'a', n: 1 }, { id: 'b' }] } }, OPTS)
  const r2 = exercise(bad, OPTS, d2)
  assert.match(exerciseLine(r2), /pressing b fails: TypeError/)
})

test('an event a handler asks for later (k.after) is tried once, with its payload, from the state the handler left', () => {
  const program = `
  k.on('r', () => { k.after(100, 'frame', { k: 1 }); return { playing: true } }, 'replay')
  k.on('frame', e => ({ shown: data.order[e.k].name }))
  return k.text(String(k.state.shown || 'all'))`
  const ok = check(card(program, { order: [{ name: 'x' }, { name: 'y' }] })).r
  assert.equal(ok.tried, 2)
  assert.equal(ok.failed.length, 0)
  const bad = check(card(program, { order: [{ name: 'x' }] })).r
  assert.equal(bad.failed.length, 1)
  assert.match(exerciseLine(bad), /its later event frame \(after pressing r \(replay\)\) fails/)
})

test('the tries are pure: an ask opens no thread, a k.do is not carried out, the state given is not changed', () => {
  const program = `
  k.on('a', () => { k.ask({ label: 'this', text: 'why?' }); k.do('open', { id: 'x' }); return { asked: true } })
  return k.text('card')`
  const o = card(program, {})
  const state = { browser: false, kept: 1 }
  const d = runProgram(o, { ...OPTS, state })
  const r = exercise(o, { ...OPTS, state }, d)
  assert.equal(r.tried, 1)
  assert.equal(r.failed.length, 0)
  assert.deepEqual(state, { browser: false, kept: 1 })
})

test('handlers a program declares only in the detail are tried there too; a slow card is cut at the budget and the line says so', () => {
  const detailOnly = `
  if (k.mode === 'detail') k.on('e', () => ({ ex: data.examples.length }), 'examples')
  return k.text('card')`
  const r = check(card(detailOnly, {})).r
  assert.equal(r.tried, 1)
  assert.match(exerciseLine(r), /pressing e \(examples\) fails/)
  // forty values, each run slow: past the budget the rest are left, and the line counts them
  const slow = `
  const v = k.knob('v', { min: 1, max: 40, at: 1 })
  const t = Date.now(); while (Date.now() - t < 15) {}
  if (v > 1) return k.text(data.x.y)
  return k.text('start')`
  const s = check(card(slow, {}), 60).r
  assert.ok(s.cut > 0, 'cut')
  assert.ok(s.tried < 12)
  assert.match(exerciseLine(s), /Only \d+ of \d+ were tried in time/)
})

test('prep.mjs checks only when asked (a save), in the same run; cli.mjs --check prints the same line', async () => {
  const o = card(ZOOM, { phases: PHASES, steps: 'a25_steps' })
  const plain = await prep({ object: o, w: 80 })
  assert.equal(plain.check, undefined)
  const saved = await prep({ object: o, w: 80, check: true })
  assert.equal(saved.check.failed, 3)
  assert.match(saved.check.line, /turning zoom to orient fails/)
  assert.ok(saved.check.ms >= 0)
  const dir = mkdtempSync(join(tmpdir(), 'exercise-'))
  writeFileSync(join(dir, 'card.json'), JSON.stringify(o))
  const out = spawnSync(process.execPath, [CLI, join(dir, 'card.json'), '--check'], { encoding: 'utf8' })
  assert.equal(out.status, 1)
  assert.match(out.stdout, /turning zoom to orient fails: TypeError/)
  writeFileSync(join(dir, 'good.json'), JSON.stringify(card(ZOOM, { phases: PHASES, steps: [] })))
  const good = spawnSync(process.execPath, [CLI, join(dir, 'good.json'), '--check'], { encoding: 'utf8' })
  assert.equal(good.status, 0)
  assert.match(good.stdout, /^all 3 interactions ran/)
})
