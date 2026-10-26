// The model's reads of a --prompt label (labels/labelreads.mjs): what a reply says of each record, and whole reads
// against the real kernel with a stand-in model.
//   node --test plugin/labels/test/labels.test.mjs
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { answersOf, because, failedCall, readLabel, summary } from '../labelreads.mjs'

const LEAN = fileURLToPath(new URL('../../bin/thimble', import.meta.url))
const LABEL = { name: 'apology', definition: 'The message apologizes.', values: ['yes', 'no'], reason: true }
const UNITS = [{ ref: 'a.jsonl#L1', text: 'Sorry, my mistake.' }, { ref: 'a.jsonl#L2', text: 'Merged.' }, { ref: 'a.jsonl#L3', text: 'Done.' }]

test('a reply gives each record its value; one it leaves out, or gives a value off the list, has none and says why', () => {
  const text = 'Here:\n```json\n[{"i": 1, "value": "Yes", "confidence": 0.9, "reason": "says sorry"}, {"i": 3, "value": "maybe"}]\n```'
  const got = answersOf(text, UNITS, LABEL.values)
  assert.deepEqual(got.values, { 'a.jsonl#L1': { value: 'yes', confidence: 0.9, reason: 'says sorry' } })
  assert.equal(got.failed['a.jsonl#L2'], 'the reply gave this record no value')
  assert.match(got.failed['a.jsonl#L3'], /"maybe", which is not one of yes, no/)
  assert.deepEqual(Object.keys(answersOf('no json here', UNITS, LABEL.values).failed), UNITS.map(u => u.ref))
  assert.equal(failedCall({ isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded' }, UNITS).failed['a.jsonl#L2'], 'the call failed: the API is overloaded')
  assert.equal(failedCall({ isAnswered: false, reason: 'api-error', status: 401, error: 'authentication_failed' }, UNITS).failed['a.jsonl#L2'], 'the call failed: the sign-in failed or expired. Sign in again with /login')
  assert.equal(summary('apology', { valued: 1, records: 3, counts: { yes: 1 }, waiting: 0, failed: 2, why: '1 call failed: the API is overloaded' }),
    'apology: 1 of 3 records have a value (1 yes). 2 have no value (1 call failed: the API is overloaded): `thimble label apology --again` asks the model again.')
})

/** A Python for the kernel, or null. */
function python() {
  for (const p of [process.env.THIMBLE_PYTHON, fileURLToPath(new URL('../../.venv/bin/python', import.meta.url)), 'python3']) {
    if (!p || (p.includes('/') && !existsSync(p))) continue
    if (spawnSync(p, ['-c', 'import sys; sys.exit(sys.version_info < (3, 10))'], { encoding: 'utf8' }).status === 0) return p
  }
  return null
}

test('reads: the calls of a wave go out together; with their answers the values are written, and a failed call leaves its records with no value', { skip: !python() && 'no Python 3.10 or later' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'label-reads-'))
  mkdirSync(join(root, 'chat'))
  const lines = ['I am sorry, I broke it.', 'Merged the fix.', 'My mistake, reverting.', 'All tests pass.']
  writeFileSync(join(root, 'chat', 'room.jsonl'), lines.map((t, i) => JSON.stringify({ agent: i % 2 ? 'moss' : 'wren', text: t })).join('\n') + '\n')
  const env = { ...process.env, THIMBLE_ROOT: root, THIMBLE_PYTHON: python(), THIMBLE_SESSION: 'test-label' }
  const kernel = async (args, input) => {
    const r = spawnSync(LEAN, args, { cwd: root, env, input: input ?? '', encoding: 'utf8' })
    return { code: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' }
  }
  const k = spawnSync(LEAN, ['label', 'apology', '--in', 'chat/*.jsonl', '--prompt', 'The message apologizes.'], { cwd: root, env, encoding: 'utf8' })
  assert.equal(k.status, 0, k.stdout + k.stderr)
  // the four records make one call
  const waves = []
  const seen = []
  const answer = async (reqs, each) => {
    waves.push(reqs)
    const out = reqs.map(req => {
      const recs = req.prompt.split('### record ').slice(1)
      return { isAnswered: true, text: JSON.stringify(recs.map((r, i) => ({ i: i + 1, value: /sorry|mistake/i.test(r) ? 'yes' : 'no', confidence: 0.8 }))) }
    })
    for (const [i, r] of out.entries()) await each(i, r)
    return out
  }
  const out = await readLabel({ name: 'apology', kernel, callAll: answer, template: '{{RECORDS}}', progress: p => { seen.push(p) } })
  assert.equal(waves.length, 1)
  assert.equal(waves[0].length, 1)
  assert.equal(waves[0][0].units, 4)
  assert.deepEqual(seen, [{ done: 0, of: 4, failed: 0 }, { done: 4, of: 4, failed: 0 }])
  assert.equal(out.text, 'apology: 4 of 4 records have a value (2 yes, 2 no).')
  assert.equal(out.failedCalls, 0)
  const s = JSON.parse(spawnSync(LEAN, ['label', 'apology', '--json'], { cwd: root, env, encoding: 'utf8' }).stdout)
  assert.deepEqual(s.counts, { yes: 2, no: 2 })
  // again, with the call failing: its records have no value, and the reads say so
  spawnSync(LEAN, ['label', 'apology', '--in', 'chat/*.jsonl', '--prompt', 'The message apologizes to a person.'], { cwd: root, env, encoding: 'utf8' })
  const busy = async (reqs, each) => {
    const out = reqs.map(() => ({ isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded' }))
    for (const [i, r] of out.entries()) await each(i, r)
    return out
  }
  const failed = await readLabel({ name: 'apology', kernel, callAll: busy, template: '{{RECORDS}}' })
  assert.equal(failed.failedCalls, 1)
  assert.equal(failed.why, 'the API is overloaded')
  assert.equal(failed.because, 'a model call failed: the API is overloaded')
  assert.match(failed.text, /^apology: 0 of 4 records have a value\. 4 have no value \(a model call failed: the API is overloaded\): `thimble label apology --again` asks the model again\.$/)
  // again, with the call answered but its reply not JSON: no call failed, and the line says the reply could not be read
  spawnSync(LEAN, ['label', 'apology', '--in', 'chat/*.jsonl', '--prompt', 'The message says sorry.'], { cwd: root, env, encoding: 'utf8' })
  const prose = async (reqs, each) => {
    const out = reqs.map(() => ({ isAnswered: true, text: 'I read the records and most of them apologize.' }))
    for (const [i, r] of out.entries()) await each(i, r)
    return out
  }
  const unread = await readLabel({ name: 'apology', kernel, callAll: prose, template: '{{RECORDS}}' })
  assert.equal(unread.failedCalls, 0)
  assert.equal(unread.failed, 4)
  assert.equal(unread.because, 'a model reply held no JSON array of values, so it could not be read')
  assert.match(unread.text, /4 have no value \(a model reply held no JSON array of values, so it could not be read\)/)
})

test('why records got no value: one part for each way, in plain words, and none left out', () => {
  assert.equal(because({ unread: 50, unreadWhy: 'held no JSON array of values' }), '50 model replies held no JSON array of values, so they could not be read')
  const off = answersOf('[{"i": 1, "value": "maybe"}, {"i": 2, "value": "no"}]', UNITS, LABEL.values)
  assert.equal(off.leftOut, 1)
  assert.equal(off.offList, 1)
  assert.equal(off.unread, null)
  assert.equal(because({ calls: 2, callWhy: 'the API is overloaded', unread: 1, unreadWhy: 'held no JSON array of values', leftOut: off.leftOut, offList: off.offList, offWhy: off.offWhy, before: 3 }),
    '2 model calls failed: the API is overloaded; a model reply held no JSON array of values, so it could not be read; ' +
    "the model's replies left out a record; the model gave a record a value off the label's list (the reply gave \"maybe\", which is not one of yes, no); " +
    '3 records had no value before these reads')
  assert.equal(because({}), '')
})
