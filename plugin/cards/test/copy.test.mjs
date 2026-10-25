// The cards an answer places, as text in /copy's Markdown and /export's text (cards/copy.mjs), on made-up answers.
//   node --test plugin/cards/test/copy.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { cardIdsIn, cardsAsText, withoutCitations } from '../copy.mjs'

const cards = { ca1b2c3d4e5: { title: 'Saves per day', text: '06-01  140 ███\n06-02    4 █' } }

test('the ids a text names, once each', () => {
  assert.deepEqual(cardIdsIn('[A](card:ca1b2c3d4e5)\n\nsee (card:ca1b2c3d4e5) and (card:cffffffff0)'), ['ca1b2c3d4e5', 'cffffffff0'])
})

test('/copy: a line that only places a card becomes its title and its text in a code block', () => {
  const md = 'Most saves came in one week.\n\n[Saves per day](card:ca1b2c3d4e5)\n\n- June 1: 140 saves.'
  assert.equal(cardsAsText(md, cards, 'markdown'), 'Most saves came in one week.\n\n**Saves per day**\n\n```\n06-01  140 ███\n06-02    4 █\n```\n\n- June 1: 140 saves.')
})

test('/export: the drawn link, even wrapped, becomes the title and the text at its indent', () => {
  const out = '● Most saves came in one week.\n\n  Saves per day\n  (card:ca1b2c3d4e5)\n\n  - June 1: 140 saves.\n'
  assert.equal(cardsAsText(out, cards, 'export'), '● Most saves came in one week.\n\n  Saves per day\n\n  06-01  140 ███\n  06-02    4 █\n\n  - June 1: 140 saves.\n')
})

test('a link inside a sentence, an unknown card and a card with no text copy', () => {
  const md = 'As [the card](card:ca1b2c3d4e5) shows, it peaked.\n\n[Gone](card:cffffffff0)'
  assert.equal(cardsAsText(md, cards, 'markdown'), md)
  assert.equal(cardsAsText('[Saves](card:ca1b2c3d4e5)', { ca1b2c3d4e5: { title: 'Saves per day', text: '' } }, 'markdown'), '**Saves per day**')
})

test('citations read as their words alone', () => {
  assert.equal(withoutCitations('It peaked in [one week](#), with [13,339 saves](#).', 'markdown'), 'It peaked in one week, with 13,339 saves.')
  assert.equal(withoutCitations('  in one week (#),\n  with 13,339 saves (#).', 'export'), '  in one week,\n  with 13,339 saves.')
})
