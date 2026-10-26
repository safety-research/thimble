// The answers' pure part (core/answers.mjs) and what the person engaged with, in words (core/engaged.mjs). All data is
// made up.   node --test plugin/core/test/answers.test.mjs
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isPersonPrompt, labelCommands, sinceLastPrompt } from '../answers.mjs'
import { HEAD, askedLine, commentsText, openedLine } from '../engaged.mjs'

test('a Bash command names the labels it runs `thimble label` on, in order; data and the list name none', () => {
  assert.deepEqual(labelCommands('thimble label alone --code "x" && thimble label alone --csv'), [
    { name: 'alone', args: ['--code', 'x'] }, { name: 'alone', args: ['--csv'] },
  ])
  assert.deepEqual(labelCommands('cd data; /opt/x/bin/thimble label toxic --prompt "Is it toxic?" --limit 20 | tail -3'), [
    { name: 'toxic', args: ['--prompt', 'Is it toxic?', '--limit', '20'] },
  ])
  // the list, a flag first, a heredoc's body and a comment are no label runs
  assert.deepEqual(labelCommands('thimble label --json'), [])
  assert.deepEqual(labelCommands("python3 - <<'PY'\nprint('thimble label fake')\nPY\nthimble label real --regex x # thimble label other"), [{ name: 'real', args: ['--regex', 'x'] }])
  assert.deepEqual(labelCommands('echo thimble label'), [])
})

test("since the person's last prompt: that prompt, Claude's rows after it, and the answers; a task's report is not the person's, and a turn whose sender was not recorded ends the span", () => {
  // since the person's last prompt: that prompt, Claude's rows after it, and the answers; a task's report is not the person's
  {
    const turns = [
      { prompt: { text: 'Why was pr/118 reverted?', by: 'composer', row: 'p1' }, rows: ['a', 'b'], answer: 'b' },
      { prompt: { text: '<task-notification>…', by: 'task-notification', row: 'p2' }, rows: ['c'], answer: 'c' },
      { prompt: { text: 'x', by: 'peer', row: 'p3' }, rows: ['d'], answer: null },
    ]
    assert.deepEqual(sinceLastPrompt(turns), { prompt: { row: 'p1', text: 'Why was pr/118 reverted?' }, rows: ['a', 'b', 'c', 'd'], replies: ['b', 'c'] })
    assert.deepEqual(sinceLastPrompt([...turns, { prompt: { text: 'And then?', by: 'bridge', row: null }, rows: [], answer: null }]), { prompt: { row: null, text: 'And then?' }, rows: [], replies: [] })
    assert.deepEqual(sinceLastPrompt([]), { prompt: null, rows: [], replies: [] })
    assert.equal(isPersonPrompt('plugin'), true)
    assert.equal(isPersonPrompt('task-notification'), false)
  }
  // only a turn known to be the person's ends the span: a turn whose sender was not recorded (a hand-back whose prompt
  // matched no submission) is a reply to catch up on, like a task's
  {
    const turns = [
      { prompt: { text: 'How many runs failed?', by: 'composer', row: 'p1' }, rows: ['a'], answer: 'a' },
      { prompt: { text: '<agent-message from="a1">…', by: 'task-notification', row: 'p2' }, rows: ['b'], answer: 'b' },
      { prompt: { text: '<agent-message from="a2">…', by: 'unknown', row: null }, rows: ['c'], answer: 'c' },
    ]
    assert.deepEqual(sinceLastPrompt(turns), { prompt: { row: 'p1', text: 'How many runs failed?' }, rows: ['a', 'b', 'c'], replies: ['a', 'b', 'c'] })
    assert.deepEqual(sinceLastPrompt([...turns, { prompt: { text: '', by: 'continuation', row: null }, rows: ['d'], answer: 'd' }]).replies, ['a', 'b', 'c', 'd'])
    assert.equal(sinceLastPrompt([turns[0], { ...turns[2], prompt: { ...turns[2].prompt, by: 'unclassified' } }]).replies.length, 2)
    // with no prompt of the person's yet, every turn is in the span
    assert.deepEqual(sinceLastPrompt(turns.slice(1)), { prompt: null, rows: ['b', 'c'], replies: ['b', 'c'] })
    assert.equal(isPersonPrompt('unknown'), false)
    assert.equal(isPersonPrompt(undefined), false)
  }
})

test('what the person opened and asked, in words Claude reads; the same open is the same key', () => {
  const msg = 'The revert undid a change that broke the build on the main branch for two days.'
  const cite = openedLine({ kind: 'citation', row: 'r1', n: 2, words: '12 of 40', status: 'corrected' }, msg)
  assert.equal(cite.text, '- They opened the citation "12 of 40" in your message that begins "The revert undid a change that broke the build on the main…"; the check corrected it.')
  assert.equal(openedLine({ kind: 'citation', row: 'r1', n: 2, words: 'x', status: 'verified' }).key, cite.key)
  assert.match(openedLine({ kind: 'explain', row: 'r1', term: 'p95' }).text, /^- They opened the explainer of "p95"\.$/)
  assert.match(openedLine({ kind: 'heads', row: 'r1', term: 'fell 40%', title: 'March is half a month' }).text, /They opened the heads-up "March is half a month" on "fell 40%"/)
  assert.equal(openedLine({ kind: 'other' }), null)
  assert.equal(askedLine({ text: 'Which runs?', about: 'the card "Runs"' }).text, '- They asked a side thread about the card "Runs", which a side agent answers there: "Which runs?"')
  assert.match(HEAD, /none of it asks anything of you/)
})

test('the explainers and heads-ups shown on a message, in words Claude reads: each one whole; none, nothing', () => {
  const t = commentsText([
    { id: 'h1', kind: 'heads', term: 'fell 40%', title: 'Most of the drop is the short month', bullets: ['[The file ends on Mar 14](refunds.csv).', 'Per day, refunds fell 12%.'] },
    { id: 'g1', term: 'chargeback', body: 'A refund the bank takes back.', here: '[Ticket 4471](t.jsonl#L88) is one.' },
  ], 'Refunds fell 40% in March.')
  assert.match(t, /^thimble showed the analyst these comments in your message that begins "Refunds fell 40% in March\."/)
  assert.match(t, /none of them asks anything of you/)
  assert.match(t, /would tell them twice/)
  assert.match(t, /\n- A heads-up on "fell 40%": Most of the drop is the short month \[The file ends on Mar 14\]\(refunds\.csv\)\. Per day, refunds fell 12%\./)
  assert.match(t, /\n- An explainer on "chargeback": A refund the bank takes back\. \[Ticket 4471\]\(t\.jsonl#L88\) is one\.$/)
  assert.equal(commentsText([], 'x'), '')
})
