// The card after the answer's helpers (shell/cardfork.mjs): the fork's request and fix composed from the version's
// sections, its reply read, query names bound to the ids thimble ran them under, the problems that ask for a fix, and
// the lean skill with its card parts replaced. `node --test lean/shell/test/cardfork.test.mjs`.
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { bindQueries, fixText, jsonOf, problemsOf, queryIdOf, readReply, requestText, skillWithCards, slugOf } from '../cardfork.mjs'

const LEAN = join(fileURLToPath(import.meta.url), '..', '..', '..')
const V1 = readFileSync(join(LEAN, 'prompts', 'card', 'v1.md'), 'utf8')
const SKILL = readFileSync(join(LEAN, 'skills', 'lean', 'SKILL.md'), 'utf8')

test('the request holds the question, the answer, the cards so far, the guidance and the toolkit, and no other section', () => {
  const t = requestText(V1, { question: 'when did they edit most?', answer: 'June 18 had the most saves.', cards: ['01-saves'], guidance: 'THE GUIDANCE', toolkit: 'THE TOOLKIT' })
  for (const s of ['when did they edit most?', 'June 18 had the most saves.', '01-saves', 'THE GUIDANCE', 'THE TOOLKIT']) assert.ok(t.includes(s), s)
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(t), 'every placeholder filled')
  assert.ok(!t.includes('## The fix') && !t.includes('Save what the person will keep'), 'only the request')
  assert.match(requestText(V1, {}), /saved in this session: none/)
})

test('the fix holds each problem as a line, the card as written, and the toolkit', () => {
  const t = fixText(V1, { problems: ['problem: q9 has no column n', 'Its program failed: TypeError'], card: '{"card":"x"}', toolkit: 'THE TOOLKIT' })
  assert.match(t, /^- problem: q9 has no column n$/m)
  assert.match(t, /^- Its program failed: TypeError$/m)
  assert.ok(t.includes('{"card":"x"}') && t.includes('THE TOOLKIT'))
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(t))
})

test('a reply is read whether fenced or not: no card with its reason, a card with its queries, a fix that holds, and words with no JSON', () => {
  assert.deepEqual(readReply('{"card": null, "why": "one number"}'), { kind: 'none', why: 'one number' })
  const r = readReply('Here it is:\n```json\n{"card": "Edits per Day!", "queries": [{"name": "byday", "label": "edits per day", "code": "tally(df, \\"day\\")"}, {"name": "1bad", "code": "x"}], "object": {"title": "Edits per day", "program": "return k.text(\'x\')", "data": {"days": "$byday"}}}\n```')
  assert.equal(r.kind, 'card')
  assert.equal(r.name, 'edits-per-day')
  assert.deepEqual(r.queries.map(q => q.name), ['byday'])
  assert.equal(r.object.data.days, '$byday')
  assert.deepEqual(readReply('{"ok": true}'), { kind: 'ok' })
  assert.equal(readReply('I would draw bars.').kind, 'unreadable')
  assert.equal(readReply('{"card": "x", "object": {"title": "no program"}}').kind, 'unreadable')
  assert.equal(jsonOf('[1, 2]'), null)
  assert.equal(slugOf('  Who Overwrote Whom?  '), 'who-overwrote-whom')
})

test('a query name becomes the id thimble ran it under, in data, text and cites, and a longer name or a price is left alone', () => {
  assert.equal(queryIdOf('q12 · edits per day\n   day  n\n...\nq12 done in 0.1s'), 'q12')
  assert.equal(queryIdOf('Traceback (most recent call last)'), null)
  const o = bindQueries({ data: { days: '$byday', other: 'q3' }, text: 'June 18 had [6,543]($byday#day=2026-06-18@n), $bydays and $5' }, { byday: 'q12' })
  assert.equal(o.data.days, 'q12')
  assert.equal(o.data.other, 'q3')
  assert.equal(o.text, 'June 18 had [6,543](q12#day=2026-06-18@n), $bydays and $5')
})

test('what asks for a fix: problem lines, citations that do not hold, a program that failed, an interaction that failed; never warnings', () => {
  const save = 'saved 03-x v1: thimble/objects/03-x.json\n  /days ← q12 (exact)\n  3 of 4 citations hold\n  problem: /total names q9, which has no column total'
  const drawn = '03-x@1 is drawn for the person under your reply: 12 rows by 96 columns, 4 parts they can select.\nTried as the person would, the key f fails: TypeError: x is undefined (line 3). Fix the program.\nWarning: region id "a b" uses characters ids cannot hold; it is "a-b"'
  const p = problemsOf(save, drawn)
  assert.equal(p.length, 3)
  assert.ok(p[0].startsWith('3 of 4 citations hold'))
  assert.ok(p[1].startsWith('problem:'))
  assert.ok(p[2].startsWith('Tried as the person would'))
  assert.deepEqual(problemsOf('saved 03-x v1\n  4 of 4 citations hold', '03-x@1 is drawn for the person under your reply\nWarning: something'), [])
  assert.equal(problemsOf('', 'Its program failed: ReferenceError: y (line 2).').length, 1)
})

test("the lean skill while the card comes after the answer: its saving principle and card section are the version's, the rest as it was", () => {
  const s = skillWithCards(SKILL, V1)
  assert.ok(s.includes('thimble draws the card for an answer after you write the answer'))
  assert.ok(s.includes('run `lean guide cards` first'))
  assert.ok(!s.includes('Make a card its title, its chart and its takeaway'), 'the card section is replaced')
  assert.ok(!s.includes('When a result is worth more than one reply'), 'the saving principle is replaced')
  assert.ok(s.includes('An object is a program, its data and its lineage'), 'the rest of the saving principle stays')
  assert.ok(s.includes('**Cite what you show.**') && s.includes('## Example: a count and the rows behind it'), 'the rest stays')
  assert.equal((s.match(/## What the person sees/g) || []).length, 1)
  // a skill with neither part gets both at its end
  const bare = skillWithCards('# Where each value comes from\n\nSome words.', V1)
  assert.ok(bare.includes('Some words.') && bare.includes('## What the person sees') && bare.includes('thimble draws a card for it when one'))
})
