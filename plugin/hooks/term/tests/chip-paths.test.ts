// Chips of cited files that share a name (bug hunt B25): each names its file by the shortest end of its path that no
// other cited file's path ends in (`P1/transcript.md line 5`), and a file whose name no other cited file has keeps its
// name alone (hooks/term/lib.ts citedFileName). `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import * as lib from '../lib'
import { inlineRuns, parseReply } from '../lib'

// the files cited so far, forgotten before and after each test
const forgetCitedFiles = () => (lib as { forgetCitedFiles?: () => void }).forgetCitedFiles?.()

const chips = (text: string) => inlineRuns(text).flatMap(r => (r.cite ? [r.text] : []))

test("same-named files in a paragraph's chips read by the folder that tells them apart", () => {
  forgetCitedFiles()
  const text = 'Lines carry a "(?)" mark: 10 in P1 and 14 in P2 [[P1/transcript.md#L5]] [[P2/transcript.md#L5]]. P3 to P7 have no such marks [[P3/transcript.md#L5]]; see [[events.jsonl#L12]].'
  expect(chips(text)).toEqual(['[ P1/transcript.md line 5 ]', '[ P2/transcript.md line 5 ]', '[ P3/transcript.md line 5 ]', '[ events.jsonl line 12 ]'])
  forgetCitedFiles()
})

test('a reply notes every file it cites before it draws a chip, and only as much of a path as tells it apart', () => {
  forgetCitedFiles()
  const blocks = parseReply('First [[runs/r1/forge.db#L3]].\n\nThen [[runs/r2/forge.db#L3]].', { all: true })
  const drawn = blocks.flatMap(b => (b.type === 'rich' ? b.runs.flatMap(r => (r.cite ? [r.text] : [])) : []))
  expect(drawn).toEqual(['[ r1/forge.db line 3 ]', '[ r2/forge.db line 3 ]'])
  forgetCitedFiles()
})

test("a long run folder that tells same-named files apart is kept whole, never cut from its start", () => {
  forgetCitedFiles()
  const text = 'It looped [[otter-pond__strict-fan-out/transcript.jsonl#L840]] while [[otter-pond__strict/transcript.jsonl#L12]] and [[kestrel-nine__goal/transcript.jsonl#L1167]] ran on [[otter-pond__loose-fan-out-with-retries-and-a-very-long-name/transcript.jsonl#L3]].'
  const got = chips(text)
  expect(got.slice(0, 3)).toEqual(['[ otter-pond__strict-fan-out/transcript.jsonl line 840 ]', '[ otter-pond__strict/transcript.jsonl line 12 ]', '[ kestrel-nine__goal/transcript.jsonl line 1167 ]'])
  // past the longest a chip may be, the file's shared name is cut first, then the folder in its middle, its two ends kept
  expect(got[3]).toMatch(/^\[ otter-pond__loose.*….*name\/… line 3 \]$/)
  forgetCitedFiles()
})
