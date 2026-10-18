// Home's Checks section (home.ts checksSection): one row per passage the checks commented on, the passage in plain
// words with its citations as their words or chips, in straight quotation marks as every other row's (its own
// straight ones curly), and how many comments it has. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { homeLayout, plainLines } from '../home'
import type { HomeComment, HomeData } from '../home'

const PASSAGE = 'Bot7 edited [4](card:pages-bot7@out0#L1) distinct pages, all in the **main** wiki, the "Welcome" page first.'
const COMMENTS: HomeComment[] = [
  { id: 'c1', check: 'Important details', colour: '#c80', quote: PASSAGE, ref: 'answer:t1#s1' },
  { id: 'c2', check: 'Important details', colour: '#c80', quote: PASSAGE, ref: 'answer:t1#s1' },
  { id: 'c3', check: 'Important details', colour: '#c80', quote: 'So the "namespace" is the wiki.', ref: 'answer:t1#s4' },
  { id: 'c4', check: 'Important details', colour: '#c80', quote: 'The burst ended at 22:00.', ref: 'answer:t2#s2' },
]

test("home's Checks rows: one per passage with its count, plain words, the same quotation marks as every row", () => {
  const d: HomeData = { views: [], reports: [], threads: [], cardGroups: [], labels: [], coverage: null, comments: COMMENTS }
  const lay = homeLayout(d, { folded: [], unfolded: ['checks'], more: ['checks'], pick: '' }, 160)
  const rows = plainLines(lay.lines)
  const head = rows.findIndex(r => r.startsWith('Checks (4)'))
  expect(rows.slice(head + 1, head + 4)).toEqual([
    expect.stringMatching(/^⚑ "Bot7 edited 4 distinct pages, all in the main wiki, the “Welcome” page first\." +2 comments · Important details$/),
    expect.stringMatching(/^⚑ "So the “namespace” is the wiki\." +Important details$/),
    expect.stringMatching(/^⚑ "The burst ended at 22:00\." +Important details$/),
  ])
  expect(lay.picks.map(p => p.key)).toEqual(['comment:c1', 'comment:c3', 'comment:c4'])
})
