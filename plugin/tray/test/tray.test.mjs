// The tray's state and words (tray/tray.mjs): the stack of marks, the stops ] and [ move through in reading order and
// where they stop, the bar's words, and what a question asked with the tray open carries for Claude. Made-up data.
//   node --test plugin/tray/test/tray.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  aboutOf, back, base, cutTitle, drawsHyperlinks, evidenceLine, explainerText, fileHref, firstSentence, indexOf, lineWindow,
  open, push, saidOf, scopeText, stepFrom, stepWords, stopWhat, stopsOfRow, top,
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
  // a long line keeps the value in view, with … where it was cut
  const long = { text: `${'a'.repeat(100)}VALUE${'b'.repeat(100)}`, spans: [[100, 105]] }
  const cut = lineWindow(long, 40)
  assert.ok(cut.text.length <= 40 && cut.text.startsWith('…') && cut.text.endsWith('…'))
  assert.equal(cut.text.slice(cut.spans[0][0], cut.spans[0][1]), 'VALUE')
  assert.deepEqual(lineWindow({ text: 'short', spans: [] }, 40), { text: 'short', spans: [] })
})
