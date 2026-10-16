// A side thread's answer with the cards it cites drawn where it cites them (lib.ts cardsInline): a card cited by a chip
// alone (`[[card:<id>]]`) leaves its sentence and stands after the sentence's paragraph, once; the turn's other cards
// after the answer. `claude plugin test mods/thimble-term`.
import { expect, test } from 'claude-code/testing'

import { cardsInline } from '../hooks/lib'

test('a card cited by a chip alone stands after the paragraph that cites it, its chip taken out of the sentence', () => {
  const md = 'Yes. The transcripts are under 1 MB [[card:a1b2c3d4]].\nThe logs are the rest.\n\nThat is all.'
  expect(cardsInline(md)).toBe('Yes. The transcripts are under 1 MB.\nThe logs are the rest.\n\n[[card:a1b2c3d4]]\n\nThat is all.')
})

test('a chip in brackets loses its brackets; the link form and the `cell:` spelling are chips too', () => {
  expect(cardsInline('Mostly video ([[cell:a1b2c3d4]]).')).toBe('Mostly video.\n\n[[card:a1b2c3d4]]')
  expect(cardsInline('Mostly video [↗](card:a1b2c3d4).')).toBe('Mostly video.\n\n[[card:a1b2c3d4]]')
})

test('a card is drawn once: a second chip of it, or an embed of it, adds no second card', () => {
  expect(cardsInline('One [[card:aaaa1111]].\n\nTwo [[card:aaaa1111]].')).toBe('One.\n\n[[card:aaaa1111]]\n\nTwo.')
  expect(cardsInline('One [[card:aaaa1111]].\n[[card:aaaa1111]]')).toBe('One.\n[[card:aaaa1111]]')
})

test("the turn's other cards stand after the answer; a value cited on a card and a code fence are left as written", () => {
  expect(cardsInline('It holds [[4579|card:aaaa1111#pages/TOTAL]] pages.', ['aaaa1111', 'bbbb2222'])).toBe('It holds [[4579|card:aaaa1111#pages/TOTAL]] pages.\n\n[[card:aaaa1111]]\n\n[[card:bbbb2222]]')
  expect(cardsInline('```\nx [[card:aaaa1111]]\n```')).toBe('```\nx [[card:aaaa1111]]\n```')
  expect(cardsInline('', ['aaaa1111'])).toBe('[[card:aaaa1111]]')
})
