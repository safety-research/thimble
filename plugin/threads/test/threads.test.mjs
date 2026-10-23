// Side threads' pure part (threads/threads.mjs): one thread per thing, the fork's first question, its transcript as the
// thread's turns, the list's rows. All data is made up.   node --test plugin/threads/test/threads.test.mjs
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ago, askWords, cardPart, display, shownAbout, firstMessage, forkDirective, nameOf, nextMessage, rowsOf, sentNote, stepWords, threadKey, turnsOf } from '../threads.mjs'

test('one thread per citation, explainer, card or pane; a citation\'s evidence pane is that citation\'s thread', () => {
  const cite = threadKey({ about: '41 of the 44', mark: { row: 'row-1', kind: 'citation', n: 2 } })
  assert.equal(cite, 'mark-row-1-citation-2')
  assert.equal(threadKey({ about: 'whatever', pane: { kind: 'evidence', args: { row: 'row-1', n: 2 } } }), cite)
  assert.equal(threadKey({ about: 'p95', mark: { row: 'row-1', kind: 'explain', id: 'g1' } }), 'mark-row-1-explain-g1')
  assert.equal(threadKey({ about: 'Runs', card: 'c0123456789ab' }), 'card-c0123456789ab')
  // a pane's arguments in any order are one thread
  assert.equal(threadKey({ about: 'x', pane: { kind: 'labels', args: { label: 'toxic', value: 'yes' } } }), threadKey({ about: 'y', pane: { kind: 'labels', args: { value: 'yes', label: 'toxic' } } }))
  assert.notEqual(threadKey({ about: 'x', pane: { kind: 'labels', args: { label: 'toxic' } } }), threadKey({ about: 'x', pane: { kind: 'labels', args: {} } }))
  assert.equal(nameOf({ subject: 'Saves per day, by the wiki\'s editors and their bots' }), 'main/Saves per day, by the wiki\'s ed…')
  // a passage of a reply: one thread per row and words
  const passage = threadKey({ about: '"Two runs failed."', passage: { row: 'row-1', text: 'Two runs failed.' } })
  assert.match(passage, /^passage-row-1-[0-9a-z]+$/)
  assert.equal(threadKey({ about: 'other words', passage: { row: 'row-1', text: 'Two runs failed.\n' } }), passage)
  assert.notEqual(threadKey({ about: 'x', passage: { row: 'row-1', text: 'One run passed.' } }), passage)
  assert.notEqual(threadKey({ about: 'x', passage: { row: 'row-2', text: 'Two runs failed.' } }), passage)
})

test('the first question says what it is about and where the data is; a later one names a new thing only', () => {
  const scope = { about: '41 of the 44', mark: { row: 'r1', kind: 'citation', n: 1 } }
  const first = firstMessage({ text: ' why so many? ', scope, detail: 'Its sentence: "41 of the 44 runs failed."', root: '/made-up/data' })
  assert.equal(first, 'why so many?\n\nAbout: Claude\'s citation "41 of the 44" in its reply.\nIts sentence: "41 of the 44 runs failed."\nThe data: /made-up/data')
  assert.match(firstMessage({ text: 'q', scope: { about: 'Runs', card: 'c1' } }), /About: the card "Runs" \(id "c1"\)\./)
  assert.match(firstMessage({ text: 'q', scope: { about: 'p95', mark: { row: 'r1', kind: 'heads', id: 'h' } } }), /important detail/)
  assert.equal(firstMessage({ text: 'why?', scope: { about: '"Two runs failed."', passage: { row: 'r1', text: 'Two runs failed. Both timed out.' } } }), 'why?\n\nAbout: this passage of Claude\'s message:\nTwo runs failed. Both timed out.')
  assert.equal(nextMessage({ text: 'and then?', scope, last: scope }), 'and then?')
  assert.equal(nextMessage({ text: 'and then?', scope: { about: 'coverage', pane: { kind: 'coverage', args: {} } }, last: scope }), 'and then?\n\n(About "coverage" now.)')
})

test("a fork's transcript is the thread's turns: the question after its directive, steps in a few words, the last words as the answer", () => {
  const sent = firstMessage({ text: 'why so many?', scope: { about: 'x', card: 'c1' } })
  const messages = [
    { role: 'assistant', content: [{ type: 'tool_use', name: 'Agent', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', content: 'ok' }, { type: 'text', text: `<fork-boilerplate>be a fork</fork-boilerplate>\nYour directive: ${forkDirective('THREAD GUIDE', sent)}` }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Let me count.' }, { type: 'tool_use', name: 'Bash', input: { command: 'python3 count.py\nmore' } }] },
    { role: 'user', content: [{ type: 'tool_result', content: '41' }] },
    { role: 'assistant', content: [{ type: 'text', text: '41 of the 44 runs failed (runs.jsonl).' }] },
    { role: 'user', content: [{ type: 'text', text: '<system-reminder>The coordinator sent a message while you were working:\nand the 3?\n\nAddress this before completing your current task.</system-reminder>' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'They used the old config.' }] },
  ]
  const turns = turnsOf(messages)
  assert.deepEqual(turns, [
    { role: 'person', text: sent },
    { role: 'claude', text: '41 of the 44 runs failed (runs.jsonl).', calls: ['Let me count.', 'python3 count.py'] },
    { role: 'person', text: 'and the 3?' },
    { role: 'claude', text: 'They used the old config.', calls: [] },
  ])
  // as the person reads them: their question as typed, with what it was about, and the cards drawn for an answer
  const thread = { asks: [{ text: 'why so many?', scope: { about: 'Runs', card: 'c1' }, sent, at: 'a1', cards: ['c9'] }, { text: 'and the 3?', scope: { about: 'Runs', card: 'c1' }, sent: 'and the 3?', at: 'a2' }], turns: [] }
  const shown = display(thread, turns, 'now')
  assert.deepEqual(shown.map(x => [x.role, x.text, x.about ?? null, x.cards ?? null]), [
    ['person', 'why so many?', 'Runs', null], ['claude', '41 of the 44 runs failed (runs.jsonl).', null, ['c9']],
    ['person', 'and the 3?', 'Runs', null], ['claude', 'They used the old config.', null, null],
  ])
  assert.match(sentNote({ subject: 'Runs', turns: shown }), /^The analyst sent you the answer of a side thread about Runs\. They asked there: "and the 3\?"\nThe side agent answered:\nThey used the old config\.$/)
})

test('a step reads without the folders it ran in: no leading cd, paths in the data folder relative, others by name', () => {
  const root = '/made-up/data'
  assert.equal(stepWords('cd /made-up/data/runs/r1 && python3 count.py', root), 'python3 count.py')
  assert.equal(stepWords('cd "/made-up/data" ; cd runs && wc -l events.jsonl', root), 'wc -l events.jsonl')
  assert.equal(stepWords('python3 /made-up/data/tools/count.py /made-up/data/runs/r1/events.jsonl', root), 'python3 tools/count.py runs/r1/events.jsonl')
  assert.equal(stepWords('Read /made-up/data/harness/config.yaml', root), 'Read harness/config.yaml')
  assert.equal(stepWords('ls /made-up/data', root), 'ls .')
  assert.equal(stepWords('cat /home/someone/notes/todo.txt | head', root), 'cat …/todo.txt | head')
  assert.equal(stepWords('cd /made-up/data/runs/r1', root), 'cd runs/r1')
  assert.equal(stepWords('Let me count.', root), 'Let me count.')
  assert.equal(stepWords('grep -c merged forge.db', ''), 'grep -c merged forge.db')
})

test('the list: the newest first, how many questions, the last one, how long ago', () => {
  const now = Date.parse('2026-10-22T12:00:00Z')
  const rows = rowsOf([
    { key: 'a', subject: 'coverage', status: 'done', asks: [{}], turns: [{ role: 'person', text: 'what is left?' }], at: '2026-10-22T11:56:00Z' },
    { key: 'b', subject: 'Runs', status: 'running', asks: [{}, {}], turns: [{ role: 'person', text: 'one' }, { role: 'claude', text: 'x' }, { role: 'person', text: 'two' }], at: '2026-10-22T11:59:50Z' },
  ], now)
  assert.deepEqual(rows, [
    { key: 'b', name: 'main/Runs', status: 'running', asks: 2, last: 'two', ago: 'now' },
    { key: 'a', name: 'main/coverage', status: 'done', asks: 1, last: 'what is left?', ago: '4m' },
  ])
  assert.equal(ago('2026-10-20T12:00:00Z', now), '2d')
})

test('the input bar names its thing in a few words: never the sentence a model reads about a pane', () => {
  const about = 'the claims of this session, with a long description'
  assert.equal(askWords({ about, pane: { kind: 'claims', args: {} } }), 'the claims')
  assert.equal(askWords({ about, pane: { kind: 'claims', args: { claim: 'k1' } } }), 'this claim')
  assert.equal(askWords({ about, pane: { kind: 'claims', args: { group: '2' } } }), 'this cluster')
  assert.equal(askWords({ about: 'the card "Runs per day"', card: 'c0123456789ab' }), 'this card')
  assert.equal(askWords({ about: '41 of the 44', mark: { row: 'row-1', kind: 'citation', n: 2 } }), '41 of the 44')
  assert.equal(askWords({ about: 'coverage', pane: { kind: 'coverage', args: {} } }), 'coverage')
  // under a question: the same few words, but a card keeps its title
  assert.equal(shownAbout({ about, pane: { kind: 'claims', args: { claim: 'k1' } } }), 'this claim')
  assert.equal(shownAbout({ about: 'Runs', card: 'c1' }), 'Runs')
})

test("a card's part: the line its text copy marks selected with ▸, from the mark on, its runs of spaces shortened", () => {
  const copy = 'Merges per run\n  r0 made-up      1        +3\n▸ r1 made-up        2 merged        +12\n▸ r1 made-up  details'
  assert.equal(cardPart(copy), '▸ r1 made-up  2 merged  +12')
  assert.equal(cardPart('│ ▸ r2 made-up   +4 │'), '▸ r2 made-up  +4 │')
  assert.equal(cardPart('no selection here'), '')
  assert.equal(cardPart(), '')
})
