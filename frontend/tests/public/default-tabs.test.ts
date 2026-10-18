// The files a new workspace opens (src/files/Tree.tsx defaultTabs): the README shown, never the largest data file, whose
// first page can wait on a scan of gigabytes.
import { describe, expect, test } from 'vitest'
import { defaultTabs } from '../../src/files/Tree.tsx'
import type { SourceInfo } from '../../src/lib/types.ts'

const file = (path: string, size_bytes: number, extra: Partial<SourceInfo> = {}): SourceInfo => ({ path, kind: 'text', title: path, size_bytes, ...extra })

describe('a new workspace', () => {
  test('shows the README, with the largest file of records in the tab beside it', () => {
    const files = [file('big.jsonl', 8e9), file('small.jsonl', 10), file('README.md', 2000), file('notes.txt', 50)]
    expect(defaultTabs(files)).toEqual(['README.md', 'big.jsonl'])
    expect(defaultTabs([file('readme', 10), file('notes.txt', 50)])).toEqual(['readme'])
  })
})
