// The Table view reads a CSV file by record, not by line (src/files/views/table.tsx splitDelimited).
import { describe, expect, test } from 'vitest'
import { splitDelimited } from '../../src/files/views/table.tsx'

describe('a CSV file in the Table view', () => {
  test('a quoted cell holds the delimiter, doubled quotes and line breaks, and its record is keyed by its first line', () => {
    const text = ['1,plain,"a, b"', '2,"says ""hi""","--- a/x.py', '+++ b/x.py', '@@ -1 +1 @@"', '3,last,""']
    const rows = splitDelimited(text.map((t, i) => ({ line: i + 2, text: t })), ',')
    expect(rows).toEqual([
      { line: 2, cells: ['1', 'plain', 'a, b'] },
      { line: 3, cells: ['2', 'says "hi"', '--- a/x.py\n+++ b/x.py\n@@ -1 +1 @@'] },
      { line: 6, cells: ['3', 'last', ''] },
    ])
  })
})
