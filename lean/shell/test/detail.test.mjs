// The card detail's state (shell/carddetail.js) and the side threads' scoping (shell/threads.js): parts, examples, versions,
// keys that act only while the composer is empty, the "from" line, the program behind p, and what a thread is about.
//   node --test lean/shell/test/detail.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { asTable, beganWord, examplesView, exampleSet, fmtWords, fromLine, keyOf, linkRuns, partOfLink, partsOf, programLines, recordWords, stepPart, stepVersion, versionsOf } from '../carddetail.js'
import { aboutOf, answerOf, firstMessage, nextMessage, ownReport, samePart, threadKey, toMain, turnsOf } from '../threads.js'
import { runProgram } from '../../draw/sandbox-node.mjs'
import { renderTerm } from '../../draw/term.js'

const rect = (x, y, w = 4, h = 1) => ({ x, y, w, h })

test('parts are the regions drawn with cells, in reading order; a knob dial is a part, a link to a cite is not', () => {
  const grid = {
    regions: [
      { id: 'fix', meta: { label: 'Fix' }, rects: [rect(40, 6)] },
      { id: 'orient', meta: { label: 'Orient' }, rects: [rect(0, 6), rect(0, 7)] },
      { id: 'detour', meta: { label: 'Timezone detour' }, rects: [rect(7, 1, 20, 4)] },
      { id: 'nothing', meta: {}, rects: [] },
      { id: 'file', meta: { cite: 'file' }, rects: [rect(0, 9)], link: true },
      { id: 'scale', meta: { knob: 'scale', label: 'scale ×8' }, rects: [rect(30, 0)], link: true },
    ],
  }
  const parts = partsOf(grid)
  assert.deepEqual(parts.map(p => p.id), ['scale', 'detour', 'orient', 'fix'])
  assert.equal(parts[0].knob, 'scale')
  assert.equal(stepPart(parts, 'orient', 1), 'fix')
  assert.equal(stepPart(parts, 'fix', 1), 'scale', 'wraps at the end')
  assert.equal(stepPart(parts, 'scale', -1), 'fix', 'wraps at the start')
  assert.equal(stepPart(parts, null, 1), 'scale')
  assert.equal(stepPart([], 'x', 1), null)
})

test('parts come from a real drawing: regions of a program, a knob among them', () => {
  const object = {
    id: 'sweep', v: 1, data: { gaps: [[1, 9.5], [2, 6.1], [4, 3.2], [8, 1.6]] },
    program: `const s = k.knob('scale', { values: data.gaps.map(g => g[0]), at: 1, label: 'scale' })
const gap = data.gaps.find(g => g[0] === s)[1]
k.cite('gap', { text: 'max gap ' + gap, source: 'sweep.csv' })
return k.stack(k.dial('scale'), k.region('gap', { label: 'max gap', cite: 'gap' }, k.text('gap ' + gap)), k.region('b32', { label: 'batch 32' }, k.text('batch 32')))`,
  }
  const drawing = runProgram(object, { w: 60, mode: 'detail' })
  assert.equal(drawing.error, undefined)
  const parts = partsOf(renderTerm(drawing, { w: 60 }))
  assert.deepEqual(parts.map(p => p.id), ['scale', 'gap', 'b32'])
  const turned = runProgram(object, { w: 60, mode: 'detail', state: { scale: 8 } })
  assert.match(JSON.stringify(turned.root), /gap 1\.6/)
})

test('versions: v1 · v2 from the history; h steps back, and from v1 to the latest', () => {
  const vs = versionsOf({ version: 2, history: [{ v: 1, at: 'a' }, { v: 2, at: 'b', change: 'split by label' }] })
  assert.deepEqual(vs.map(x => x.v), [1, 2])
  assert.equal(stepVersion(vs, 2), 1)
  assert.equal(stepVersion(vs, 1), 2)
  assert.deepEqual(versionsOf({ version: 3 }).map(x => x.v), [3])
  assert.equal(stepVersion([{ v: 1 }], 1), 1)
})

test('keys act only while the composer is empty, so a question that starts with p or h types normally; details come on demand', () => {
  const ctx = { composer: '', versions: 2, knob: true, thread: true }
  assert.deepEqual(keyOf('p', ctx), { act: 'program' })
  assert.deepEqual(keyOf('h', ctx), { act: 'version' })
  assert.deepEqual(keyOf('e', ctx), { act: 'examples' })
  assert.deepEqual(keyOf(']', ctx), { act: 'example', dir: 1 })
  assert.deepEqual(keyOf('[', ctx), { act: 'example', dir: -1 })
  assert.deepEqual(keyOf('down', ctx), { act: 'part', dir: 1 })
  assert.deepEqual(keyOf('.', ctx), { act: 'knob', dir: 1 })
  assert.deepEqual(keyOf('m', ctx), { act: 'main' })
  for (const k of ['p', 'h', 'e', ']', '[', 'down', '.', 'm', 't', '0']) assert.equal(keyOf(k, { ...ctx, composer: 'w', bar: true }), null, `${k} types once a question has begun`)
  assert.equal(keyOf('h', { ...ctx, versions: 1 }), null, 'one version: h types')
  assert.equal(keyOf('.', { ...ctx, knob: false }), null, 'no knob selected: . types')
  assert.equal(keyOf('m', { ...ctx, thread: false }), null, 'no thread yet: m types')
  assert.equal(keyOf('w', ctx), null, 'any other letter types')
  // the bar and the program close before the detail does
  assert.equal(keyOf('0', ctx), null, 'nothing to close: 0 is left alone')
  assert.deepEqual(keyOf('0', { ...ctx, bar: true }), { act: 'back' })
  assert.deepEqual(keyOf('esc', { ...ctx, overlay: true }), { act: 'back' })
  assert.deepEqual(keyOf('esc', ctx), { act: 'close' })
  // a key that began a word gives its letter back
  assert.equal(beganWord('p', 300, 'l'), true)
  assert.equal(beganWord('p', 900, 'l'), false)
  assert.equal(beganWord(']', 100, 'l'), false)
  assert.equal(beganWord('p', 100, '['), false)
})

test('examples show the meaningful words of a record, never a dump of field: value', () => {
  const rev = { rev_id: 'wikiA~PageX@2', page_id: 'wikiA/PageX', name: 'PageX', seq: 2, body: 'Hello agents,\n sign below so we know who is here.', body_len: 40, label: 'ScoutBot', time: '2026-06-18T10:00:00Z' }
  const w = recordWords(rev)
  assert.equal(w.words, 'Hello agents, sign below so we know who is here.')
  assert.doesNotMatch(w.words, /rev_id|page_id/)
  assert.match(w.meta, /PageX/)
  assert.match(w.meta, /ScoutBot/)
  // the field the card is about wins
  assert.equal(recordWords({ user: 'ScoutBot', text: 'test test', title: 'Lexicon' }, { fields: ['title'] }).words, 'Lexicon')
  // a row the kernel read back carries its words and meta
  assert.deepEqual(recordWords({ ref: 'revisions.jsonl#L12', text: 'rev_id: a, body: b', words: 'b', meta: 'PageX · ScoutBot' }), { words: 'b', meta: 'PageX · ScoutBot' })
  assert.deepEqual(recordWords({ ref: 'revisions.jsonl#L12', text: 'plain words' }), { words: 'plain words', meta: 'revisions.jsonl#L12' })
  // a transcript row: its words, else its tool call
  assert.equal(recordWords({ type: 'assistant', message: { content: [{ type: 'text', text: 'Reading the fixture now.' }] } }).words, 'Reading the fixture now.')
  assert.equal(recordWords({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pytest -x' } }] } }).words, 'Bash: pytest -x')
  // a record with no words reads as its short fields, not as JSON
  assert.equal(recordWords({ epoch: 3, val_acc: 91.2, loss: 0.31 }).words, 'epoch 3 · val_acc 91.2 · loss 0.31')
})

test('examples read as a table of short rows, or as lines of words with their meta; fmt wins', () => {
  const steps = [881, 882, 1239, 1240, 1241].map(s => ({ step: s, activity: 'rerun', summary: s === 1240 ? 'Still rerunning: fails 1 in 9' : 'reruns test_checkout_total' }))
  assert.equal(asTable(steps), true)
  const t = examplesView(steps, { at: 3, fit: 5 })
  assert.equal(t.kind, 'table')
  assert.deepEqual(t.cols, ['step', 'activity', 'summary'])
  assert.equal(t.rows.find(r => r.on).rec.step, 1240)
  const revs = [{ body: 'a'.repeat(200), label: 'X' }, { body: 'second', label: 'Y' }]
  assert.equal(asTable(revs), false)
  const l = examplesView(revs, { at: 1, fit: 4 })
  assert.equal(l.kind, 'lines')
  assert.equal(l.rows.find(r => r.on).words, 'second')
  const f = examplesView([{ text: 'Put the table back.', user: 'Scout', rev: 40350 }], { fmt: '“{text}”\n{user} · rev {rev}', fit: 4 })
  assert.deepEqual({ words: f.rows[0].words, meta: f.rows[0].meta }, { words: '“Put the table back.”', meta: 'Scout · rev 40350' })
  assert.equal(fmtWords('{n} saves', { n: 3945 }).words, '3,945 saves')
  assert.equal(examplesView(steps, { at: 7 }).at, 2, 'the position wraps')
  assert.equal(exampleSet({ examples: { e: { records: [1] } } }, { examples: 'e' }).records.length, 1)
  assert.equal(exampleSet({ examples: { e: { records: [] } } }, { examples: 'e' }), null)
})

test('the from line: source · rows used · labels · coverage', () => {
  const facts = { sources: [{ path: 'transcript_steps.csv', rows: 2143 }], rows: 2143, labels: ['activity'], coverage: { feeding: 1, files: 4 } }
  const text = segs => segs.map(s => s.t).join('')
  assert.equal(text(fromLine(facts, { rows: 840 })), 'from transcript_steps.csv · 840 rows · label activity · ░ 1 of 4 files read')
  assert.equal(text(fromLine({ ...facts, labels: [], coverage: { feeding: 3, files: 3 } })), 'from transcript_steps.csv · 2,143 rows · all 3 files read')
  assert.equal(fromLine(facts).find(s => /1 of 4/.test(s.t)).tone, 'warn')
  assert.equal(text(fromLine({ sources: [{ path: 'a.csv' }, { path: 'b.csv' }], rows: 0, labels: [] })), 'from a.csv +1 more')
})

test('the program behind p: the lines that name the part, else its stem, else the regions', () => {
  const program = "const days = data.days\nk.cite('day-' + d.day, {})\nreturn k.region('links-peak', {}, k.text('x'))\nk.region('other', {}, 1)"
  assert.deepEqual([...programLines(program, 'links-peak')], [3])
  assert.deepEqual([...programLines(program, 'day-2026-06-18')], [2])
  assert.deepEqual([...programLines(program, 'nowhere')], [3, 4])
  assert.equal(programLines(program, null).size, 0)
})

test("the takeaway's citations select their parts", () => {
  const runs = linkRuns('A detour came back at [641](#revert); then [840](q3#n) steps, **480** after.')
  assert.deepEqual(runs.filter(r => r.link).map(r => [r.s, r.link]), [['641', '#revert'], ['840', 'q3#n']])
  assert.equal(runs.find(r => r.bold).s, '480')
  const parts = [{ id: 'revert' }, { id: 'rerun-loop' }]
  assert.equal(partOfLink('#revert', parts, () => []), 'revert')
  assert.equal(partOfLink('q3#n', parts, id => (id === 'rerun-loop' ? ['q3#n'] : [])), 'rerun-loop')
  assert.equal(partOfLink('#gone', parts, () => []), null)
})

test('a thread is scoped to a card (each question to its part) or to a mark', () => {
  const part = { object: 'r17-trail', v: 1, region: 'rerun-loop', label: 'Rerun loop' }
  assert.equal(threadKey(part), 'card-r17-trail')
  assert.equal(threadKey({ ...part, region: 'revert' }), 'card-r17-trail', 'one thread per card')
  assert.equal(threadKey({ row: 'abc123', mark: { kind: 'cite', ref: 'q3#n', label: '840' } }), 'mark-abc123-q3-n')
  assert.equal(aboutOf(part), 'Rerun loop')
  assert.equal(aboutOf({ object: 'x' }), 'this card')
  assert.equal(aboutOf({ row: 'r', mark: { kind: 'gloss', term: 'fixture scope' } }), 'fixture scope')
  const first = firstMessage({ text: 'Where did the time go?', scope: part, card: { id: 'r17-trail', v: 1, title: 'Run r17' }, refs: ['q3#station=rerun-loop@n'], root: '/data/run' })
  assert.match(first, /^Where did the time go\?\n\nAbout: the part "Rerun loop" \(rerun-loop\) of the card "Run r17" \(r17-trail@1/)
  assert.match(first, /Its rows: q3#station=rerun-loop@n/)
  assert.match(firstMessage({ text: 'q', scope: part, selFile: '/data/run/thimble/threads/s/sel/card-r17-trail.json' }), /selected now, for a later message that names none: \/data\/run\/thimble\/threads\/s\/sel\/card-r17-trail\.json/)
  assert.equal(nextMessage({ text: 'and after 1240?', scope: part, last: part }), 'and after 1240?', 'the same part needs no "about"')
  assert.match(nextMessage({ text: 'and this?', scope: { ...part, region: 'revert', label: 'Revert 641' }, last: part }), /About the part "Revert 641" \(revert\) now/)
  assert.equal(samePart(part, { ...part, label: 'other words' }), true)
})

test("a thread's turns come from its subagent's transcript; its answer is its last words or its hand-back", () => {
  const msgs = [
    { role: 'user', content: [{ type: 'text', text: '<system-reminder>env</system-reminder>' }, { type: 'text', text: 'Where did the time go?' }] },
    { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'lean resolve "q3#n"\nmore' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'rows' }] },
    { role: 'assistant', content: [{ type: 'text', text: '840 steps were reruns.' }] },
    { role: 'user', content: [{ type: 'text', text: 'and after 1240?' }] },
    { role: 'assistant', content: [{ type: 'tool_use', name: 'SubagentHandback', input: { message: '480 came after.' } }] },
  ]
  const turns = turnsOf(msgs)
  assert.deepEqual(turns.map(t => t.role), ['person', 'claude', 'person', 'claude'])
  assert.equal(turns[0].text, 'Where did the time go?')
  assert.deepEqual(turns[1].calls, ['lean resolve "q3#n"'])
  assert.equal(turns[1].text, '840 steps were reruns.')
  assert.equal(answerOf(msgs), '480 came after.')
  assert.equal(ownReport('<agent-message from="a1b2">\n[Subagent hand-back] …', ['a1b2']), 'a1b2')
  assert.equal(ownReport('<task-notification>\n<task-id>a1b2</task-id>', ['a1b2']), 'a1b2')
  assert.equal(ownReport('<task-id>zzz</task-id>', ['a1b2']), null, "another agent's report is main's")
  const sent = toMain({ scope: { object: 'r17', region: 'rerun-loop', label: 'Rerun loop' }, card: 'Run r17', turns })
  assert.match(sent, /side thread about Rerun loop on the card "Run r17"/)
  assert.match(sent, /The thread answered: 480 came after\./)
  assert.equal(toMain({ scope: {}, turns: [{ role: 'person', text: 'q' }] }), '')
})
