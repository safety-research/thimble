// The squeeze chips' pure parts (verbs/squeeze/chips.mjs): chip state, a chip of the person's combined with the fixed
// ones in one request, the reply read and held to the original, the marks placed again after a rewrite, and the
// original restored. node --test lean/verbs/squeeze/test
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { newRecord, remark, withObserver } from '../../../shell/message.js'
import { ARRIVE, CHIPS, applyRewrite, checkRewrite, chipsOf, fromVersions, glyph, isLong, isOriginal, keyOf, noteFor, noteOf, ownChip, readReply, request, restore, rowsOf, stepAt, withOwn } from '../chips.mjs'
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
const PROMPT = readFileSync(fileURLToPath(new URL('../prompt.md', import.meta.url)), 'utf8')

function record() {
  const rec = newRecord({ row: 'r1', session: 's1', text: TEXT })
  rec.marks.find(m => m.kind === 'spark').values = [3, 1, 4, 1, 5]
  return withObserver(rec, { verbs: {}, glosses: { g1: { term: 'fixture' }, g2: { term: 'coupon test' } } })
}

test('every message has the same chips: Length, Report ↔ Interpret, Familiarity; the observer only says where the original stands', () => {
  const rec = record()
  const chips = chipsOf(rec)
  assert.deepEqual(chips.map(c => c.name), ['Length', 'Report ↔ Interpret', 'Familiarity'])
  assert.deepEqual(chips.map(c => c.levels[c.level]), ['full', 'both', 'familiar'])
  assert.deepEqual(chips.map(c => c.known), [true, false, false])
  assert.ok(isOriginal(chips))
  assert.equal(keyOf(chips), '')
  // the observer's levels, by name or index; a proposed new dimension is ignored
  const seen = withObserver(rec, { verbs: { s: { at: { interpret: 'report', familiarity: 2 }, chips: [{ name: 'Story', levels: ['hidden', 'full'] }] } }, glosses: rec.glosses })
  const c2 = chipsOf(seen)
  assert.deepEqual(c2.map(c => c.name), ['Length', 'Report ↔ Interpret', 'Familiarity'])
  assert.deepEqual(c2.map(c => c.levels[c.level]), ['full', 'report', 'expert'])
  assert.ok(c2.every(c => c.known))
  assert.equal(CHIPS.length, 3)
})

test('a chip steps one level at a time and stops at its ends; the dots show where it is', () => {
  const rec = record()
  assert.deepEqual(stepAt(rec, 'length', -1), { length: 2 })
  assert.equal(stepAt(rec, 'length', 1), null)
  const at = { length: 0 }
  assert.equal(stepAt({ ...rec, squeeze: { at } }, 'length', -1), null)
  const [len, interp, fam] = chipsOf(rec)
  assert.equal(glyph(len, 1), '●●○○')
  assert.equal(glyph(interp, 0), '●○○')
  assert.equal(glyph(interp, 2), '○○●')
  assert.equal(glyph(fam, 2), '●●●')
  // the version's key names only the levels that differ from the original
  assert.equal(keyOf(chipsOf({ ...rec, squeeze: { at: { length: ARRIVE, interpret: 1 } } })), 'length=1')
})

test("the person's own chip combines with the fixed ones: one request carries every chip's level, and asks for the new chip's levels", () => {
  let rec = record()
  rec = { ...rec, squeeze: { at: { length: 1, familiarity: 0 } } }
  const own = ownChip(rec, '+ for my manager')
  assert.equal(own.name, 'For my manager')
  assert.equal(own.words, 'for my manager')
  rec = { ...rec, squeeze: withOwn(rec, own) }
  const chips = chipsOf(rec)
  assert.deepEqual(chips.map(c => c.name), ['Length', 'Report ↔ Interpret', 'Familiarity', 'For my manager'])
  const req = request(rec, { system: PROMPT, question: 'Why does it fail?', newOwn: own })
  const tail = req.prompt[1].text
  assert.match(tail, /- Length: short \(levels one line · short · medium · full; the original is at full\)/)
  assert.match(tail, /- Familiarity: new /)
  assert.match(tail, /- Report ↔ Interpret: as the original/)
  assert.match(tail, /The person added a chip in their own words: "for my manager"/)
  assert.ok(!/- For my manager:/.test(tail), 'the chip being sized is named once, as new')
  // the fixed text is first and marked for the cache: the prompt, then the question and the original
  assert.equal(req.system[0].cache, true)
  assert.equal(req.prompt[0].cache, true)
  assert.match(req.prompt[0].text, /The person asked: Why does it fail\?/)
  assert.ok(req.prompt[0].text.includes(TEXT))
  // once sized, a later change names it with its level beside the others
  const reply = readReply('<chip levels="off | plain | status" pick="status"/>\n<text>\n**Status:** fixed.\n</text>')
  assert.deepEqual(reply.chip, { levels: ['off', 'plain', 'status'], level: 2 })
  const after = applyRewrite(rec, { text: reply.text, at: rec.squeeze.at, newOwn: own, chip: reply.chip }, remark)
  const later = request({ ...after, squeeze: { ...after.squeeze, at: { ...after.squeeze.at, length: 0 } } }, { system: PROMPT })
  assert.match(later.prompt[1].text, /- For my manager: status \(the person's own chip, "for my manager"; levels off · plain · status; "off" changes nothing\)/)
  assert.match(later.prompt[1].text, /- Length: one line/)
})

test('a rewrite is held to the original: a ref it never cited loses its link, and a number it never states is named', () => {
  const out = checkRewrite(TEXT, 'Fixed in [2 tries](q9#x@n); it failed [1 run in 9](q2#test=checkout@fail_rate), 12% of runs.')
  assert.equal(out.text, 'Fixed in 2 tries; it failed [1 run in 9](q2#test=checkout@fail_rate), 12% of runs.')
  assert.equal(out.problems.length, 2)
  assert.match(out.problems[0], /q9#x@n is not in the original/)
  assert.match(out.problems[1], /"12" is not in the original/)
  assert.deepEqual(checkRewrite(TEXT, 'It failed about [1 in 9](q2#test=checkout@fail_rate); now it [passed 200 times](q3#test=checkout@passes).').problems, [])
})

test('after a rewrite the marks are placed again on the new text: citations, a sparkline with its values, the glosses whose terms stayed', () => {
  const rec = record()
  const short = '**Fixed:** a shared `cart` fixture leaked a coupon, about [1 run in 9](q2#test=checkout@fail_rate) [~](q5@n); now it [passed 200 times](q3#test=checkout@passes).'
  const next = applyRewrite(rec, { text: short, at: { length: 0 }, made: { ms: 900, model: 'sonnet' } }, remark)
  assert.equal(next.shown, short)
  const at = m => short.slice(m.start, m.end)
  assert.deepEqual(next.marks.filter(m => m.kind !== 'gloss').map(at), ['[1 run in 9](q2#test=checkout@fail_rate)', '[~](q5@n)', '[passed 200 times](q3#test=checkout@passes)'])
  assert.deepEqual(next.marks.find(m => m.kind === 'spark').values, [3, 1, 4, 1, 5])
  assert.deepEqual(next.marks.filter(m => m.kind === 'gloss').map(m => m.gloss), ['g1'])
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

test('a message taller than the screen arrives squeezed; the rows count as drawn', () => {
  assert.equal(rowsOf('a\n\nb', 100), 3)
  assert.equal(rowsOf('word '.repeat(50).trim(), 100), 3)
  assert.equal(rowsOf('[a long label](q1#x@n)', 10), 1)
  const long = Array.from({ length: 40 }, (_, i) => `Line ${i} of a long answer.`).join('\n')
  assert.ok(isLong(long, { cols: 100, room: 34 }))
  assert.ok(!isLong(TEXT, { cols: 100, room: 34 }))
  assert.ok(!isLong(long, { cols: 100, room: 60 }))
})

test('readReply takes the text from its tags, or the whole reply when it gave none', () => {
  assert.deepEqual(readReply('<text>\nA.\n</text>'), { text: 'A.', chip: null })
  assert.deepEqual(readReply('A plain reply.'), { text: 'A plain reply.', chip: null })
  assert.equal(readReply('<chip levels="off | on" pick="on"/><text>B</text>').chip.level, 1)
})

test('run.mjs: the same rewrite from words, through ctx.model, for /verb and tools that hold a record', async () => {
  const rec = record()
  assert.deepEqual(parseWords(rec, 'length=short familiarity=new').at, { length: 1, familiarity: 0 })
  assert.deepEqual(parseWords(rec, '').at, { length: ARRIVE })
  assert.throws(() => parseWords(rec, 'story=full'), /no chip "story"/)
  const asked = []
  const model = { complete: async req => { asked.push(req); return { isAnswered: true, text: '<text>Fixed: [1 run in 9](q2#test=checkout@fail_rate).</text>', usage: { input_tokens: 10, output_tokens: 5 } } } }
  const r = await run({ message: rec, args: 'length=one line', model, verb: { model: 'sonnet' } })
  assert.equal(asked.length, 1)
  assert.equal(r.message.shown, 'Fixed: [1 run in 9](q2#test=checkout@fail_rate).')
  assert.equal(r.message.marks[0].ref, 'q2#test=checkout@fail_rate')
  const back = await run({ message: r.message, args: 'original', model })
  assert.equal(back.message.shown, null)
  assert.equal(asked.length, 1)
})
