// The Trace verb: the short path it draws from the kernel's facts, stepping on from a step, the full trace Claude
// writes (and its retry), the hint, and the worked examples of SKILL.md, each run in the drawing sandbox.
// node --test lean/verbs/trace/test
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { runProgram } from '../../../draw/sandbox-node.mjs'
import { gridText, renderTerm } from '../../../draw/term.js'
import { applies } from '../hint.mjs'
import { parseReply, slimFacts } from '../prompt.mjs'
import { run, targetOf } from '../run.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))

// facts as `lean trace --json` gives them, for made-up data: a count over a labeled log, and a note in a swarm
const VALUE = {
  ref: 'obj:uses#/kinds/1/n', text: null, label: 'message',
  back: {
    chain: [
      { step: 'object', id: '01-uses', version: 1, at: '/kinds/1/n', value: 3 },
      { step: 'binding', at: '/kinds', from: 'q2' },
      { step: 'query', id: 'q2', about: 'saves per kind', lineage: 'exact', code: 'tally(use("kind"), "kind")', inputs: [],
        upstream: [{ name: 'kind', query: 'q1', about: 'kind per save', code: 'df = load("saves.jsonl")', lineage: 'exact',
          inputs: [{ path: 'saves.jsonl', rows_read: 8 }], upstream: [] }] },
    ],
    count: 3, rows: ['saves.jsonl#L3,5,7'], notes: [],
    records: [{ ref: 'saves.jsonl#L3', text: 'id: 2, kind: message' }],
  },
  files: { used: ['saves.jsonl'], not_used: ['pages.jsonl'] },
  forward: { queries: [], objects: [], answers: [{ turn: 1, t: '2026-10-18T10:00:00Z', ref: '/s/x.jsonl#L2.b0', text: 'Of 8 saves, 3 are messages.' }] },
}
const per = (agent, read, wrote, line) => ({ agent, file: `agents/${agent}.jsonl`,
  first_read: read && { ref: `agents/${agent}.jsonl#L2.b0`, t: `2026-01-01T${read}:00Z` },
  first_wrote: wrote && { ref: `agents/${agent}.jsonl#L3.b0`, t: `2026-01-01T${wrote}:00Z` }, lines: line ? [line] : [] })
const LINE = {
  ref: 'agents/a31.jsonl#L3.b0', text: '# type: ignore',
  copied_from: { agent: 'a31', t: '2026-01-01T10:11:00Z', text: 'Bash: sed -i s/x/cast(Foo, y)  # type: ignore/', block: 'Bash: sed -i s/x/cast(Foo, y)  # type: ignore/',
    sources: [{ passage: '# type: ignore', chars: 14, from: 'agents/a31.jsonl#L2.b0', t: '2026-01-01T10:03:00Z', kind: 'tool_result', via: 'Bash: cat SCRATCHPAD.md',
      origin: { agent: 'a07', ref: 'agents/a07.jsonl#L3.b0', t: '2026-01-01T09:42:00Z', line: 'add `# type: ignore` to unblock' } }] },
  spread: { text: '# type: ignore', within: 'agents/', files: 4, read: 2, outside: null,
    origin: per('a07', null, '09:42', 'add `# type: ignore` to unblock'), copied: [per('a31', '10:03', '10:11', 'x = cast(Foo, y)  # type: ignore')],
    own: [], held_out: [per('a12', '10:05', null)], never: ['a40'], per_file: [] },
  forward: { queries: [], objects: [], answers: [] },
}

const kernelFor = byRef => async args => {
  const ref = args[1]
  const f = byRef[ref]
  if (!f) throw new Error(`no facts for ${ref}`)
  return JSON.stringify({ ...f, ref, text: args.includes('--text') ? args[args.indexOf('--text') + 1] : f.text })
}
const draw = { runProgram }
const show = (object, w = 100) => gridText(renderTerm(runProgram(object, { w }), { w }))

test('a value: the short path names its query, the label it builds on, its rows, the files not behind it and the answer', async () => {
  const out = await run({ ref: VALUE.ref, kernel: kernelFor({ [VALUE.ref]: VALUE }), draw, w: 100 })
  assert.equal(out.object.verb, 'trace')
  assert.deepEqual(out.object.source, { ref: VALUE.ref, text: undefined, label: undefined })
  const text = show(out.object)
  for (const s of ['3 · message', 'q2 · saves per kind', 'uses "kind", kept by q1', '3 of 8 rows · saves.jsonl', 'not behind it: pages.jsonl', 'answer, turn 1', 't full trace'])
    assert.ok(text.includes(s), `missing "${s}" in\n${text}`)
  assert.match(out.note, /The person traced obj:uses#\/kinds\/1\/n/)
  const drawing = runProgram(out.object, { w: 100 })
  assert.equal(drawing.error, undefined)
  const refs = Object.fromEntries(drawing.regions.map(r => [r.id, r.meta.ref]))
  assert.equal(refs['q-q1'], 'q1')
  assert.equal(refs.rows, 'saves.jsonl#L3')
})

test('a line: back to the words its agent read and the agent who wrote them first; how far they spread', async () => {
  const out = await run({ ref: LINE.ref, kernel: kernelFor({ [LINE.ref]: LINE }), draw, w: 100 })
  const text = show(out.object)
  for (const s of ['a31 wrote:', 'read "# type: ignore" at 10:03', 'in what cat SCRATCHPAD.md showed', 'a07 wrote them first, 09:42', '1 wrote it after reading it', '1 read it, held out', '1 never read it'])
    assert.ok(text.includes(s), `missing "${s}" in\n${text}`)
})

test('t on a step traces on from it, carrying the words it follows', async () => {
  const origin = 'agents/a07.jsonl#L3.b0'
  const seen = []
  const kernel = async args => { seen.push(args); return kernelFor({ [LINE.ref]: LINE, [origin]: { ...LINE, ref: origin, copied_from: { ...LINE.copied_from, agent: 'a07', sources: [] } } })(args) }
  const first = await run({ ref: LINE.ref, kernel, draw })
  const drawing = runProgram(first.object, { w: 100 })
  assert.deepEqual(targetOf({ object: first.object, drawing, region: 'origin' }), { ref: origin, text: '# type: ignore', label: 'a07 wrote them first, 09:42' })
  const next = await run({ object: first.object, drawing, region: 'origin', kernel, draw })
  assert.deepEqual(seen[1], ['trace', origin, '--text', '# type: ignore', '--json'])
  assert.ok(show(next.object).includes('★ a07 wrote "# type: ignore" first'))
})

test('t on the trace itself asks Claude for the full trace; a program that fails gets one more try', async () => {
  const first = await run({ ref: VALUE.ref, kernel: kernelFor({ [VALUE.ref]: VALUE }), draw })
  const prompts = []
  const replies = [
    'title: broken\n```js\nreturn k.frame(data.nothing.here)\n```',
    'title: where 3 comes from\n```js\nconst f = data.facts\nreturn k.frame(k.text(f.label + " " + data.claude.note), { title: "trace" })\n```\n```json\n{"note": "my reading"}\n```',
  ]
  const model = async p => { prompts.push(p); return replies[prompts.length - 1] }
  const out = await run({ object: first.object, kernel: kernelFor({ [VALUE.ref]: VALUE }), draw, model, skill: '# the skill text', toolkit: 'the toolkit text' })
  assert.equal(prompts.length, 2)
  assert.match(prompts[0], /draw the full trace of obj:uses#\/kinds\/1\/n/)
  assert.ok(prompts[0].includes('# the skill text') && prompts[0].includes('the toolkit text') && prompts[0].includes('"label": "message"'))
  assert.match(prompts[1], /Your program failed: TypeError/)
  assert.equal(out.object.full, true)
  assert.ok(show(out.object).includes('message my reading'))
  assert.equal(applies(out.object), null) // a full trace offers no further t
})

test('without a model, the full trace is asked of Claude in the conversation', async () => {
  const first = await run({ ref: VALUE.ref, kernel: kernelFor({ [VALUE.ref]: VALUE }), draw })
  const out = await run({ object: first.object, kernel: kernelFor({ [VALUE.ref]: VALUE }), draw, ask: 'which rows are links?' })
  assert.equal(out.object, undefined)
  assert.match(out.note, /full trace of obj:uses#\/kinds\/1\/n: "which rows are links\?"/)
  assert.match(out.note, /lean trace obj:uses#\/kinds\/1\/n --json/)
})

test('what to trace: a citation, a region with a ref or a cite, a quote, or the object', () => {
  assert.deepEqual(targetOf({ ref: 'q2#kind=links@n' }), { ref: 'q2#kind=links@n', text: undefined })
  const drawing = { regions: [{ id: 'day', meta: { cite: 'c1', label: 'Thu' } }], cites: { c1: { text: '132 saves', query: 'q3#day=2026-06-18@n' } } }
  assert.deepEqual(targetOf({ drawing, region: 'day' }), { ref: 'q3#day=2026-06-18@n', text: undefined, label: 'Thu' })
  assert.deepEqual(targetOf({ region: { id: 'x', meta: { ref: 'a.jsonl#L4.b1', quote: 'PRECISION ALERT' } } }), { ref: 'a.jsonl#L4.b1', text: 'PRECISION ALERT', label: undefined })
  assert.deepEqual(targetOf({ object: { id: '03-days', title: 'Days', lineage: { bindings: [{ at: '/days', ref: 'q3' }] } } }), { ref: 'obj:03-days#/days', label: 'Days' })
  assert.equal(targetOf({ object: { id: 'drawn-only', program: 'x' } }), null)
})

test('the hint says what t would do for this object, or nothing', () => {
  assert.equal(applies({ lineage: { bindings: [{ at: '/days', ref: 'q3' }] } }), 'where these numbers come from')
  assert.equal(applies({ text: 'a07 said [this](agents/a07.jsonl#L3.b0)' }), 'who read and copied this')
  assert.equal(applies({ data: { example: { ref: 'runs.csv#row=3' } } }), 'where this came from')
  assert.equal(applies({ verb: 'trace', program: 'x' }), 'full trace')
  assert.equal(applies({ program: 'return k.text("hi")', data: {} }), null)
})

test('the worked examples of SKILL.md run on facts of their kind and give every step a ref', () => {
  const skill = readFileSync(HERE + '../SKILL.md', 'utf8')
  const programs = [...skill.matchAll(/```js\n([\s\S]*?)```/g)].map(m => m[1])
  assert.equal(programs.length, 2)
  const claude = { groups: [{ label: 'kept the shortcut as written', agents: ['a31'] }] }
  for (const [program, f, extra] of [[programs[0], VALUE, {}], [programs[1], LINE, claude]]) {
    const object = { program, data: { facts: slimFacts(f), claude: extra } }
    const drawing = runProgram(object, { w: 100 })
    assert.equal(drawing.error, undefined, JSON.stringify(drawing.error))
    assert.deepEqual(drawing.warnings, [])
    const grid = renderTerm(drawing, { w: 100 })
    assert.ok(grid.h <= 24, `${grid.h} rows`)
    const withRef = drawing.regions.filter(r => r.meta.ref || r.meta.agents)
    assert.ok(withRef.length >= 3, gridText(grid))
  }
})

test('a reply is read for its title, its program and its judgments', () => {
  const r = parseReply('Here it is.\ntitle: spread of the note\n```javascript\nreturn k.text("x")\n```\n```json\n{"groups": []}\n```')
  assert.deepEqual(r, { title: 'spread of the note', program: 'return k.text("x")', data: { groups: [] } })
  assert.equal(parseReply('no code').program, null)
})
