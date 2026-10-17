// A citation written as a link whose words are in double brackets (bug hunt E2): main wrote `[[↗]](card:<id>)`, which
// drew a red × chip of a file named "↗" followed by the raw `(card:<id>)`, and the Citations view counted one failed
// citation of "↗". It reads as the card's chip it means everywhere the terminal reads citations (hooks/term/lib.ts
// withoutOwnBrackets). `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { plainCites } from '../cite'
import { cardsInline, citations, inlineRuns } from '../lib'

const chips = (text: string) => inlineRuns(text).flatMap(r => (r.cite ? [r.text] : []))
const shown = (text: string) => inlineRuns(text).map(r => r.text).join('')

test('bug hunt E2: `[[↗]](card:<id>)` is the card chip, never a citation of a file named ↗', () => {
  const answer = 'Most runs finished [[↗]](card:tally-ends). There are 221 across the 23 runs [[↗]](card:session-rows), and 4 gave up ([[↗]](card:gave-up)).'
  expect(citations(answer).map(c => c.ref)).toEqual(['card:tally-ends', 'card:session-rows', 'card:gave-up'])
  expect(chips(answer)).toEqual(['[ card:tally-ends ]', '[ card:session-rows ]', '[ card:gave-up ]'])
  expect(shown(answer)).toBe('Most runs finished [ card:tally-ends ]. There are 221 across the 23 runs [ card:session-rows ], and 4 gave up [ card:gave-up ].')
  expect(plainCites('Ends [[ ↗ ]](card:tally-ends).')).toBe('Ends [ card:tally-ends ].')
  // a value and a file's line written the same way
  expect(citations('[[221]](card:session-rows#n/all) and [[↗]](notes.md#L3)').map(c => c.raw)).toEqual(['[[221|card:session-rows#n/all]]', '[[notes.md#L3]]'])
  // a thread's answer draws the card after its paragraph
  expect(cardsInline('Most runs finished [[↗]](card:tally-ends).')).toBe('Most runs finished.\n\n[[card:tally-ends]]')
  // code keeps its form
  expect(inlineRuns('Type `[[↗]](card:x1)` to cite.').find(r => r.code)?.text).toBe('[[↗]](card:x1)')
})
