// The reader's line count (src/files/Reader.tsx linesText): an estimate, while a big file's line index is being built,
// reads as one, rounded to three figures.
import { describe, expect, test } from 'vitest'
import { linesText } from '../../src/files/Reader.tsx'

describe('the line count', () => {
  test('an exact count is given in full', () => {
    expect(linesText(1_065_203, false)).toBe((1_065_203).toLocaleString())
    expect(linesText(7, false)).toBe('7')
  })
  test('an estimate says so and keeps three figures', () => {
    expect(linesText(1_065_203, true)).toBe(`about ${(1_070_000).toLocaleString()}`)
    expect(linesText(98_765, true)).toBe(`about ${(98_800).toLocaleString()}`)
    expect(linesText(412, true)).toBe('about 412')
  })
})
