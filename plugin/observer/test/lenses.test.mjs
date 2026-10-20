// The post-turn pass as lenses (observer/compose.mjs, lenses/): a fragment's sections, the system prompt (the frame and
// the enabled lenses' instructions, the reply's skeleton), the message (the turn, each lens's digest and its rules this
// turn), each lens's share of the pass, and each lens's merge into the store.
//   node --test plugin/observer/test
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { ROOT, textOf } from '../../prompts/node.mjs'
import { composeSystem, composeTurn, sectionsOf, sharesOf, skeletonOf } from '../compose.mjs'
import { parseAnswer } from '../evidence.js'
import { LENSES } from '../lenses/index.mjs'

const byName = Object.fromEntries(LENSES.map(l => [l.name, l]))
const FRAG = 'LENS one\n\nits principles\n\n<!-- digest -->\nKnown: {{THINGS}}\n\n<!-- when open -->\nNo line now.\n<!-- when backoff -->\nNothing now.'
const ST = { glossed: ['p95'], headsGiven: ['March is half a month'] }

test("a fragment's sections: its instructions, its digest's template, its rules by name", () => {
  const s = sectionsOf(FRAG)
  assert.equal(s.body, 'LENS one\n\nits principles')
  assert.equal(s.digest, 'Known: {{THINGS}}')
  assert.deepEqual(s.when, { open: 'No line now.', backoff: 'Nothing now.' })
  assert.deepEqual(sectionsOf('only a body'), { body: 'only a body', digest: null, when: {} })
})

test("the system prompt: the frame with each enabled lens's instructions in order, the skeleton's keys once", () => {
  const parts = [byName.actions, byName.squeeze, byName.explain, byName.heads].map(lens => ({ lens, text: `## ${lens.name}\nwords\n<!-- digest -->\nDIGEST ${lens.name}` }))
  const sys = composeSystem('FRAME\n{{LENSES}}\nREPLY {{SKELETON}}', parts)
  assert.equal(sys.text, 'FRAME\n## actions\nwords\n\n## squeeze\nwords\n\n## explain\nwords\n\n## heads\nwords\nREPLY {"verbs": {}, "glosses": [], "heads": null}')
  assert.doesNotMatch(sys.text, /DIGEST/)
  assert.equal(sys.chars.explain, '## explain\nwords'.length + 2)
  assert.equal(sys.shared + Object.values(sys.chars).reduce((a, b) => a + b, 0), sys.text.length)
  assert.equal(skeletonOf(LENSES), '{"verbs": {}, "glosses": [], "heads": null, "claims": []}')
})

test("the message: the turn's values, each lens's digest, and a rule only when its condition holds", () => {
  const one = { name: 'one', digest: st => ({ THINGS: st.things.join(', ') }), when: st => (st.open ? ['open'] : []) }
  const tmpl = 'Q {{QUESTION}}\n{{DIGEST}}\n{{RULES}}'
  const quiet = composeTurn(tmpl, { QUESTION: 'why?' }, [{ lens: one, text: FRAG }], { things: ['x', 'y'], open: false })
  assert.equal(quiet.text, 'Q why?\nKnown: x, y\n')
  const open = composeTurn(tmpl, { QUESTION: 'why?' }, [{ lens: one, text: FRAG }], { things: [], open: true })
  assert.equal(open.text, 'Q why?\nKnown: \n\nNo line now.\n')
  assert.equal(open.chars.one, 'Known: '.length + 2 + 'No line now.'.length + 2)
})

test('the real fragments compose: every lens of the registry has instructions, and its digest fills from the state', () => {
  const frame = textOf('observer', ROOT, {}).text
  const parts = LENSES.map(lens => ({ lens, text: textOf(lens.feature, ROOT, {}).text }))
  const sys = composeSystem(frame, parts)
  for (const h of ['## The actions that light', "## Where the answer stands on squeeze's chips", '## Explainers', '## Heads-ups', '## The claims of this turn']) assert.ok(sys.text.includes(h), h)
  assert.doesNotMatch(sys.text, /\{\{[A-Z_]+\}\}/)
  assert.doesNotMatch(sys.text, /<!--/)
  // the fork's template (observer-turn): the messages to read, the evidence, the digests, the skeleton
  const turn = composeTurn(textOf('observer-turn', ROOT, {}).text, { MESSAGES: 'Read this message of Claude\'s', ROW: 'v visualize', SHOWN: '', OBJECTS: 'No objects yet.', COVERAGE: 'c', SKELETON: skeletonOf(LENSES) }, parts, ST)
  assert.doesNotMatch(turn.text, /\{\{[A-Z_]+\}\}/)
  assert.doesNotMatch(turn.text, /notes/i)
  assert.match(turn.text, /Terms that already have an explainer in this session:\n- p95/)
  assert.match(turn.text, /\{"verbs": \{\}, "glosses": \[\], "heads": null, "claims": \[\]\}\s*$/)
})

test("each lens's share of the pass: its characters in and out, the frame and the turn as the shared part", () => {
  const parts = [byName.heads, byName.explain].map(lens => ({ lens, text: `${lens.name} words\n<!-- digest -->\nD` }))
  const system = composeSystem('F {{LENSES}} {{SKELETON}}', parts)
  const turn = composeTurn('T {{DIGEST}}', {}, parts, ST)
  const raw = { heads: { term: 't', bullets: ['b'] }, glosses: [{ term: 'p95' }] }
  const text = JSON.stringify(raw)
  const s = sharesOf({ system, turn, lenses: parts.map(x => x.lens), raw, rawText: text })
  assert.equal(s.lenses.heads.out, JSON.stringify(raw.heads).length)
  assert.equal(s.lenses.explain.out, JSON.stringify(raw.glosses).length)
  assert.equal(s.lenses.heads.in, system.chars.heads + turn.chars.heads)
  assert.equal(s.shared_in, system.shared + turn.shared)
  assert.ok(s.shared_out >= 0)
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

test('the explain lens has no rule of its own, and its digest and the heads-up lens\'s fill every placeholder', () => {
  assert.deepEqual(byName.explain.when({}), [])
  const explain = readFileSync(new URL('../../prompts/lens-explain.md', import.meta.url), 'utf8')
  assert.deepEqual(sectionsOf(explain).when, {})
  for (const name of ['heads', 'explain']) {
    const frag = readFileSync(new URL(`../../prompts/lens-${name}.md`, import.meta.url), 'utf8')
    const d = sectionsOf(frag).digest
    assert.ok(d, `lens-${name} has a digest`)
    const keys = [...d.matchAll(/\{\{([A-Z_]+)\}\}/g)].map(m => m[1])
    const vals = byName[name].digest(ST)
    for (const k of keys) assert.ok(k in vals, `lens-${name}'s digest fills {{${k}}}`)
  }
})

