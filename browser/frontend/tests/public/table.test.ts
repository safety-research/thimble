// The Table view reads a CSV file by record, not by line (src/files/views/table.tsx splitDelimited).
import { describe, expect, test } from 'vitest'
import type { SourceRecord } from '../../src/lib/types.ts'
import { citedCell, splitDelimited } from '../../src/files/views/table.tsx'

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

describe('a span ref into a long record in the Table view', () => {
  test('names the cell that holds the quoted words and where they sit in its text', () => {
    const memory = `${'earlier notes '.repeat(40)}the retraction was dropped in a rewrite${' later'.repeat(30)}`
    const record = { id: 7, agent: 'a1', content: memory }
    const block = JSON.stringify(record)
    const start = block.indexOf('the retraction')
    const rec = { line: 12, record, blocks: [{ kind: 'text', text: block }], meta: {} } as unknown as SourceRecord
    const got = citedCell([rec], ['id', 'agent', 'content'], { line: 12, block: 0, start, end: start + 'the retraction was dropped'.length })
    expect(got).toEqual({ line: 12, col: 'content', at: [memory.indexOf('the retraction'), memory.indexOf('the retraction') + 26] })
    expect(citedCell([rec], ['id', 'agent', 'content'], { line: 12 })).toBeNull()
    expect(citedCell([rec], ['id', 'agent', 'content'], { line: 13, block: 0, start, end: start + 5 })).toBeNull()
  })
  test('finds them deep in a nested field, past what its cell shows', () => {
    const letter = `${'Some earlier lines. '.repeat(30)}It was tested under "pressure"\nin May.`
    const record = { id: 'e2', data: { agentId: 'a-1', medium: 'Email', messageContent: letter } }
    const block = JSON.stringify(record, null, 2)
    const words = 'tested under \\"pressure\\"\\nin May'
    const start = block.indexOf(words)
    const rec = { line: 4, record, blocks: [{ kind: 'raw', text: block }], meta: {} } as unknown as SourceRecord
    const got = citedCell([rec], ['id', 'data'], { line: 4, block: 0, start, end: start + words.length })
    const shown = JSON.stringify(record.data, null, 2)
    expect(got).toEqual({ line: 4, col: 'data', at: [shown.indexOf(words), shown.indexOf(words) + words.length] })
  })
})
