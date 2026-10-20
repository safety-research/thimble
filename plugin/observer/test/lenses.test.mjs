// The post-turn pass as lenses (observer/compose.mjs, lenses/): the real texts compose with every placeholder filled,
// and each lens merges its part of the reply into the store.
//   node --test plugin/observer/test
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'

import { ROOT, textOf } from '../../prompts/node.mjs'
import { composeSystem, composeTurn, skeletonOf } from '../compose.mjs'
import { parseAnswer } from '../evidence.js'
import { LENSES } from '../lenses/index.mjs'

const byName = Object.fromEntries(LENSES.map(l => [l.name, l]))
const ST = { glossed: ['p95'], headsGiven: ['March is half a month'] }

test('the real fragments compose: every lens of the registry has instructions, and its digest fills from the state', () => {
  const frame = textOf('observer', ROOT, {}).text
  const parts = LENSES.map(lens => ({ lens, text: textOf(lens.feature, ROOT, {}).text }))
  const sys = composeSystem(frame, parts)
  assert.doesNotMatch(sys.text, /\{\{[A-Z_]+\}\}/)
  assert.doesNotMatch(sys.text, /<!--/)
  // the fork's template (observer-turn): the messages to read, the evidence, the digests, the skeleton
  const turn = composeTurn(textOf('observer-turn', ROOT, {}).text, { MESSAGES: 'Read this message of Claude\'s', ROW: 'v visualize', SHOWN: '', OBJECTS: 'No objects yet.', COVERAGE: 'c', SKELETON: skeletonOf(LENSES) }, parts, ST)
  assert.doesNotMatch(turn.text, /\{\{[A-Z_]+\}\}/)
  assert.doesNotMatch(turn.text, /notes/i)
  assert.match(turn.text, /Terms that already have an explainer in this session:\n- p95/)
  assert.match(turn.text, /\{"verbs": \{\}, "glosses": \[\], "heads": null, "claims": \[\]\}\s*$/)
})

/** A context as the observer hands it to a merge: what it holds, and what the merges did to it. */
function ctxOf(o = {}) {
  const did = { logged: {} }
  const ctx = {
    moved: false, verbs: {}, glosses: null,
    log: (k, v) => { did.logged[k] = v }, ...o,
  }
  return { ctx, did }
}
const merge = async (name, reply, o) => {
  const { ctx, did } = ctxOf(o)
  const lens = byName[name]
  await lens.merge(lens.read(parseAnswer(JSON.stringify(reply))), ctx)
  return { ctx, did }
}
test('the actions, squeeze and explain lenses each put their part where it goes', async () => {
  const a = await merge('actions', { verbs: { v: { note: '2 views ready', proposals: ['overwrites per day, June 18 marked', 'b', 'c'] }, s: { at: { interpret: 'report' } } } })
  assert.deepEqual(a.ctx.verbs, { v: { lit: true, note: '2 views ready', proposals: ['overwrites per day, June 18 marked', 'b'] } })
  const s = await merge('squeeze', { verbs: { s: { at: { interpret: 'report', familiarity: 'fluent' } } } })
  assert.deepEqual(s.ctx.verbs.s.at, { interpret: 'report', familiarity: 'fluent' })
  assert.equal(s.ctx.verbs.s.lit, false)
  const g = { term: 'p95', body: 'b' }
  assert.deepEqual((await merge('explain', { glosses: [g] })).ctx.glosses, [g])
  // every explain the pass gives is kept: no count and no backoff
  const more = ['canary', 'p99', 'shard', 'quorum'].map(term => ({ term, body: term }))
  assert.deepEqual((await merge('explain', { glosses: [g, ...more] })).ctx.glosses, [g, ...more])
  // when lit with no proposal and no note, v stays dim
  assert.deepEqual((await merge('actions', { verbs: { v: { proposals: [] } } })).ctx.verbs, {})
})

