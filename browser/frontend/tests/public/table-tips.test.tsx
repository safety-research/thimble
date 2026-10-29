// @vitest-environment jsdom
// Files' Table mode names a row's colors where they stand, as the Transcript mode does (src/files/views/table.tsx
// TableRow): the row's edge, the cell of its bands and its number, names what Color by's labels say of the row
// (ColorContext `title`), and each label's dot names its label and the row's value of it, both in the one tooltip's
// `data-tip` (components/Tooltip HoverTips), not the browser's title, and to a screen reader. A row Color by's labels say
// nothing of names nothing; a cell's own text keeps its title.
import { expect, test } from 'vitest'
import { ColorContext, type RecordColor } from '../../src/files/colorContext'
import { ReaderLabelsContext, type ReaderLabels } from '../../src/files/marks.tsx'
import { Table } from '../../src/files/views/table.tsx'
import type { Concept, SourcePage, SourceRecord } from '../../src/lib/types.ts'
import { mount } from './mount.tsx'

const PATH = 'events.jsonl'
const rec = (line: number, step: string): SourceRecord => ({ line, record: { step, note: `a made-up note on step ${line} of the run` }, blocks: [], meta: {} })
const page: SourcePage = { path: PATH, kind: 'events', total_lines: 3, start: 1, records: [rec(1, 'read'), rec(2, 'test'), rec(3, 'other')] }
const SCAN = { id: 'k1', name: 'what the step does', unit: 'record', labels: ['runs tests', 'other'], classes: [] } as unknown as Concept
const labels: ReaderLabels = {
  path: PATH,
  on: [SCAN],
  lanes: [SCAN],
  focus: 'k1',
  rows: new Map([[`${PATH}#L2`, new Map([['k1', { ref: `${PATH}#L2`, label: 'runs tests', confidence: null, source: null }]])]]),
  want: () => undefined,
}
const GREEN = 'var(--label-3)'
const colors = new Map<number, RecordColor>([
  [2, { color: GREEN, bands: [GREEN], tint: GREEN, title: 'what the step does: runs tests' }],
  [3, { color: null, bands: [null], tint: null, title: null }],
])

test("a row's edge names what Color by's labels say of it, and a label's dot its value, on hover and to a screen reader", async () => {
  const el = await mount(
    <ReaderLabelsContext.Provider value={labels}>
      <ColorContext.Provider value={colors}>
        <Table workspace="w" path={PATH} kind="events" page={page} loadMore={() => undefined} />
      </ColorContext.Provider>
    </ReaderLabelsContext.Provider>,
  )
  const edge = (line: number) => el.querySelector<HTMLElement>(`.reader-table-row[data-line="${line}"] > td.reader-table-gutter`)!
  expect(edge(2).querySelector('.reader-band')).not.toBeNull()
  expect(edge(2).dataset.tip).toBe('what the step does: runs tests')
  expect(edge(2).getAttribute('aria-description')).toBe('what the step does: runs tests')
  // Color by's labels say nothing of rows 1 and 3
  for (const line of [1, 3]) {
    expect(edge(line).hasAttribute('data-tip'), `row ${line}`).toBe(false)
    expect(edge(line).hasAttribute('aria-description'), `row ${line}`).toBe(false)
  }
  // the label's dot on row 2, nested in the edge, names the label and the value
  const dot = edge(2).querySelector<HTMLElement>('.reader-table-dot:not(.is-empty)')!
  expect(dot.dataset.tip).toBe('what the step does: runs tests')
  expect([dot.getAttribute('role'), dot.getAttribute('aria-label')]).toEqual(['img', 'what the step does: runs tests'])
  expect(edge(1).querySelector('.reader-table-dot:not(.is-empty)')).toBeNull()
  // the tooltip is thimble's, not the browser's; a cell's own long text keeps its title
  expect(el.querySelector('td.reader-table-gutter[title], .reader-table-dot[title]')).toBeNull()
  expect(el.querySelector('.reader-table-row[data-line="2"] td[title]')).not.toBeNull()
})
