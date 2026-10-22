// The tray's state and words (tray/tray.mjs): the stack of marks, the stops ] and [ move through in reading order and
// where they stop, the bar's words, and what a question asked with the tray open carries for Claude. Made-up data.
//   node --test plugin/tray/test/tray.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  aboutOf, back, base, canRepair, cutTitle, drawsHyperlinks, evidenceLine, explainerText, fileHref, firstSentence, hiddenOutput, indexOf, lineWindow,
  moreLines, open, pageOf, printLine, push, rowsOf, saidOf, scopeText, stepFrom, stepWords, stopWhat, stopsOfRow, stopsOfTurn, top,
} from '../tray.mjs'

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

test('a heads-up on a citation\'s words stops before the citation, so one ] opens it; an explainer there stops after it', () => {
  const cites = [{ n: 1, start: 30, words: 'more in 7 of 8' }, { n: 2, start: 60, words: 'tied in 1' }]
  const spans = [{ id: 'g1', kind: 'explain', start: 4, end: 14 }, { id: 'h1', kind: 'heads', start: 31, end: 45 }, { id: 'g2', kind: 'explain', start: 61, end: 65 }]
  const stops = stopsOfRow('r2', cites, spans, [])
  assert.deepEqual(stops.map(s => (s.kind === 'citation' ? `c${s.n}` : s.id)), ['g1', 'h1', 'c1', 'c2', 'g2'])
})

test('a turn\'s stops: the cards Claude drew inline stand between the text rows where their calls stood, v\'s under their row', () => {
  const own = { a: [{ row: 'a', kind: 'citation', n: 1 }], b: [{ row: 'b', kind: 'explain', id: 'g1' }, { row: 'b', card: 'cv' }] }
  const stops = stopsOfTurn(['a', 'b'], row => own[row], [{ id: 'c0', after: 0 }, { id: 'c1', after: 1 }, { id: 'c9', after: 5 }])
  assert.deepEqual(stops.map(s => s.card ?? (s.kind === 'citation' ? `c${s.n}` : s.id)), ['c0', 'c1', 'c1', 'g1', 'c9', 'cv'])
  assert.deepEqual(stops.filter(s => s.card).map(s => `${s.card}@${s.row}`), ['c0@a', 'c1@a', 'c9@b', 'cv@b'])
})

test('a tall tray body: the lines that fit and a row for m, which goes on and then back to the top', () => {
  assert.deepEqual(pageOf([1, 1, 1], 5), { start: 0, end: 3, more: 0, next: null })
  assert.deepEqual(pageOf([1, 1, 1], 0), { start: 0, end: 3, more: 0, next: null })
  const hs = [1, 2, 1, 1, 3, 1]
  assert.deepEqual(pageOf(hs, 5), { start: 0, end: 3, more: 3, next: 3 })
  assert.deepEqual(pageOf(hs, 5, 3), { start: 3, end: 5, more: 4, next: 5 })
  assert.deepEqual(pageOf(hs, 5, 5), { start: 5, end: 6, more: 5, next: 0 })
  // a unit taller than the room still shows
  assert.equal(pageOf([9, 1], 4).end, 1)
  assert.equal(rowsOf('', 40), 1)
  assert.equal(rowsOf('aaaa bbbb cccc', 9), 2)
  assert.equal(rowsOf('x'.repeat(20), 8), 3)
})

test('the bar names ] with what it goes to while there is a next, else [ with what is before', () => {
  assert.deepEqual(stepWords({ next: true, prev: false, nextWhat: 'explainer' }), [{ key: ']', words: 'next explainer' }])
  assert.deepEqual(stepWords({ next: false, prev: true, prevWhat: 'card' }), [{ key: '[', words: 'previous card' }])
  assert.deepEqual(stepWords({ next: true, prev: true }), [{ key: ']', words: 'next' }])
  assert.deepEqual(stepWords({ next: false, prev: false }), [])
  assert.equal(cutTitle('notes/deep/plan.txt:12', 12), '…plan.txt:12')
  assert.equal(cutTitle('a long title here', 8), 'a long …')
})

test('a question asked with the tray open says which mark was open, where, and what it said', () => {
  const cite = scopeText(C1, { begins: 'Two of the five runs failed', words: '[2 of 5](#) runs', status: 'verified', evidence: { kind: 'quote', file: 'runs/summary.txt', line: '4', lines: [] } })
  assert.match(cite, /citation of your reply open in the tray: "2 of 5 runs" in your reply that begins "Two of the five runs failed"/)
  assert.match(cite, /The check verified it\. Its evidence is runs\/summary\.txt:4\./)
  const g = { id: 'g1', term: 'p95', body: 'The time [95 of 100](#) requests stay under.', here: 'Here it rose in run 3.' }
  assert.match(scopeText(G1, { begins: 'Latency rose', gloss: g }), /the term "p95" in your reply that begins "Latency rose"\. The explainer said: The time 95 of 100 requests stay under\. Here it rose in run 3\./)
  const h = { id: 'h1', kind: 'heads', term: 'cache', title: 'The cache was cold', bullets: ['Run 1 read from disk.'], todo: 'Compare runs 2 to 5.' }
  assert.match(scopeText({ row: 'r2', kind: 'heads', id: 'h1' }, { gloss: h }), /important detail .*"The cache was cold", on the words "cache"\. It said: Run 1 read from disk\. What to do: Compare runs 2 to 5\./)
  assert.equal(aboutOf(C1, { words: '[2 of 5](#)' }), 'the citation "2 of 5"')
  assert.equal(aboutOf(G1, { gloss: g }), 'the explainer of "p95"')
  assert.match(saidOf(h), /^thimble marked them as an important detail, "The cache was cold"/)
})

test('an explainer\'s words keep their citations; a heads-up reads as a title, bullets and what to do', () => {
  assert.equal(explainerText({ term: 'p95', body: 'The time [95 of 100](#) stay under.', here: 'Here: run 3.' }), 'The time [95 of 100](#) stay under.\n\nHere: run 3.')
  assert.equal(explainerText({ kind: 'heads', term: 'x', title: 'Cold *cache*', bullets: ['a', ' ', 'b'], todo: 'look' }), '**Cold cache**\n\n- a\n- b\n\n→ look')
})

test('a file link where the terminal draws hyperlinks', () => {
  assert.equal(drawsHyperlinks({ TERM_PROGRAM: 'iTerm.app' }), true)
  assert.equal(drawsHyperlinks({ TERM_PROGRAM: 'Apple_Terminal' }), false)
  assert.equal(drawsHyperlinks({ FORCE_HYPERLINK: '0', TERM_PROGRAM: 'kitty' }), false)
  assert.equal(fileHref('/data/a #1.txt', '12-14'), 'file:///data/a%20%231.txt#L12')
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
})

test('the code line that printed the cited output line: its own words stand in that line, else the last print', () => {
  const code = 'day, n, names = peak()\nprint(f"peak: {day}, with {n:,} saves under {names} names")\nprint(f"total: {total:,}")'
  assert.equal(printLine(code, 'peak: June 18, with 6,543 saves under 906 names'), 'print(f"peak: {day}, with {n:,} saves under {names} names")')
  assert.equal(printLine('  print(before, "before Jun 23")\n  print(after, "after")', '444 before Jun 23'), 'print(before, "before Jun 23")')
  // the most words on a tie of fit, the later line on an even tie
  assert.equal(printLine('print("a:", x)\nprint("a: %d of %d" % (x, y))', 'a: 3 of 4'), 'print("a: %d of %d" % (x, y))')
  // none fits: the last print; no print: the last line with code
  assert.equal(printLine('print(count())\nprint(other())\n# done', 'failed: 11'), 'print(other())')
  assert.equal(printLine('x = 1\nx + 1\n', '2'), 'x + 1')
  assert.equal(printLine('', 'x'), '')
  assert.equal(printLine('echo "rows: $n"\necho "cols: ${m}"', 'rows: 12'), 'echo "rows: $n"')
})

test('x repairs a citation the check found wrong or could not confirm', () => {
  assert.equal(canRepair({ status: 'failed' }), true)
  assert.equal(canRepair({ status: 'verified' }), false)
  assert.equal(canRepair({ status: 'corrected' }), false)
  assert.equal(canRepair({ status: 'checking' }), false)
  assert.equal(canRepair(null), false)
})
