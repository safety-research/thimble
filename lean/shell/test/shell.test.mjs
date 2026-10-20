// The shell's Node side: the verb registry, the verb runner, and what the shell says of an object.
//   node --test lean/shell/test/shell.test.mjs
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { chainWords, forDrawing, fromFacts, isRef, objectRefs, recordRefs, regionRefs, rowByName } from '../object.js'
import { runProgram } from '../../draw/sandbox-node.mjs'
import { prep } from '../node/prep.mjs'
import { findVerb, listVerbs, verbsFor } from '../node/registry.mjs'
import { runVerb, specOf } from '../node/verb.mjs'

function verbsDir(spec) {
  const dir = mkdtempSync(join(tmpdir(), 'verbs-'))
  for (const [name, files] of Object.entries(spec)) {
    mkdirSync(join(dir, name))
    for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, name, f), text)
  }
  return dir
}

const RUN_OK = 'export async function run(ctx) { return { text: `ran on ${ctx.object.id}${ctx.region ? " " + ctx.region : ""}`, note: "n", extra: 1 } }'

test('a verb is a folder: verb.json and run.mjs; every field of verb.json is kept, and a clash of keys is said', () => {
  const dir = verbsDir({
    squeeze: { 'verb.json': '{"key": "s", "name": "squeeze", "line": "shorter", "order": 1, "anything": {"x": 1}}', 'run.mjs': RUN_OK },
    stress: { 'verb.json': '{"key": "s", "line": "how sturdy"}', 'run.mjs': RUN_OK },
    broken: { 'verb.json': '{"key": "b"}' },
    nojson: { 'run.mjs': RUN_OK },
  })
  const { verbs, problems } = listVerbs(dir)
  assert.deepEqual(verbs.map(v => v.name), ['squeeze', 'stress'])
  assert.deepEqual(verbs[0].anything, { x: 1 })
  assert.equal(verbs[1].key, undefined)
  assert.ok(problems.some(p => /stress: key "s" is squeeze's/.test(p)))
  assert.ok(problems.some(p => /broken: no run\.mjs/.test(p)))
  assert.ok(problems.some(p => /nojson: no readable verb\.json/.test(p)))
  assert.equal(findVerb(verbs, 's').name, 'squeeze')
  assert.equal(findVerb(verbs, 'STRESS').name, 'stress')
})

test('the hint row picks the verbs the object names, then those whose hint.mjs has a phrase for it, at most 3', async () => {
  const dir = verbsDir({
    a: { 'verb.json': '{"key": "a", "order": 1}', 'run.mjs': RUN_OK },
    b: { 'verb.json': '{"key": "b", "order": 2}', 'run.mjs': RUN_OK, 'hint.mjs': 'export const applies = o => o.data ? "b for this" : null' },
    c: { 'verb.json': '{"key": "c", "order": 3}', 'run.mjs': RUN_OK, 'hint.mjs': 'export const applies = () => { throw new Error("x") }' },
    d: { 'verb.json': '{"key": "d", "order": 4}', 'run.mjs': RUN_OK, 'hint.mjs': 'export const applies = () => "d always"' },
  })
  const { verbs } = await verbsFor({ data: { x: 1 }, hints: ['d', 'nosuchverb'] }, { dir })
  assert.deepEqual(verbs.filter(v => v.picked).map(v => v.name), ['d', 'b'])
  assert.equal(verbs.find(v => v.name === 'b').phrase, 'b for this')
  assert.equal(verbs.find(v => v.name === 'c').phrase, null)
  const none = await verbsFor({}, { dir: verbsDir({ a: { 'verb.json': '{}', 'run.mjs': RUN_OK } }) })
  assert.deepEqual(none.verbs.filter(v => v.picked), [])
})

test('the plugin\'s verbs are visualize and squeeze, on v and s, the message row\'s, then label, which has no key (the kernel asks for it)', async () => {
  const { verbs, problems } = listVerbs()
  assert.deepEqual(problems, [])
  assert.deepEqual(verbs.map(v => [v.key ?? null, v.name]), [['v', 'visualize'], ['s', 'squeeze'], [null, 'label']])
  assert.deepEqual(verbs.filter(v => v.feed === true).map(v => v.name), ['label'])
  assert.deepEqual(verbs.filter(v => v.row === true).map(v => v.key), ['v', 's'])
})

test('a verb that calls the model stops until the shell has its answer, then runs with it', async () => {
  const dir = verbsDir({
    asks: { 'verb.json': '{}', 'run.mjs': 'export async function run(ctx) { const r = await ctx.model.complete({ model: "haiku", prompt: "hi" }); return { text: `said ${r.text}` } }' },
    swallows: { 'verb.json': '{}', 'run.mjs': 'export async function run(ctx) { try { await ctx.model.fork({ prompt: "why" }) } catch { return { text: "gave up" } } return { text: "never" } }' },
  })
  const input = { object: { id: '01-x', version: 1 }, root: tmpdir() }
  const first = await runVerb('asks', input, { dir })
  assert.equal(first.need.kind, 'complete')
  assert.deepEqual(first.need.request, { model: 'haiku', prompt: 'hi' })
  const second = await runVerb('asks', { ...input, answers: { [first.need.key]: { isAnswered: true, text: 'hello' } } }, { dir })
  assert.equal(second.text, 'said hello')
  // a verb that catches the stop itself still waits for its call
  assert.equal((await runVerb('swallows', input, { dir })).need.kind, 'fork')
})

test('a verb\'s object is saved by the kernel, its own lineage kept as declared', () => {
  const { name, spec } = specOf({ id: 'squeeze-x-1', v: 2, title: 't', program: 'p', data: {}, lineage: { cites: [1] }, declared: { read: 'a' } }, 'squeeze')
  assert.equal(name, 'squeeze-x-1')
  assert.deepEqual(spec, { title: 't', program: 'p', data: {}, declared: { read: 'a', squeeze: { cites: [1] } } })
})

test('a verb runs with the object, the region and its refs; a verb that throws comes back as an error', async () => {
  const dir = verbsDir({
    ok: { 'verb.json': '{"key": "o"}', 'run.mjs': 'export async function run(ctx) { return { text: `${ctx.object.id} ${ctx.region} ${ctx.refs.join(",")} ${typeof ctx.draw.runProgram} ${typeof ctx.kernel.resolve}`, note: "for Claude" } }' },
    bad: { 'verb.json': '{}', 'run.mjs': 'export async function run() { throw new Error("no luck") }' },
    made: { 'verb.json': '{}', 'run.mjs': 'export async function run() { return { object: { id: "07-made", version: 2 }, text: { a: 1 } } }' },
  })
  const input = { object: { id: '01-x', version: 1 }, region: 'day-1', refs: ['q1#day=1@n'], root: tmpdir() }
  const r = await runVerb('o', input, { dir })
  assert.equal(r.text, '01-x day-1 q1#day=1@n function function')
  assert.equal(r.note, 'for Claude')
  assert.equal(r.verb, 'ok')
  assert.match((await runVerb('bad', input, { dir })).error, /bad failed: no luck/)
  assert.match((await runVerb('nope', input, { dir })).error, /no verb "nope"/)
  const made = await runVerb('made', input, { dir })
  assert.deepEqual(made.saved, { id: '07-made', v: 2 })
  assert.equal(made.text, '{"a":1}')
})

const OBJ = {
  id: '01-saves', version: 1, title: 'Saves',
  data: { days: [{ day: '2026-06-17', n: 3, _rows: ['r.jsonl#L1-3'] }, { day: '2026-06-18', n: 2, _rows: ['r.jsonl#L4-5'] }] },
  lineage: { cites: [{ ref: 'q1#day=2026-06-18@n', label: '2' }, { ref: 'not a ref', label: 'x' }] },
}
const DRAWING = {
  regions: [
    { id: 'named', meta: { ref: 'q1#day=2026-06-17@n' } },
    { id: 'viacite', meta: { cite: 'c1' } },
    { id: 'day-2026-06-18', meta: { label: 'Jun 18', examples: 'ex' } },
    { id: 'nothing', meta: {} },
  ],
  cites: { c1: { text: 't', ref: ['obj:01-saves#/days/0/n'] } },
  examples: { ex: { total: 2, records: [{ ref: 'r.jsonl#L4', text: 'four' }, { text: 'no ref' }] } },
}

test('a region rests on the refs the program named, or on the data row its id names, never on a guess between two', () => {
  assert.deepEqual(regionRefs(OBJ, DRAWING, 'named'), { refs: ['q1#day=2026-06-17@n'], how: 'named' })
  assert.deepEqual(regionRefs(OBJ, DRAWING, 'viacite').refs, ['obj:01-saves#/days/0/n'])
  const m = regionRefs(OBJ, DRAWING, 'day-2026-06-18')
  assert.deepEqual(m.refs, ['obj:01-saves#/days/1'])
  assert.match(m.how, /matched by name: day = 2026-06-18/)
  assert.deepEqual(regionRefs(OBJ, DRAWING, 'nothing').refs, [])
  const twins = { id: 'o', data: { a: [{ k: 'xy', _rows: ['f#L1'] }, { k: 'xy', _rows: ['f#L2'] }] } }
  assert.equal(rowByName(twins, 'part-xy'), null)
  assert.deepEqual(recordRefs(DRAWING, 'day-2026-06-18'), [{ ref: 'r.jsonl#L4', text: 'four' }])
  assert.deepEqual(objectRefs(OBJ).map(c => c.ref), ['q1#day=2026-06-18@n'])
  assert.ok(isRef('revisions.jsonl#L28') && isRef('q12') && isRef('obj:01-a#/x') && !isRef('hello') && !isRef('https://x.org/#a'))
  assert.ok(isRef('r12') && isRef('r1#day=2026-06-18@n') && !isRef('r17-trail'))
})

test('a resolve chain reads as a few words, and a check that fails is said', () => {
  const w = chainWords({ chain: [{ step: 'object', id: 'o', at: '/days/1' }, { step: 'binding' }, { step: 'query', id: 'q1', about: 'saves per day', check: 'the value is 3, the rows are 2' }], rows: ['r.jsonl#L4-5'], count: 2, records: [{ ref: 'r.jsonl#L4', text: 'x' }], notes: [] })
  assert.equal(w.line, 'q1 · saves per day ← 2 source rows in r.jsonl')
  assert.deepEqual(w.notes, ['the value is 3, the rows are 2'])
  assert.equal(chainWords({ error: 'no query q9' }).error, true)
})

test('an object saved with no program draws its title and words', async () => {
  const o = forDrawing({ id: '02-words', version: 3, title: 'Words', text: 'June 18 had [6,543](q1#day=2026-06-18@n).' })
  assert.equal(o.v, 3)
  assert.equal(o.data.text, 'June 18 had 6,543.')
  const { drawing, verbs } = await prep({ object: { id: '02-words', version: 3, title: 'Words', text: 'hi' }, w: 60 })
  assert.equal(drawing.error, undefined)
  assert.ok(Array.isArray(verbs))
})

test('the from line counts labels once, and coverage when the kernel gave it', () => {
  const f = fromFacts({ lineage: { queries: { q1: { kept: ['kind'], inputs: [{ path: 'a.csv' }] }, q2: { uses: [{ name: 'kind' }] } } } }, { error: 'no lean' })
  assert.deepEqual(f, { sources: [{ path: 'a.csv', rows: null }], rows: 0, labels: ['kind'] })
})

test('a bar keeps the examples and cite its own meta names, so selecting it shows them', () => {
  const d = runProgram({ program: "k.examples('ex-1', { records: [{ text: 'a' }], total: 1 }); return k.bars([{ id: 'b1', label: 'one', value: 1, meta: { ref: 'q1#k=1@n', examples: 'ex-1' } }])", data: {} }, { w: 40 })
  const r = d.regions.find(x => x.id === 'b1')
  assert.equal(r.meta.examples, 'ex-1')
  assert.equal(r.meta.ref, 'q1#k=1@n')
})

test('every state key the plugin keeps is named in its types contract', () => {
  const here = new URL('../../', import.meta.url).pathname
  const declared = new Set([...readFileSync(join(here, 'types', 'index.d.ts'), 'utf8').split("'thimble': {")[1].matchAll(/^ {6}(\w+):/gm)].map(m => m[1]))
  const used = new Set()
  const walk = dir => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'app' || e.name.startsWith('.')) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.ts$/.test(e.name)) for (const m of readFileSync(p, 'utf8').matchAll(/plugin: 'thimble', key: '(\w+)'/g)) used.add(m[1])
    }
  }
  walk(here)
  assert.ok(used.size > 20)
  assert.deepEqual([...used].filter(k => !declared.has(k)), [])
})
