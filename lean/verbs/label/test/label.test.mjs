// The label verb (verbs/label/): the request for one batch of records, what a reply says of each record, and a whole
// run against the real kernel with a stand-in model, through the verb runner (shell/node/verb.mjs), which hands back
// every call a run starts together.
//   node --test lean/verbs/label/test
import '../../../test-home.mjs'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { runVerb } from '../../../shell/node/verb.mjs'
import { answersOf, failedCall, requestFor } from '../calls.mjs'
import { summary } from '../run.mjs'

const LEAN = fileURLToPath(new URL('../../../bin/thimble', import.meta.url))
const LABEL = { name: 'apology', definition: 'The message apologizes.', values: ['yes', 'no'], reason: true }
const UNITS = [{ ref: 'a.jsonl#L1', text: 'Sorry, my mistake.' }, { ref: 'a.jsonl#L2', text: 'Merged.' }, { ref: 'a.jsonl#L3', text: 'Done.' }]

test('the request for a batch holds the definition, the values and each record under its number; its notes for the shell are kept apart', () => {
  const r = requestFor('C {{NAME}} | {{DEFINITION}} | {{VALUES}}{{REASON_FIELD}}\n{{RECORDS}}', LABEL, UNITS, { model: 'sonnet', effort: 'low', maxTokens: 8000, timeoutMs: 1000, promptId: 'labels/v1' })
  assert.match(r.prompt, /^C apology \| The message apologizes\. \| yes, no, "reason": one short sentence/)
  assert.match(r.prompt, /### record 1\nSorry, my mistake\.\n\n### record 2\nMerged\.\n\n### record 3\nDone\.$/)
  assert.equal(r.model, 'sonnet')
  assert.equal(r.effort, 'low')
  assert.equal(r.units, 3)
  assert.deepEqual(r.telemetry, { feature: 'labels', prompt: 'labels/v1' })
  assert.doesNotMatch(requestFor('{{REASON_FIELD}}', { ...LABEL, reason: false }, UNITS).prompt, /reason/)
})

test('a reply gives each record its value; one it leaves out, or gives a value off the list, has none and says why', () => {
  const text = 'Here:\n```json\n[{"i": 1, "value": "Yes", "confidence": 0.9, "reason": "says sorry"}, {"i": 3, "value": "maybe"}]\n```'
  const got = answersOf(text, UNITS, LABEL.values)
  assert.deepEqual(got.values, { 'a.jsonl#L1': { value: 'yes', confidence: 0.9, reason: 'says sorry' } })
  assert.equal(got.failed['a.jsonl#L2'], 'the reply gave this record no value')
  assert.match(got.failed['a.jsonl#L3'], /"maybe", which is not one of yes, no/)
  assert.deepEqual(Object.keys(answersOf('no json here', UNITS, LABEL.values).failed), UNITS.map(u => u.ref))
  assert.equal(failedCall({ isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded_error' }, UNITS).failed['a.jsonl#L2'], 'the call failed: api-error 529 (overloaded_error)')
  assert.equal(summary('apology', { valued: 1, records: 3, counts: { yes: 1 }, waiting: 0, failed: 2, why: '1 call failed: api-error 529' }),
    'apology: 1 of 3 records have a value (1 yes). 2 have no value (1 call failed: api-error 529): `thimble label apology --again` asks the model again.')
})

/** A Python with pandas for the kernel's counts, or null. */
function python() {
  for (const p of [process.env.THIMBLE_PYTHON, fileURLToPath(new URL('../../../.venv/bin/python', import.meta.url)), 'python3']) {
    if (!p || (p.includes('/') && !existsSync(p))) continue
    if (spawnSync(p, ['-c', 'import pandas'], { encoding: 'utf8' }).status === 0) return p
  }
  return null
}

test('a run: the calls of a wave are handed back together; with their answers the run writes the values, the card is saved again, and a failed call leaves its records with no value', { skip: !python() && 'no Python with pandas' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'label-verb-'))
  mkdirSync(join(root, 'chat'))
  const lines = ['I am sorry, I broke it.', 'Merged the fix.', 'My mistake, reverting.', 'All tests pass.']
  writeFileSync(join(root, 'chat', 'room.jsonl'), lines.map((t, i) => JSON.stringify({ agent: i % 2 ? 'moss' : 'wren', text: t })).join('\n') + '\n')
  const env = { ...process.env, THIMBLE_ROOT: root, THIMBLE_PYTHON: python(), THIMBLE_SESSION: 'test-label' }
  const k = spawnSync(LEAN, ['label', 'apology', '--in', 'chat/*.jsonl', '--prompt', 'The message apologizes.'], { cwd: root, env, encoding: 'utf8' })
  assert.equal(k.status, 0, k.stdout + k.stderr)
  const saved = { ...process.env }
  Object.assign(process.env, env)
  try {
    // the four records make one call; the run stops on it and hands it back
    const verb = join(fileURLToPath(new URL('../../', import.meta.url)))
    const answers = {}
    let out = await runVerb('label', { root, args: 'apology', answers, round: 0 }, { dir: verb })
    assert.ok(out.need, JSON.stringify(out))
    const needs = out.needs || [out.need]
    assert.equal(needs.length, 1)
    assert.equal(needs[0].request.units, 4)
    assert.deepEqual(out.limits, { parallel: 4, rounds: 60 })
    for (const n of needs) {
      const recs = n.request.prompt.split('### record ').slice(1)
      answers[n.key] = { isAnswered: true, text: JSON.stringify(recs.map((r, i) => ({ i: i + 1, value: /sorry|mistake/i.test(r) ? 'yes' : 'no', confidence: 0.8 }))) }
    }
    out = await runVerb('label', { root, args: 'apology', answers, round: 1 }, { dir: verb })
    assert.equal(out.need, undefined, JSON.stringify(out))
    assert.equal(out.text, 'apology: 4 of 4 records have a value (2 yes, 2 no).')
    assert.match(out.saved.id, /label-apology$/)
    assert.equal(out.saved.v, 2)
    const s = JSON.parse(spawnSync(LEAN, ['label', 'apology', '--json'], { cwd: root, env, encoding: 'utf8' }).stdout)
    assert.deepEqual(s.counts, { yes: 2, no: 2 })
    // again, with the call failing: its records have no value, and the run says so
    spawnSync(LEAN, ['label', 'apology', '--in', 'chat/*.jsonl', '--prompt', 'The message apologizes to a person.'], { cwd: root, env, encoding: 'utf8' })
    const again = {}
    out = await runVerb('label', { root, args: 'apology', answers: again, round: 0 }, { dir: verb })
    for (const n of out.needs || [out.need]) again[n.key] = { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded_error' }
    out = await runVerb('label', { root, args: 'apology', answers: again, round: 1 }, { dir: verb })
    assert.equal(out.failed, true)
    assert.match(out.text, /^apology: 0 of 4 records have a value\. 4 have no value \(1 call failed: api-error 529 \(overloaded_error\)\): `thimble label apology --again` asks the model again\.$/)
  } finally {
    for (const key of Object.keys(env)) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key] }
  }
})

test('the runner hands back every call a run starts together, with the verb\'s limits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'verbs-'))
  mkdirSync(join(dir, 'fan'))
  writeFileSync(join(dir, 'fan', 'verb.json'), JSON.stringify({ name: 'fan', parallel: 3, rounds: 12 }))
  writeFileSync(join(dir, 'fan', 'run.mjs'), "export async function run(ctx) { const r = await Promise.all(['a', 'b', 'c'].map(p => ctx.model.complete({ model: 'haiku', prompt: p }))); return { text: r.map(x => x.text).join(',') } }\n")
  const first = await runVerb('fan', { root: dir }, { dir })
  assert.equal(first.needs.length, 3)
  assert.deepEqual(first.needs.map(n => n.request.prompt), ['a', 'b', 'c'])
  assert.equal(first.need.key, first.needs[0].key)
  assert.deepEqual(first.limits, { parallel: 3, rounds: 12 })
  const answers = Object.fromEntries(first.needs.map(n => [n.key, { isAnswered: true, text: n.request.prompt.toUpperCase() }]))
  const done = await runVerb('fan', { root: dir, answers }, { dir })
  assert.equal(done.text, 'A,B,C')
})
