// The reader's line count (src/files/Reader.tsx linesText): shown only once it is exact, never while a big file's line
// index is being built.
import { describe, expect, test } from 'vitest'
import { linesText } from '../../src/files/Reader.tsx'

describe('the line count', () => {
  test('an exact count is given in full', () => {
    expect(linesText(1_065_203, false)).toBe((1_065_203).toLocaleString())
    expect(linesText(7, false)).toBe('7')
  })
  test('an estimate is not shown', () => {
    expect(linesText(1_065_203, true)).toBe('')
    expect(linesText(412, true)).toBe('')
  })
})
