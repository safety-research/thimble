// The tray's state and words (tray/tray.mjs): the stack of marks, the stops ] and [ move through in reading order and
// where they stop, the bar's words, and what a question asked with the tray open carries for Claude. Made-up data.
//   node --test plugin/tray/test/tray.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { partsAround } from '../../core/text.js'
import { aboutOf, back, base, checkStatus, evidenceLine, firstSentence, hiddenOutput, indexOf, lineWindow, moreLines, open, printLine, push, restWords, stepFrom, stepWords, stopKind, stopWhat, stopsOfRow, top, wasLine } from '../tray.mjs'

const C1 = { row: 'r2', kind: 'citation', n: 1 }
const G1 = { row: 'r2', kind: 'explain', id: 'g1' }

test('the stack: a mark opens alone, a citation inside it opens over it, 0 goes back, then closes', () => {
  let t = open({ ...G1, open: null })
  assert.deepEqual(t, { stack: [G1] })
  t = push(t, C1)
  assert.deepEqual(top(t), C1)
  assert.deepEqual(base(t), G1)
  // the same mark twice in a row is not stacked
  assert.equal(push(t, C1).stack.length, 2)
  t = back(t)
  assert.deepEqual(top(t), G1)
  assert.equal(back(t), null)
})

test('a row\'s stops: its citations and explainers by where they stand, then its cards; ] stops at the ends', () => {
  const stops = stopsOfRow('r2', [{ n: 2, start: 40 }, { n: 1, start: 5 }, { n: 0, start: 60 }], [{ id: 'g1', kind: 'explain', start: 20 }, { id: 'h1', kind: 'heads', start: 7 }], ['c9'])
  assert.deepEqual(stops.map(s => s.card ?? (s.kind === 'citation' ? `c${s.n}` : s.id)), ['c1', 'h1', 'g1', 'c2', 'c9'])
  assert.equal(indexOf(stops, C1), 0)
  assert.equal(indexOf(stops, { row: 'r2', card: 'c9' }), 4)
  assert.equal(stepFrom(stops, 4, 1), null)
  assert.equal(stepFrom(stops, 0, -1), null)
  assert.deepEqual(stops.map(stopWhat), ['citation', 'heads up', 'explainer', 'citation', 'card'])
})

test('an explainer or a heads-up on a citation\'s words, or over them, stops before it: a click opens it first, ] goes on to the citation', () => {
  const cites = [{ n: 1, start: 10, words: 'build fails' }, { n: 2, start: 50, words: '41 runs' }]
  // g1 inside the first citation's words, h1 over the second citation and the words beside it
  const stops = stopsOfRow('r2', cites, [{ id: 'g1', kind: 'explain', start: 11, end: 22 }, { id: 'h1', kind: 'heads', start: 44, end: 70 }], ['c9'])
  assert.deepEqual(stops.map(s => s.card ?? (s.kind === 'citation' ? `c${s.n}` : s.id)), ['g1', 'c1', 'h1', 'c2', 'c9'])
  assert.deepEqual(stops.map(stopWhat).slice(0, 2), ['explainer', 'citation'])
})

test('the bar names the mark ] opens by its kind, the words that name it apart to draw in its look: show the answer\'s first mark, next a later one; a narrow bar keeps the name, then the key alone, never a verb with no name', () => {
  const stops = stopsOfRow('r2', [{ n: 1, start: 30 }], [{ id: 'g1', kind: 'explain', start: 5 }, { id: 'h1', kind: 'heads', start: 50 }], ['c9'])
  assert.deepEqual(stops.map(stopKind), ['explain', 'citation', 'heads', null])
  assert.deepEqual(restWords(stops[0], true), { words: 'show explainer', what: 'explainer', kind: 'explain', shorter: ['explainer', ''] })
  assert.deepEqual(restWords(stops[1], false), { words: 'next citation', what: 'citation', kind: 'citation', shorter: ['citation', ''] })
  assert.deepEqual(restWords(stops[2], false), { words: 'next heads up', what: 'heads up', kind: 'heads', shorter: ['heads up', ''] })
  // the tray's header: what ] and [ go to, by name and kind; a card has no kind
  assert.deepEqual(stepWords({ next: true, prev: true, nextWhat: 'heads up', nextKind: 'heads' }), [{ key: ']', words: 'next heads up', what: 'heads up', kind: 'heads' }])
  assert.deepEqual(stepWords({ next: false, prev: true, prevWhat: 'card', prevKind: null }), [{ key: '[', words: 'previous card', what: 'card', kind: null }])
  // the words around the name, which the bar and the header draw in their own looks
  assert.deepEqual(partsAround(' show explainer', 'explainer'), [{ s: ' show ', marked: false }, { s: 'explainer', marked: true }])
  assert.deepEqual(partsAround(' heads up', 'heads up'), [{ s: ' ', marked: false }, { s: 'heads up', marked: true }])
  assert.deepEqual(partsAround(' show', 'explainer'), [{ s: ' show', marked: false }])
  assert.deepEqual(partsAround(' next card', undefined), [{ s: ' next card', marked: false }])
})

test("a citation's check in the words every place that shows its card says it in (the tray's header, the evidence pane, the claims pane): the reply's sign after it, then the word; a corrected one says corrected, or repaired after x, with what it was under it", () => {
  const word = m => { const s = checkStatus(m); return `${s.sign} ${s.word} (${s.tone})` }
  assert.equal(word({ status: 'checking' }), 'spin checking (dim)')
  assert.equal(word({ status: 'deferred' }), '? not checked (dim)')
  assert.equal(word({ status: 'verified' }), '✓ verified (good)')
  assert.equal(word({ status: 'verified', repair: true }), '✓ verified (good)')
  assert.equal(word({ status: 'corrected', was: '15 of 40' }), '✓ corrected (good)')
  assert.equal(word({ status: 'corrected', was: '15 of 40', repair: true }), '✓ repaired (good)')
  assert.equal(word({ status: 'failed' }), '× failed (bad)')
  // a status no check gave, or no citation, is failed (marks/store.ts notRun)
  assert.equal(word({ status: 'pending' }), '× failed (bad)')
  assert.equal(checkStatus(null).key, 'failed')
  // under a corrected one's status: what it was, its marks gone; a rewritten sentence or a narrowed citation says which
  assert.equal(wasLine({ was: '**15** of 40' }), 'was 15 of 40')
  assert.equal(wasLine({ was: 'Of the runs, 15 of 40 failed.', rewritten: true }), 'sentence rewritten; was Of the runs, 15 of 40 failed.')
  assert.equal(wasLine({ was: '15 of 40 runs', narrowed: true }), 'narrowed; was 15 of 40 runs')
})

test('a citation\'s card: why in one sentence, and the one line of evidence that holds the value, cut around it', () => {
  assert.equal(firstSentence('Counted 12.5 of 40 runs. The rest passed.'), 'Counted 12.5 of 40 runs.')
  assert.equal(firstSentence('no stop at the end'), 'no stop at the end')
  // computed: the output line where the first highlight starts, the span moved into it
  const out = 'runs: 40\nmerged: 12 of 40\nopen: 3'
  assert.deepEqual(evidenceLine({ kind: 'computed', code: 'print()', output: out, highlight: [[17, 25]] }), { text: 'merged: 12 of 40', spans: [[8, 16]] })
  assert.deepEqual(evidenceLine({ kind: 'computed', code: 'print()', output: '\nfirst words' }), { text: 'first words', spans: [] })
  // a file: the cited line that holds the highlight, with its number
  const lines = [{ n: 3, text: 'runs: 40' }, { n: 4, text: 'failed: 12', highlight: [8, 10] }, { n: 5, text: 'open: 3' }]
  assert.deepEqual(evidenceLine({ kind: 'quote', file: 'runs/summary.txt', line: '4', lines }), { n: 4, text: 'failed: 12', spans: [[8, 10]] })
  assert.deepEqual(evidenceLine({ kind: 'quote', file: 'runs/summary.txt', line: '5', lines: [lines[0], lines[2]] }), { n: 5, text: 'open: 3', spans: [] })
  assert.equal(evidenceLine(null), null)
  // the output lines the one line leaves out: a trailing newline starts none; a file's evidence has none
  assert.equal(hiddenOutput({ kind: 'computed', output: out }), 2)
  assert.equal(hiddenOutput({ kind: 'computed', output: 'merged: 12\nopen: 3\n' }), 1)
  assert.equal(hiddenOutput({ kind: 'computed', output: 'merged: 12\n' }), 0)
  assert.equal(hiddenOutput({ kind: 'quote', file: 'runs/summary.txt', line: '4', lines }), 0)
  assert.equal(moreLines(1), '+ 1 more line')
  assert.equal(moreLines(3), '+ 3 more lines')
  // a long line keeps the value in view, with … where it was cut
  const long = { text: `${'a'.repeat(100)}VALUE${'b'.repeat(100)}`, spans: [[100, 105]] }
  const cut = lineWindow(long, 40)
  assert.ok(cut.text.length <= 40 && cut.text.startsWith('…') && cut.text.endsWith('…'))
  assert.equal(cut.text.slice(cut.spans[0][0], cut.spans[0][1]), 'VALUE')
  assert.deepEqual(lineWindow({ text: 'short', spans: [] }, 40), { text: 'short', spans: [] })
  // a line with words is cut between them, … only where words were left out
  const said = 'Each open ticket waits for a second reviewer to sign off before it can close — ask one with `desk sign <n>`.'
  const at = said.indexOf('a second reviewer to sign off')
  for (const room of [24, 40, 60]) {
    const w = lineWindow({ text: said, spans: [[at, at + 29]] }, room)
    assert.ok(w.text.length <= room)
    assert.match(w.text, /^… \S/)
    assert.match(w.text, /\S …$/)
    for (const word of w.text.replace(/^… | …$/g, '').split(' ')) assert.ok(said.split(' ').includes(word), `${room}: ${word}`)
    assert.ok('a second reviewer to sign off'.startsWith(w.text.slice(w.spans[0][0], w.spans[0][1])))
  }
  assert.equal(lineWindow({ text: said, spans: [[0, 4]] }, 30).text, 'Each open ticket waits for a …')
})


test('what a side thread is about quotes the words once: words that open with a quote keep their own', () => {
  assert.equal(aboutOf({ kind: 'heads', row: 'r1', id: 'h1' }, { gloss: { title: '"Cheated" is their own word' } }), 'the heads-up "Cheated" is their own word')
  assert.equal(aboutOf({ kind: 'heads', row: 'r1', id: 'h1' }, { gloss: { title: 'March is half a month' } }), 'the heads-up "March is half a month"')
  assert.equal(aboutOf({ kind: 'citation', row: 'r1', n: 2 }, { words: '“please post R3”' }), 'the citation “please post R3”')
})

test('the line of code above a citation\'s output is one that printed it: never a print whose words the output lacks', () => {
  // a script with a print of its own words, then a shell echo after it
  const script = "python3 - <<'EOF'\nfor r in runs:\n    print(r, 'issues' if r.i else 'prs-only', 'h merged=', r.n)\nEOF\necho $TMPDIR"
  assert.equal(printLine(script, 'run-7 prs-only 8 h merged= 223'), "print(r, 'issues' if r.i else 'prs-only', 'h merged=', r.n)")
  // two prints with words: the one whose words the line holds, not the last
  assert.equal(printLine("print('gateway', a, 'of', b)\nprint('poverty revs times', t)", 'gateway 3 of 238'), "print('gateway', a, 'of', b)")
  // no print's words in the line: a print of values alone may have printed it; else none
  assert.equal(printLine("print('totals')\nprint(n)", '41'), 'print(n)')
  assert.equal(printLine("print('totals')", '41'), '')
})

test("of several prints, the line shown is the one that printed the cited line, by its words or its place among them; a neighbor's print of other values never stands in for it", () => {
  // a literal inside the print's own expression picks what it counts and is not printed: the sum printed 12, not the
  // print of len above it
  const two = "print(len(runs))\nprint(sum(r['status'] == 'failed' for r in runs))"
  assert.equal(printLine(two, '40\n12', 1), "print(sum(r['status'] == 'failed' for r in runs))")
  assert.equal(printLine(two, '40\n12', 0), 'print(len(runs))')
  // a heading print, then the value's: the heading's words are on a line above
  const day = 'print("Failures by day:")\nprint(runs[runs.status == "failed"].groupby("day").size())'
  assert.equal(printLine(day, 'Failures by day:\nday\n2026-10-01    3\n2026-10-02    5\ndtype: int64', 3), 'print(runs[runs.status == "failed"].groupby("day").size())')
  // a loop that prints a label line, then a value line: each value line is the value's print, the line before the
  // loop the print before it
  const loop = 'print(len(runs))\nfor d in days:\n    print("day", d)\n    print(counts[d])'
  const out = '40\nday 2026-10-01\n3\nday 2026-10-02\n5'
  assert.deepEqual([0, 2, 4].map(i => printLine(loop, out, i)), ['print(len(runs))', 'print(counts[d])', 'print(counts[d])'])
  // a label print that goes on with a value of several lines, then a print of one value: the value's last line is the
  // second print's, the lines between could be either's, so none is shown
  const label = 'print("by status:", counts)\nprint(len(runs))'
  const said = 'by status: status\npassed    28\nfailed    12\n40'
  assert.deepEqual([2, 3].map(i => printLine(label, said, i)), ['', 'print(len(runs))'])
  // three prints of values, each of several lines or one: a line inside them could be any one's, so none is shown,
  // though a comparison's literal names a word of the line
  const three = 'print(runs.shape)\nprint(runs["status"].value_counts())\nprint(runs.groupby("config")["status"].apply(lambda s: (s == "failed").mean()))'
  assert.equal(printLine(three, '(40, 5)\nstatus\npassed    28\nfailed    12\nName: count, dtype: int64\nconfig\na    0.20\nb    0.45', 3), '')
})
