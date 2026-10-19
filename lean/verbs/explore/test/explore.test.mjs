// Explore's tests: node --test lean/verbs/explore/test
import '../../../test-home.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runProgram } from '../../../draw/sandbox-node.mjs'
import { renderSvg } from '../../../draw/svg.js'
import { gridText, renderTerm } from '../../../draw/term.js'
import { nodeCtx, toAnsi } from '../cli.mjs'
import { applies } from '../hint.mjs'
import { countRows, explorable, explorationOf, hint, keys, press, request, rowsFor, run, turnKnob } from '../run.mjs'
import { viewLines } from '../view.mjs'

const HERE = fileURLToPath(new URL('..', import.meta.url))
const DATA = ['saves-per-day', 'run-steps', 'heavy-editors'].map(n => JSON.parse(readFileSync(join(HERE, 'examples', n + '.data.json'), 'utf8')))
const PROGRAMS = [...readFileSync(join(HERE, 'SKILL.md'), 'utf8').matchAll(/```js\n([\s\S]*?)```/g)].map(m => m[1])
const obj = (i, extra) => Object.assign({ id: ['03-explore-saves', '04-explore-run', '05-explore-heavy'][i], version: 1, verb: 'explore', program: PROGRAMS[i], data: DATA[i] }, extra)

// a kernel with no Python: it reads row sets back as made-up records, and counts what it was asked
function fakeKernel(objects = []) {
  const calls = []
  return {
    calls,
    resolve: async (ref, n = 5) => { calls.push(['resolve', ref, n]); return { count: countRows(ref), records: Array.from({ length: Math.min(n, countRows(ref) || 1) }, (_, i) => ({ ref: `${ref.split('#')[0]}#L${i + 1}`, text: `row ${i + 1} of ${ref}` })) } },
    rows: async (ref, { n = 5, fields = [] } = {}) => { calls.push(['rows', ref, n, fields.join(',')]); return Array.from({ length: Math.min(n, countRows(ref)) }, (_, i) => ({ ref: `${ref.split('#')[0]}#L${i + 1}`, value: { user: 'red-fox', text: `save ${i + 1}` } })) },
    objects: () => objects,
  }
}
const ctxOf = (object, kernel, extra) => Object.assign({ object, kernel, draw: { runProgram }, w: 96, h: 24, verb: { dir: '/x/lean/verbs/explore' } }, extra)

test('the skill\'s worked examples run, in both renderers, each with a knob and parts that lead to rows', () => {
  assert.equal(PROGRAMS.length, 3)
  PROGRAMS.forEach((program, i) => {
    for (const w of [72, 100, 140]) {
      const d = runProgram({ program, data: DATA[i] }, { w })
      assert.equal(d.error, undefined, `example ${i + 1} at ${w}: ${d.error && d.error.message}`)
      assert.deepEqual(d.warnings, [], `example ${i + 1} at ${w}`)
      assert.equal(JSON.stringify(renderTerm(d, { w }).marks), JSON.stringify(renderSvg(d, { w }).marks), `example ${i + 1}: the renderers disagree`)
      assert.ok(d.controls.length === 1, `example ${i + 1} has one knob`)
      assert.ok(explorable(d), `example ${i + 1} is explorable`)
    }
  })
})

test('x on something with no explore view asks Claude to write one (ask), which the shell sends as a turn', async () => {
  const plain = { id: '02-saves-per-day', version: 1, title: 'Saves per day', program: 'return k.text("hi")', data: {} }
  const r = await run(ctxOf(plain, fakeKernel([plain])))
  assert.equal(r.view, undefined)
  assert.equal(r.note, undefined)
  assert.match(r.ask, /read \/x\/lean\/verbs\/explore\/SKILL\.md/)
  assert.match(r.ask, /thimble save explore-saves-per-day --from FILE/)
  assert.match(r.ask, /"of": "02-saves-per-day"/)
  assert.match(r.ask, /Check that it draws, as the person will see it, with `thimble verb explore --text explore-saves-per-day`/)
  assert.match((await run(ctxOf(plain, fakeKernel([plain]), { check: 'node cli.mjs --text' }))).ask, /with `node cli\.mjs --text explore-saves-per-day`/)
  const reply = await run(ctxOf(null, fakeKernel(), { reply: { text: 'Jun 18 had the most saves: 6,543 of 14,591.\nMore.' } }))
  assert.match(reply.ask, /your reply that begins "Jun 18 had the most saves: 6,543 of 14,591\."/)
  // once Claude wrote one, x on the same object opens it at once
  const ex = obj(0, { of: '02-saves-per-day', updated: '2026-10-18T09:00:00Z' })
  assert.equal(explorationOf([plain, ex], plain).id, ex.id)
  const again = await run(ctxOf(plain, fakeKernel([plain, ex])))
  // the view Claude saved opens as it is: the shell is handed its id and version, so nothing is saved again
  assert.deepEqual(again.object, { id: ex.id, version: 1 })
  assert.equal(again.note, undefined)
  assert.equal(again.ask, undefined)
  assert.match(again.text, /^Opened 03-explore-saves: turn split; select a part to read its rows\.$/)
  assert.match(hint(again.view), /◂ ▸ split · tab parts · ↵ rows/)
})

test('a knob turns, the sentence follows, and rows open under the selected part', async () => {
  const kernel = fakeKernel()
  const ctx = ctxOf(obj(2), kernel)
  let { view } = await run(ctx)
  const text = () => gridText(renderTerm(view.drawing, { w: 96 }))
  assert.match(text(), /accounts saved at least ◂ 20 ▸ times/)
  view = await press(view, 'right', ctx)
  assert.match(text(), /saved at least ◂ 50 ▸ times/)
  view = await press(view, 'left', ctx)
  view = await press(view, 'left', ctx)
  assert.deepEqual(view.state, { min: 10 })
  // ↵ with nothing selected opens the first part with rows; the part names fields, so the kernel reads them
  view = await press(view, 'enter', ctx)
  assert.equal(view.region, 'heavy')
  assert.equal(view.rows.records.length, 5)
  assert.equal(view.rows.records[0].text, 'red-fox · save 1')
  assert.equal(view.rows.count, DATA[2].accounts.filter(a => a.n >= 10).reduce((s, a) => s + a.n, 0))
  assert.ok(kernel.calls.every(c => c[0] === 'rows' && c[3] === 'user,text'))
  // the rows follow the knob
  view = await press(view, 'right', ctx)
  assert.equal(view.rows.count, DATA[2].accounts.filter(a => a.n >= 20).reduce((s, a) => s + a.n, 0))
  const lines = viewLines(view, { w: 96 })
  const plain = toAnsi(lines, { plain: true })
  assert.match(plain, /┌ [\d,]+ rows · \d+ accounts with 20\+ saves · revisions\.jsonl/)
  assert.match(plain, /▸ \d+ accounts with 20\+ saves {2}◂ ▸ heavy means at least · ↵ close rows$/)
  view = await press(view, 'enter', ctx)
  assert.equal(view.rows, null)
})

test('scrubbing a run keeps the selection on the cursor, and its rows are that step\'s call and result', async () => {
  const kernel = fakeKernel()
  const ctx = ctxOf(obj(1), kernel)
  let { view } = await run(ctx)
  view = await press(view, 'tab', ctx)
  assert.equal(view.region, 'cursor', 'tab reaches the step under the cursor first, in reading order')
  assert.equal((await press(view, 'tab', ctx)).region, 'step', 'then the knob inside it')
  view = await press(view, 'enter', ctx)
  assert.deepEqual(view.rows.refs, ['agents/worker-03.jsonl#L3,4'])
  assert.equal(view.rows.count, 2)
  for (let i = 0; i < 3; i++) view = await press(view, 'shift+right', ctx)
  assert.equal(view.state.step, 31)
  assert.equal(view.region, 'cursor')
  assert.deepEqual(view.rows.refs, DATA[1].steps[30]._rows)
  assert.match(gridText(renderTerm(view.drawing, { w: 96 })), /step ◂ 31 of 64 ▸/)
  view = await press(view, 'shift+right', ctx)
  view = await press(view, 'shift+right', ctx)
  view = await press(view, 'shift+right', ctx)
  assert.equal(view.state.step, 61)
  view = await press(view, 'shift+right', ctx)
  assert.equal(view.state.step, 64, 'scrubbing stops at the last step')
  // turning a knob by its id (a click on its ◂) leaves the selection, and the rows, on the cursor
  view = await turnKnob(view, 'step', -1, ctx)
  assert.equal(view.region, 'cursor')
  assert.deepEqual(view.rows.refs, DATA[1].steps[62]._rows)
})

test('rows: refs come from the part\'s meta or its cite; row sets count without the kernel', async () => {
  assert.equal(countRows('revisions.jsonl#L4-9,12,40-41'), 9)
  assert.equal(countRows('runs.csv#row=1-30'), 30)
  assert.equal(countRows('forge.db#prs/1-12'), 12)
  assert.equal(countRows('a.jsonl#L4.b1'), 1)
  assert.equal(countRows('a.jsonl#L4.b0-2,5-9.b1'), 8)
  assert.equal(countRows('q3#day=2026-06-18@n'), null)
  const d = runProgram({ program: `k.cite('c', { text: 'x', query: 'q3#day=2026-06-18@n', rows: [{ a: 1 }] })
    return k.stack(k.region('a', { cite: 'c' }, k.text('a')), k.region('b', { ref: 'obj:01-x#/days/2' }, k.text('b')), k.region('c2', 'no rows', k.text('c')))` }, { w: 60 })
  const kernel = fakeKernel()
  const a = await rowsFor(d, 'a', kernel)
  assert.deepEqual(a.refs, ['q3#day=2026-06-18@n'])
  const b = await rowsFor(d, 'b', kernel)
  assert.deepEqual(b.refs, ['obj:01-x#/days/2'])
  const c = await rowsFor(d, 'c2', kernel)
  assert.equal(c.note, 'this part names no rows')
  assert.ok(explorable(d))
  // a program that throws offers no keys, and its error goes back to Claude as a note (no turn of its own)
  const bad = { id: '09-explore-bad', version: 1, verb: 'explore', program: 'return data.nope.x', data: {} }
  const r = await run(ctxOf(bad, fakeKernel()))
  assert.deepEqual(keys(r.view), [])
  assert.match(r.note, /09-explore-bad failed to draw: TypeError: .*Fix its program and save it again under the same name/)
})

test('the hint says what x would do for this object, or nothing', () => {
  assert.equal(applies(obj(2)), 'turn heavy means at least')
  assert.equal(applies(obj(1)), 'scrub step')
  assert.equal(applies({ id: 'a', program: 'return k.bars(data.days)', data: { days: DATA[0].days } }), `explore ${DATA[0].days.length} days`)
  assert.equal(applies({ id: 'a', text: 'A summary in words.', data: {} }), null)
  assert.equal(applies(null, { reply: { text: 'Jun 18 had 6,543 saves of 14,591.' } }), 'explore')
  assert.equal(applies(null, { reply: { text: 'Done: I renamed the file.' } }), null)
})

test('end to end with the real kernel: a query, a saved explore view, rows read back by ↵', async t => {
  const py = process.env.THIMBLE_PYTHON || 'python3'
  try { execFileSync(py, ['-c', 'import pandas'], { stdio: 'ignore' }) } catch (e) { t.skip('no Python with pandas (set THIMBLE_PYTHON)'); return }
  const dir = mkdtempSync(join(tmpdir(), 'explore-'))
  writeFileSync(join(dir, 'log.jsonl'), Array.from({ length: 30 }, (_, i) => JSON.stringify({ day: `2026-03-0${1 + (i % 3)}`, user: ['red-fox', 'blue-jay'][i % 2], text: `save ${i + 1}` })).join('\n') + '\n')
  const env = { ...process.env, THIMBLE_PYTHON: py, THIMBLE_HOME: join(dir, '.home'), THIMBLE_SESSION: 'test' }
  const lean = (args, input) => execFileSync(join(HERE, '..', '..', 'bin', 'thimble'), args, { cwd: dir, env, input, encoding: 'utf8' })
  lean(['q', 'saves per day'], 'df = load("log.jsonl", fields=["day", "user", "text"])\ntally(df, "day")\n')
  writeFileSync(join(dir, 'view.js'), `const k2 = k.knob('min', { values: [0, 10], at: 0, label: 'at least' })
    return k.stack(data.days.filter(d => d.n >= k2).map(d => k.region('day-' + d.day, { label: d.day, rows: d._rows, fields: ['user', 'text'] }, k.beside(k.text(d.day), k.bar(d.n, { max: 10 })))))`)
  writeFileSync(join(dir, 'spec.json'), JSON.stringify({ title: 'Saves per day', verb: 'explore', data: { days: 'q1' } }))
  assert.match(lean(['save', 'explore-days', '--from', 'spec.json', '--program', 'view.js']), /saved 01-explore-days v1/)
  const ctx = nodeCtx(dir, { w: 80 })
  const saved = await ctx.kernel.load('explore-days')
  const prev = { THIMBLE_PYTHON: process.env.THIMBLE_PYTHON, THIMBLE_SESSION: process.env.THIMBLE_SESSION, THIMBLE_HOME: process.env.THIMBLE_HOME }
  Object.assign(process.env, { THIMBLE_PYTHON: py, THIMBLE_SESSION: 'test', THIMBLE_HOME: env.THIMBLE_HOME })
  try {
    let { view } = await run(Object.assign(ctx, { object: saved }))
    view = await press(view, 'enter', ctx)
    assert.equal(view.region, 'day-2026-03-01')
    assert.equal(view.rows.count, 10)
    assert.deepEqual(view.rows.records.map(r => r.ref), ['log.jsonl#L1', 'log.jsonl#L4', 'log.jsonl#L7', 'log.jsonl#L10', 'log.jsonl#L13'])
    assert.equal(view.rows.records[1].text, 'blue-jay · save 4')
  } finally { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
})
