// The Squeeze verb's tests: node --test lean/verbs/squeeze/test
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runProgram } from '../../../draw/sandbox-node.mjs'
import { renderSvg } from '../../../draw/svg.js'
import { renderTerm } from '../../../draw/term.js'
import { COPIES } from '../demo/sync.mjs'
import { applies } from '../hint.mjs'
import { isSqueeze, normalize, parseAnswer, run, strayNumbers } from '../run.mjs'
import { cut, expand, sentences } from '../spans.mjs'

const VERB = fileURLToPath(new URL('..', import.meta.url))
const SKILL = readFileSync(VERB + 'SKILL.md', 'utf8')

// a made-up report, in the shape a long reply takes
const REPORT = `**Fixed the flaky \`test_checkout_total\`.** The flake came from test order, not from time.

## Root cause
Both tests take the \`cart\` fixture from \`tests/conftest.py\`, declared with \`scope="module"\`. So pytest built one cart for the file, e.g. for every test in it. CI showed it in about 1 run in 9.

## Checks
- The checkout tests passed 200 times in a row.
- The full suite passes.

## How it got there
- First theory: a timezone mismatch in v2.5 of the date helper.
- I reran the test 840 times; it failed 1 in 9.

| step | runs |
|------|------|
| rerun | 840 |
`
const ANSWER = {
  dims: [{ id: 'length', name: 'length', levels: ['one line', 'short'], why: 'a long run needs a one-line answer' },
    { id: 'story', name: 'story', levels: ['hidden', 'in brief'], why: 'most of the run was a detour' }],
  first: { length: 1, story: 0 },
  versions: [{ at: { length: 1, story: 0 }, lines: [
    { text: 'Fixed `test_checkout_total`: two tests shared one module-scoped `cart` fixture.', from: ['1.1', '3.1'] },
    { text: 'The checkout tests passed 200 times in a row.', from: ['5.1'] }],
  out: [{ what: 'how it got there', from: ['8.1-9.1'] }] }],
}

/** A model that answers from a list, and keeps what it was asked. */
function fakeModel(...answers) {
  const calls = []
  return { calls, complete: async req => { calls.push(req); const a = answers.shift(); return typeof a === 'object' && a && a.isAnswered === false ? a : { isAnswered: true, text: typeof a === 'string' ? a : JSON.stringify(a), usage: { input_tokens: 10, output_tokens: 5 } } } }
}

test('the original is cut into spans whose ids follow its blocks and sentences', () => {
  const { spans, blocks } = cut(REPORT)
  const ids = spans.map(s => s.id)
  assert.deepEqual(ids.slice(0, 6), ['1.1', '1.2', '2.1', '3.1', '3.2', '3.3'])
  assert.equal(spans.find(s => s.id === '2.1').kind, 'h')
  assert.equal(spans.find(s => s.id === '5.1').kind, 'li')
  assert.ok(spans.some(s => s.kind === 'row' && /rerun/.test(s.text)), 'a table row is a span of its own')
  assert.ok(!spans.some(s => /^\|[-|\s]+\|$/.test(s.text)), 'the row under a table header is no span')
  assert.equal(blocks.length, new Set(spans.map(s => s.b)).size)
  assert.deepEqual(cut(REPORT).spans.map(s => s.id), ids, 'the same text gets the same ids')
  // no split after an abbreviation, inside code, inside a number or a link
  assert.deepEqual(sentences('So it ran once, e.g. for every test. Then `a.b. C` held. It was v2.5. See [the doc. Here](x.md#L2) now.'),
    ['So it ran once, e.g. for every test.', 'Then `a.b. C` held.', 'It was v2.5.', 'See [the doc. Here](x.md#L2) now.'])
})

test('from opens ranges and block numbers, in document order, and drops ids that name nothing', () => {
  const { spans } = cut(REPORT)
  assert.deepEqual(expand(['3.3', '3.1-3.2'], spans), ['3.1', '3.2', '3.3'])
  assert.deepEqual(expand(['3'], spans), ['3.1', '3.2', '3.3'])
  assert.deepEqual(expand(['[1.2]', '99.1', ''], spans), ['1.2'])
})

test('a line that states a number its spans do not, or cites nothing, is kept with its problem named', () => {
  const { spans } = cut(REPORT)
  assert.deepEqual(strayNumbers('passed 200 times, 1,200 in all', ['passed 200 times in a row']), ['1200'])
  assert.deepEqual(strayNumbers('about 1 run in 9', ['about 1 run in 9']), [])
  const n = normalize({ dims: ANSWER.dims, versions: [{ at: { length: 0 }, lines: [
    { text: 'Passed 300 times.', from: ['5.1'] }, { text: 'Fixed.', from: ['77.1'] }] }] }, spans)
  assert.match(n.versions[0].lines[0].problem, /"300" is not in the spans it cites/)
  assert.equal(n.versions[0].lines[1].problem, 'cites no span of the original')
  assert.equal(n.problems.length, 2)
  assert.deepEqual(n.versions[0].at, { length: 0, story: 0 }, 'a level left out is the first')
  const many = normalize({ dims: [1, 2, 3, 4].map(i => ({ id: 'd' + i, levels: ['a', 'b'] })), versions: [{ at: { d1: 9 }, lines: [{ text: 'x', from: ['1.1'] }] }] }, spans)
  assert.equal(many.dims.length, 3)
  assert.equal(many.versions[0].at.d1, 1, 'a level past the last is the last')
  assert.deepEqual(parseAnswer('Here it is:\n```json\n{"a": 1}\n```'), { a: 1 })
})

test('run makes a squeeze with one quiet model call: the skill as system prompt, the numbered spans as prompt', async () => {
  const model = fakeModel(ANSWER)
  const r = await run({ object: { id: 'reply:t1', text: REPORT, question: 'why does the test flake?' }, model, skill: SKILL, verb: { model: 'sonnet' } })
  assert.equal(model.calls.length, 1)
  const req = model.calls[0]
  assert.equal(req.model, 'sonnet')
  assert.match(req.system[0].text, /Choose the dimensions for this text/)
  assert.doesNotMatch(req.system[0].text, /^---/, 'the frontmatter is not sent')
  assert.match(req.prompt, /The person asked: why does the test flake\?/)
  assert.match(req.prompt, /\[3\.2\] So pytest built one cart/)
  assert.ok(isSqueeze(r.object))
  assert.deepEqual(r.object.data.at, { length: 1, story: 0 })
  assert.equal(r.object.data.of.id, 'reply:t1')
  assert.match(r.text, /^Fixed test_checkout_total/)
  assert.match(r.note, /squeezed to 2 of \d+ lines \(length short, story hidden\)/)
  assert.deepEqual(r.object.lineage.cites.map(c => c.spans), [['1.1', '3.1'], ['5.1']])
  assert.equal(r.object.lineage.made[0].by, 'model')
})

test('the squeeze draws the same regions in both renderers: a line each, its cite holding its spans', async () => {
  const r = await run({ object: { text: REPORT }, model: fakeModel(ANSWER), skill: SKILL })
  for (const w of [80, 140]) {
    const d = runProgram(r.object, { w })
    assert.equal(d.error, undefined, d.error && d.error.message)
    assert.deepEqual(d.warnings, [])
    const t = renderTerm(d, { w }), s = renderSvg(d, { w })
    assert.deepEqual(t.regions.map(x => x.id), s.regions.map(x => x.id))
    assert.deepEqual(t.regions.map(x => x.id).slice(0, 2), ['line-1', 'line-2'])
    assert.deepEqual(d.cites['line-1'].rows.map(x => x.span), ['1.1', '3.1'])
    assert.ok(t.regions.some(x => x.id === 'dim-story'), 'each dimension Claude chose is drawn')
    // wide, the original is drawn beside it: a line's spans are links into its region, so selecting it lights them
    const line1 = t.regions.find(x => x.id === 'line-1')
    if (w >= 110) assert.ok(line1.rects.length > 1, 'the spans of line 1 join its region')
    else assert.equal(line1.rects.length, 1)
  }
  const focus = { ...r.object, data: { ...r.object.data, focus: 'line-2' } }
  const t = renderTerm(runProgram(focus, { w: 90 }), { w: 90 })
  assert.ok(t.regions.find(x => x.id === 'line-2').rects.length >= 2, 'the focused line and its span in its paragraph')
})

test('moving along a dimension uses a version already written, and writes a missing one with one more call', async () => {
  const model = fakeModel(ANSWER, { versions: [{ at: { length: 1, story: 1 }, lines: [{ text: 'It flaked 1 in 9; I reran it 840 times first.', from: ['3.3', '9.1'] }] }] })
  const made = (await run({ object: { text: REPORT }, model, skill: SKILL })).object
  const shorter = await run({ object: made, args: 'shorter', model, skill: SKILL })
  assert.equal(model.calls.length, 2, 'the shorter version was not written yet')
  assert.match(model.calls[1].prompt, /Write the version at \{"length":0,"story":0\} only/)
  assert.equal(shorter.object.v, 2)
  const again = await run({ object: shorter.object, args: 'shorter', model, skill: SKILL })
  assert.match(again.text, /shortest version on length/)
  assert.equal(model.calls.length, 2, 'nothing below the first level, so no call')
  const back = await run({ object: shorter.object, args: 'fuller', model, skill: SKILL })
  assert.equal(model.calls.length, 2, 'the fuller version was written already')
  assert.deepEqual(back.object.data.at, { length: 1, story: 0 })
  const why = await run({ object: back.object, args: 'why 2', model, skill: SKILL })
  assert.match(why.text, /^Line 2 came from 5\.1:\n {2}\[5\.1\] The checkout tests passed 200 times in a row\./)
  const orig = await run({ object: back.object, args: 'original', model, skill: SKILL })
  assert.equal(orig.object.data.show, 'original')
})

test('a model call that fails says why, and nothing is made', async () => {
  const model = fakeModel({ isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded_error' })
  await assert.rejects(run({ object: { text: REPORT }, model, skill: SKILL }), /the model gave no squeeze: the API answered 529 \(overloaded_error\)/)
  await assert.rejects(run({ object: { text: REPORT }, skill: SKILL }), /ctx\.model\.complete/)
  const short = await run({ object: { text: 'One line. Two.' }, model, skill: SKILL })
  assert.match(short.text, /already short/)
  assert.equal(short.object, undefined)
})

test('the hint names a long text, and shorter while a squeeze can go shorter', async () => {
  assert.equal(applies({ text: 'short.' }), null)
  assert.match(applies({ text: REPORT }), /^squeeze \d+ lines$/)
  const sq = (await run({ object: { text: REPORT }, model: fakeModel(ANSWER), skill: SKILL })).object
  assert.equal(applies(sq), 'shorter')
  assert.equal(applies({ ...sq, data: { ...sq.data, at: { length: 0, story: 0 } } }), null)
})

test('units (a session\'s turns) keep their own ids', async () => {
  const units = [1, 2, 3, 4].map(i => ({ id: `t${i}`, text: `you: question ${i} → claude: a long answer about part ${i} of the work, with its numbers and names.` }))
  const model = fakeModel({ dims: [{ id: 'length', levels: ['one line per turn'] }], versions: [{ at: {}, lines: [{ text: 'Asked about part 1 and 2.', from: ['t1-t2'] }] }] })
  const r = await run({ object: { id: 'session', units }, model, skill: SKILL })
  assert.match(model.calls[0].prompt, /\[t3\] you: question 3/)
  assert.deepEqual(r.object.data.versions[0].lines[0].from, ['t1', 't2'])
  assert.equal(runProgram(r.object, { w: 100 }).error, undefined)
})

test('main\'s path: the CLI lists the spans, then checks and draws the squeeze main wrote', () => {
  const dir = mkdtempSync(join(tmpdir(), 'squeeze-test-'))
  writeFileSync(join(dir, 'report.md'), REPORT)
  writeFileSync(join(dir, 'answer.json'), JSON.stringify({ ...ANSWER, versions: [{ ...ANSWER.versions[0], lines: [...ANSWER.versions[0].lines, { text: 'It failed 31 times.', from: ['9.1'] }] }] }))
  const cli = (...a) => execFileSync('node', [VERB + 'cli.mjs', ...a], { cwd: dir, encoding: 'utf8' })
  assert.match(cli('report.md'), /\[3\.3\] CI showed it in about 1 run in 9\./)
  const out = cli('report.md', '--from', 'answer.json', '--text', '--w', '90', '--out', 'sq.json')
  assert.match(out, /3 of \d+ lines/)
  assert.match(out, /"31" is not in the spans it cites/)
  assert.match(cli('sq.json', '--focus', 'line-2', '--text'), /came from 1 span of the original \(5\.1\)/)
})

test('the demo plugin\'s copies are current (node lean/verbs/squeeze/demo/sync.mjs)', () => {
  for (const [from, to] of COPIES) assert.equal(readFileSync(VERB + 'demo/hooks/lib/' + to, 'utf8'), readFileSync(from, 'utf8'), `${to} is stale`)
})
