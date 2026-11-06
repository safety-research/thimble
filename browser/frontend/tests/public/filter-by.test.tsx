// @vitest-environment jsdom
// Filter by in Files' Transcript mode (src/files/useFilterBy.ts): with None nothing is hidden; a key's toggles are
// every value the server lists, then Other, then the records with none; a record whose value is off is hidden, the
// choice and the values off are kept per file, and Show turns every value back on.
import { act, useRef } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { NONE, OTHER } from '../../src/files/colorChoice'
import { filterKey, useFilterBy, type FilterBy } from '../../src/files/useFilterBy'
import type { FilesLabels } from '../../src/files/useLabels'
import type { SourceKeys, SourceRecord } from '../../src/lib/types'
import { mount, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
  localStorage.clear()
})

const KEYS: SourceKeys = {
  path: 'run.jsonl',
  total: 46,
  bins: 0,
  partial: false,
  bytes: [],
  keys: [{ key: 'type', values: [{ value: 'assistant', n: 30 }, { value: 'user', n: 12 }], more: { values: 2, n: 3 }, none: 1, at: [] }],
}
const NO_LABELS = { all: [], on: [], focus: null, byId: new Map(), presence: new Map(), toggle: () => undefined } as unknown as FilesLabels
const records: SourceRecord[] = ['user', 'assistant', 'assistant'].map((type, i) => ({ line: i + 1, record: { type }, blocks: [], meta: {} }))

let got: FilterBy | null = null
function Harness() {
  const quiet = useRef(new Set<string>())
  got = useFilterBy('w', 'run.jsonl', true, NO_LABELS, [], KEYS, records, new Map(), records.length, quiet)
  return null
}

test('Filter by a key: a value turned off hides its records, kept for the file, and Show brings them back', async () => {
  await mount(<Harness />)
  expect(got!.choice).toEqual({ by: 'off' })
  expect(got!.verdict).toBeNull()
  await act(async () => got!.choose({ by: 'key', key: 'type' }))
  expect(got!.values.map((v) => v.id)).toEqual(['assistant', 'user', OTHER, NONE])
  await act(async () => got!.toggle('assistant', false))
  expect([1, 2, 3].map((l) => got!.verdict!.hides(l))).toEqual([false, true, true])
  expect(JSON.parse(localStorage.getItem(filterKey('w', 'run.jsonl'))!)).toEqual({ by: 'k:type', off: { 'k:type': ['assistant'] } })
  await act(async () => got!.verdict!.show())
  expect(got!.verdict).toBeNull()
  expect(got!.choice).toEqual({ by: 'key', key: 'type' })
})
