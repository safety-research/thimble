// The files a new workspace opens (src/files/Tree.tsx defaultTabs): the README shown, never the largest data file, whose
// first page can wait on a scan of gigabytes, which opens in the tab beside it.
import { expect, test } from 'vitest'
import { defaultTabs } from '../../src/files/Tree.tsx'
import type { SourceInfo } from '../../src/lib/types.ts'

const file = (path: string, size_bytes: number): SourceInfo => ({ path, kind: 'text', title: path, size_bytes })

test('a new workspace shows its README, with the largest file of records in the tab beside it', () => {
  expect(defaultTabs([file('big.jsonl', 8e9), file('small.jsonl', 10), file('README.md', 2000), file('notes.txt', 50)])).toEqual(['README.md', 'big.jsonl'])
})
