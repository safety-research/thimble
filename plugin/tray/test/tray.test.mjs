// The tray's state and words (tray/tray.mjs): the stack of marks, the stops ] and [ move through in reading order and
// where they stop, the bar's words, and what a question asked with the tray open carries for Claude. Made-up data.
//   node --test plugin/tray/test/tray.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { aboutOf, back, base, evidenceLine, firstSentence, hiddenOutput, indexOf, lineWindow, moreLines, open, pageOf, pageRows, push, stepFrom, stopWhat, stopsOfRow, top } from '../tray.mjs'

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

test('a unit taller than the room shows a room of its rows at a time: m goes on in it, then to the next unit', () => {
  assert.equal(pageOf([9, 1], 4).end, 1)
  assert.deepEqual(pageOf([9, 1], 4), { start: 0, end: 1, more: 1, next: 0, nextSkip: 3 })
  assert.deepEqual(pageOf([9, 1], 4, 0, 3), { start: 0, end: 1, more: 1, next: 0, skip: 3, nextSkip: 6 })
  assert.deepEqual(pageOf([9, 1], 4, 0, 6), { start: 0, end: 1, more: 1, next: 1, skip: 6 })
})

test('the line that says there is more counts rows, so a paragraph that wraps counts as the lines it takes', () => {
  // seven paragraphs, the first five rows tall: a room of 4 shows its first three rows (one row says there is more)
  const hs = [5, 1, 2, 1, 3, 1, 1]
  assert.deepEqual(pageRows(hs, 4, pageOf(hs, 4)), { first: 1, last: 3, total: 14 })
  // m: its last two rows, then the next paragraph
  assert.deepEqual(pageRows(hs, 4, pageOf(hs, 4, 0, 3)), { first: 4, last: 6, total: 14 })
  // whole units: rows 6 to 8, the second and third paragraphs
  assert.deepEqual(pageRows(hs, 4, pageOf(hs, 4, 1)), { first: 6, last: 8, total: 14 })
  // a cut unit at the end counts the rows of it the page shows
  assert.deepEqual(pageRows(hs, 5, pageOf(hs, 5, 3)), { first: 9, last: 12, total: 14 })
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
