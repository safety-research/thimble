// Emphasis by CommonMark's flanking rules (bug hunt C11): `__` and `_` inside a word are part of the word, so a card's
// takeaway that names two runs called `alpha-tool__fan-out` and `beta-nano__goal` keeps its underscores and draws no
// bold between them; `*` and `**` open only before a word and close only after one (hooks/term/lib.ts inlineRuns,
// plainMarks). `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { inlineRuns, plainMarks } from '../lib'

const drawn = (text: string) => inlineRuns(text).map(r => (r.b ? `<b>${r.text}</b>` : r.i ? `<i>${r.text}</i>` : r.code ? `<code>${r.text}</code>` : r.text)).join('')

test('underscores inside a word are words, not emphasis', () => {
  const takeaway = 'alpha-tool__fan-out cost the most per hour, and beta-nano__goal cost about $6.'
  expect(drawn(takeaway)).toBe(takeaway)
  expect(drawn('the file snake_case_name and other_one_too')).toBe('the file snake_case_name and other_one_too')
  expect(drawn('foo__bar__baz')).toBe('foo__bar__baz')
  expect(plainMarks(takeaway)).toBe(takeaway)
})

test('underscores and stars at the edges of words still mark bold and italic', () => {
  expect(drawn('a __bold__ word and an _italic_ one.')).toBe('a <b>bold</b> word and an <i>italic</i> one.')
  expect(drawn('**$222** per hour, *about* $6')).toBe('<b>$222</b> per hour, <i>about</i> $6')
  expect(drawn('(_aside_)')).toBe('(<i>aside</i>)')
  // CommonMark lets stars mark part of a word
  expect(drawn('foo**bar**baz')).toBe('foo<b>bar</b>baz')
  expect(plainMarks('a **bold** and `code_x_` and __b__')).toBe('a bold and code_x_ and b')
})

test('a star or two with spaces on both sides is a star, not emphasis', () => {
  expect(drawn('2 * 3 * 4 is 24')).toBe('2 * 3 * 4 is 24')
  expect(drawn('a ** b ** c')).toBe('a ** b ** c')
  expect(drawn('the *.md and *.txt files')).toBe('the *.md and *.txt files')
})
