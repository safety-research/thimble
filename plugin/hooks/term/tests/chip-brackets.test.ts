// A chip inside brackets its writer put around it (bug hunt C19): a side thread's fork wrote `[[↗](transcript.jsonl#L88)]`,
// which the thread's answer drew as `[↗ (transcript.jsonl#L88)]`. Whatever the brackets, a chip draws as `[ transcript.jsonl
// line 88 ]`, in a reply's paragraph, a preview's words and a thread's answer with a card chip (hooks/term/lib.ts
// withoutOwnBrackets). `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { plainCites } from '../cite'
import { cardsInline, citations, inlineRuns, parseReply } from '../lib'

const chips = (text: string) => inlineRuns(text).flatMap(r => (r.cite ? [r.text] : []))
const shown = (text: string) => inlineRuns(text).map(r => r.text).join('')

test('bug hunt C19: a chip in brackets of any kind draws as a chip, its brackets gone', () => {
  const fork = 'It read one image as "QzW7p" [[↗](transcript.jsonl#L88)] and another as "M4kXe" [[↗](transcript.jsonl#L94)], then clicked [[↗](transcript.jsonl#L1050)].'
  expect(chips(fork)).toEqual(['[ transcript.jsonl line 88 ]', '[ transcript.jsonl line 94 ]', '[ transcript.jsonl line 1050 ]'])
  expect(shown(fork)).toBe('It read one image as "QzW7p" [ transcript.jsonl line 88 ] and another as "M4kXe" [ transcript.jsonl line 94 ], then clicked [ transcript.jsonl line 1050 ].')
  for (const written of ['([↗](notes.md#L3))', '[ [↗](notes.md#L3) ]', '{[↗](notes.md#L3)}', '[[[notes.md#L3]]]', '([](notes.md#L3))', '[[notes.md#L3]]', '[↗](notes.md#L3)']) {
    expect(shown(`See ${written}.`)).toBe('See [ notes.md line 3 ].')
    expect(citations(`See ${written}.`).map(c => c.ref)).toEqual(['notes.md#L3'])
  }
  // a link with words of its own, a web link and code keep their brackets
  expect(shown('See [[the third line](notes.md#L3)].')).not.toContain('[ notes.md line 3 ]')
  expect(chips('See [[↗](https://example.org/a)].')).toEqual([])
  expect(inlineRuns('Type `[[↗](notes.md#L3)]` to cite.').find(r => r.code)?.text).toBe('[[↗](notes.md#L3)]')
})

test("bug hunt C19: a thread's answer whose only citations are in brackets is drawn with chips, not left to Markdown", () => {
  const answer = 'The agent solved the text kind itself [[↗](transcript.jsonl#L88)].\n\nThe click kind took a script [[↗](card:solver-steps)].'
  const md = cardsInline(answer)
  // the card chip leaves its sentence for the card, no `[]` left behind
  expect(md).toBe('The agent solved the text kind itself [↗](transcript.jsonl#L88).\n\nThe click kind took a script.\n\n[[card:solver-steps]]')
  const blocks = parseReply(md)
  const first = blocks[0]!
  expect(first.type).toBe('rich')
  expect(first.type === 'rich' ? first.runs.map(r => r.text).join('') : '').toBe('The agent solved the text kind itself [ transcript.jsonl line 88 ].')
  expect(blocks.some(b => b.type === 'card' && b.id === 'solver-steps')).toBe(true)
  // a preview's words (the threads tree's answer row)
  expect(plainCites('Solved it itself [[↗](transcript.jsonl#L88)].')).toBe('Solved it itself [ transcript.jsonl line 88 ].')
})
