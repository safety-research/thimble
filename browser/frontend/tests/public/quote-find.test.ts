// The words a citation quotes, found in its record (src/lib/quoteFind.ts): an inline citation's words in quotation marks
// become a span ref of the record it cites, and a table row a span ref names shows those words in the cell that holds
// them (src/files/views/table.tsx citedCell).
import { describe, expect, test } from 'vitest'
import { citedCell } from '../../src/files/views/table.tsx'
import { findQuote, quotedWords, quoteSpanRef } from '../../src/lib/quoteFind.ts'
import type { ResolvedRef, SourceRecord } from '../../src/lib/types.ts'

describe('quoted words', () => {
  test('a quote is found as written, as JSON writes it, and with its spaces and case folded', () => {
    expect(findQuote('a b "c d" e', 'c d')).toEqual([5, 8])
    const raw = JSON.stringify({ content: 'He said "all done"\nthen left' })
    const at = findQuote(raw, 'said "all done"\nthen')!
    expect(raw.slice(at[0], at[1])).toBe('said \\"all done\\"\\nthen')
    expect(findQuote('x All  Individual\nsearches y', 'all individual searches')).toEqual([2, 26])
    expect(findQuote('nothing here', 'missing words')).toBeNull()
  })

  test("a citation's words in quotation marks come first, longest first, then its whole text", () => {
    expect(quotedWords('reported its inbox searches "completed successfully"')).toEqual(['completed successfully', 'reported its inbox searches "completed successfully"'])
    expect(quotedWords('“one” and “a longer one”')).toEqual(['a longer one', 'one', '“one” and “a longer one”'])
    expect(quotedWords('71.9%')).toEqual([])
  })

  test('a citation of a whole record opens at the words it quotes, as a span of that record', () => {
    const r = { ref: 'events.jsonl#L7', kind: 'record', path: 'events.jsonl', line: 7, excerpt: '', blocks: [{ kind: 'raw', text: '{"msg":"All sender searches completed successfully today"}' }] } as unknown as ResolvedRef
    expect(quoteSpanRef(r, 'reported its searches "completed successfully"')).toBe('events.jsonl#L7.b0:c28-50')
    expect(quoteSpanRef(r, 'a claim in other words')).toBeNull()
    expect(quoteSpanRef({ ...r, kind: 'span' }, '"completed successfully"')).toBeNull()
  })

  test('the cell of a table row that holds the quoted words is found, and where they sit in its text', () => {
    const text = '## Doctrine\nIt was a significant misinterpretation of environmental failures, not a foe.'
    const line = JSON.stringify({ id: 'm1', content: text })
    const records = [{ line: 4, record: { id: 'm1', content: text }, blocks: [{ kind: 'raw', text: line }] }] as unknown as SourceRecord[]
    const q = 'a significant misinterpretation'
    const start = line.indexOf(q)
    const got = citedCell(records, ['id', 'content'], { line: 4, block: 0, start, end: start + q.length })!
    expect(got.col).toBe('content')
    expect(text.slice(got.at[0], got.at[1])).toBe(q)
    expect(citedCell(records, ['id', 'content'], { line: 4 })).toBeNull()
  })
})
