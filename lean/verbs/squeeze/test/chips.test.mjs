// The squeeze chips' pure parts (verbs/squeeze/chips.mjs): chip state with its levels, a stretch of the person's
// combined with the fixed chips in one request, the reply read and held to the original, the marks placed again after a
// rewrite, the text cut as it writes itself in, and the original restored. node --test lean/verbs/squeeze/test
import '../../../test-home.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { newRecord, remark, verbsOf, withObserver } from '../../../shell/message.js'
import { ARRIVE, CATCHUP_HEAD, CHIPS, applyRewrite, catchUpStands, catchUpText, checkRewrite, chipsOf, dropOrphanHeads, endsOf, fromVersions, glyph, isCatchUp, isHeading, isLong, isOriginal, keepCorrections, keyOf, mustKeep, noteFor, noteOf, readReply, rebaseAt, request, restore, revealCut, revealStep, rowsOf, stepAt, stretchChip, termsOf, unplacedMoves, withStretch } from '../chips.mjs'
import { parseWords, run } from '../run.mjs'

// a made-up report, as a long reply takes it
const TEXT = [
  '**Fixed `test_checkout_total`.** It failed in about [1 run in 9](q2#test=checkout@fail_rate) because the `cart` fixture in [tests/conftest.py:14](tests/conftest.py#L14) had `scope="module"`.',
  '',
  'The coupon test left a coupon on the shared cart. Failures by day [~](q5@n).',
  '',
  '- The fix is one line.',
  '- The test then [passed 200 times in a row](q3#test=checkout@passes).',
].join('\n')
const PROMPT = readFileSync(fileURLToPath(new URL('../../../prompts/squeeze/v3.md', import.meta.url)), 'utf8')

function record() {
  const rec = newRecord({ row: 'r1', session: 's1', text: TEXT })
  rec.marks.find(m => m.kind === 'spark').values = [3, 1, 4, 1, 5]
  return withObserver(rec, { verbs: {}, glosses: { g1: { term: 'fixture' }, g2: { term: 'coupon test' } } })
}

test('every message has the same chips: Length (4), Report ↔ Interpret (3), Familiarity (5); the observer only says where the original stands', () => {
  const rec = record()
  const chips = chipsOf(rec)
  assert.deepEqual(chips.map(c => c.name), ['Length', 'Report ↔ Interpret', 'Familiarity'])
  assert.deepEqual(chips.map(c => c.levels), [['one line', 'short', 'medium', 'full'], ['report', 'balanced', 'interpret'], ['new to the field', 'beginner', 'working', 'fluent', 'expert']])
  assert.deepEqual(chips.map(c => c.levels[c.level]), ['full', 'balanced', 'working'])
  assert.deepEqual(chips.map(c => c.known), [true, false, false])
  assert.ok(isOriginal(chips))
  assert.equal(keyOf(chips), '')
  // the observer's levels, by name, by index, or by an older name; a proposed new dimension is ignored
  const seen = withObserver(rec, { verbs: { s: { at: { interpret: 'report', familiarity: 4 }, chips: [{ name: 'Story', levels: ['hidden', 'full'] }] } }, glosses: rec.glosses })
  const c2 = chipsOf(seen)
  assert.deepEqual(c2.map(c => c.name), ['Length', 'Report ↔ Interpret', 'Familiarity'])
  assert.deepEqual(c2.map(c => c.levels[c.level]), ['full', 'report', 'expert'])
  assert.ok(c2.every(c => c.known))
  assert.equal(CHIPS.length, 3)
  const older = withObserver(rec, { verbs: { s: { at: { interpret: 'both', familiarity: 'familiar' } } }, glosses: rec.glosses })
  assert.deepEqual(chipsOf(older).map(c => c.levels[c.level]), ['full', 'balanced', 'working'])
  // the observer's s may carry only where the answer stands: the record keeps it, unlit
  const kept = verbsOf({ s: { at: { interpret: 'Interpret', familiarity: 'new to the field' } } })
  assert.deepEqual(kept.s, { lit: false, note: '', at: { interpret: 'interpret', familiarity: 'new to the field' }, chips: [] })
  assert.deepEqual(chipsOf({ ...rec, verbs: kept }).map(c => c.levels[c.level]), ['full', 'interpret', 'new to the field'])
})

test('a chip steps one level at a time and stops at its ends; its dots show one ● at its place', () => {
  const rec = record()
  assert.deepEqual(stepAt(rec, 'length', -1), { length: 2 })
  assert.equal(stepAt(rec, 'length', 1), null)
  const at = { length: 0 }
  assert.equal(stepAt({ ...rec, squeeze: { at } }, 'length', -1), null)
  assert.deepEqual(stepAt(rec, 'familiarity', 1), { familiarity: 3 })
  const [len, interp, fam] = chipsOf(rec)
  assert.equal(glyph(len, 1), '○●○○')
  assert.equal(glyph(len, 3), '○○○●')
  assert.equal(glyph(interp, 0), '●○○')
  assert.equal(glyph(interp, 2), '○○●')
  assert.equal(glyph(fam, 0), '●○○○○')
  assert.equal(glyph(fam, 4), '○○○○●')
  // the version's key names only the levels that differ from the original
  assert.equal(keyOf(chipsOf({ ...rec, squeeze: { at: { length: ARRIVE, interpret: 1 } } })), 'length=1')
})

test("a step made before the observer placed the original counts again from the level it gives; Length and placed chips are left as they are", () => {
  const rec = record()
  const placed = withObserver(rec, { verbs: { s: { at: { interpret: 'interpret', familiarity: 'fluent' } } }, glosses: {} })
  // one step toward report from the middle (balanced) moves Report ↔ Interpret before anyone said where the original is
  assert.deepEqual(unplacedMoves(rec, { length: 1, interpret: 0 }), ['interpret'])
  assert.deepEqual(unplacedMoves(rec, { length: 1 }), [])
  assert.deepEqual(unplacedMoves(placed, { interpret: 0 }), [])
  // the original stands at interpret: one step toward report is balanced; Length stays as set
  assert.deepEqual(rebaseAt(rec, placed, { length: 1, interpret: 0 }), { length: 1, interpret: 1 })
  // two steps up from working toward expert, the original at fluent: the last level, expert
  assert.deepEqual(rebaseAt(rec, placed, { familiarity: 4 }), { familiarity: 4 })
  assert.deepEqual(rebaseAt(rec, placed, { familiarity: 3 }), { familiarity: 4 })
  // a step that lands on the original's level, or past an end, is the original on that chip
  const atReport = withObserver(rec, { verbs: { s: { at: { interpret: 'report' } } }, glosses: {} })
  assert.deepEqual(rebaseAt(rec, atReport, { length: 2, interpret: 0 }), { length: 2 })
  // nothing to count again when the observer has said nothing, or had placed the chip already
  assert.deepEqual(rebaseAt(rec, rec, { interpret: 0 }), { interpret: 0 })
  assert.deepEqual(rebaseAt(placed, placed, { interpret: 1 }), { interpret: 1 })
  // the arrival's version stays the same version whatever level the observer gives: its other chips are as the original
  assert.equal(keyOf(chipsOf({ ...placed, squeeze: { at: { length: ARRIVE } } })), keyOf(chipsOf({ ...rec, squeeze: { at: { length: ARRIVE } } })))
})

test('a stretch is two ends the person types: it stands at the original, its first end, and each of 3 steps moves toward the second', () => {
  assert.deepEqual(endsOf('+engineer and manager'), { from: 'engineer', to: 'manager' })
  assert.deepEqual(endsOf('+ between novice and expert'), { from: 'novice', to: 'expert' })
  assert.deepEqual(endsOf('+engineer ↔ manager'), { from: 'engineer', to: 'manager' })
  assert.deepEqual(endsOf('+ data scientist / product lead'), { from: 'data scientist', to: 'product lead' })
  assert.deepEqual(endsOf('+ for my manager'), { from: 'as written', to: 'for my manager' })
  assert.equal(endsOf('+'), null)
  let rec = record()
  rec = { ...rec, squeeze: { at: { length: 1, familiarity: 0 } } }
  const x = stretchChip(rec, '+engineer and manager')
  assert.deepEqual(x, { id: 'x-engineer-manager', kind: 'stretch', from: 'engineer', to: 'manager' })
  rec = { ...rec, squeeze: withStretch(rec, x) }
  const chips = chipsOf(rec)
  assert.deepEqual(chips.map(c => c.name), ['Length', 'Report ↔ Interpret', 'Familiarity', 'engineer ↔ manager'])
  const st = chips[3]
  assert.equal(st.levels.length, 4)
  assert.equal(st.level, 0)
  assert.equal(glyph(st, st.level), '●○○○')
  // a new stretch changes nothing yet: the key is the other chips' alone
  assert.equal(keyOf(chips), 'length=1&familiarity=0')
  // one request carries every chip's level, the stretch by its two ends and its step
  rec = { ...rec, squeeze: { ...rec.squeeze, at: { ...rec.squeeze.at, [x.id]: 2 } } }
  const req = request(rec, { system: PROMPT, question: 'Why does it fail?' })
  const tail = req.prompt[1].text
  assert.match(tail, /- Length: short, at most \d+ words \(levels one line · short · medium · full; the original is at full, \d+ words\)/)
  assert.match(tail, /- Familiarity: new to the field /)
  assert.match(tail, /- Report ↔ Interpret: as the original/)
  assert.match(tail, /- A stretch the person made, from "engineer" to "manager": 2 of 3 steps toward "manager" \(the original stands at "engineer", step 0\)/)
  const end = request({ ...rec, squeeze: { ...rec.squeeze, at: { [x.id]: 3 } } }, { system: PROMPT })
  assert.match(end.prompt[1].text, /3 of 3, all the way to "manager"/)
  // the fixed text is first and marked for the cache: the prompt, then the question and the original
  assert.equal(req.system[0].cache, true)
  assert.equal(req.prompt[0].cache, true)
  assert.match(req.prompt[0].text, /The person asked: Why does it fail\?/)
  assert.ok(req.prompt[0].text.includes(TEXT))
  // a version with the stretch is kept by its levels; a fourth stretch pushes the oldest out
  const after = applyRewrite(rec, { text: '**Status:** fixed.', at: rec.squeeze.at }, remark)
  assert.equal(after.squeeze.versions['length=1&familiarity=0&x-engineer-manager=2'], '**Status:** fixed.')
  let many = after
  for (const w of ['+a and b', '+c and d', '+e and f']) many = { ...many, squeeze: withStretch(many, stretchChip(many, w)) }
  assert.deepEqual(many.squeeze.own.map(c => c.id), ['x-a-b', 'x-c-d', 'x-e-f'])
  assert.ok(!('x-engineer-manager' in many.squeeze.at))
})

test('a rewrite is held to the original: a ref it never cited loses its link, and a number it never states is named', () => {
  const out = checkRewrite(TEXT, 'Fixed in [2 tries](q9#x@n); it failed [1 run in 9](q2#test=checkout@fail_rate), 12% of runs.')
  assert.equal(out.text, 'Fixed in 2 tries; it failed [1 run in 9](q2#test=checkout@fail_rate), 12% of runs.')
  assert.equal(out.problems.length, 2)
  assert.match(out.problems[0], /q9#x@n is not in the original/)
  assert.match(out.problems[1], /"12" is not in the original/)
  assert.deepEqual(checkRewrite(TEXT, 'It failed about [1 in 9](q2#test=checkout@fail_rate); now it [passed 200 times](q3#test=checkout@passes).').problems, [])
  // a kept ref whose words state another number of the text: the words stay, the link goes
  const moved = checkRewrite(TEXT, 'The fix held [200 times](tests/conftest.py#L14); it [passed 200 times](q3#test=checkout@passes).')
  assert.equal(moved.text, 'The fix held 200 times; it [passed 200 times](q3#test=checkout@passes).')
  assert.match(moved.problems[0], /"200 times" was linked to the source of "tests\/conftest.py:14"/)
  // the cited value with a date or a total beside it is kept; a total alone in place of the value is not
  const orig = 'Most saves came on [6,543](q1#day=18@n) days, [13,403 of 14,591](q10#wiki=dse@n) on one wiki.'
  assert.deepEqual(checkRewrite(orig, 'Peak: [6,543 on Jun 18](q1#day=18@n); [13,403 saves](q10#wiki=dse@n).').problems, [])
  const total = checkRewrite(orig, 'Of [14,591 edits](q10#wiki=dse@n), most came on one day.')
  assert.equal(total.text, 'Of 14,591 edits, most came on one day.')
  assert.match(total.problems[0], /"14,591 edits" was linked to the source of "13,403 of 14,591"/)
})

test('after a rewrite the marks are placed again on the new text: citations, a sparkline with its values, each gloss on its term or a word of it', () => {
  const rec = record()
  const short = '**Fixed:** a shared `cart` fixture leaked a coupon, about [1 run in 9](q2#test=checkout@fail_rate) [~](q5@n); now it [passed 200 times](q3#test=checkout@passes).'
  const next = applyRewrite(rec, { text: short, at: { length: 0 }, made: { ms: 900, model: 'sonnet' } }, remark)
  assert.equal(next.shown, short)
  const at = m => short.slice(m.start, m.end)
  assert.deepEqual(next.marks.filter(m => m.kind !== 'gloss').map(at), ['[1 run in 9](q2#test=checkout@fail_rate)', '[~](q5@n)', '[passed 200 times](q3#test=checkout@passes)'])
  assert.deepEqual(next.marks.find(m => m.kind === 'spark').values, [3, 1, 4, 1, 5])
  // `fixture` stayed as it was; of `coupon test` only "coupon" stayed, and the explain stands on it
  assert.deepEqual(next.marks.filter(m => m.kind === 'gloss').map(m => [m.gloss, at(m), m.anchor ?? 'term']), [['g1', 'fixture', 'term'], ['g2', 'coupon', 'word']])
  assert.equal(next.squeeze.versions['length=0'], short)
  assert.equal(next.squeeze.made[0].ms, 900)
  // the original's marks are kept, so a later version that brings the sparkline back still has its values
  const again = applyRewrite(next, { text: 'Failures [~](q5@n), [1 run in 9](q2#test=checkout@fail_rate).', at: { length: 1 } }, remark)
  assert.deepEqual(again.marks.find(m => m.kind === 'spark').values, [3, 1, 4, 1, 5])
  assert.match(noteOf(again, 100), /^1 of \d+ lines$/)
  assert.match(noteFor(again), /Length: short/)
})

test('a level seen before comes back with no call, and the original comes back with its own marks', () => {
  const rec = record()
  const a = applyRewrite(rec, { text: 'Short: [1 run in 9](q2#test=checkout@fail_rate).', at: { length: 1 } }, remark)
  const b = applyRewrite(a, { text: 'One line.', at: { length: 0 } }, remark)
  const back = fromVersions(b, { length: 1 }, remark)
  assert.equal(back.shown, 'Short: [1 run in 9](q2#test=checkout@fail_rate).')
  assert.equal(fromVersions(b, { length: 2 }, remark), null)
  const orig = restore(b, remark)
  assert.equal(orig.shown, null)
  assert.deepEqual(orig.squeeze.at, {})
  assert.deepEqual(orig.marks.map(m => `${m.kind} ${m.start}`), rec.marks.map(m => `${m.kind} ${m.start}`))
  assert.deepEqual(orig.marks.find(m => m.kind === 'spark').values, [3, 1, 4, 1, 5])
  assert.ok(isOriginal(chipsOf(orig)))
  // the versions written stay, so a level seen before still comes back after the original
  assert.equal(fromVersions(orig, { length: 0 }, remark).shown, 'One line.')
})

test('a message taller than half the screen arrives squeezed; the rows count as drawn', () => {
  assert.equal(rowsOf('a\n\nb', 100), 3)
  assert.equal(rowsOf('word '.repeat(50).trim(), 100), 3)
  assert.equal(rowsOf('[a long label](q1#x@n)', 10), 1)
  const long = Array.from({ length: 40 }, (_, i) => `Line ${i} of a long answer.`).join('\n')
  assert.ok(isLong(long, { cols: 100, room: 26 }))
  assert.ok(!isLong(TEXT, { cols: 100, room: 26 }))
  assert.ok(!isLong(long, { cols: 100, room: 60 }))
})

test('readReply takes the text from its tags, or the whole reply when it gave none', () => {
  assert.deepEqual(readReply('<text>\nA.\n</text>'), { text: 'A.' })
  assert.deepEqual(readReply('A plain reply.'), { text: 'A plain reply.' })
  assert.deepEqual(readReply('```markdown\nB.\n```'), { text: 'B.' })
})

test('the new text writes itself in from the top: each cut ends a word and never splits a link, code, bold or a table row', () => {
  const t = '**Status:** fixed. The [cart fixture](q1#x@n) is `scope="module"`, shared.\n\n| run | steps |\n|---|---|\n| r17 | 2,143 |'
  assert.equal(revealCut(t, 0), '**Status:**')
  assert.equal(revealCut(t, 3), '**Status:**')
  assert.equal(revealCut(t, 14), '**Status:** fixed.')
  assert.equal(revealCut(t, 26), '**Status:** fixed. The [cart fixture](q1#x@n)')
  assert.equal(revealCut(t, 52), '**Status:** fixed. The [cart fixture](q1#x@n) is `scope="module"`,')
  assert.ok(revealCut(t, 80).endsWith('| run | steps |'))
  assert.equal(revealCut(t, 1000), t)
  // every cut is a prefix of the text, and they grow
  let last = ''
  for (let n = 0; n <= t.length; n += 7) {
    const c = revealCut(t, n)
    assert.ok(t.startsWith(c))
    assert.ok(c.length >= last.length)
    last = c
  }
  // the pace: about 400 characters a second, never more than about 2.5 s for the whole
  assert.equal(revealStep(300, 50), 20)
  assert.equal(revealStep(5000, 50), 100)
})

test('run.mjs: the same rewrite from words, through ctx.model, for /verb and tools that hold a record', async () => {
  const rec = record()
  assert.deepEqual(parseWords(rec, 'length=short familiarity=new to the field').at, { length: 1, familiarity: 0 })
  assert.deepEqual(parseWords(rec, '+engineer and manager'), { at: {}, own: '+engineer and manager' })
  assert.deepEqual(parseWords(rec, '').at, { length: ARRIVE })
  assert.throws(() => parseWords(rec, 'story=full'), /no chip "story"/)
  const asked = []
  const model = { complete: async req => { asked.push(req); return { isAnswered: true, text: '<text>Fixed: [1 run in 9](q2#test=checkout@fail_rate).</text>', usage: { input_tokens: 10, output_tokens: 5 } } } }
  const r = await run({ message: rec, args: 'length=one line', model, verb: { model: 'sonnet' } })
  assert.equal(asked.length, 1)
  // the terms of its explain marks are named, to keep in their words
  assert.match(asked[0].prompt[1].text, /Terms the person can open an explanation of\. Where your text keeps what a term names, use the term in these words:\n- fixture\n- coupon test/)
  assert.equal(r.message.shown, 'Fixed: [1 run in 9](q2#test=checkout@fail_rate).')
  assert.equal(r.message.marks[0].ref, 'q2#test=checkout@fail_rate')
  const back = await run({ message: r.message, args: 'original', model })
  assert.equal(back.message.shown, null)
  assert.equal(asked.length, 1)
  // a stretch from words: kept on the record, standing at the original, with no call
  const x = await run({ message: back.message, args: '+engineer and manager', model })
  assert.equal(asked.length, 1)
  assert.deepEqual(x.message.squeeze.own, [{ id: 'x-engineer-manager', kind: 'stretch', from: 'engineer', to: 'manager' }])
})

test('the corrections of its own earlier answer are found in the original: a list under a lead, a paragraph, a sentence; an offer is not one', () => {
  const list = 'The answer.\n\nTwo corrections to my last answer:\n- **AgentRelent:** 316, not 317.\n- **The split:** 5,242, not 5,181.\n\nCaveats: rough.'
  assert.deepEqual(mustKeep(list), ['**AgentRelent:** 316, not 317.', '**The split:** 5,242, not 5,181.'])
  const para = 'The answer.\n\n**I also need to correct something I told you.** I said it was many agents. It may be one process.'
  assert.deepEqual(mustKeep(para), ['**I also need to correct something I told you.** I said it was many agents. It may be one process.'])
  assert.deepEqual(mustKeep('June 18 was the peak. Earlier I said 21:25; the last save was at 22:10.'), ['Earlier I said 21:25; the last save was at 22:10.'])
  assert.deepEqual(mustKeep('I can check whether the answers were actually wrong, if you want.'), [])
  assert.deepEqual(mustKeep('June 18 had 6,543 saves, most of them on one page.'), [])
})

test('a claim of this message that revises one of its own earlier claims is a correction to keep; one that revises the person\'s is not', () => {
  const claims = { claims: [
    { id: 'c1', by: 'claude', text: 'old' },
    { id: 'c2', by: 'claude', revises: 'c1', said: [{ row: 'r2', sentence: 'It is 316, not 317.' }] },
    { id: 'c3', by: 'person', text: 'theirs' },
    { id: 'c4', by: 'claude', revises: 'c3', said: [{ row: 'r2', sentence: 'Not two thirds: half.' }] },
  ] }
  assert.deepEqual(mustKeep('No lead here.', { claims, row: 'r2' }), ['It is 316, not 317.'])
})

test('a rewrite that leaves a correction out gets it back after it; one that kept it in other words is left as it is', () => {
  const keep = ['**AgentRelent:** 316, not 317.', '**The split:** 5,242, not 5,181.']
  const r = keepCorrections('The peak was June 18 (316 edits, not 317).', keep)
  assert.deepEqual(r.back, ['**The split:** 5,242, not 5,181.'])
  assert.ok(r.text.endsWith('\n\n**The split:** 5,242, not 5,181.'))
  assert.deepEqual(keepCorrections('Peak June 18; earlier I said 317 and 5,181, it is 316 and 5,242.', keep).back, [])
})

// a correction section whose second item is a heading over a list of its own, as Claude writes one
const NESTED = [
  'First, two corrections to my last answer:',
  '- **The 70% leaves out round 1.** Reading is 70% of calls only in rounds 2 and 3; in round 1 building takes [55%](q4#row=3@build).',
  '- **The numbers I did not cite before:**',
  '  - Mid-run, Tern spends [37%](q4#row=24@test) of calls testing.',
  '  - 81 of the 86 idle helpers are in round 1 ([13](q2#run=r1-a@idle) + [68](q2#run=r1-b@idle)).',
  '',
  'Helper-44 then ran for 6 hours, from 07:30 to 13:30, and made 2 merges.',
].join('\n')

test('a correction that heads a list keeps the list: its sub-items are part of it, in the request as in the original', () => {
  const keep = mustKeep(NESTED)
  assert.equal(keep.length, 2)
  assert.equal(keep[1], '**The numbers I did not cite before:**\n  - Mid-run, Tern spends [37%](q4#row=24@test) of calls testing.\n  - 81 of the 86 idle helpers are in round 1 ([13](q2#run=r1-a@idle) + [68](q2#run=r1-b@idle)).')
  const tail = request({ text: NESTED, squeeze: { at: { length: 1 } } }, { system: 'S', keep }).prompt[1].text
  // the sub-items stand under their heading, one level in
  assert.match(tail, /\n- \*\*The numbers I did not cite before:\*\*\n {2}- Mid-run, Tern spends \[37%\]\(q4#row=24@test\) of calls testing\.\n {2}- 81 of the 86 idle helpers/)
})

test('a sub-item the rewrite left out comes back under its heading; a heading never comes back alone; a number said elsewhere in the original is not the correction\'s', () => {
  const keep = mustKeep(NESTED)
  // the rewrite keeps the 70% correction and the 37%, and drops the idle helpers; "13" of 13:30 is no sign they stayed
  const rewrite = 'Round 1 differs: building takes [55%](q4#row=3@build) there, and Tern tests [37%](q4#row=24@test) of calls. Helper-44 ran 6 hours, to 13:30.'
  const r = keepCorrections(rewrite, keep, NESTED)
  assert.deepEqual(r.back, ['**The numbers I did not cite before:**\n- 81 of the 86 idle helpers are in round 1 ([13](q2#run=r1-a@idle) + [68](q2#run=r1-b@idle)).'])
  assert.ok(r.text.endsWith('\n\n**The numbers I did not cite before:**\n- 81 of the 86 idle helpers are in round 1 ([13](q2#run=r1-a@idle) + [68](q2#run=r1-b@idle)).'))
  // without the original, the 13 of 13:30 would pass for the [13] of the idle helpers
  assert.deepEqual(keepCorrections(rewrite, keep).back, [])
  // every sub-item kept: nothing comes back, not even the heading
  assert.deepEqual(keepCorrections(`${rewrite} 81 of 86 idle helpers are round 1.`, keep, NESTED).back, [])
})

test('a rewrite that ends on a heading with nothing under it loses the heading; a bold sentence at the end stays', () => {
  assert.deepEqual(dropOrphanHeads('Helper-44 made 2 merges.\n\n**The numbers I did not cite before:**'), { text: 'Helper-44 made 2 merges.', dropped: ['**The numbers I did not cite before:**'] })
  assert.deepEqual(dropOrphanHeads('Two things.\n\n## Caveats\n\n- **Next:**').dropped, ['## Caveats', '- **Next:**'])
  assert.equal(dropOrphanHeads('Helper-44 made 2 merges.\n\n**Fix it before you send it.**').text, 'Helper-44 made 2 merges.\n\n**Fix it before you send it.**')
  assert.equal(dropOrphanHeads('**Only a heading:**').text, '**Only a heading:**')
  assert.ok(isHeading('- **Caveats**') && isHeading('Two corrections to my last answer:') && !isHeading('**It is 316.**') && !isHeading('It ran to 13:30.'))
})

test('the request names the corrections and does not count them in a level\'s length', () => {
  const q = request({ text: 'A. Earlier I said 3; it is 4.', squeeze: { at: { length: 0 } } }, { system: 'S', keep: ['Earlier I said 3; it is 4.'] })
  const tail = q.prompt[1].text
  assert.match(tail, /one line, one sentence, at most 35 words, then each correction listed below in a few words/)
  assert.match(tail, /Corrections in the original\. Each stays at every level, in as few words as it needs, next to what it corrects:\n- Earlier I said 3; it is 4\./)
  assert.doesNotMatch(request({ text: 'A.', squeeze: { at: { length: 0 } } }, { system: 'S' }).prompt[1].text, /Corrections in the original/)
})

test('the request names the terms of the explain marks, to keep in their words; none when the message has no explain marks', () => {
  assert.deepEqual(termsOf(record()), ['fixture', 'coupon test'])
  assert.deepEqual(termsOf({ glosses: { a: { term: '  rebase\n loop ' }, b: { term: 'rebase loop' }, c: {} } }), ['rebase loop'])
  const q = request(record(), { system: 'S', terms: termsOf(record()) })
  assert.match(q.prompt[1].text, /Terms the person can open an explanation of\. Where your text keeps what a term names, use the term in these words:\n- fixture\n- coupon test\n/)
  assert.doesNotMatch(request(record(), { system: 'S' }).prompt[1].text, /Terms the person can open/)
})

test('squeeze:v5 is v4 with the principle of keeping the explain terms, and it is the default', () => {
  const v4 = readFileSync(fileURLToPath(new URL('../../../prompts/squeeze/v4.md', import.meta.url)), 'utf8')
  const v5 = readFileSync(fileURLToPath(new URL('../../../prompts/squeeze/v5.md', import.meta.url)), 'utf8')
  assert.match(v5, /\*\*Keep the terms the person can open\.\*\*/)
  assert.equal(v5.replace(/\*\*Keep the terms the person can open\.\*\*[^\n]*\n\n/, ''), v4)
})

test('a catch-up is several messages written as one: its original is them in order, its request names them so, and the note tells Claude what the person read', () => {
  const first = 'I will start the reader first.'
  const second = 'The empty label has [741 IPs](q4#label=@ips) for [899 revisions](q4#label=@n).'
  const third = 'The reader is back: 3,104 lines.\n\nI also need to correct something I told you: I wrote that it starts at the first write; it does not.'
  const text = catchUpText([first, `${second}\n`, '', third])
  assert.equal(text, `${first}\n\n---\n\n${second}\n\n---\n\n${third}`)
  const cu = { text, shown: null, marks: [], glosses: {}, verbs: {}, objects: [], catchup: { host: 'r3', rows: ['r1', 'r2', 'r3'], replies: 2, question: 'What does labels.jsonl say about the empty label?', prompt: 'p1' }, squeeze: { at: { length: ARRIVE } } }
  assert.ok(isCatchUp(cu) && catchUpStands(cu))
  assert.ok(!catchUpStands({ ...cu, catchup: { ...cu.catchup, dismissed: true } }))
  assert.ok(!isCatchUp(record()))
  const keep = mustKeep(text)
  assert.deepEqual(keep, ['I also need to correct something I told you: I wrote that it starts at the first write; it does not.'])
  const req = request(cu, { system: 'P', question: cu.catchup.question, keep })
  const head = req.prompt[0].text
  // one header line differs from a single message's request; the rest is the same request
  assert.equal(head, `The person asked: What does labels.jsonl say about the empty label?\n\n${CATCHUP_HEAD}\n<original>\n${text}\n</original>`)
  assert.equal(CATCHUP_HEAD, "Claude's messages since the person's last prompt, in the order it wrote them, as written (the original). Write them as one message:")
  assert.match(req.prompt[1].text, /- Length: short, at most \d+ words/)
  assert.match(req.prompt[1].text, /Corrections in the original\. Each stays at every level/)
  assert.equal(request(record(), { system: 'P' }).prompt[0].text.split('\n')[2], "Claude's message, as written (the original):")
  // nothing for Claude until a version shows; then the version, as the person reads it
  assert.equal(noteFor(cu), '')
  const shown = applyRewrite(cu, { text: 'The empty label: [741 IPs](q4#label=@ips). The reader counted 3,104 lines; it does not start at the first write.', at: { length: ARRIVE } }, remark)
  assert.equal(noteFor(shown), 'The person caught up on your 2 replies since their last prompt by reading them rewritten as one message by the squeeze chips (Length: short); what you wrote is unchanged, and they can read it. "This" may mean the catch-up they read:\nThe empty label: [741 IPs](q4#label=@ips). The reader counted 3,104 lines; it does not start at the first write.')
  // its citations are placed on the version, as any message's
  assert.deepEqual(shown.marks.filter(m => m.kind === 'cite').map(m => m.ref), ['q4#label=@ips'])
})
