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
import { FilterBy } from '../../src/files/FilterBy'
import { NONE, OTHER, type ColorChoice } from '../../src/files/colorChoice'
import { closeLabelEditor } from '../../src/files/LabelEditor'
import { filteredLines, filterKey, filterKeyValues, filterValueOf, readFilter, useFilterBy, type FilterBy as FilterState } from '../../src/files/useFilterBy'
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
const click = async (el: Element, init: MouseEventInit = {}) => act(async () => void el.dispatchEvent(new MouseEvent('click', { bubbles: true, ...init })))

describe("a key's values and a record's value", () => {
  test("a key's toggles are every value listed, then Other, then the records with none, with no color", () => {
    expect(filterKeyValues(TYPE)).toEqual([
      { id: 'assistant', name: 'assistant', n: 30, color: null },
      { id: 'user', name: 'user', n: 12, color: null },
      { id: OTHER, name: 'Other', n: 3, color: null },
      { id: NONE, name: 'No type', n: 1, color: null },
    ])
  })
  test("a record's value is its toggle: a listed value as itself, any other Other, none NONE", () => {
    expect([filterValueOf(TYPE, 'user'), filterValueOf(TYPE, 'tool_progress'), filterValueOf(TYPE, null)]).toEqual(['user', OTHER, NONE])
  })
  test('the lines hidden are those whose value is off', () => {
    const records = [rec(1, 'user'), rec(2, 'assistant'), rec(3, 'tool_progress'), rec(4, null)]
    const valueOf = (r: SourceRecord) => filterValueOf(TYPE, r.record.type ?? null)
    expect([...filteredLines(records, valueOf, ['assistant', OTHER])]).toEqual([2, 3])
    expect([...filteredLines(records, valueOf, [])]).toEqual([])
  })
  test('what is kept per file is read back, anything else as None', () => {
    localStorage.setItem(filterKey('w', 'run.jsonl'), JSON.stringify({ by: 'k:type', off: { 'k:type': ['user', 3], bad: 'x' } }))
    expect(readFilter('w', 'run.jsonl')).toEqual({ by: 'k:type', off: { 'k:type': ['user'] } })
    expect(readFilter('w', 'other.jsonl')).toEqual({ by: null, off: {} })
  })
})

describe('the control', () => {
  const draw = (choice: ColorChoice, picked: ColorChoice[] = [], toggled: [string, boolean][] = []) =>
    mount(<FilterBy choice={choice} keys={KEYS.keys} labels={[LABEL]} values={choice.by === 'key' ? filterKeyValues(TYPE) : []} off={['user']} onChoose={(c) => picked.push(c)} onToggle={(v, alone) => toggled.push([v, alone])} countsOf={() => ({ reading: 4, writing: 2 })} />)
  test('says Filter by with None and draws no toggles; with a choice it names it', async () => {
    const none = await draw({ by: 'off' })
    expect(none.querySelector('.filterby-trigger')?.textContent).toBe('Filter by')
    expect(none.querySelectorAll('.filterby-chip')).toHaveLength(0)
    unmountAll()
    const el = await draw({ by: 'key', key: 'type' })
    expect(el.querySelector('.filterby-trigger')?.textContent).toBe('Filter by: type')
  })
  test('the menu offers None, the keys and the labels, each with its values in words and no swatch', async () => {
    const picked: ColorChoice[] = []
    const el = await draw({ by: 'off' }, picked)
    await click(el.querySelector('.filterby-trigger')!)
    const items = [...document.querySelectorAll('.colorby-menu [role="menuitemradio"]')]
    expect(items.map((b) => b.querySelector('.menu-item-label')?.textContent)).toEqual(['None', 'type', 'activity'])
    expect(items[0].getAttribute('aria-checked')).toBe('true')
    expect(items.slice(1).map((b) => b.querySelector('.filterby-words')?.textContent)).toEqual(['assistant · user · Other', 'reading · writing'])
    expect(document.querySelector('.colorby-menu .colorby-sw, .colorby-menu .colorby-preview-chip')).toBeNull()
    await click(items[1])
    expect(picked).toEqual([{ by: 'key', key: 'type' }])
  })
  test('each value is a toggle with a box ticked while its records show; a click turns it off or on, Alt shows it alone', async () => {
    const toggled: [string, boolean][] = []
    const el = await draw({ by: 'key', key: 'type' }, [], toggled)
    const chips = [...el.querySelectorAll('.filterby-chip')]
    expect(chips.map((c) => [c.querySelector('.colorby-name')?.textContent, c.getAttribute('aria-pressed'), !!c.querySelector('.filterby-box.on svg')])).toEqual([
      ['assistant', 'true', true],
      ['user', 'false', false],
      ['Other', 'true', true],
      ['No type', 'true', true],
    ])
    // words only: Filter by draws no color
    expect(el.querySelector('.filterby .colorby-sw')).toBeNull()
    await click(chips[1])
    await click(chips[0], { altKey: true })
    expect(toggled).toEqual([
      ['user', false],
      ['assistant', true],
    ])
  })
})

describe('the state', () => {
  const labelsOf = (on: Concept[], toggle = vi.fn()): FilesLabels =>
    ({ all: [LABEL], on, focus: null, setFocus: () => undefined, byId: new Map([[LABEL.id, LABEL]]), presence: new Map([[LABEL.id, { 'run.jsonl': { reading: 1, writing: 1 } }]]), toggle, setClasses: () => undefined, setColour: () => undefined, save: async () => LABEL, remove: async () => undefined }) as unknown as FilesLabels
  const records = [rec(1, 'user'), rec(2, 'assistant'), rec(3, 'assistant')]
  const rows = new Map<string, Map<string, LabelRow>>([
    ['run.jsonl#L1', new Map([['c1', { ref: 'run.jsonl#L1', label: 'reading', confidence: null, source: null }]])],
    ['run.jsonl#L2', new Map([['c1', { ref: 'run.jsonl#L2', label: 'writing', confidence: null, source: null }]])],
  ])
  let got: FilterState | null = null
  let quiet: Set<string> | null = null
  function Harness({ labels, path = 'run.jsonl' }: { labels: FilesLabels; path?: string }) {
    const q = useRef(new Set<string>())
    quiet = q.current
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
  test('a label chosen while it is off is turned on and left to Filter by; while it is off the choice is None', async () => {
    const toggle = vi.fn()
    await mount(<Harness labels={labelsOf([], toggle)} />)
    await act(async () => got!.choose({ by: 'label', id: 'c1' }))
    expect(toggle).toHaveBeenCalledWith('c1')
    expect([...quiet!]).toEqual(['c1'])
    expect(got!.choice).toEqual({ by: 'off' })
  })
  test('a key the file no longer has is None', async () => {
    localStorage.setItem(filterKey('w', 'run.jsonl'), JSON.stringify({ by: 'k:speaker', off: { 'k:speaker': ['a'] } }))
    await mount(<Harness labels={labelsOf([])} />)
    expect(got!.choice).toEqual({ by: 'off' })
    expect(got!.verdict).toBeNull()
  })
})
