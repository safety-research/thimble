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
import { exercise, exerciseLine } from '../exercise.mjs'
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
