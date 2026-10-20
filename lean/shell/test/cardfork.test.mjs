// The card after the answer's helpers (shell/cardfork.mjs): the fork's request and fix composed from the version's
// sections, its reply read, query names bound to the ids thimble ran them under, the problems that ask for a fix, and
// the thimble skill with its card parts replaced. `node --test lean/shell/test/cardfork.test.mjs`.
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { bindQueries, fixText, jsonOf, problemsOf, queryIdOf, readReply, requestText, skillWithCards, slugOf, viewText } from '../cardfork.mjs'

const LEAN = join(fileURLToPath(import.meta.url), '..', '..', '..')
const V1 = readFileSync(join(LEAN, 'prompts', 'card', 'v1.md'), 'utf8')
const V2 = readFileSync(join(LEAN, 'prompts', 'card', 'v2.md'), 'utf8')
const SKILL = readFileSync(join(LEAN, 'skills', 'thimble', 'SKILL.md'), 'utf8')

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
  assert.equal(queryIdOf('r12 · edits per day\n   day  n\n...\nr12 done in 0.1s'), 'r12')
  assert.equal(queryIdOf('Traceback (most recent call last)'), null)
  const o = bindQueries({ data: { days: '$byday', other: 'q3' }, text: 'June 18 had [6,543]($byday#day=2026-06-18@n), $bydays and $5' }, { byday: 'q12' })
  assert.equal(o.data.days, 'q12')
  assert.equal(o.data.other, 'q3')
  assert.equal(o.text, 'June 18 had [6,543](q12#day=2026-06-18@n), $bydays and $5')
})

test('what asks for a fix: problem lines, citations that do not hold, a program that failed, an interaction that failed; never warnings', () => {
  const save = 'saved 03-x v1: thimble/objects/03-x.json\n  /days ← q12 (exact)\n  3 of 4 citations hold\n  problem: /total names q9, which has no column total'
  const drawn = '03-x@1 is drawn for the analyst under your reply: 12 rows by 96 columns, 4 parts they can select.\nTried as the analyst would, the key f fails: TypeError: x is undefined (line 3). Fix the program.\nWarning: region id "a b" uses characters ids cannot hold; it is "a-b"'
  const p = problemsOf(save, drawn)
  assert.equal(p.length, 3)
  assert.ok(p[0].startsWith('3 of 4 citations hold'))
  assert.ok(p[1].startsWith('problem:'))
  assert.ok(p[2].startsWith('Tried as the analyst would'))
  assert.deepEqual(problemsOf('saved 03-x v1\n  4 of 4 citations hold', '03-x@1 is drawn for the analyst under your reply\nWarning: something'), [])
  assert.equal(problemsOf('', 'Its program failed: ReferenceError: y (line 2).').length, 1)
})

test("the thimble skill while the card comes after the answer: its saving principle and card section are the version's, the rest as it was", () => {
  const s = skillWithCards(SKILL, V1)
  assert.ok(s.includes('thimble draws the card for an answer after you write the answer'))
  assert.ok(s.includes('run `thimble guide cards` first'))
  assert.ok(!s.includes('Every card has three parts'), 'the card section is replaced')
  assert.ok(!s.includes('Save a card when the work is worth more than one reply'), 'the saving words are replaced')
  assert.ok(s.includes('**Save what the person will keep as a card.**'), "the version's saving principle comes in its place")
  assert.ok(s.includes('## Communicating') && s.includes('## Computing and citing') && s.includes('## Example'), 'the rest stays')
  assert.equal((s.match(/## Cards/g) || []).length, 1)
  // a skill with neither part gets both at its end
  const bare = skillWithCards('# Where each value comes from\n\nSome words.', V1)
  assert.ok(bare.includes('Some words.') && bare.includes('## What the person sees') && bare.includes('thimble draws a card for it when one'))
})

test("v's card from the fork: only a version with its section asks for it, with the pick, the cards it has and the other proposals", () => {
  assert.equal(viewText(V1, { what: 'x' }), '')
  const t = viewText(V2, { what: 'June 18 had the most saves', choice: 'saves by hour', has: ['01-saves'], proposals: ['who saved'], answer: 'June 18 had the most saves: 6,543.', guidance: 'THE GUIDANCE', toolkit: 'THE TOOLKIT' })
  assert.match(t, /under your answer that begins "June 18 had the most saves"/)
  assert.match(t, /shows what it says, as "saves by hour"\. This message is from thimble/)
  assert.match(t, /It has the card 01-saves already: make a different view, not a copy\./)
  assert.match(t, /Also proposed for it: who saved\./)
  for (const x of ['June 18 had the most saves: 6,543.', 'THE GUIDANCE', 'THE TOOLKIT']) assert.ok(t.includes(x), x)
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(t))
  const bare = viewText(V2, { what: 'x' })
  assert.match(bare, /shows what it says\. This message/)
  assert.ok(!bare.includes('already') && !bare.includes('proposed'))
  // v2's skill parts say v's card comes from the fork too
  assert.ok(skillWithCards(SKILL, V2).replace(/\s+/g, ' ').includes('When the person presses v under an answer, a fork draws that card too'))
})
