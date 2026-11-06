// The cards an answer places, as text in /copy's Markdown (cards/copy.mjs), on a made-up answer.
//   node --test plugin/cards/test/copy.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { cardsAsText } from '../copy.mjs'

const cards = { ca1b2c3d4e5: { title: 'Saves per day', text: '06-01  140 ███\n06-02    4 █' } }

test('/copy: a line that only places a card becomes its title and its text in a code block', () => {
  const md = 'Most saves came in one week.\n\n[Saves per day](card:ca1b2c3d4e5)\n\n- June 1: 140 saves.'
  assert.equal(cardsAsText(md, cards, 'markdown'), 'Most saves came in one week.\n\n**Saves per day**\n\n```\n06-01  140 ███\n06-02    4 █\n```\n\n- June 1: 140 saves.')
})
