// @vitest-environment jsdom
// The labels that are on in the Table view (src/files/views/table.tsx) mark rows, not columns: a row the focused label
// highlights takes its tint, a span the focused label marks is filled in its cell and another label's underlined, and
// the line-number cell holds a slot per label that is on, under its mark, with a dot in the row's class colour.
// The records and labels are invented.
import { afterEach, describe, expect, test } from 'vitest'
import { ReaderLabelsContext, type ReaderLabels } from '../../src/files/marks.tsx'
import { Table } from '../../src/files/views/table.tsx'
import type { Concept, LabelRow, SourcePage } from '../../src/lib/types.ts'
import { mount, unmountAll } from './mount.tsx'

const PATH = 'wiki/tags.jsonl'
const label = (id: string, name: string, values: string[], color: number, marks: 'record' | 'span'): Concept =>
  ({ id, name, labels: values, unit: 'record', marks, classes: values.map((v, i) => ({ name: v, color: i === 0 ? color : 0, highlight: i === 0 })) }) as unknown as Concept
const vendor = label('k1', 'username names a vendor', ['names a vendor', 'other'], 3, 'span')
const bot = label('k2', 'bot account', ['bot', 'human'], 5, 'record')
const records = [
  { user: 'Agent050Acme', revisions: 3 },
  { user: 'AgentHelper', revisions: 1 },
  { user: 'Agent230AI', revisions: 8 },
].map((record, i) => ({ line: i + 1, record, blocks: [], meta: {} }))
const page = { path: PATH, kind: 'events', total_lines: 3, start: 1, records } as unknown as SourcePage
const row = (line: number, value: string, spans?: string[]): LabelRow => ({ ref: `${PATH}#L${line}`, label: value, confidence: null, source: null, spans })
const rows = new Map<string, Map<string, LabelRow>>([
  [`${PATH}#L1`, new Map([['k1', row(1, 'names a vendor', ['Acme'])], ['k2', row(1, 'bot')]])],
  [`${PATH}#L2`, new Map([['k1', row(2, 'other')]])],
  [`${PATH}#L3`, new Map([['k2', row(3, 'bot')]])],
])
const ctx: ReaderLabels = { path: PATH, on: [vendor, bot], lanes: [vendor, bot], focus: 'k2', rows, want: () => {} }

afterEach(unmountAll)

describe('labels in the Table view', () => {
  test('add no column; a row the focused label matches is tinted, spans marked, and its gutter holds a slot per label', async () => {
    const el = await mount(
      <ReaderLabelsContext.Provider value={ctx}>
        <Table workspace="w" path={PATH} kind="events" page={page} loadMore={() => {}} />
      </ReaderLabelsContext.Provider>,
    )
    expect([...el.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(['#', 'user', 'revisions'])
    expect([...el.querySelectorAll<HTMLElement>('thead .reader-table-tag')].map((t) => t.querySelector('.files-label-box, .files-label-tag')?.classList.contains('on'))).toEqual([true, true])
    expect([...el.querySelectorAll<HTMLElement>('thead .reader-table-tag')].map((t) => t.textContent), 'a single-class label is named by its colour, with no number').toEqual(['', ''])
    const tr = [...el.querySelectorAll<HTMLElement>('tbody tr')]
    expect(tr.map((r) => r.querySelectorAll('td').length)).toEqual([3, 3, 3])
    expect(tr.map((r) => r.classList.contains('has-tint'))).toEqual([true, false, true])
    expect(tr[0].style.getPropertyValue('--tint')).toBe('var(--label-5)')
    expect(tr[2].style.getPropertyValue('--tint')).toBe('var(--label-5)')
    const span = tr[0].querySelector('.reader-span')
    expect([span?.textContent, span?.classList.contains('is-under')]).toEqual(['Acme', true])
    const slots = tr.map((r) => [...r.querySelectorAll<HTMLElement>('.reader-table-gutter .reader-table-dot')].map((d) => (d.classList.contains('is-empty') ? '' : d.title)))
    expect(slots).toEqual([['username names a vendor: names a vendor', 'bot account: bot'], ['', ''], ['', 'bot account: bot']])
  })

  test('with the span label focused its text is filled, and a row only the other label matches is not tinted', async () => {
    const el = await mount(
      <ReaderLabelsContext.Provider value={{ ...ctx, focus: 'k1' }}>
        <Table workspace="w" path={PATH} kind="events" page={page} loadMore={() => {}} />
      </ReaderLabelsContext.Provider>,
    )
    const tr = [...el.querySelectorAll<HTMLElement>('tbody tr')]
    expect(tr.map((r) => r.classList.contains('has-tint'))).toEqual([true, false, false])
    expect(tr[0].querySelector('.reader-span')?.classList.contains('is-under')).toBe(false)
  })
})
