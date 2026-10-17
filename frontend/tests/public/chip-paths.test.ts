// Chips of cited files that would read the same (bug hunt B25): a chip names a file by its run's folder and its name,
// and when another cited file reads the same, by the shortest end of its path that tells them apart
// (src/lib/refs.ts fileChipName).
import { afterEach, expect, test } from 'vitest'
import * as refs from '../../src/lib/refs.ts'
import { addressLabel, refLabel } from '../../src/lib/refs.ts'

// a chip notes the file it names once it is drawn (RefChip); the files cited so far are forgotten after each test
const kit = refs as { noteCitedRef?: (ref: string) => void; forgetCitedFiles?: () => void }
const noteCitedRef = (ref: string) => kit.noteCitedRef?.(ref)
afterEach(() => kit.forgetCitedFiles?.())

test('two cited files that would read the same read by the shortest path that tells them apart', () => {
  noteCitedRef('a/x/notes.json#L2')
  expect(refLabel('a/x/notes.json#L2')).toBe('x › notes.json L2')
  noteCitedRef('b/x/notes.json#L5')
  expect(refLabel('a/x/notes.json#L2')).toBe('a › x › notes.json L2')
  expect(refLabel('b/x/notes.json#L5')).toBe('b › x › notes.json L5')
  expect(addressLabel('b/x/notes.json#L5')).toBe('b › x › notes.json L5')
  // the folder a chip names already tells P1's transcript from P2's
  noteCitedRef('P1/transcript.md#L5')
  noteCitedRef('P2/transcript.md#L5')
  expect(refLabel('P1/transcript.md#L5')).toBe('P1 › transcript.md L5')
  expect(refLabel('P2/transcript.md#L5')).toBe('P2 › transcript.md L5')
})
