// @vitest-environment jsdom
// Filter by in Files' Transcript mode (src/files/useFilterBy.ts, FilterBy.tsx), as the view kit's Filter by: the
// trigger says "Filter by" with None and "Filter by: <choice>" with a choice; its menu offers None, the records' keys and
// the labels that mark the file, each with its values in words and no color; a value is a toggle with a box ticked
// while its records show (Alt shows it alone); a key's toggles are every value the server lists, then Other, then the
// records with none; a record whose value is off is hidden, the choice and the values off are kept per file, a label
// chosen while off is turned on and left to Filter by (Color by keeps its choice), and a choice that no longer stands
// is None.
import { act, useRef } from 'react'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { NONE, OTHER } from '../../src/files/colorChoice'
import { closeLabelEditor } from '../../src/files/LabelEditor'
import { filterKey, useFilterBy, type FilterBy as FilterState } from '../../src/files/useFilterBy'
import type { FilesLabels } from '../../src/files/useLabels'
import type { Concept, LabelRow, SourceKey, SourceKeys, SourceRecord } from '../../src/lib/types'
import { mount, unmountAll } from './mount.tsx'

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})
afterEach(() => {
  act(() => closeLabelEditor())
  unmountAll()
  vi.restoreAllMocks()
  localStorage.clear()
})

const TYPE: SourceKey = {
  key: 'type',
  values: [
    { value: 'assistant', n: 30 },
    { value: 'user', n: 12 },
  ],
  more: { values: 2, n: 3 },
  none: 1,
  at: [],
}
const KEYS: SourceKeys = { path: 'run.jsonl', total: 46, bins: 0, partial: false, bytes: [], keys: [TYPE] }
const LABEL: Concept = {
  id: 'c1',
  name: 'activity',
  description: "What the agent does. 'reading': it reads files. 'writing': it writes code.",
  unit: 'record',
  kind: 'prompt',
  spec: '',
  labels: ['reading', 'writing', 'other'],
  created_by: 'analyst',
  ts: '',
  glob: 'run.jsonl',
  classes: [
    { name: 'reading', color: 1, highlight: true },
    { name: 'writing', color: 2, highlight: true },
    { name: 'other', color: 0, highlight: false },
  ],
} as unknown as Concept
const rec = (line: number, type: string | null): SourceRecord => ({ line, record: type == null ? { note: 'x' } : { type }, blocks: [], meta: {} })

describe('the state', () => {
  const labelsOf = (on: Concept[], toggle = vi.fn()): FilesLabels =>
    ({ all: [LABEL], on, focus: null, setFocus: () => undefined, byId: new Map([[LABEL.id, LABEL]]), presence: new Map([[LABEL.id, { 'run.jsonl': { reading: 1, writing: 1 } }]]), toggle, setClasses: () => undefined, setColour: () => undefined, save: async () => LABEL, remove: async () => undefined }) as unknown as FilesLabels
  const records = [rec(1, 'user'), rec(2, 'assistant'), rec(3, 'assistant')]
  const rows = new Map<string, Map<string, LabelRow>>([
    ['run.jsonl#L1', new Map([['c1', { ref: 'run.jsonl#L1', label: 'reading', confidence: null, source: null }]])],
    ['run.jsonl#L2', new Map([['c1', { ref: 'run.jsonl#L2', label: 'writing', confidence: null, source: null }]])],
  ])
  let got: FilterState | null = null
  function Harness({ labels, path = 'run.jsonl' }: { labels: FilesLabels; path?: string }) {
    const q = useRef(new Set<string>())
    got = useFilterBy('w', path, true, labels, [LABEL], KEYS, records, rows, records.length, q)
    return null
  }
  test('None hides nothing; a key with a value off hides its records, kept for the file', async () => {
    await mount(<Harness labels={labelsOf([])} />)
    expect(got!.choice).toEqual({ by: 'off' })
    expect(got!.verdict).toBeNull()
    await act(async () => got!.choose({ by: 'key', key: 'type' }))
    expect(got!.values.map((v) => v.id)).toEqual(['assistant', 'user', OTHER, NONE])
    await act(async () => got!.toggle('assistant', false))
    expect([1, 2, 3].map((l) => got!.verdict!.hides(l))).toEqual([false, true, true])
    expect(JSON.parse(localStorage.getItem(filterKey('w', 'run.jsonl'))!)).toEqual({ by: 'k:type', off: { 'k:type': ['assistant'] } })
    // Show turns every value back on
    await act(async () => got!.verdict!.show())
    expect(got!.verdict).toBeNull()
    expect(got!.choice).toEqual({ by: 'key', key: 'type' })
  })
  test("a label's values hide by the label's rows; a record it does not mark is Not marked", async () => {
    await mount(<Harness labels={labelsOf([LABEL])} />)
    await act(async () => got!.choose({ by: 'label', id: 'c1' }))
    expect(got!.values.map((v) => [v.id, v.color])).toEqual([
      ['reading', null],
      ['writing', null],
      [NONE, null],
    ])
    await act(async () => got!.toggle(NONE, false))
    expect([1, 2, 3].map((l) => got!.verdict!.hides(l))).toEqual([false, false, true])
  })
})
