// The post-turn pass as lenses (observer/compose.mjs, lenses/, turn.mjs): a fragment's sections, the system prompt
// (the frame and the enabled lenses' instructions, the reply's skeleton), the message (the turn, each lens's digest and
// its rules this turn), each lens's share of the pass, each lens's merge into the store, and the turn cut to fit.
//   node --test lean/observer/test
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { emptyStore } from '../../verbs/claims/claims.js'
import { ROOT, textOf } from '../../prompts/node.mjs'
import { composeSystem, composeTurn, sectionsOf, sharesOf, skeletonOf } from '../compose.mjs'
import { isRepeat, parseAnswer } from '../evidence.js'
import { LENSES } from '../lenses/index.mjs'
import { callOf, stepsOf, turnMessages } from '../turn.mjs'

const byName = Object.fromEntries(LENSES.map(l => [l.name, l]))
const FRAG = 'LENS one\n\nits principles\n\n<!-- digest -->\nKnown: {{THINGS}}\n\n<!-- when open -->\nNo line now.\n<!-- when backoff -->\nNothing now.'
const ST = { seen: ['a line seen'], known: [], notesGiven: ['a note given'], open: null, skips: 0, glossed: ['p95'], glossSkip: 0, store: emptyStore('s'), grown: [] }

test("a fragment's sections: its instructions, its digest's template, its rules by name", () => {
  const s = sectionsOf(FRAG)
  assert.equal(s.body, 'LENS one\n\nits principles')
  assert.equal(s.digest, 'Known: {{THINGS}}')
  assert.deepEqual(s.when, { open: 'No line now.', backoff: 'Nothing now.' })
  assert.deepEqual(sectionsOf('only a body'), { body: 'only a body', digest: null, when: {} })
})

test("the system prompt: the frame with each enabled lens's instructions in order, the skeleton's keys once", () => {
  const parts = [byName.notes, byName.actions, byName.squeeze, byName.claims].map(lens => ({ lens, text: `## ${lens.name}\nwords\n<!-- digest -->\nDIGEST ${lens.name}` }))
  const sys = composeSystem('FRAME\n{{LENSES}}\nREPLY {{SKELETON}}', parts)
  assert.equal(sys.text, 'FRAME\n## notes\nwords\n\n## actions\nwords\n\n## squeeze\nwords\n\n## claims\nwords\nREPLY {"notes": [], "verbs": {}, "claims": []}')
  assert.doesNotMatch(sys.text, /DIGEST/)
  assert.equal(sys.chars.notes, '## notes\nwords'.length + 2)
  assert.equal(sys.shared + Object.values(sys.chars).reduce((a, b) => a + b, 0), sys.text.length)
  assert.equal(skeletonOf(LENSES), '{"notes": [], "line": null, "settled": false, "verbs": {}, "glosses": [], "claims": []}')
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
  for (const h of ['## Notes to Claude', '## One line to the analyst', '## The actions that light', "## Where the answer stands on squeeze's chips", '## Explain marks', '## The claims of this turn']) assert.ok(sys.text.includes(h), h)
  assert.doesNotMatch(sys.text, /\{\{[A-Z_]+\}\}/)
  assert.doesNotMatch(sys.text, /<!--/)
  const turn = composeTurn(textOf('observer-turn', ROOT, {}).text, { QUESTION: 'q', QUESTION_STEP: 's', DECISION: 'none stated', ROW: 'v visualize', STEPS: '(none)', LINES: '1', ANSWER: 'a', SHOWN: '', OBJECTS: 'No objects yet.', COVERAGE: 'c', EARLIER: '(none)' }, parts, { ...ST, open: { line: 'an open line', prompts: 1 } })
  assert.doesNotMatch(turn.text, /\{\{[A-Z_]+\}\}/)
  assert.match(turn.text, /Notes Claude already has:\n- a note given/)
  assert.match(turn.text, /Terms the analyst already saw explained:\n- p95/)
  assert.match(turn.text, /"an open line" \(shown 1 prompt ago\)/)
  assert.match(turn.text, /A line is open above the prompt now\. Give no new line this time/)
  // the attention version of the frame holds the draft principles in place of the default-none paragraph
  const att = textOf('observer', ROOT, { THIMBLE_PROMPTS: 'observer:attention-v1' }).text
  assert.match(att, /## When something is worth the person's time and attention/)
  assert.match(att, /\*\*Unasked output costs attention, even when it is ignored\.\*\*/)
  assert.ok(att.includes('{{LENSES}}'))
})

test("each lens's share of the pass: its characters in and out, the frame and the turn as the shared part", () => {
  const parts = [byName.notes, byName.claims].map(lens => ({ lens, text: `${lens.name} words\n<!-- digest -->\nD` }))
  const system = composeSystem('F {{LENSES}} {{SKELETON}}', parts)
  const turn = composeTurn('T {{DIGEST}}', {}, parts, ST)
  const raw = { notes: [{ note: 'n' }], claims: [{ claim: 'c' }], clusters: [] }
  const text = JSON.stringify(raw)
  const s = sharesOf({ system, turn, lenses: parts.map(x => x.lens), raw, rawText: text })
  assert.equal(s.lenses.notes.out, JSON.stringify(raw.notes).length)
  assert.equal(s.lenses.claims.out, JSON.stringify({ claims: raw.claims, clusters: [] }).length)
  assert.equal(s.lenses.notes.in, system.chars.notes + turn.chars.notes)
  assert.equal(s.shared_in, system.shared + turn.shared)
  assert.ok(s.shared_out >= 0)
})

/** A context as the observer hands it to a merge: what it holds, and what the merges did to it. */
function ctxOf(o = {}) {
  const did = { notes: [], shown: null, settled: false, logged: {}, claims: null }
  const ctx = {
    open: null, skips: 0, seen: [], known: [], moved: false, glossSkip: 0, isRepeat, verbs: {}, glosses: null,
    note: n => did.notes.push(n), log: (k, v) => { did.logged[k] = v }, settle: async () => { did.settled = true },
    lineOpenNow: async () => !!ctx.open, showLine: async L => { did.shown = L }, claims: async v => { did.claims = v }, ...o,
  }
  return { ctx, did }
}
const merge = async (name, reply, o) => {
  const { ctx, did } = ctxOf(o)
  const lens = byName[name]
  await lens.merge(lens.read(parseAnswer(JSON.stringify(reply))), ctx)
  return { ctx, did }
}
const LINE = { decision: 'send it', line: 'Before you send it: the 39% is of link edits.', title: 'A share of link edits', explanation: '- x', rests_on: 'q' }

test('the line lens: shown at a decision; else its finding goes to Claude as a note, and a repeat goes nowhere', async () => {
  assert.deepEqual((await merge('line', { line: LINE })).did.shown.line, LINE.line)
  const none = await merge('line', { line: { ...LINE, decision: '' } })
  assert.equal(none.did.shown, null)
  assert.equal(none.did.logged.line_dropped.why, 'it names no decision')
  assert.match(none.did.notes[0].note, /^Before you send it/)
  assert.equal(none.did.notes[0].from, 'line')
  const open = await merge('line', { line: LINE, settled: true }, { open: { line: 'old' } })
  assert.equal(open.did.settled, true)
  assert.equal(open.did.logged.line_dropped.why, 'a line is open')
  assert.equal((await merge('line', { line: LINE }, { skips: 2 })).did.logged.line_dropped.why, 'backoff')
  const rep = await merge('line', { line: LINE }, { seen: [LINE.line] })
  assert.equal(rep.did.logged.line_dropped.why, 'repeat')
  assert.equal(rep.did.notes.length, 0)
  assert.equal((await merge('line', { line: LINE }, { moved: true })).did.logged.line_dropped.why, 'stale: a new turn began')
})

test('the notes, actions, squeeze, explain and claims lenses each put their part where it goes', async () => {
  assert.deepEqual((await merge('notes', { notes: [{ note: 'one', rests_on: 'x' }, { note: 'two' }, { note: 'three' }] })).did.notes.map(n => n.note), ['one', 'two'])
  const a = await merge('actions', { verbs: { v: { note: '2 views ready', proposals: ['overwrites per day, June 18 marked', 'b', 'c'] }, s: { at: { interpret: 'report' } } } })
  assert.deepEqual(a.ctx.verbs, { v: { lit: true, note: '2 views ready', proposals: ['overwrites per day, June 18 marked', 'b'] } })
  const s = await merge('squeeze', { verbs: { s: { at: { interpret: 'report', familiarity: 'fluent' } } } })
  assert.deepEqual(s.ctx.verbs.s.at, { interpret: 'report', familiarity: 'fluent' })
  assert.equal(s.ctx.verbs.s.lit, false)
  const g = { term: 'p95', body: 'b' }
  assert.deepEqual((await merge('explain', { glosses: [g] })).ctx.glosses, [g])
  assert.deepEqual((await merge('explain', { glosses: [g] }, { glossSkip: 2 })).ctx.glosses, [])
  const c = await merge('claims', { claims: [{ claim: 'x', quote: 'y' }], clusters: [] })
  assert.deepEqual(c.did.claims, { claims: [{ claim: 'x', quote: 'y' }], clusters: [] })
  // when lit with no proposal and no note, v stays dim
  assert.deepEqual((await merge('actions', { verbs: { v: { proposals: [] } } })).ctx.verbs, {})
})

test('the rules of the line and explain lenses hold only when their conditions do', () => {
  assert.deepEqual(byName.line.when({ open: { line: 'x' }, skips: 3 }), ['open'])
  assert.deepEqual(byName.line.when({ open: null, skips: 3 }), ['backoff'])
  assert.deepEqual(byName.line.when({ open: null, skips: 0 }), [])
  assert.deepEqual(byName.explain.when({ glossSkip: 1 }), ['backoff'])
  for (const name of ['notes', 'line', 'explain', 'claims']) {
    const frag = readFileSync(new URL(`../../prompts/lens-${name}/v1.md`, import.meta.url), 'utf8')
    const d = sectionsOf(frag).digest
    assert.ok(d, `lens-${name} has a digest`)
    const keys = [...d.matchAll(/\{\{([A-Z_]+)\}\}/g)].map(m => m[1])
    const vals = byName[name].digest(ST)
    for (const k of keys) assert.ok(k in vals, `lens-${name}'s digest fills {{${k}}}`)
  }
})

const MSGS = [
  { role: 'user', text: 'an earlier question', toolUses: [] },
  { role: 'assistant', text: 'an earlier answer', toolUses: [] },
  { role: 'user', text: 'when did they edit most?', toolUses: [] },
  { role: 'assistant', text: 'Counting saves per day.', toolUses: [{ tool: 'Bash', input: { command: 'thimble q "saves per day" <<PY\n...\nPY' }, text: 'day n\n2026-06-18 6543\n' + 'x'.repeat(5000) }] },
  { role: 'user', text: '', toolResults: [{ tool_use_id: 'u1', text: '...' }], toolUses: [] },
  { role: 'assistant', text: '', toolUses: [{ tool: 'Read', input: { file_path: '/d/rev.jsonl', offset: 10, limit: 5 }, text: 'rows' }, { tool: 'Skill', input: { skill: 'thimble' }, text: 'the whole skill' }] },
  { role: 'assistant', text: 'June 18 had the most saves.', toolUses: [] },
]

test('the turn the pass reads: from the last prompt, words and calls in order, results cut to fit, the answer apart', () => {
  assert.equal(turnMessages(MSGS).length, 4)
  const s = stepsOf(MSGS, { answer: 'June 18 had the most saves.', budget: 2000 })
  assert.doesNotMatch(s, /earlier/)
  assert.match(s, /^Claude: Counting saves per day\.\nClaude ran Bash: thimble q "saves per day" <<PY \.\.\. PY\n {2}→ day n\n {4}2026-06-18 6543/)
  assert.match(s, /Claude ran Read: \/d\/rev\.jsonl from line 10 \(5 lines\)\n {2}→ rows/)
  assert.match(s, /Claude ran Skill: thimble$/m)
  assert.doesNotMatch(s, /the whole skill/)
  assert.doesNotMatch(s, /June 18 had the most saves/)
  assert.ok(s.length < 3000)
  assert.equal(callOf({ tool: 'Grep', input: { pattern: 'x', path: '/d' } }), 'Grep: x in /d')
  assert.equal(stepsOf([{ role: 'user', text: 'hi' }]), '(no steps before the answer)')
})
