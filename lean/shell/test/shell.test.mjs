// The shell's Node side: what the shell says of an object, and the drawing a child prepares.
//   node --test shell/test/shell.test.mjs
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { chainWords, forDrawing, fromFacts, isRef, objectRefs, recordRefs, regionRefs, rowByName } from '../object.js'
import { runProgram } from '../../draw/sandbox-node.mjs'
import { prep } from '../node/prep.mjs'

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
  const { drawing } = await prep({ object: { id: '02-words', version: 3, title: 'Words', text: 'hi' }, w: 60 })
  assert.equal(drawing.error, undefined)
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
