// The observer's look as lenses (observer/compose.mjs, lenses.mjs, reply.mjs): the real texts compose with every
// placeholder filled, each lens names its prompt text and its switch, and the reply is read leniently.
//   node --test plugin/observer/test
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { TEXTS, fileOf } from '../../prompts/registry.mjs'
import { SWITCHES } from '../../settings/features.mjs'
import { composeSystem, composeTurn, skeletonOf } from '../compose.mjs'
import { LENSES } from '../lenses.mjs'
import { parseAnswer } from '../reply.mjs'

const text = name => readFileSync(new URL(`../../${fileOf(name)}`, import.meta.url), 'utf8')
const ST = { glossed: ['p95'], headsGiven: ['March is half a month'], claims: { CLAIMS: 'c1 · k1 · The build broke on June 3.', CLUSTERS: 'k1 · what broke · 1', GROWN: '' } }

test('each lens names a text of the registry and the switch it belongs to', () => {
  assert.deepEqual(LENSES.map(l => l.name), ['explain', 'heads', 'claims'])
  for (const l of LENSES) {
    assert.ok(TEXTS[l.feature], `${l.name} reads ${l.feature}`)
    assert.ok(SWITCHES.some(s => s.key === l.option && (s.lenses ?? []).includes(l.name)), `${l.name} belongs to ${l.option}`)
  }
})

test('the real fragments compose: every placeholder filled, each digest from the state, the skeleton last', () => {
  const parts = LENSES.map(lens => ({ lens, text: text(lens.feature) }))
  const sys = composeSystem(text('observer'), parts)
  assert.doesNotMatch(sys.text, /\{\{[A-Z_]+\}\}/)
  assert.doesNotMatch(sys.text, /<!--/)
  const turn = composeTurn(text('observer-turn'), { MESSAGES: "Read this message of Claude's", ROW: 'v card', SHOWN: '', OBJECTS: 'No cards in these turns.', COVERAGE: 'c', SKELETON: skeletonOf(LENSES) }, parts, ST)
  assert.doesNotMatch(turn.text, /\{\{[A-Z_]+\}\}/)
  assert.match(turn.text, /Terms that already have an explainer in this session:\n- p95/)
  assert.match(turn.text, /- March is half a month/)
  assert.match(turn.text, /c1 · k1 · The build broke on June 3\./)
  assert.match(turn.text, /\{"glosses": \[\], "heads": null, "claims": \[\]\}\s*$/)
  // a lens whose feature is off has no section
  const two = composeSystem(text('observer'), parts.slice(0, 2))
  assert.doesNotMatch(two.text, /## Claims/)
})

test("the look's reply is read leniently: each lens's part, and nothing else", () => {
  const a = parseAnswer('Here: {"glosses": [{"term": "p95"}], "heads": {"term": "x"}, "claims": [{"claim": "y"}], "verbs": {"v": {}}, "notes": []}')
  assert.deepEqual(Object.keys(a).sort(), ['claims', 'clusters', 'glosses', 'heads'])
  assert.deepEqual(a.glosses, [{ term: 'p95' }])
  assert.equal(parseAnswer('{"heads": []}').heads, null)
  assert.equal(parseAnswer('no json'), null)
})
