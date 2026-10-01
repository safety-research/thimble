// The Files search's text half has no time limit (src/files/FileSearch.tsx): while it reads, a row says how many
// files it has read, and the analyst's Stop keeps what it found, with its count marked as a floor (find.ts resultRows).
import { describe, expect, test } from 'vitest'
import { grepStatus } from '../../src/files/FileSearch.tsx'
import { resultRows } from '../../src/files/find.ts'
import type { GrepFile } from '../../src/lib/types.ts'

const progress = { progress: true as const, scanned: 12345, of: 1032208 }
const file: GrepFile = { path: 'a.jsonl', total: 3, complete: true, matches: [{ line: 4, text: 'the hit', hit: [4, 7] }] }

describe('the text search', () => {
  test('says how many files it has read while it runs, and where it was stopped', () => {
    expect(grepStatus({ loading: true, stopped: false, progress: null })).toBeNull()
    expect(grepStatus({ loading: true, stopped: false, progress: { ...progress, scanned: 0 } })).toBe('Searching 1,032,208 files')
    expect(grepStatus({ loading: true, stopped: false, progress })).toBe('Searched 12,345 of 1,032,208 files')
    expect(grepStatus({ loading: false, stopped: true, progress })).toBe('Stopped after 12,345 of 1,032,208 files')
    expect(grepStatus({ loading: false, stopped: false, progress })).toBeNull()
  })

  test('marks its count as a floor once stopped', () => {
    const head = (stopped: boolean) => resultRows(null, { files: [file], done: null, stopped }, false).find((r) => r.kind === 'head')
    expect(head(false)).toMatchObject({ note: '3 matches in 1 file' })
    expect(head(true)).toMatchObject({ note: '3 matches+ in 1 file' })
  })
})
